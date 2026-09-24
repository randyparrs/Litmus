"""Probability of passing the freeze rule with GenLayer-style consensus (2026-09-24), using the
REAL variation between passes measured in the failed freeze attempt 1
(calibration/results-v2-freeze1.jsonl). Calculation only, no network.

Per round (6 passes: leader = pass 1, validators = passes 2-6):
  - verdict of the round = the verdict shared by at least 4 of the 6 passes (strict majority;
    on-chain: 3 of the 5 committee votes agree with the leader);
  - rotation = the leader's verdict is shared by 3 or fewer passes;
  - tie = no verdict with 4 of 6.

Rule "final" (default; docs/ARCHITECTURE.md, Calibration). Hard criteria, the only ones that decide:
A never INCONSISTENT, B never CONSISTENT, E never CONSISTENT; in a tie the round violates them when
the forbidden verdict is one of the tied ones (3 of 6). Sanity caps, reported: INCONCLUSIVE,
rotations and ties, at most 4 in 16 each per agent. The decision to run uses M1.

Rule "s30" (`--rule s30`, the earlier proposal, reproduces that calculation): A majority CONSISTENT in
16/16; B never CONSISTENT and at most 1 INCONCLUSIVE; E never CONSISTENT; at most 2 rotations in
16 per agent; a tie is a failed round. The decision used the LOWEST of the three models.

Model: every probe instance of attempt 1 (round, probe id) has 6 graded passes, k of them PASS.
A new round draws the contract's balanced selection (the 5 templates once + 4 distinct ones a
second time) and, per slot, one instance of that template; its per-pass pass rate p comes from:
  M1  plug-in: p = k/6 of the drawn instance (pure resampling of what was measured);
  M2  beta-binomial per template fitted by maximum likelihood on the k's of that template
      (p ~ Beta, 6 independent passes);
  M3  stress: M2's dispersion with the mean replaced by the 100-probe difficulty rate
      (calibration/difficulty-v2.jsonl), which is lower than attempt 1 for A.

    py -3.12 calibration/freeze_prob.py [--rule s30]
"""

import json
import math
import os
import sys
import types

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RECORD = os.path.join(HERE, "results-v2-freeze1.jsonl")
TEMPLATES = ["ledger", "schedule", "attribution", "ordering", "delta"]
KIND = {"ledger": "int", "delta": "int", "schedule": "time", "attribution": "name", "ordering": "name"}
# 100-probe difficulty (calibration/difficulty-v2.jsonl), passes out of 100
DIFFICULTY = {
    "agent-a": {"ledger": 100, "schedule": 100, "attribution": 99, "ordering": 89, "delta": 96},
    "agent-b": {"ledger": 26, "schedule": 7, "attribution": 26, "ordering": 19, "delta": 21},
}
PASSES, VALIDATORS, ROUNDS, MAX_ROT = 6, 5, 16, 2
SANITY_CAP = 4   # final rule: INCONCLUSIVE, rotations and ties, each at most 4 in 16 per agent
N_SIM = 400_000
CONS, INCO, INCS, NOMAJ = 0, 1, 2, 3   # CONSISTENT, INCONCLUSIVE, INCONSISTENT, no majority


def _load_contract():
    """grade() and derive_verdict() from the contract itself, with genlayer stubbed out."""
    class _Any:
        def __getattr__(self, name):
            return _Any()

        def __call__(self, *a, **k):
            return a[0] if len(a) == 1 and callable(a[0]) and not k else _Any()

        def __getitem__(self, key):
            return _Any()

        def __mro_entries__(self, bases):
            return (object,)

    stub = types.ModuleType("genlayer")
    stub.__getattr__ = lambda name: _Any()
    sys.modules["genlayer"] = stub
    ns = {"__name__": "contract"}
    with open(os.path.join(ROOT, "contracts", "VerificationInstance.py"), encoding="utf-8") as f:
        exec(compile(f.read(), "VerificationInstance.py", "exec"), ns)
    return ns


C = _load_contract()
VERDICT_CODE = {C["CONSISTENT"]: CONS, C["INCONCLUSIVE"]: INCO, C["INCONSISTENT"]: INCS}


def load_instances():
    """Per agent: list of (template, k) and a reproduction check against the record."""
    rows = [json.loads(l) for l in open(RECORD, encoding="utf-8")]
    inst = {"agent-a": [], "agent-b": [], "agent-e": []}
    mismatches = 0
    for r in rows:
        if r["agent"] not in inst:
            continue
        per_pass = []
        for answers in r["answers_per_pass"]:
            outs = [C["grade"]({"kind": KIND[p["template"]], "expected": p["expected"]}, answers.get(pid))
                    for pid, p in r["probes"].items()]
            per_pass.append(outs)
        verdicts = [C["derive_verdict"](o)[0] for o in per_pass]
        if (per_pass[0].count(C["PASS"]) != r["probes_passed"] or verdicts[0] != r["verdict"]
                or [v == verdicts[0] for v in verdicts[1:]] != r["validator_agrees"]):
            mismatches += 1
        for j, (pid, p) in enumerate(r["probes"].items()):
            k = sum(1 for o in per_pass if o[j] == C["PASS"])
            inst[r["agent"]].append((p["template"], k))
    return inst, mismatches, rows


def _bb_loglik(ks, mu, s):
    a, b = mu * s, (1 - mu) * s
    lb = math.lgamma(a) + math.lgamma(b) - math.lgamma(a + b)
    return sum(math.lgamma(k + a) + math.lgamma(PASSES - k + b) - math.lgamma(PASSES + a + b) - lb for k in ks)


def fit_bb(ks):
    """Beta-binomial MLE on a grid. Returns (mu, s), or None when every k is 0 or every k is 6."""
    if all(k == PASSES for k in ks) or all(k == 0 for k in ks):
        return None
    best = None
    for mu in np.linspace(0.002, 0.998, 499):
        for s in np.exp(np.linspace(math.log(0.02), math.log(2000), 120)):
            ll = _bb_loglik(ks, mu, s)
            if best is None or ll > best[0]:
                best = (ll, mu, s)
    return best[1], best[2]


def samplers(agent, inst):
    """Per model: template -> function(rng, n) returning n per-pass pass rates."""
    by_t = {t: np.array([k for tt, k in inst[agent] if tt == t]) for t in TEMPLATES}
    fits = {t: fit_bb(list(by_t[t])) for t in TEMPLATES}
    pooled = fit_bb([k for t in TEMPLATES for k in by_t[t]])
    out = {"M1": {}, "M2": {}, "M3": {}}
    for t in TEMPLATES:
        ks = by_t[t]
        out["M1"][t] = (lambda ks: lambda rng, n: rng.choice(ks, n) / PASSES)(ks)
        f = fits[t]
        if f is None:
            const = float(ks[0]) / PASSES
            out["M2"][t] = (lambda c: lambda rng, n: np.full(n, c))(const)
        else:
            out["M2"][t] = (lambda mu, s: lambda rng, n: rng.beta(mu * s, (1 - mu) * s, n))(*f)
        s3 = (f or pooled or (None, 50.0))[1]
        mu3 = min(max(DIFFICULTY[agent][t] / 100, 1e-4), 1 - 1e-4)
        out["M3"][t] = (lambda mu, s: lambda rng, n: rng.beta(mu * s, (1 - mu) * s, n))(mu3, s3)
    return out, by_t, fits, pooled


def simulate_round(rng, sampler):
    """Per simulated round: majority verdict code and rotation flag, vectorised over N_SIM."""
    n = N_SIM
    p = np.empty((n, 9))
    # balanced selection: every template once + 4 distinct ones again (one template appears once)
    single = rng.integers(0, 5, n)
    for ti, t in enumerate(TEMPLATES):
        p[:, ti] = sampler[t](rng, n)
    extra = np.empty((n, 4))
    for ti, t in enumerate(TEMPLATES):
        draws = sampler[t](rng, n)
        mask = single != ti
        # the 4 extra slots in template order, skipping the single one
        col = np.where(mask, ti - (single < ti).astype(int), -1)
        for c in range(4):
            sel = col == c
            extra[sel, c] = draws[sel]
    p[:, 5:] = extra
    passes = rng.random((n, PASSES, 9)) < p[:, None, :]
    counts = passes.sum(axis=2)                                   # (n, 6) probes passed per pass
    v = np.where(counts >= C["CONSISTENT_MIN"], CONS, np.where(counts <= C["INCONSISTENT_MAX"], INCS, INCO))
    tallies = np.stack([(v == code).sum(axis=1) for code in (CONS, INCO, INCS)], axis=1)
    maj = np.full(n, NOMAJ)
    for code in (CONS, INCO, INCS):
        maj = np.where(tallies[:, code] >= 4, code, maj)
    leader_share = np.take_along_axis(tallies, v[:, :1], axis=1)[:, 0]
    rotation = leader_share <= 3
    strict = (v == v[:, :1]).all(axis=1)
    return maj, rotation, strict, tallies


def freeze_probability(agent, maj, rot, strict):
    """Exact 16-round probability by dynamic programming over (rotations, inconclusives)."""
    ok_cons = maj == CONS
    ok_b = maj == INCS
    inc_b = maj == INCO
    if agent == "agent-a":
        cats = {(0, 0): np.mean(ok_cons & ~rot), (1, 0): np.mean(ok_cons & rot)}
        max_inc = 0
    else:
        cats = {(0, 0): np.mean(ok_b & ~rot), (1, 0): np.mean(ok_b & rot),
                (0, 1): np.mean(inc_b & ~rot), (1, 1): np.mean(inc_b & rot)}
        max_inc = 1
    dp = {(0, 0): 1.0}
    for _ in range(ROUNDS):
        nxt = {}
        for (r, i), pr in dp.items():
            for (dr, di), pc in cats.items():
                key = (r + dr, i + di)
                if key[0] <= MAX_ROT and key[1] <= max_inc:
                    nxt[key] = nxt.get(key, 0.0) + pr * pc
        dp = nxt
    old_rule_ok = (ok_cons if agent == "agent-a" else (ok_b | inc_b)) & strict
    old = np.mean(old_rule_ok) ** ROUNDS if agent == "agent-a" else None
    per_round = {"CONS": np.mean(maj == CONS), "INCO": np.mean(maj == INCO), "INCS": np.mean(maj == INCS),
                 "no majority": np.mean(maj == NOMAJ), "rotation": np.mean(rot), "not 6/6": np.mean(~strict)}
    return sum(dp.values()), per_round, old


def old_rule_b(maj, strict):
    """Old criterion for B: never CONSISTENT, at most 1 INCONCLUSIVE, 6/6 in every round."""
    clean = np.mean((maj == INCS) & strict)
    inc = np.mean((maj == INCO) & strict)
    return clean ** ROUNDS + ROUNDS * inc * clean ** (ROUNDS - 1)


def final_probability(agent, maj, rot, tallies):
    """Final rule (docs/ARCHITECTURE.md, Calibration). Hard criterion per round: A never INCONSISTENT,
    B never CONSISTENT; in a tie (no verdict with 4 of 6) the round violates it when the
    forbidden verdict is one of the tied ones (3 of 6 passes: it could win after a rotation).
    Sanity caps, at most SANITY_CAP in 16 each: INCONCLUSIVE, rotations, ties.
    Returns (P(hard and caps), P(hard alone), per-round rates)."""
    forbidden = INCS if agent == "agent-a" else CONS
    tie = maj == NOMAJ
    viol = (maj == forbidden) | (tie & (tallies[:, forbidden] >= 3))
    inc = maj == INCO
    ok = ~viol
    cats = {}
    for di in (0, 1):
        for dr in (0, 1):
            for dt in (0, 1):
                m = ok & (inc == bool(di)) & (rot == bool(dr)) & (tie == bool(dt))
                pc = float(np.mean(m))
                if pc > 0:
                    cats[(di, dr, dt)] = pc
    dp = {(0, 0, 0): 1.0}
    for _ in range(ROUNDS):
        nxt = {}
        for key, pr in dp.items():
            for d, pc in cats.items():
                k = tuple(a + b for a, b in zip(key, d))
                if max(k) <= SANITY_CAP:
                    nxt[k] = nxt.get(k, 0.0) + pr * pc
        dp = nxt
    hard = float(np.mean(ok)) ** ROUNDS
    per_round = {"violation": np.mean(viol), "CONS": np.mean(maj == CONS), "INCO": np.mean(inc),
                 "INCS": np.mean(maj == INCS), "tie": np.mean(tie), "rotation": np.mean(rot)}
    return sum(dp.values()), hard, per_round


def main():
    rule = "s30" if "--rule" in sys.argv and sys.argv[sys.argv.index("--rule") + 1] == "s30" else "final"
    print(f"rule: {rule}")
    inst, mismatches, rows = load_instances()
    print(f"record: {RECORD}")
    print(f"reproduction check against the record (verdict, leader passes, validator agreement): "
          f"{mismatches} mismatches in {sum(1 for r in rows if r['agent'] in inst)} rows")
    e_max = max(r["probes_passed"] for r in rows if r["agent"] == "agent-e")
    print(f"agent-e: max {e_max}/9 in attempt 1, 0 variation between passes -> P(E never CONSISTENT) ~ 1")
    rng = np.random.default_rng(20260924)
    result = {}
    for agent in ("agent-a", "agent-b"):
        s, by_t, fits, pooled = samplers(agent, inst)
        print(f"\n== {agent}")
        for t in TEMPLATES:
            ks = by_t[t]
            f = fits[t]
            mixed = int(((ks > 0) & (ks < PASSES)).sum())
            fit_txt = "degenerate (no variation)" if f is None else f"mu {f[0]:.3f} s {f[1]:.2f}"
            print(f"  {t:12s} instances {len(ks):3d}  mean k/6 {ks.mean() / PASSES:.3f}  "
                  f"mixed {mixed:2d}  M2 {fit_txt}  difficulty {DIFFICULTY[agent][t]}/100")
        result[agent] = {}
        for model in ("M1", "M2", "M3"):
            maj, rot, strict, tallies = simulate_round(rng, s[model])
            if rule == "s30":
                prob, per_round, old = freeze_probability(agent, maj, rot, strict)
                if agent == "agent-b":
                    old = old_rule_b(maj, strict)
                extra = f"   old 6/6 rule {old:.4f}"
            else:
                prob, hard, per_round = final_probability(agent, maj, rot, tallies)
                extra = f"   (hard criterion alone {hard:.4f})"
            result[agent][model] = prob
            pr = "  ".join(f"{k} {v:.4f}" for k, v in per_round.items())
            print(f"  {model}: P(freeze rule) = {prob:.4f}{extra}")
            print(f"      per round: {pr}")
    print("\n== joint (A and B; E ~ 1)")
    joint = {m: result["agent-a"][m] * result["agent-b"][m] for m in ("M1", "M2", "M3")}
    for m, v in joint.items():
        print(f"  {m}: {v:.4f}")
    low = min(joint.values())
    print(f"  LOWEST: {low:.4f}   M1 (the one that decides under the final rule): {joint['M1']:.4f}")
    decide = joint["M1"] if rule == "final" else low
    print(f"  -> {'RUN (>= 0.90)' if decide >= 0.90 else 'DO NOT RUN (< 0.90)'}")


if __name__ == "__main__":
    main()
