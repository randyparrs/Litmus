"""Freeze run of probe set v2, configuration C1, against the live preset agents.

Runs the REAL VerificationInstance code in gltest direct mode: probe generation, the POST to
the agent, grading and verdict are exactly what the contract does on chain. Web requests are
not mocked: they go live to the preset agents through gltest's live web handler
(`direct_vm._live_web_handler`, the fallback gltest uses in glsim mode; a private attribute).

Every verification is executed 6 times, like on chain: 1 leader (`run()`) + 5 validators
(`run_validator()`, which repeats the POST and compares the verdict with the leader's).

Configuration C1 (a deliberate decision, 2026-09-24): pool of 5 templates, 9 probes per
verification, CONSISTENT if >= 7 pass, INCONSISTENT if <= 4, otherwise INCONCLUSIVE. The verdict
is a statistical test with target error rates, checked with calibration/verdict_math.py on the
100-probe measurement (docs/ARCHITECTURE.md, Verdict).

Agents:
  agent-a   advanced model (Llama 3.3 70B, CoreWeave fp16)
  agent-b   small model (Llama 3.2 3B, Cloudflare)
  agent-e   the cheap attacker, no model (presets/agent-e.mjs, frozen)
  CHECK     a strong model of another family (default agent-c, DeepSeek V4 Flash). NOT a
            criterion: when A and the check model give the SAME wrong answer to a probe, the
            wording is reviewed before freezing.
Same probes for everyone: in every round all agents answer the same verification (same instance
address, verification id and run() datetime, so the same seed).

Consensus as on GenLayer (docs/ARCHITECTURE.md, Calibration). The verdict of every
pass is recomputed from its raw reply exactly as observe() does, and checked against the leader's
certificate and the validators' agreement. Per round:
  majority  = the verdict shared by at least 4 of the 6 passes (on-chain: 3 of the 5 committee
              votes agree with the leader);
  rotation  = the leader's verdict is shared by 3 passes or fewer (the leader is rotated);
  tie       = no verdict with 4 of 6.
Hard criteria, the ONLY ones that decide the freeze (P = 0.976 with the variation between passes
measured in attempt 1, calibration/freeze_prob.py, model M1):
  A. agent-a never INCONSISTENT.
  B. agent-b never CONSISTENT.
  E. agent-e never CONSISTENT.
  In a tie the round violates them when the forbidden verdict is one of the tied ones (3 of 6).
Reported with a sanity cap of 4 in 16 per agent (over the cap: the freeze waits for a manual
review): INCONCLUSIVE, rotations, ties.
Reported only: latency, network (HTTP status of every pass), 6/6 agreement, answers of A across
passes, rescued 429/5xx, replies without a FINAL line, and the ambiguity check (probes where A and
the check model agree on the same wrong answer).
The run is valid only with the 16 rounds complete for A, B and E and every per-pass verdict
reproducing the contract.

Not part of the normal test suite (it hits the network and uses model quota). With the presets
running locally (presets/server.mjs), in PowerShell:

    $env:PRESET_BASE_URL = "<preset server URL>"
    py -3.12 -m pytest calibration/test_calibration.py -q -s -p no:cacheprovider > calibration\\out.txt 2>&1

Every run draws a new random salt (printed in the report and saved in plan.json and in every
result row); $env:CALIBRATION_SALT repeats one. $env:CALIBRATION_ROUNDS changes the 16 rounds.
Results: calibration/results.jsonl (one line per round and agent), calibration/plan.json.
"""

import hashlib
import json
import os
import secrets
import statistics
import sys
import time
import urllib.error
import urllib.request

import pytest

HERE = os.path.dirname(__file__)
INSTANCE = os.path.abspath(os.path.join(HERE, "..", "contracts", "VerificationInstance.py"))
RESULTS = os.environ.get("CALIBRATION_RESULTS") or os.path.join(HERE, "results.jsonl")
PLAN_FILE = os.path.join(HERE, "plan.json")
BASE = os.environ.get("PRESET_BASE_URL", "").rstrip("/")
ROUNDS = int(os.environ.get("CALIBRATION_ROUNDS", "16"))
SPACING_S = float(os.environ.get("CALIBRATION_SPACING_S", "20"))
CHECK_AGENT = os.environ.get("CALIBRATION_CHECK_AGENT", "agent-c")
SALT = os.environ.get("CALIBRATION_SALT") or secrets.token_hex(8)
_last_start = [0.0]
AGENTS = ("agent-a", "agent-b", "agent-e", CHECK_AGENT)
NO_MODEL = ("agent-e",)
CUT_AGENTS = ("agent-a", "agent-b", "agent-e")
VALIDATORS = 5
LATENCY_MEDIAN_MAX_S = 20.0
LATENCY_ANY_MAX_S = 40.0
SANITY_CAP = 4    # INCONCLUSIVE, rotations and ties: each at most 4 in 16 per agent
MAJORITY = 4      # of 6 passes
FORBIDDEN = {"agent-a": "INCONSISTENT", "agent-b": "CONSISTENT", "agent-e": "CONSISTENT"}
REQUESTER = "0x1111111111111111111111111111111111111111"
FACTORY = "0x2222222222222222222222222222222222222222"

pytestmark = pytest.mark.skipif(not BASE, reason="PRESET_BASE_URL not set")

_plan_cache = []


def _plan(direct_vm, direct_deploy) -> list:
    """One (verification_id, run datetime) per round, from the salt. The template choice is
    balanced inside every verification (the contract picks the 5 templates once plus 4 more)."""
    if _plan_cache:
        return _plan_cache
    direct_deploy(INSTANCE, "plan", "https://plan.invalid/agent", "m", "t", REQUESTER, FACTORY)
    mod = sys.modules["_contract_VerificationInstance"]
    address = bytes(direct_vm._contract_address)
    for r in range(ROUNDS):
        at = f"2026-09-24T{r // 60:02d}:{r % 60:02d}:00.000000Z"
        vid = hashlib.sha256(f"{SALT}|{r}".encode()).hexdigest()[:32]
        probes = mod.generate_probes(mod.derive_seed(address, vid, at))
        _plan_cache.append({"round": r, "verification_id": vid, "run_at": at,
                            "templates": [p["template"] for p in probes]})
    with open(PLAN_FILE, "w", encoding="utf-8") as f:
        json.dump({"salt": SALT, "rounds": _plan_cache}, f, indent=1)
    return _plan_cache


class _Recorder:
    """Live web handler that performs the real request and records latency + response."""

    def __init__(self):
        self.calls = []

    def __call__(self, data):
        url = data.get("url", "")
        body = data.get("body")
        headers = {k: (v.decode() if isinstance(v, bytes) else v) for k, v in (data.get("headers") or {}).items()}
        req = urllib.request.Request(url, data=body if body else None, method=data.get("method", "GET"), headers=headers)
        t0 = time.time()
        meta = {}
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                status, raw = r.status, r.read()
                for key, header in (("providers", "X-Preset-Providers"), ("retry_reasons", "X-Preset-Retry-Reasons"),
                                    ("finish_reasons", "X-Preset-Finish-Reasons"), ("final_found", "X-Preset-Final-Found")):
                    value = r.headers.get(header)
                    meta[key] = json.loads(value) if value else None
                meta["retries"] = int(r.headers.get("X-Preset-Retries") or 0)
        except urllib.error.HTTPError as e:
            status, raw = e.code, e.read()
        self.calls.append({
            "seconds": round(time.time() - t0, 2), "status": status, "raw": raw,
            # the contract reads at most 64 KB of the body: keep the same, so 9 answers fit
            "body": raw.decode("utf-8", "replace")[:64 * 1024],
            "providers": meta.get("providers"), "retries": meta.get("retries", 0),
            "retry_reasons": meta.get("retry_reasons") or [], "finish_reasons": meta.get("finish_reasons") or [],
            "final_found": meta.get("final_found") or [],
        })
        return {"ok": {"response": {"status": status, "headers": {}, "body": raw}}}


def _answers_of(call):
    try:
        return {a["id"]: a["answer"] for a in json.loads(call["body"])["answers"]}
    except Exception:
        return {"_raw": call["body"][:200]}


def _pass_verdict(mod, probes, call) -> str:
    """The verdict one pass reaches, from its raw reply, exactly as observe() computes it."""
    answers = {}
    try:
        if call["status"] != 200:
            return mod.INCONCLUSIVE
        data = json.loads((call["raw"] or b"")[:mod.MAX_BODY_BYTES].decode("utf-8"))
        for item in data.get("answers", []):
            if isinstance(item, dict) and isinstance(item.get("id"), str):
                answers[item["id"]] = item.get("answer")
    except Exception:
        return mod.INCONCLUSIVE
    return mod.derive_verdict([mod.grade(p, answers.get(p["id"])) for p in probes])[0]


def _consensus(pass_verdicts: list) -> dict:
    """Majority (>= 4 of 6), rotation (leader's verdict shared by <= 3 passes) and tie."""
    tally = {v: pass_verdicts.count(v) for v in ("CONSISTENT", "INCONCLUSIVE", "INCONSISTENT")}
    majority = next((v for v, n in tally.items() if n >= MAJORITY), None)
    return {"majority": majority, "rotation": tally.get(pass_verdicts[0], 0) < MAJORITY,
            "tie": majority is None, "tally": tally}


def test_plan(direct_vm, direct_deploy):
    """Runs first (file order). The plan needs the contract loaded, and gltest allows ONE load of
    the contract per test, so the rounds cannot build it themselves."""
    plan = _plan(direct_vm, direct_deploy)
    assert len(plan) == ROUNDS


@pytest.mark.parametrize("agent", AGENTS)
@pytest.mark.parametrize("round_no", range(ROUNDS))
def test_round(direct_vm, direct_deploy, agent, round_no):
    assert _plan_cache, "test_plan must run first"
    step = _plan_cache[round_no]
    if agent not in NO_MODEL:
        wait = _last_start[0] + SPACING_S - time.time()
        if wait > 0:
            time.sleep(wait)
        _last_start[0] = time.time()
    direct_vm.warp(step["run_at"])  # before deploying: direct mode fixes gl.message.raw at load
    c = direct_deploy(INSTANCE, step["verification_id"], f"{BASE}/{agent}", "calibration",
                      "advanced-reasoning", REQUESTER, FACTORY)
    rec = _Recorder()
    direct_vm._live_web_handler = rec

    cert = c.run()                                                     # pass 1: leader
    agrees = [direct_vm.run_validator() for _ in range(VALIDATORS)]    # passes 2-6: validators

    mod = sys.modules["_contract_VerificationInstance"]
    probes = mod.generate_probes(cert["seed"])
    pass_verdicts = [_pass_verdict(mod, probes, c_) for c_ in rec.calls]
    # the recomputation must reproduce the contract: leader's certificate and validators' votes
    reproduced = (len(pass_verdicts) == 1 + VALIDATORS and pass_verdicts[0] == cert["verdict"]
                  and [v == pass_verdicts[0] for v in pass_verdicts[1:]] == agrees)
    cons = _consensus(pass_verdicts) if reproduced else {"majority": None, "rotation": None, "tie": None}

    row = {
        "agent": agent, "round": round_no, "salt": SALT,
        "verification_id": step["verification_id"], "run_at": step["run_at"], "seed": cert["seed"],
        "verdict": cert["verdict"], "reason_code": cert["reason_code"], "detail": cert["agent_error_detail"],
        "probes_passed": cert["probes_passed"], "probes_total": cert["probes_total"],
        # per probe id: the same template can appear twice in a verification
        "probes": {p["id"]: {"template": p["template"], "expected": p["expected"], "answered": p["answer_head"],
                             "outcome": p["outcome"]} for p in cert["probes"]},
        "validator_agrees": agrees, "same_verdict_passes": 1 + sum(agrees),
        "pass_verdicts": pass_verdicts, "pass_verdicts_reproduced": reproduced,
        "majority_verdict": cons["majority"], "rotation": cons["rotation"], "tie": cons["tie"],
        "request_seconds": [c_["seconds"] for c_ in rec.calls],
        "request_status": [c_["status"] for c_ in rec.calls],
        "answers_per_pass": [_answers_of(c_) for c_ in rec.calls],
        "providers_per_pass": [c_["providers"] for c_ in rec.calls],
        "retries_per_pass": [c_["retries"] for c_ in rec.calls],
        "retry_reasons_per_pass": [c_["retry_reasons"] for c_ in rec.calls],
        "finish_reasons_per_pass": [c_["finish_reasons"] for c_ in rec.calls],
        "final_found_per_pass": [c_["final_found"] for c_ in rec.calls],
        "failed_passes": [{"pass": i + 1, "status": c_["status"], "body": c_["body"][:2000]}
                          for i, c_ in enumerate(rec.calls) if c_["status"] != 200],
    }
    with open(RESULTS, "a", encoding="utf-8") as f:
        f.write(json.dumps(row) + "\n")
    assert reproduced, f"per-pass verdicts {pass_verdicts} do not reproduce the contract ({cert['verdict']}, {agrees})"


def test_report():
    """Runs last (file order). Prints the tables, the acceptance rule and the ambiguity check."""
    if not os.path.exists(RESULTS):
        pytest.skip("no results yet")
    rows = [json.loads(line) for line in open(RESULTS, encoding="utf-8")]
    salts = sorted({r.get("salt") for r in rows})
    print(f"\n==> freeze run, salt {salts}  (reproduce with CALIBRATION_SALT=<salt>), {ROUNDS} rounds")
    if len(salts) > 1:
        print("  WARNING: results.jsonl mixes runs with different salts")
    ok = {}

    for agent in AGENTS:
        mine = [r for r in rows if r["agent"] == agent]
        if not mine:
            continue
        role = "ambiguity check, not a criterion" if agent == CHECK_AGENT else "acceptance rule"
        print(f"\n==================== {agent}: {len(mine)} rounds ({role}) ====================")
        verdicts = {v: sum(r["verdict"] == v for r in mine) for v in ("CONSISTENT", "INCONCLUSIVE", "INCONSISTENT")}
        print(f"  verdicts: {verdicts}")
        print("  probes passed per round: " + " ".join(f"{r['probes_passed']}/{r['probes_total']}" for r in mine))
        per_t = {}
        for r in mine:
            for p in r["probes"].values():
                t = per_t.setdefault(p["template"], [0, 0])
                t[0] += p["outcome"] == "PASS"
                t[1] += 1
        print("  per template (leader): " + "  ".join(f"{t} {v[0]}/{v[1]}" for t, v in sorted(per_t.items())))
        print("  same verdict across the 6 passes, per round: " + " ".join(f"{r['same_verdict_passes']}/6" for r in mine))
        lat = [s for r in mine for s in r["request_seconds"]]
        print(f"  latency per request s: median {statistics.median(lat)}  max {max(lat)}  (n={len(lat)})")
        prov = {}
        for r in mine:
            for pp in r.get("providers_per_pass", []):
                for name in (pp or ["<none>"]):
                    prov[name] = prov.get(name, 0) + 1
        print(f"  providers seen (probe calls): {prov}")
        no_final = sum(1 for r in mine for ff in r.get("final_found_per_pass", []) for x in (ff or []) if x is False)
        print(f"  replies without a FINAL line (all passes): {no_final}")
        for r in mine:
            for f in r.get("failed_passes", []):
                print(f"  round {r['round']} pass {f['pass']} http {f['status']}: {f['body'][:400]}")
            for i, reasons in enumerate(r.get("retry_reasons_per_pass", [])):
                for m in reasons:
                    print(f"  round {r['round']} pass {i + 1} retried: {m[:300]}")
        if agent == "agent-a":
            varying = 0
            for r in mine:
                per_probe = {}
                for ans in r["answers_per_pass"]:
                    for pid, a in ans.items():
                        per_probe.setdefault(pid, set()).add(a)
                changed = {pid: sorted(v) for pid, v in per_probe.items() if len(v) > 1}
                if changed:
                    varying += 1
                    print(f"  round {r['round']}: A's answers varied across passes: {json.dumps(changed)[:300]}")
            print(f"  rounds where some answer of A varied across passes: {varying}/{len(mine)}")

        print("  per-pass verdicts (C/I/X = CONSISTENT/INCONCLUSIVE/INCONSISTENT, leader first):")
        for r in mine:
            letter = {"CONSISTENT": "C", "INCONCLUSIVE": "I", "INCONSISTENT": "X"}
            pv = "".join(letter.get(v, "?") for v in r.get("pass_verdicts", []))
            flags = " ROTATION" * bool(r.get("rotation")) + " TIE" * bool(r.get("tie"))
            print(f"    round {r['round']:2d}: {pv}  majority {r.get('majority_verdict')}{flags}")

        if agent not in CUT_AGENTS:
            continue
        forbidden = FORBIDDEN[agent]
        valid = len(mine) == ROUNDS and all(r.get("pass_verdicts_reproduced") for r in mine)
        # a tie violates the hard criterion when the forbidden verdict is one of the tied ones
        violations = [r["round"] for r in mine if r.get("majority_verdict") == forbidden
                      or (r.get("tie") and r.get("pass_verdicts", []).count(forbidden) >= 3)]
        hard = valid and not violations
        counts = {"INCONCLUSIVE (majority)": sum(r.get("majority_verdict") == "INCONCLUSIVE" for r in mine),
                  "rotations": sum(bool(r.get("rotation")) for r in mine),
                  "ties": sum(bool(r.get("tie")) for r in mine)}
        over_cap = [name for name, n in counts.items() if n > SANITY_CAP]
        ok[agent] = {"hard": hard, "valid": valid, "over_cap": over_cap}
        majority = {v: sum(r.get("majority_verdict") == v for r in mine)
                    for v in ("CONSISTENT", "INCONCLUSIVE", "INCONSISTENT", None)}
        print(f"  majority verdicts: {majority}")
        print(f"  VALID RUN (16 rounds, per-pass verdicts reproduce the contract): {'YES' if valid else 'NO'}")
        print(f"  HARD CRITERION: {agent} never {forbidden}: {'PASS' if hard else 'FAIL'}"
              + (f"  (violations in rounds {violations})" if violations else ""))
        for name, n in counts.items():
            print(f"  {name}: {n}/{len(mine)}  (sanity cap {SANITY_CAP}: {'ok' if n <= SANITY_CAP else 'OVER'})")
        print(f"  reported: 6/6 in {sum(r['same_verdict_passes'] == 6 for r in mine)}/{len(mine)} rounds; "
              f"latency median {statistics.median(lat):.2f} s max {max(lat):.2f} s "
              f"(reference: median < {LATENCY_MEDIAN_MAX_S}, max <= {LATENCY_ANY_MAX_S}); "
              f"passes not HTTP 200: {sum(s != 200 for r in mine for s in r['request_status'])}")

    print(f"\n==================== ambiguity check: agent-a vs {CHECK_AGENT} ====================")
    by_key = {(r["agent"], r["round"]): r for r in rows}
    flagged = []
    for rnd in sorted({r["round"] for r in rows}):
        a, k = by_key.get(("agent-a", rnd)), by_key.get((CHECK_AGENT, rnd))
        if not a or not k:
            continue
        for pid, pa in a["probes"].items():
            pk = k["probes"].get(pid, {})
            if pa["outcome"] == "FAIL" or pk.get("outcome") == "FAIL":
                same = (pa["outcome"] == "FAIL" and pk.get("outcome") == "FAIL"
                        and pa["answered"].strip().lower() == pk.get("answered", "").strip().lower())
                print(f"  round {rnd} {pid} {pa['template']:<12} expected {pa['expected']!r}  A {pa['answered'][:40]!r}  "
                      f"{CHECK_AGENT} {pk.get('answered', '')[:40]!r}  -> {'REVIEW THE WORDING' if same else 'differs'}")
                if same:
                    flagged.append((rnd, pid))
    print(f"  probes where both strong models agree on the same wrong answer: {len(flagged)}")

    if all(a in ok for a in CUT_AGENTS):
        freeze = all(o["hard"] for o in ok.values())
        review = [f"{a}: {', '.join(o['over_cap'])} over the cap" for a, o in ok.items() if o["over_cap"]]
        if flagged:
            review.append(f"ambiguity flags: {len(flagged)}")
        print(f"\n==> HARD CRITERIA (A never INCONSISTENT, B and E never CONSISTENT): {'PASS' if freeze else 'FAIL'}")
        if not freeze:
            print("==> FREEZE probe_set_version 2: NO")
        elif review:
            print(f"==> FREEZE probe_set_version 2: YES, WAITING FOR A MANUAL REVIEW OF: {'; '.join(review)}")
        else:
            print("==> FREEZE probe_set_version 2: YES")
