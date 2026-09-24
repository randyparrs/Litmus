"""Verdict as a statistical test (a deliberate decision, 2026-09-24): which probe count, verdict
thresholds and template pool meet the target error rates. Calculation only, no network.

Per-template rates are the measured ones (the 50-probe measurement of 2026-09-24, counts below;
Agent E: 500 seeds per template against the contract generator). Every target is checked with the
UPPER bound of the 95% Clopper-Pearson interval in the unfavourable direction (A's failure rate,
B's and E's pass rates), per template.

Targets per verification:
  A (strong):  P(INCONSISTENT) < 0.1 %   and   P(CONSISTENT) >= 97 %
  B (weak):    P(CONSISTENT)  < 1 %
  E (no model): P(CONSISTENT) ~ 0

Template selection per verification, balanced: with a pool of m templates and k probes, every
template appears floor(k/m) times and the remaining k mod m probes go to distinct templates chosen
at random (so with m >= k all k are distinct). Probes of the same template are treated as
independent draws at that template's rate.

Freeze run: for each configuration, the acceptance rule is chosen so that it passes with at least
90 % probability if the true rates are the measured (point) ones.

    py -3.12 calibration/verdict_math.py
"""

import itertools
import math

N_AB = 50
# 50-probe measurement, passes out of 50 (2026-09-24)
A_PASS = {"ledger": 48, "correction": 50, "schedule": 50, "attribution": 50, "quantities": 50,
          "ordering": 46, "exclusion": 45, "delta": 50}
B_PASS = {"ledger": 7, "correction": 25, "schedule": 8, "attribution": 18, "quantities": 26,
          "ordering": 9, "exclusion": 20, "delta": 10}
N_E = 500
# Agent E against the contract generator, 500 seeds per template
E_PASS = {"ledger": 4, "correction": 2, "schedule": 1, "attribution": 0, "quantities": 0,
          "ordering": 0, "exclusion": 0, "delta": 0, "swaps": 0, "rooms": 0}
# Per-template sample size for A and B (None: N_AB for every template). Set by load_measured().
N_BY = None


def binom_cdf(x, n, p):
    return sum(math.comb(n, i) * p ** i * (1 - p) ** (n - i) for i in range(x + 1))


def cp_upper(x, n, alpha=0.05):
    """Upper end of the two-sided (1 - alpha) Clopper-Pearson interval for x successes of n."""
    if x >= n:
        return 1.0
    lo, hi = x / n, 1.0
    for _ in range(80):
        mid = (lo + hi) / 2
        if binom_cdf(x, n, mid) > alpha / 2:
            lo = mid
        else:
            hi = mid
    return hi


def rates(pool, which):
    """Per-template pass probability: point estimate and the unfavourable 95 % bound."""
    out = {}
    for t in pool:
        n = N_BY[which][t] if N_BY and which in N_BY else N_AB
        if which == "A":
            fails = n - A_PASS[t]
            out[t] = (A_PASS[t] / n, 1 - cp_upper(fails, n))  # bound: A passes LESS
        elif which == "B":
            out[t] = (B_PASS[t] / n, cp_upper(B_PASS[t], n))  # bound: B passes MORE
        else:
            out[t] = (E_PASS[t] / N_E, cp_upper(E_PASS[t], N_E))
    return out


def selections(pool, k):
    """All balanced selections (multisets of templates) with their probabilities."""
    m = len(pool)
    base, extra = divmod(k, m)
    combos = list(itertools.combinations(pool, extra)) if extra else [()]
    for extra_set in combos:
        sel = [t for t in pool for _ in range(base)] + list(extra_set)
        yield sel, 1 / len(combos)


def pass_count_dist(sel, p):
    """Poisson-binomial distribution of passes for one selection."""
    dist = [1.0]
    for t in sel:
        q = p[t]
        new = [0.0] * (len(dist) + 1)
        for i, v in enumerate(dist):
            new[i] += v * (1 - q)
            new[i + 1] += v * q
        dist = new
    return dist


def verdict_probs(pool, k, c, d, p):
    """P(CONSISTENT: passes >= c), P(INCONSISTENT: passes <= d), P(INCONCLUSIVE)."""
    pc = pi = 0.0
    for sel, w in selections(pool, k):
        dist = pass_count_dist(sel, p)
        pc += w * sum(dist[c:])
        pi += w * sum(dist[: d + 1])
    return pc, pi, 1 - pc - pi


def evaluate(pool, k, c, d):
    ra, rb, re = rates(pool, "A"), rates(pool, "B"), rates(pool, "E")
    res = {}
    for name, r in (("A", ra), ("B", rb), ("E", re)):
        res[name + "_point"] = verdict_probs(pool, k, c, d, {t: v[0] for t, v in r.items()})
        res[name + "_bound"] = verdict_probs(pool, k, c, d, {t: v[1] for t, v in r.items()})
    ok = (res["A_bound"][1] < 0.001 and res["A_bound"][0] >= 0.97
          and res["B_bound"][0] < 0.01 and res["E_bound"][0] < 1e-4)
    return res, ok


def freeze_rule(res, rounds=16):
    """Smallest allowances so the freeze run passes with >= 90 % at the POINT rates.
    Rule: A never INCONSISTENT and CONSISTENT in at least rounds - a; B never CONSISTENT and
    INCONCLUSIVE in at most b; E never CONSISTENT."""
    a_c, a_i, _ = res["A_point"]
    b_c, _, b_n = res["B_point"]
    e_c = res["E_point"][0]

    def p_at_most(j, n, q):  # P(at most j "bad" of n) with bad prob q
        return sum(math.comb(n, i) * q ** i * (1 - q) ** (n - i) for i in range(j + 1))

    best = None
    for a_allow in range(rounds + 1):
        for b_allow in range(rounds + 1):
            # A: all rounds not INCONSISTENT, at most a_allow INCONCLUSIVE
            p_a = (1 - a_i) ** rounds * p_at_most(a_allow, rounds, (1 - a_c - a_i) / (1 - a_i) if a_i < 1 else 1)
            # B: no CONSISTENT, at most b_allow INCONCLUSIVE
            p_b = (1 - b_c) ** rounds * p_at_most(b_allow, rounds, b_n / (1 - b_c) if b_c < 1 else 1)
            p_e = (1 - e_c) ** rounds
            p = p_a * p_b * p_e
            if p >= 0.90 and (best is None or a_allow + b_allow < best[0] + best[1]):
                best = (a_allow, b_allow, p)
        if best:
            break
    return best


POOLS = {
    "P8 (all 8)": list(A_PASS),
    "P5 (no correction, quantities, exclusion)": ["ledger", "schedule", "attribution", "ordering", "delta"],
    "P4 (P5 without attribution)": ["ledger", "schedule", "ordering", "delta"],
}
CONFIGS = [(5, 4, 2), (5, 5, 2), (7, 6, 3), (7, 5, 3), (7, 6, 4), (9, 8, 4), (9, 7, 4)]


def pct(x):
    return f"{100 * x:.3f}%" if x < 0.01 else f"{100 * x:.1f}%"


def with_sample_size(n):
    """Same measured proportions, as if each template had been measured n times per model."""
    global N_AB, A_PASS, B_PASS
    saved = (N_AB, dict(A_PASS), dict(B_PASS))
    N_AB = n
    A_PASS = {t: round(v * n / 50) for t, v in saved[1].items()}
    B_PASS = {t: round(v * n / 50) for t, v in saved[2].items()}
    return saved


def restore(saved):
    global N_AB, A_PASS, B_PASS
    N_AB, A_PASS, B_PASS = saved[0], saved[1], saved[2]


def load_measured(path):
    """Counts per template from a difficulty record (calibration/difficulty-<salt>.jsonl). A probe
    that ended in ERROR is left out of the sample (it is neither a pass nor a fail)."""
    import json
    global A_PASS, B_PASS, N_BY
    A_PASS, B_PASS, N_BY = {}, {}, {"A": {}, "B": {}}
    for line in open(path, encoding="utf-8"):
        r = json.loads(line)
        if r["outcome"] == "ERROR":
            continue
        which = "A" if r["agent"] == "agent-a" else "B"
        passes = A_PASS if which == "A" else B_PASS
        passes[r["template"]] = passes.get(r["template"], 0) + (r["outcome"] == "PASS")
        N_BY[which][r["template"]] = N_BY[which].get(r["template"], 0) + 1


def measured_report(path, base_pool, new_templates, k=9, c=7, d=4):
    load_measured(path)
    print(f"Measured: {path}")
    for t in list(base_pool) + list(new_templates):
        print(f"  {t:<12} A {A_PASS[t]}/{N_BY['A'][t]}   B {B_PASS[t]}/{N_BY['B'][t]}   E {E_PASS.get(t, '?')}/{N_E}")
    # New templates join only if they pass E and the per-template thresholds at the first try
    # (a deliberate decision, 2026-09-24): A >= 98 % and B <= 14 % of the probes, E <= 2 %.
    joined = []
    for t in new_templates:
        na, nb = N_BY["A"][t], N_BY["B"][t]
        ok = (A_PASS[t] >= na - na // 50 and B_PASS[t] <= 7 * nb // 50 and E_PASS.get(t, N_E) <= N_E // 50)
        print(f"  new {t}: {'JOINS' if ok else 'dropped'}")
        if ok:
            joined.append(t)
    pools = {"final (C1 + new ones that join)": list(base_pool) + joined}
    c2 = [t for t in base_pool if t != "attribution"]
    pools["C2 (fallback)"] = c2
    print(f"\nRule: {k} probes, CONSISTENT >= {c}, INCONSISTENT <= {d}, INCONCLUSIVE {d + 1}..{c - 1}")
    for name, pool in pools.items():
        res, ok = evaluate(pool, k, c, d)
        rule = freeze_rule(res)
        print(f"  {name}: {pool}")
        print(f"    bound: A cons {pct(res['A_bound'][0])}  A incons {pct(res['A_bound'][1])}  "
              f"B cons {pct(res['B_bound'][0])}  E cons {pct(res['E_bound'][0])}  -> {'MEETS' if ok else 'DOES NOT MEET'}")
        print(f"    point: A cons {pct(res['A_point'][0])}  B cons {pct(res['B_point'][0])}  B inconcl {pct(res['B_point'][2])}")
        if rule:
            print(f"    16-round freeze (>= 90 % at the measured rates): A never INCONSISTENT and at most "
                  f"{rule[0]} INCONCLUSIVE; B never CONSISTENT and at most {rule[1]} INCONCLUSIVE; "
                  f"E never CONSISTENT -> P = {rule[2]:.2f}")


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 2 and sys.argv[1] == "--measured":
        measured_report(sys.argv[2], ["ledger", "schedule", "attribution", "ordering", "delta"], ["swaps", "rooms"])
        sys.exit(0)
    print("Rates per template (point / unfavourable 95% bound), 50 probes per model:")
    for t in A_PASS:
        a, b, e = rates([t], "A")[t], rates([t], "B")[t], rates([t], "E")[t]
        print(f"  {t:<12} A passes {a[0]:.2f} / {a[1]:.3f}   B passes {b[0]:.2f} / {b[1]:.3f}   E passes {e[0]:.3f} / {e[1]:.4f}")
    print()
    print(f"{'pool':<44} {'k':>2} {'CONS>=':>6} {'INC<=':>5} | point: {'A cons':>7} {'A inc':>7} {'B cons':>7} "
          f"| meets the targets with the bound with n probes per template: {'n=50':>5} {'n=100':>6} {'n=200':>6} {'n=300':>6} "
          f"| 16-round freeze (point)")
    for pool_name, pool in POOLS.items():
        for k, c, d in CONFIGS:
            res, _ = evaluate(pool, k, c, d)
            meets = []
            for n in (50, 100, 200, 300):
                saved = with_sample_size(n)
                meets.append(evaluate(pool, k, c, d)[1])
                restore(saved)
            rule = freeze_rule(res)
            rule_s = f"A inconcl<={rule[0]}, B inconcl<={rule[1]}, P={rule[2]:.2f}" if rule else "no rule reaches 90%"
            print(f"{pool_name:<44} {k:>2} {c:>6} {d:>5} | point: {pct(res['A_point'][0]):>7} {pct(res['A_point'][1]):>7} "
                  f"{pct(res['B_point'][0]):>7} | {'':>52} " + " ".join(f"{('YES' if m else 'no'):>6}" for m in meets)
                  + f" | {rule_s}")
        print()
