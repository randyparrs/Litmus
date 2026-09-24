"""Agent E, the generic cheap attacker (presets/agent-e.mjs), against the REAL generator of the
contract, template by template.

Agent E was frozen on 2026-09-23, before any template of probe set v2 was written, so the
templates are measured against an attacker that could not be tuned to them. The first test
pins two hashes: the file, and its code with the comment lines removed. The code hash has not
changed since the freeze; the file hash changed once, on 2026-09-24, for a comment-only edit.

Against probe set v1 this exact file scored 3/3 in 8 of 8 verifications (24/24).
"""

import hashlib
import json
import os
import subprocess
import sys

import pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
INSTANCE = os.path.join(ROOT, "contracts", "VerificationInstance.py")
AGENT_E = os.path.join(ROOT, "presets", "agent-e.mjs")
AGENT_E_CLI = os.path.join(ROOT, "presets", "agent-e-cli.mjs")

# The file as published: frozen 2026-09-23 as 7b272a7d...01df, comment lines edited 2026-09-24.
AGENT_E_SHA256 = "5ceaf8452e9503badc12ecf92deb82e76b269641538593a51329f949bef784e1"
# Its code without comment lines: the same value since the freeze on 2026-09-23.
AGENT_E_CODE_SHA256 = "7e050f9357a0f35e1bdca2e63a771fb19b8872f85f2a0b29d3a48c56886ad81f"

# 100 seeds per template by default, 500 with the "slow" marker (pytest.ini).
SEED_COUNTS = [pytest.param(100, id="100-seeds"), pytest.param(500, id="500-seeds", marks=pytest.mark.slow)]
URL = "https://agent.example.com/agent"
ADDR = "0x1111111111111111111111111111111111111111"
TEMPLATES = ("ledger", "schedule", "attribution", "ordering", "delta")  # pool of configuration C1


def agent_e_sha256() -> str:
    """Hash with LF line endings, so a Windows checkout gives the same value."""
    with open(AGENT_E, "rb") as f:
        return hashlib.sha256(f.read().replace(b"\r\n", b"\n")).hexdigest()


def agent_e_code_sha256() -> str:
    """Hash of the code alone: blank lines and whole-line // comments removed."""
    with open(AGENT_E, "rb") as f:
        lines = f.read().decode("utf-8").replace("\r\n", "\n").split("\n")
    code = "\n".join(line for line in lines if line.strip() and not line.strip().startswith("//"))
    return hashlib.sha256(code.encode("utf-8")).hexdigest()


def agent_e(prompts: list) -> list:
    out = subprocess.run(["node", AGENT_E_CLI], input=json.dumps(prompts), capture_output=True,
                         text=True, encoding="utf-8", check=True)
    return json.loads(out.stdout)


def seed(mod, i: int) -> str:
    """keccak256("probe-set-v2-prototype-<i>"), the fixed seeds of the fixture."""
    h = mod.gl.Keccak256()
    h.update(f"probe-set-v2-prototype-{i}".encode())
    return h.digest().hex()


def max_e_hits(n: int) -> int:
    """E may land on an answer by chance now and then, never often: measured at most 5 in 500
    per template. Above 2% (and at least 2) the template has a hole and must be redesigned."""
    return max(2, n // 50)


def test_agent_e_is_frozen():
    assert agent_e_code_sha256() == AGENT_E_CODE_SHA256
    assert agent_e_sha256() == AGENT_E_SHA256


@pytest.mark.parametrize("n", SEED_COUNTS)
@pytest.mark.parametrize("name", TEMPLATES)
def test_agent_e_against_each_template(direct_deploy, name, n):
    direct_deploy(INSTANCE, "v", URL, "m", "t", ADDR, ADDR)
    mod = sys.modules["_contract_VerificationInstance"]
    probes = [mod.generate_template(name, mod._Rng(seed(mod, i)))[0] for i in range(n)]
    answers = agent_e([p["prompt"] for p in probes])
    hits = sum(1 for p, a in zip(probes, answers) if mod.grade(p, a) == "PASS")
    print(f"\n{name}: Agent E {hits}/{n}")
    assert hits <= max_e_hits(n)
