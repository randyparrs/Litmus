# { "Depends": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng" }

"""VerifierFactory: creates one VerificationInstance per verification, always from the
official instance code stored at construction, and registers it by verification_id.

The child is deployed with gl.contract.deploy and a deterministic salt, so its address is
known in this same transaction. The child itself is created by an asynchronous internal
deploy message that runs when this transaction is finalized (measured on Studio Next: the
instance is usable ~50 s after create_verification).

The keccak256 of the instance code is fixed at construction and exposed by
get_instance_code_hash(), so anyone can check that every instance runs the published code.
get_verifications() lists every verification, newest first, from contract storage alone."""

import json

import genlayer as gl

TIERS = ("advanced-reasoning",)
MAX_URL_CHARS = 512
MAX_MODEL_CHARS = 64
HEX = "0123456789abcdef"
MAX_PAGE = 50


def _host_of(url: str) -> str:
    rest = url[len("https://"):]
    for sep in ("/", "?", "#"):
        rest = rest.split(sep, 1)[0]
    if "@" in rest:
        rest = rest.rsplit("@", 1)[1]
    if rest.startswith("["):  # bracketed IPv6 literal
        return rest
    return rest.split(":", 1)[0].lower().rstrip(".")


def _is_ip_literal(host: str) -> bool:
    """True for any host an HTTP client would read as an IP address. Besides the dotted form,
    clients accept a single decimal number (2130706433), hexadecimal (0x7f000001) and short
    forms (127.1): a host whose last label is a number is an IPv4 address in every form, and no
    real domain ends in a number."""
    if host.startswith("[") or ":" in host:
        return True
    last = host.split(".")[-1]
    if last.isdigit():
        return True
    return last.startswith("0x") and all(ch in HEX for ch in last[2:])


def _validate(verification_id: str, agent_url: str, claimed_model: str, claimed_tier: str) -> None:
    if len(verification_id) != 32 or any(ch not in HEX for ch in verification_id):
        raise gl.vm.UserError("verification_id must be 32 lowercase hex characters")
    # The scheme is case-insensitive (RFC 3986); a backslash is read as "/" by some clients and
    # would make the host checked here differ from the host actually called.
    if agent_url[:len("https://")].lower() != "https://":
        raise gl.vm.UserError("agent_url must start with https://")
    if len(agent_url) > MAX_URL_CHARS or any(ch.isspace() for ch in agent_url):
        raise gl.vm.UserError("agent_url is too long or contains whitespace")
    if "\\" in agent_url:
        raise gl.vm.UserError("agent_url cannot contain a backslash")
    host = _host_of(agent_url)
    if host == "localhost" or host.endswith(".localhost") or _is_ip_literal(host):
        raise gl.vm.UserError("agent_url host cannot be localhost or an IP address")
    if not host or "." not in host:
        raise gl.vm.UserError("agent_url has no valid host")
    if len(claimed_model) > MAX_MODEL_CHARS:
        raise gl.vm.UserError("claimed_model is too long")
    if claimed_tier not in TIERS:
        raise gl.vm.UserError("unsupported claimed_tier")


class VerifierFactory(gl.contract.Contract):
    instance_code: bytes
    instance_code_hash: str
    instances: gl.storage.TreeMap[str, str]
    # verification ids in creation order, and one JSON record per id for get_verifications()
    ids: gl.storage.DynArray[str]
    records: gl.storage.TreeMap[str, str]
    count: gl.u256

    def __init__(self, instance_code: bytes):
        self.instance_code = instance_code
        self.instance_code_hash = "0x" + gl.Keccak256(instance_code).digest().hex()
        self.count = gl.u256(0)

    @gl.public.write
    def create_verification(self, verification_id: str, agent_url: str,
                            claimed_model: str, claimed_tier: str) -> str:
        _validate(verification_id, agent_url, claimed_model, claimed_tier)
        agent_url = "https://" + agent_url[len("https://"):]  # stored with the scheme lowercased
        if verification_id in self.instances:
            raise gl.vm.UserError("verification_id already used")

        self.count = gl.u256(int(self.count) + 1)
        addr = gl.contract.deploy(
            code=self.instance_code,
            args=[
                verification_id,
                agent_url,
                claimed_model,
                claimed_tier,
                str(gl.message.sender_address),
                str(gl.message.contract_address),
            ],
            salt_nonce=self.count,
            on="finalized",
        )
        self.instances[verification_id] = str(addr)
        self.ids.append(verification_id)
        self.records[verification_id] = json.dumps({
            "verification_id": verification_id,
            "instance": str(addr),
            "agent_url": agent_url,
            "claimed_model": claimed_model,
            "claimed_tier": claimed_tier,
            "requester": str(gl.message.sender_address),
            # display only: the instance keeps its own created_at in the certificate
            "created_at": str(gl.message.raw.get("datetime", "")),
        })
        return str(addr)

    @gl.public.view
    def get_instance(self, verification_id: str) -> str:
        return self.instances.get(verification_id, "")

    @gl.public.view
    def get_count(self) -> int:
        return int(self.count)

    @gl.public.view
    def get_instance_code_hash(self) -> str:
        """keccak256 of the instance code every verification is deployed from, 0x-prefixed."""
        return self.instance_code_hash

    @gl.public.view
    def get_verifications(self, offset: int, limit: int) -> list:
        """Verifications newest first: skips `offset` of them and returns at most `limit`
        (capped at MAX_PAGE). Each item: verification_id, instance, agent_url, claimed_model,
        claimed_tier, requester, created_at."""
        if offset < 0 or limit < 0:
            raise gl.vm.UserError("offset and limit must not be negative")
        total = len(self.ids)
        end = total - offset
        start = max(end - min(limit, MAX_PAGE), 0)
        if end <= 0:
            return []
        return [json.loads(self.records[self.ids[i]]) for i in range(end - 1, start - 1, -1)]
