import json
import os
import sys

INSTANCE = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "contracts", "VerificationInstance.py"))

VID = "0123456789abcdef0123456789abcdef"
URL = "https://agent.example.com/agent"
REQUESTER = "0x1111111111111111111111111111111111111111"
FACTORY = "0x2222222222222222222222222222222222222222"
RUN_AT = "2026-09-23T10:00:00.000000Z"


def _deploy(direct_vm, direct_deploy, vid=VID, at=RUN_AT):
    # In direct mode gl.message.raw is fixed when the contract loads, so the datetime that run()
    # reads is set before deploying (warp after the deploy does not reach gl.message.raw).
    direct_vm.warp(at)
    return direct_deploy(INSTANCE, vid, URL, "gpt-4o", "advanced-reasoning", REQUESTER, FACTORY)


def _module():
    return sys.modules["_contract_VerificationInstance"]


def _probes(direct_vm, vid=VID, at=RUN_AT):
    """The probes run() will generate, computed the way anyone can after the transaction."""
    mod = _module()
    return mod.generate_probes(mod.derive_seed(bytes(direct_vm._contract_address), vid, at))


def _answers(probes, correct):
    """Agent response where the first `correct` probes are right and the rest wrong."""
    out = []
    for i, p in enumerate(probes):
        out.append({"id": p["id"], "answer": p["expected"] if i < correct else "zzz-wrong"})
    return json.dumps({"answers": out})


def _mock_agent(direct_vm, body, status=200):
    direct_vm.mock_web(r".*agent\.example\.com.*", {"method": "POST", "status": status, "body": body})


def test_constructor_state(direct_vm, direct_deploy):
    c = _deploy(direct_vm, direct_deploy)
    assert c.get_status() == "CREATED"
    cert = json.loads(c.get_certificate())
    assert cert["verification_id"] == VID
    assert cert["agent_url"] == URL
    assert cert["claimed_tier"] == "advanced-reasoning"
    assert cert["probe_set_version"] == "2"
    assert cert["seed"] == ""  # no seed before run()
    assert cert["verdict_rule"].startswith("9 probes: CONSISTENT if at least 7 pass")
    assert "verdict" not in cert


def test_no_probes_exist_before_run(direct_vm, direct_deploy):
    c = _deploy(direct_vm, direct_deploy)
    assert c.get_probes() == []


def test_seed_comes_from_the_run_datetime_and_is_recorded(direct_vm, direct_deploy):
    c = _deploy(direct_vm, direct_deploy)
    _mock_agent(direct_vm, _answers(_probes(direct_vm), 9))
    cert = c.run()
    mod = _module()
    assert cert["verified_at"] == RUN_AT
    assert cert["seed"] == mod.derive_seed(bytes(direct_vm._contract_address), VID, RUN_AT)
    assert cert["seed_scheme"] == "keccak256(instance_address || verification_id || verified_at)"
    assert "new run() transaction" in cert["seed_note"] and "new probes" in cert["seed_note"]
    assert [p["prompt"] for p in cert["probes"]] == [p["prompt"] for p in _probes(direct_vm)]
    assert [p["prompt"] for p in c.get_probes()] == [p["prompt"] for p in cert["probes"]]


def test_another_run_datetime_gives_other_probes(direct_vm, direct_deploy):
    """Same instance address and id, another run() datetime: other probes (a new run() after a
    failed consensus does not repeat them)."""
    _deploy(direct_vm, direct_deploy)
    a = _probes(direct_vm, at=RUN_AT)
    b = _probes(direct_vm, at="2026-09-23T10:00:07.000000Z")
    assert [p["prompt"] for p in a] != [p["prompt"] for p in b]


def test_nine_probes_with_a_balanced_choice_of_templates(direct_vm, direct_deploy):
    _deploy(direct_vm, direct_deploy)
    probes = _probes(direct_vm)
    assert [p["id"] for p in probes] == [f"p{i}" for i in range(1, 10)]
    counts = {}
    for p in probes:
        counts[p["template"]] = counts.get(p["template"], 0) + 1
    # the 5 templates of the pool once each, plus 4 of them a second time
    assert sorted(counts) == sorted(_module().TEMPLATES_V2)
    assert sorted(counts.values()) == [1, 2, 2, 2, 2]
    for p in probes:
        assert p["prompt"] and p["expected"] != "" and p["kind"] in ("int", "time", "name")


def test_all_correct_is_consistent_and_single_use(direct_vm, direct_deploy):
    c = _deploy(direct_vm, direct_deploy)
    _mock_agent(direct_vm, _answers(_probes(direct_vm), 9))
    cert = c.run()
    assert cert["verdict"] == "CONSISTENT"
    assert cert["reason_code"] == "ENOUGH_PASSED"
    assert cert["probes_passed"] == 9 and cert["probes_total"] == 9
    assert [p["outcome"] for p in cert["probes"]] == ["PASS"] * 9
    assert c.get_status() == "COMPLETED"
    assert json.loads(c.get_certificate())["verdict"] == "CONSISTENT"
    with direct_vm.expect_revert("already verified"):
        c.run()


def test_seven_correct_is_consistent(direct_vm, direct_deploy):
    c = _deploy(direct_vm, direct_deploy)
    _mock_agent(direct_vm, _answers(_probes(direct_vm), 7))
    cert = c.run()
    assert cert["verdict"] == "CONSISTENT" and cert["reason_code"] == "ENOUGH_PASSED"
    assert cert["probes_passed"] == 7


def test_four_correct_is_inconsistent(direct_vm, direct_deploy):
    c = _deploy(direct_vm, direct_deploy)
    _mock_agent(direct_vm, _answers(_probes(direct_vm), 4))
    cert = c.run()
    assert cert["verdict"] == "INCONSISTENT"
    assert cert["reason_code"] == "TOO_FEW_PASSED"
    assert cert["probes_passed"] == 4


def test_zero_correct_is_inconsistent(direct_vm, direct_deploy):
    c = _deploy(direct_vm, direct_deploy)
    _mock_agent(direct_vm, _answers(_probes(direct_vm), 0))
    assert c.run()["verdict"] == "INCONSISTENT"


def test_six_correct_is_borderline_inconclusive(direct_vm, direct_deploy):
    c = _deploy(direct_vm, direct_deploy)
    _mock_agent(direct_vm, _answers(_probes(direct_vm), 6))
    cert = c.run()
    assert cert["verdict"] == "INCONCLUSIVE"
    assert cert["reason_code"] == "BORDERLINE"


def test_five_correct_is_borderline_inconclusive(direct_vm, direct_deploy):
    c = _deploy(direct_vm, direct_deploy)
    _mock_agent(direct_vm, _answers(_probes(direct_vm), 5))
    cert = c.run()
    assert cert["verdict"] == "INCONCLUSIVE"
    assert cert["reason_code"] == "BORDERLINE"


def test_http_error_is_agent_error(direct_vm, direct_deploy):
    c = _deploy(direct_vm, direct_deploy)
    _mock_agent(direct_vm, '{"error": "upstream"}', status=502)
    cert = c.run()
    assert cert["verdict"] == "INCONCLUSIVE"
    assert cert["reason_code"] == "AGENT_ERROR"
    assert cert["agent_error_detail"] == "http 502"
    assert [p["outcome"] for p in cert["probes"]] == ["ERROR"] * 9


def test_invalid_json_is_agent_error(direct_vm, direct_deploy):
    c = _deploy(direct_vm, direct_deploy)
    _mock_agent(direct_vm, "this is not json")
    cert = c.run()
    assert cert["reason_code"] == "AGENT_ERROR"
    assert "JSONDecodeError" in cert["agent_error_detail"]


def test_missing_answer_is_agent_error(direct_vm, direct_deploy):
    c = _deploy(direct_vm, direct_deploy)
    probes = _probes(direct_vm)
    partial = json.dumps({"answers": [{"id": probes[0]["id"], "answer": probes[0]["expected"]}]})
    _mock_agent(direct_vm, partial)
    cert = c.run()
    assert cert["verdict"] == "INCONCLUSIVE"
    assert cert["agent_error_detail"] == "missing or non-string answer"


def test_oversized_body_is_truncated_and_rejected(direct_vm, direct_deploy):
    c = _deploy(direct_vm, direct_deploy)
    probes = _probes(direct_vm)
    padded = json.dumps({"answers": [{"id": p["id"], "answer": p["expected"]} for p in probes], "pad": "x" * 70000})
    _mock_agent(direct_vm, padded)
    assert c.run()["reason_code"] == "AGENT_ERROR"


def test_answer_normalization_end_to_end(direct_vm, direct_deploy):
    """Formatting passes, prose does not. The case-by-case normalization tests are in
    test_probe_set_v2.py."""
    c = _deploy(direct_vm, direct_deploy)
    probes = _probes(direct_vm)
    p1, p2, p3 = probes[:3]
    body = json.dumps({"answers": [
        {"id": "p1", "answer": f'  \u201c{p1["expected"].upper()}.\u201d '},  # typographic quotes, period
        {"id": "p2", "answer": f"`{p2['expected']}`"},                      # backticks
        {"id": "p3", "answer": f"The answer is {p3['expected']}"},           # prose is NOT accepted
    ] + [{"id": p["id"], "answer": p["expected"]} for p in probes[3:]]})
    _mock_agent(direct_vm, body)
    cert = c.run()
    assert [p["outcome"] for p in cert["probes"]][:3] == ["PASS", "PASS", "FAIL"]
    assert cert["probes_passed"] == 8


def test_validator_agrees_on_same_verdict_with_different_answers(direct_vm, direct_deploy):
    c = _deploy(direct_vm, direct_deploy)
    probes = _probes(direct_vm)
    _mock_agent(direct_vm, _answers(probes, 0))
    c.run()
    direct_vm.clear_mocks()
    other_wrong = json.dumps({"answers": [{"id": p["id"], "answer": "different wrong"} for p in probes]})
    _mock_agent(direct_vm, other_wrong)
    assert direct_vm.run_validator() is True


def test_validator_disagrees_on_different_verdict(direct_vm, direct_deploy):
    c = _deploy(direct_vm, direct_deploy)
    probes = _probes(direct_vm)
    _mock_agent(direct_vm, _answers(probes, 9))
    c.run()
    direct_vm.clear_mocks()
    _mock_agent(direct_vm, _answers(probes, 6))
    assert direct_vm.run_validator() is False


def test_missing_transaction_datetime_fails(direct_vm, direct_deploy):
    """No datetime, no instance: the seed and the certificate dates must never come from ""."""
    with direct_vm.expect_revert("the transaction has no datetime"):
        _deploy(direct_vm, direct_deploy, at="")
