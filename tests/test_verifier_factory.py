import os

HERE = os.path.dirname(__file__)
FACTORY = os.path.abspath(os.path.join(HERE, "..", "contracts", "VerifierFactory.py"))
INSTANCE = os.path.abspath(os.path.join(HERE, "..", "contracts", "VerificationInstance.py"))

VID = "0123456789abcdef0123456789abcdef"
URL = "https://agent.example.com/agent-a"
TIER = "advanced-reasoning"


def _deploy(direct_deploy):
    return direct_deploy(FACTORY, open(INSTANCE, "rb").read())


def test_create_registers_instance(direct_deploy):
    f = _deploy(direct_deploy)
    addr = f.create_verification(VID, URL, "gpt-4o", TIER)
    assert addr.startswith("0x") and len(addr) == 42
    assert f.get_instance(VID) == addr
    assert f.get_count() == 1
    assert f.get_instance("f" * 32) == ""


def test_distinct_verifications_get_distinct_instances(direct_deploy):
    f = _deploy(direct_deploy)
    a = f.create_verification(VID, URL, "gpt-4o", TIER)
    b = f.create_verification("f" * 32, URL, "gpt-4o", TIER)
    assert a != b
    assert f.get_count() == 2


def test_duplicate_id_rejected(direct_vm, direct_deploy):
    f = _deploy(direct_deploy)
    f.create_verification(VID, URL, "gpt-4o", TIER)
    with direct_vm.expect_revert("verification_id already used"):
        f.create_verification(VID, URL, "gpt-4o", TIER)


def _rejects(direct_vm, f, message, **overrides):
    args = {"vid": VID, "url": URL, "model": "gpt-4o", "tier": TIER, **overrides}
    with direct_vm.expect_revert(message):
        f.create_verification(args["vid"], args["url"], args["model"], args["tier"])


def test_input_validation(direct_vm, direct_deploy):
    f = _deploy(direct_deploy)
    _rejects(direct_vm, f, "32 lowercase hex", vid="abc")
    _rejects(direct_vm, f, "32 lowercase hex", vid="G" * 32)
    _rejects(direct_vm, f, "must start with https://", url="http://agent.example.com/a")
    _rejects(direct_vm, f, "too long or contains whitespace", url="https://agent.example.com/a b")
    _rejects(direct_vm, f, "too long or contains whitespace", url="https://agent.example.com/" + "a" * 600)
    _rejects(direct_vm, f, "no valid host", url="https://intranet/agent")
    _rejects(direct_vm, f, "localhost or an IP", url="https://localhost.localhost/agent")
    _rejects(direct_vm, f, "localhost or an IP", url="https://10.0.0.5/agent")
    _rejects(direct_vm, f, "localhost or an IP", url="https://[::1]/agent")
    _rejects(direct_vm, f, "claimed_model is too long", model="m" * 65)
    _rejects(direct_vm, f, "unsupported claimed_tier", tier="basic")
    assert f.get_count() == 0


def test_ip_addresses_in_every_form_rejected(direct_vm, direct_deploy):
    """HTTP clients read a host whose last label is a number as IPv4, whatever its form."""
    f = _deploy(direct_deploy)
    for url in (
        "https://2130706433/agent",               # decimal
        "https://0x7f000001/agent",               # hexadecimal
        "https://127.1/agent",                    # short form
        "https://0177.0.0.1/agent",               # octal first part
        "https://127.0.0.0x1/agent",              # hexadecimal last part
        "https://127.0.0.1./agent",               # trailing dot
        "https://agent.example.com@127.1/agent",  # userinfo in front of the real host
        "https://LOCALHOST./agent",
    ):
        _rejects(direct_vm, f, "localhost or an IP", url=url)
    assert f.get_count() == 0


def test_hosts_with_digits_accepted(direct_deploy):
    f = _deploy(direct_deploy)
    f.create_verification("1" * 32, "https://agent1.example.com/a", "m", TIER)
    f.create_verification("2" * 32, "https://123agent.example.com/a", "m", TIER)
    f.create_verification("3" * 32, "https://agent.example.com:8443/a", "m", TIER)
    assert f.get_count() == 3


def test_backslash_rejected_and_scheme_case_insensitive(direct_vm, direct_deploy):
    f = _deploy(direct_deploy)
    _rejects(direct_vm, f, "cannot contain a backslash", url="https://agent.example.com\\@127.0.0.1/a")
    _rejects(direct_vm, f, "cannot contain a backslash", url="https://agent.example.com\\agent")
    _rejects(direct_vm, f, "must start with https://", url="HTTP://agent.example.com/a")
    f.create_verification(VID, "HTTPS://agent.example.com/a", "m", TIER)
    assert f.get_verifications(0, 1)[0]["agent_url"] == "https://agent.example.com/a"


def test_instance_code_hash(direct_deploy):
    from eth_hash.auto import keccak
    f = _deploy(direct_deploy)
    assert f.get_instance_code_hash() == "0x" + keccak(open(INSTANCE, "rb").read()).hex()


def test_get_verifications_newest_first_and_paged(direct_vm, direct_deploy):
    f = _deploy(direct_deploy)
    assert f.get_verifications(0, 10) == []
    ids = [c * 32 for c in "abc"]
    addrs = [f.create_verification(i, URL, "gpt-4o", TIER) for i in ids]
    page = f.get_verifications(0, 10)
    assert [v["verification_id"] for v in page] == ids[::-1]
    assert [v["instance"] for v in page] == addrs[::-1]
    first = page[-1]
    assert (first["agent_url"], first["claimed_model"], first["claimed_tier"]) == (URL, "gpt-4o", TIER)
    assert first["requester"].startswith("0x") and "created_at" in first
    assert [v["verification_id"] for v in f.get_verifications(1, 1)] == [ids[1]]
    assert [v["verification_id"] for v in f.get_verifications(2, 5)] == [ids[0]]
    assert f.get_verifications(3, 5) == [] and f.get_verifications(9, 5) == []
    assert f.get_verifications(0, 0) == []
    with direct_vm.expect_revert("must not be negative"):
        f.get_verifications(-1, 5)


def test_get_verifications_page_is_capped(direct_deploy):
    f = _deploy(direct_deploy)
    for n in range(52):
        f.create_verification(f"{n:032x}", URL, "m", TIER)
    assert len(f.get_verifications(0, 1000)) == 50
    assert len(f.get_verifications(50, 1000)) == 2
