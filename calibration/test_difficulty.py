"""Difficulty per template, outside the chain: the measurement behind the 100-probe table.

For every template of the contract, PER_TEMPLATE probes (default 100) from the REAL generator,
each with its own seed derived from a new salt, sent once to agent-a and once to agent-b through
the presets, and graded with the contract's own grade(). The report gives passes per template
and model; calibration/verdict_math.py --measured turns them into the verdict error rates.
Reference thresholds per template (scaled from 50 probes): A >= 98 % and B <= 14 %.

The published record, calibration/difficulty-v2.jsonl, also holds two templates that were
measured once and discarded (swaps, rooms); they are not in the contract.

A probe whose request fails (502 after the preset's own retries) is sent again, up to 2 more
times; if it still fails it counts as ERROR, never as PASS or FAIL, and is reported.

Not part of the normal suite. With the presets running (presets/server.mjs), in PowerShell:

    $env:PRESET_BASE_URL = "<preset server URL>"
    $env:LITMUS_DIFFICULTY = "1"
    py -3.12 -m pytest calibration/test_difficulty.py -q -s -p no:cacheprovider

Every run draws a new salt (DIFFICULTY_SALT=<salt> repeats one). Record:
calibration/difficulty-<salt>.jsonl, one line per probe and agent.
"""

import hashlib
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import pytest

HERE = os.path.dirname(__file__)
INSTANCE = os.path.abspath(os.path.join(HERE, "..", "contracts", "VerificationInstance.py"))
BASE = os.environ.get("PRESET_BASE_URL", "").rstrip("/")
SALT = os.environ.get("DIFFICULTY_SALT") or secrets.token_hex(8)
PER_TEMPLATE = int(os.environ.get("DIFFICULTY_PER_TEMPLATE", "100"))
AGENTS = ("agent-a", "agent-b")
# Reference thresholds, scaled from 50 probes (A >= 49, B <= 7): with 100, A >= 98 and B <= 14.
A_MIN = PER_TEMPLATE - PER_TEMPLATE // 50
B_MAX = 7 * PER_TEMPLATE // 50
BATCH = 5    # probes per POST (a verification sends 9; the preset accepts up to 10)
WORKERS = 3  # POSTs in flight per agent (15 model calls; both providers held 27 in the burst test)
# Which templates to measure (comma list; default: every template of the contract).
ONLY = [t for t in os.environ.get("DIFFICULTY_TEMPLATES", "").split(",") if t]
RESENDS = 2

pytestmark = pytest.mark.skipif(not (BASE and os.environ.get("LITMUS_DIFFICULTY") == "1"),
                                reason="set PRESET_BASE_URL and LITMUS_DIFFICULTY=1")


def _post(agent: str, probes: list) -> dict:
    body = json.dumps({"verification_id": f"difficulty-{SALT}",
                       "probes": [{"id": p["id"], "prompt": p["prompt"]} for p in probes]}).encode()
    for attempt in range(1 + RESENDS):
        req = urllib.request.Request(f"{BASE}/{agent}", data=body, method="POST",
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                reasons = json.loads(r.headers.get("X-Preset-Retry-Reasons") or "[]")
                finish = json.loads(r.headers.get("X-Preset-Finish-Reasons") or "[]")
                final = json.loads(r.headers.get("X-Preset-Final-Found") or "[]")
                answers = {a["id"]: a["answer"] for a in json.loads(r.read())["answers"]}
                meta = {p["id"]: (finish[i] if i < len(finish) else None, final[i] if i < len(final) else None)
                        for i, p in enumerate(probes)}
                return {"status": 200, "answers": answers, "retry_reasons": reasons, "attempts": attempt + 1,
                        "meta": meta}
        except urllib.error.HTTPError as e:
            last = {"status": e.code, "body": e.read().decode("utf-8", "replace")[:1000]}
        except Exception as e:  # connection failures of the operator's network
            last = {"status": 0, "body": f"{type(e).__name__}: {e}"}
        time.sleep(5)
    return {**last, "answers": {}, "retry_reasons": [], "attempts": 1 + RESENDS, "meta": {}}


def test_difficulty(direct_deploy):
    direct_deploy(INSTANCE, "difficulty", "https://difficulty.invalid/agent", "m", "t",
                  "0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222")
    mod = sys.modules["_contract_VerificationInstance"]
    names = tuple(ONLY or mod.TEMPLATES_V2)
    probes = []
    for name in names:
        for i in range(PER_TEMPLATE):
            seed = hashlib.sha256(f"{SALT}|{name}|{i}".encode()).hexdigest()
            p = mod.generate_template(name, mod._Rng(seed))[0]
            probes.append({**p, "id": f"{name}-{i}", "seed": seed})

    out_path = os.path.join(HERE, f"difficulty-{SALT}.jsonl")
    rows = []
    started = time.time()
    for agent in AGENTS:
        batches = [probes[k:k + BATCH] for k in range(0, len(probes), BATCH)]
        with ThreadPoolExecutor(WORKERS) as pool:
            results = list(pool.map(lambda b: (b, _post(agent, b)), batches))
        for batch, res in results:
            for k, p in enumerate(batch):
                ans = res["answers"].get(p["id"])
                outcome = mod.grade(p, ans) if res["status"] == 200 else "ERROR"
                rows.append({"salt": SALT, "agent": agent, "template": p["template"], "id": p["id"],
                             "seed": p["seed"], "expected": p["expected"], "answer": ans,
                             "finish_reason": res.get("meta", {}).get(p["id"], (None, None))[0],
                             "final_found": res.get("meta", {}).get(p["id"], (None, None))[1],
                             "outcome": outcome, "status": res["status"],
                             "error": res.get("body"), "attempts": res["attempts"],
                             # reasons belong to the request: recorded once, on its first probe
                             "retry_reasons": res["retry_reasons"] if k == 0 else []})
    with open(out_path, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")

    print(f"\n==> difficulty salt {SALT}, {PER_TEMPLATE} probes per template, "
          f"{time.time() - started:.0f} s, record {os.path.basename(out_path)}")
    print(f"  {'template':<12} {'A PASS':>8} {'B PASS':>8} {'A err':>6} {'B err':>6}   A>={A_MIN}  B<={B_MAX}")
    inside = True
    for name in names:
        a = [r for r in rows if r["agent"] == "agent-a" and r["template"] == name]
        b = [r for r in rows if r["agent"] == "agent-b" and r["template"] == name]
        ap, bp = sum(r["outcome"] == "PASS" for r in a), sum(r["outcome"] == "PASS" for r in b)
        ae, be = sum(r["outcome"] == "ERROR" for r in a), sum(r["outcome"] == "ERROR" for r in b)
        a_ok, b_ok = ap >= A_MIN, bp <= B_MAX
        inside = inside and a_ok and b_ok and ae == 0 and be == 0
        print(f"  {name:<12} {ap:>5}/{len(a):<2} {bp:>5}/{len(b):<2} {ae:>6} {be:>6}   "
              f"{'ok' if a_ok else 'NO':>6}  {'ok' if b_ok else 'NO':>6}")
    # A's misses, to read them before blaming the template or the model.
    for r in rows:
        if r["agent"] == "agent-a" and r["outcome"] != "PASS":
            print(f"  A miss {r['id']}: expected {r['expected']!r} answered {str(r['answer'])[:80]!r} "
                  f"status {r['status']} finish {r.get('finish_reason')} FINAL {r.get('final_found')} {r['error'] or ''}")
    # Replies without a FINAL line, split by why the reply ended (token cap or not).
    for agent in AGENTS:
        mine = [r for r in rows if r["agent"] == agent and r["status"] == 200]
        no_final = [r for r in mine if r.get("final_found") is False]
        by_finish = {}
        for r in no_final:
            by_finish[r.get("finish_reason")] = by_finish.get(r.get("finish_reason"), 0) + 1
        print(f"  {agent}: replies without FINAL {len(no_final)}/{len(mine)}, by finish_reason {by_finish}")
    reasons = [m for r in rows for m in r["retry_reasons"]]
    print(f"  429 / 5xx rescued by the preset's retries: {len(reasons)}")
    for m in sorted(set(reasons))[:5]:
        print(f"    {m[:300]}")
    print(f"\n==> ALL {len(names)} TEMPLATES INSIDE THE THRESHOLD: {'YES' if inside else 'NO'}")
