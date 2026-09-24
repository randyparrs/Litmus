"""Probe set v2: the generator of the contract, checked template by template.

- Fixture: on a fixed set of seeds the generator produces exactly what is recorded in
  tests/fixtures/probe_set_v2.json (prompt, expected answer and tries per template, plus whole
  verifications). The file was written from this contract and checked against an independent
  implementation on 500 seeds per template before it was recorded. A change to any template breaks
  this test; a new probe set version rewrites the file on purpose:
      $env:LITMUS_WRITE_PROBE_FIXTURE = "1"; py -3.12 -m pytest tests/test_probe_set_v2.py -q -p no:cacheprovider -k fixture
- Edge cases: "half" only over even numbers, "more"/"fewer" by the real direction in delta,
  and a regeneration loop with a fixed cap and a guaranteed exit.
- Name pool ASCII only; name templates leave at least 4 plausible candidates.
- Normalization (audit finding M-02): one test per case.

The seed-sweeping checks run on 100 seeds by default and on 500 with the "slow" marker (see
pytest.ini).
"""

import json
import os
import re
import sys

import pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
INSTANCE = os.path.join(ROOT, "contracts", "VerificationInstance.py")
FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "probe_set_v2.json")
FIXTURE_SEEDS = 25
FIXTURE_VERIFICATIONS = 10
URL = "https://agent.example.com/agent"
ADDR = "0x1111111111111111111111111111111111111111"

TEMPLATES = ("ledger", "schedule", "attribution", "ordering", "delta")  # pool of configuration C1
NAME_TEMPLATES = ("attribution", "ordering")
SEED_COUNTS = [pytest.param(100, id="100-seeds"), pytest.param(500, id="500-seeds", marks=pytest.mark.slow)]


@pytest.fixture
def mod(direct_deploy):
    direct_deploy(INSTANCE, "v", URL, "m", "t", ADDR, ADDR)
    return sys.modules["_contract_VerificationInstance"]


def seed(mod, i: int) -> str:
    """keccak256("probe-set-v2-prototype-<i>"), the fixed seeds of the fixture."""
    h = mod.gl.Keccak256()
    h.update(f"probe-set-v2-prototype-{i}".encode())
    return h.digest().hex()


def _all(mod, name, n):
    return [mod.generate_template(name, mod._Rng(seed(mod, i))) for i in range(n)]


# ---------------------------------------------------------------------------------------
# The recorded generator output
# ---------------------------------------------------------------------------------------

def _snapshot(mod) -> dict:
    templates = {}
    for name in TEMPLATES:
        rows = []
        for i in range(FIXTURE_SEEDS):
            probe, tries, _ = mod.generate_template(name, mod._Rng(seed(mod, i)))
            rows.append({"seed_index": i, "seed": seed(mod, i), "prompt": probe["prompt"],
                         "expected": probe["expected"], "tries": tries})
        templates[name] = rows
    verifications = [{"seed": seed(mod, i), "probes": mod.generate_probes(seed(mod, i))}
                     for i in range(FIXTURE_VERIFICATIONS)]
    return {"seed_rule": 'keccak256("probe-set-v2-prototype-<i>")', "templates": templates,
            "verifications": verifications}


def test_generator_matches_recorded_fixture(mod):
    current = _snapshot(mod)
    if os.environ.get("LITMUS_WRITE_PROBE_FIXTURE") == "1":
        os.makedirs(os.path.dirname(FIXTURE), exist_ok=True)
        with open(FIXTURE, "w", encoding="utf-8", newline="\n") as f:
            json.dump(current, f, indent=1, ensure_ascii=True)
            f.write("\n")
    with open(FIXTURE, encoding="utf-8") as f:
        recorded = json.load(f)
    for name in TEMPLATES:
        assert current["templates"][name] == recorded["templates"][name], name
    assert current["verifications"] == recorded["verifications"]


def test_nine_probes_per_verification_with_a_balanced_choice(mod):
    assert tuple(mod.TEMPLATES_V2) == TEMPLATES and mod.PROBES_TOTAL == 9
    twice = {t: 0 for t in TEMPLATES}
    for i in range(100):
        names = [p["template"] for p in mod.generate_probes(seed(mod, i))]
        assert len(names) == 9 and set(names) == set(TEMPLATES)
        assert sorted(names.count(t) for t in TEMPLATES) == [1, 2, 2, 2, 2]
        for t in TEMPLATES:
            twice[t] += names.count(t) == 2
    assert all(v > 0 for v in twice.values())  # every template gets its second probe sometimes


@pytest.mark.parametrize("passed,verdict", [(9, "CONSISTENT"), (8, "CONSISTENT"), (7, "CONSISTENT"),
                                            (6, "INCONCLUSIVE"), (5, "INCONCLUSIVE"), (4, "INCONSISTENT"),
                                            (1, "INCONSISTENT"), (0, "INCONSISTENT")])
def test_verdict_rule_of_configuration_c1(mod, passed, verdict):
    outcomes = ["PASS"] * passed + ["FAIL"] * (9 - passed)
    assert mod.derive_verdict(outcomes)[0] == verdict
    assert mod.derive_verdict(outcomes[:8] + ["ERROR"]) == ("INCONCLUSIVE", "AGENT_ERROR")


# ---------------------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------------------

@pytest.mark.parametrize("n", SEED_COUNTS)
def test_half_is_only_taken_of_even_numbers(mod, n):
    halved = [v for _, _, raw in _all(mod, "ledger", n) for v in raw["facts"]["halved"]]
    assert halved, "no ledger probe used 'half': the test would prove nothing"
    assert all(v % 2 == 0 for v in halved)


@pytest.mark.parametrize("n", SEED_COUNTS)
def test_delta_says_fewer_when_the_total_of_the_two_items_went_down(mod, n):
    words = set()
    for probe, _, raw in _all(mod, "delta", n):
        f = raw["facts"]
        assert f["word"] == ("more" if f["after"] > f["before"] else "fewer")
        assert f" {f['word']} " in probe["prompt"]
        assert int(probe["expected"]) == abs(f["after"] - f["before"]) > 0
        words.add(f["word"])
    assert words == {"more", "fewer"}


@pytest.mark.parametrize("n", SEED_COUNTS)
def test_ordering_names_the_winner_and_never_lists_the_chain_in_order(mod, n):
    for probe, _, raw in _all(mod, "ordering", n):
        order = raw["facts"]["order"]
        assert sorted(order) == list(range(7))
        assert order != sorted(order) and order != sorted(order, reverse=True)
        assert f"{raw['people'][0]} won the race." in probe["prompt"]
        assert probe["expected"] in (raw["people"][2], raw["people"][3])


@pytest.mark.parametrize("n", SEED_COUNTS)
@pytest.mark.parametrize("name", TEMPLATES)
def test_no_count_of_one_with_a_plural_noun(mod, name, n):
    for probe, _, _ in _all(mod, name, n):
        assert not re.findall(r"(?<![-\w])(?:1|one) [a-z]+s\b", probe["prompt"]), probe["prompt"]


def test_regeneration_has_a_fixed_cap_and_always_exits(mod):
    calls = []

    def always_naive(rng):
        calls.append(1)
        rng.randint(0, 1)
        return {"prompt": "x", "expected": "7", "naive": {"7"}}

    out, tries = mod._guarded(mod._Rng(seed(mod, 0)), always_naive)
    assert tries == mod.MAX_TRIES == 32
    assert len(calls) == mod.MAX_TRIES
    assert out["expected"] == "7"  # the exit returns the last candidate, never loops forever


@pytest.mark.parametrize("n", SEED_COUNTS)
@pytest.mark.parametrize("name", TEMPLATES)
def test_expected_answer_is_never_a_naive_one(mod, name, n):
    for probe, tries, raw in _all(mod, name, n):
        assert tries < mod.MAX_TRIES
        assert probe["expected"] not in raw["naive"]


# ---------------------------------------------------------------------------------------
# Names
# ---------------------------------------------------------------------------------------

def test_name_pool_is_plain_ascii(mod):
    assert len(set(mod.NAMES)) == len(mod.NAMES) >= 40
    for n in mod.NAMES:
        assert n.isascii() and n.isalpha() and n[0].isupper() and n[1:].islower()


@pytest.mark.parametrize("n", SEED_COUNTS)
@pytest.mark.parametrize("name", NAME_TEMPLATES)
def test_name_templates_leave_at_least_four_plausible_candidates(mod, name, n):
    for probe, _, raw in _all(mod, name, n):
        people = raw["people"]
        assert 7 <= len(people) <= 8
        plausible = [p for p in people if p not in raw["naive"]]
        assert probe["expected"] in plausible
        assert len(plausible) >= 4


# ---------------------------------------------------------------------------------------
# Normalization, one case per test
# ---------------------------------------------------------------------------------------

INT = {"kind": "int", "expected": "-12"}
POS = {"kind": "int", "expected": "1234"}
NAME = {"kind": "name", "expected": "Katya"}
TIME = {"kind": "time", "expected": "09:05"}

CASES = [
    ("int plain", INT, "-12", "PASS"),
    ("int unicode minus U+2212", INT, "\u221212", "PASS"),
    ("int hyphen U+2010", INT, "\u201012", "PASS"),
    ("int non-breaking hyphen U+2011", INT, "\u201112", "PASS"),
    ("int figure dash U+2012", INT, "\u201212", "PASS"),
    ("int en dash U+2013", INT, "\u201312", "PASS"),
    ("int em dash U+2014", INT, "\u201412", "PASS"),
    ("int horizontal bar U+2015", INT, "\u201512", "PASS"),
    ("int leading plus", POS, "+1234", "PASS"),
    ("int no-break space U+00A0 as separator", POS, "1\u00a0234", "PASS"),
    ("int thin space U+2009 as separator", POS, "1\u2009234", "PASS"),
    ("int narrow no-break space U+202F as separator", POS, "1\u202f234", "PASS"),
    ("int comma separator", POS, "1,234", "PASS"),
    ("int surrounding no-break spaces", POS, "\u00a01234\u00a0", "PASS"),
    ("int final period", POS, "1234.", "PASS"),
    ("int typographic quotes", POS, "\u201c1234\u201d", "PASS"),
    ("int wrong value", POS, "1235", "FAIL"),
    ("int prose", POS, "The answer is 1234", "FAIL"),
    ("name lower case", NAME, "katya", "PASS"),
    ("name upper case", NAME, "KATYA", "PASS"),
    ("name straight quotes", NAME, '"Katya"', "PASS"),
    ("name typographic double quotes", NAME, "\u201cKatya\u201d", "PASS"),
    ("name typographic single quotes", NAME, "\u2018Katya\u2019", "PASS"),
    ("name backticks", NAME, "`Katya`", "PASS"),
    ("name final period", NAME, "Katya.", "PASS"),
    ("name final exclamation", NAME, "Katya!", "PASS"),
    ("name quotes and period", NAME, "\u201cKatya.\u201d", "PASS"),
    ("name other person", NAME, "Hana", "FAIL"),
    ("name prose", NAME, "It was Katya", "FAIL"),
    ("time plain", TIME, "09:05", "PASS"),
    ("time without leading zero", TIME, "9:05", "PASS"),
    ("time final period", TIME, "09:05.", "PASS"),
    ("time quotes", TIME, '"09:05"', "PASS"),
    ("time no-break spaces around", TIME, "\u00a009:05\u00a0", "PASS"),
    ("time wrong", TIME, "09:50", "FAIL"),
    ("time with am/pm", TIME, "9:05 am", "FAIL"),
]


@pytest.mark.parametrize("label,probe,answer,outcome", CASES, ids=[c[0] for c in CASES])
def test_normalization(mod, label, probe, answer, outcome):
    assert mod.grade(probe, answer) == outcome


def test_non_string_answer_is_error(mod):
    assert mod.grade(INT, None) == "ERROR"
    assert mod.grade(NAME, 12) == "ERROR"
