# { "Depends": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng" }

"""VerificationInstance: one behavioral-consistency verification of an AI agent endpoint.

Created by VerifierFactory, one instance per verification. run() sends a fixed-size batch of
parametric probes to the agent in ONE POST, grades every answer in code against a value
computed in code, and derives the verdict from explicit rules. Every validator repeats the
POST independently and agrees when it reaches the same verdict. No LLM judges anything.

The certificate describes how the endpoint answered THIS verification. It does not identify
the model behind the endpoint and is not a permanent guarantee.

Probes are generated with a keccak-based generator (no `random`) from a seed that includes the
datetime of the run() transaction: the probes do not exist before run() is mined, so nobody,
the agent's owner included, can compute them in advance."""

import json
import re

import genlayer as gl

# Probe set v2 (2026-09-23), replacing v1 after finding C-01 of the external audit: the v1
# templates (arithmetic, a repeated rule, box state) were solved by a parser with no model
# behind it, 24 of 24 probes. Frozen as "2" on 2026-09-24 (freeze run, salt c88c03e8c265de47:
# A never INCONSISTENT, B and E never CONSISTENT in 16 rounds, verdict by majority of 6 passes);
# changing any template or its difficulty requires a new version and a new calibration.
PROBE_SET_VERSION = "2"
PROBES_TOTAL = 9
CONSISTENT_MIN = 7    # 7, 8 or 9 of 9 passed
INCONSISTENT_MAX = 4  # 0 to 4 of 9 passed; 5 or 6 is INCONCLUSIVE (BORDERLINE)
VERDICT_RULE = "9 probes: CONSISTENT if at least 7 pass, INCONSISTENT if at most 4 pass, otherwise INCONCLUSIVE"

# How the seed is built, recorded in every certificate.
SEED_SCHEME = "keccak256(instance_address || verification_id || verified_at)"
SEED_NOTE = (
    "The seed depends on the datetime of the run() transaction: the probes do not exist before "
    "run(), and a new run() transaction after a failed consensus uses new probes."
)

MAX_BODY_BYTES = 64 * 1024
ANSWER_HEAD_CHARS = 200

# The transaction datetime, taken from the message in DETERMINISTIC code (never inside the
# nondet block). Measured on Studio Next 2026-09-22 with a probe contract: the value is the
# same for the leader and the validators (two writes ACCEPTED / MAJORITY_AGREE). gl.vm.get_timestamp
# does not exist in this SDK, and neither does gl.message_raw.
def tx_datetime() -> str:
    # The seed and both certificate dates depend on it: without it, fail instead of deriving a
    # seed from an empty string.
    value = gl.message.raw.get("datetime")
    if not value:
        raise gl.vm.UserError("the transaction has no datetime")
    return str(value)


STATUS_CREATED = "CREATED"
STATUS_COMPLETED = "COMPLETED"

CONSISTENT = "CONSISTENT"
INCONSISTENT = "INCONSISTENT"
INCONCLUSIVE = "INCONCLUSIVE"

PASS = "PASS"
FAIL = "FAIL"
ERROR = "ERROR"


class _Rng:
    """Deterministic generator: keccak(seed || counter). Same seed, same sequence, on every
    validator and in every Python version."""

    def __init__(self, seed_hex: str):
        self._seed = bytes.fromhex(seed_hex)
        self._counter = 0

    def randint(self, lo: int, hi: int) -> int:
        h = gl.Keccak256()
        h.update(self._seed)
        h.update(self._counter.to_bytes(8, "big"))
        self._counter += 1
        return lo + int.from_bytes(h.digest()[:8], "big") % (hi - lo + 1)

    def choice(self, seq):
        return seq[self.randint(0, len(seq) - 1)]

    def sample(self, seq, k: int) -> list:
        pool = list(seq)
        return [pool.pop(self.randint(0, len(pool) - 1)) for _ in range(k)]

    def shuffle(self, seq) -> list:
        return self.sample(seq, len(seq))


def derive_seed(instance_address: bytes, verification_id: str, verified_at: str) -> str:
    h = gl.Keccak256()
    h.update(instance_address)
    h.update(verification_id.encode("utf-8"))
    h.update(verified_at.encode("utf-8"))
    return h.digest().hex()


# ---------------------------------------------------------------------------------------
# Probe templates of PROBE_SET_VERSION "2". Their output on a fixed set of seeds is recorded in
# tests/fixtures/probe_set_v2.json; tests/test_probe_set_v2.py checks the generator still
# produces exactly that.
#
# Rules every template follows:
# - Prose, not formulas: the numbers are written in digits or in words, the operations are
#   verbs, and every template carries data that looks usable but does not count.
# - Each template is built to beat the STRATEGY of Agent E (presets/agent-e.mjs, the frozen
#   cheap attacker), not its bugs.
# - One wording, one answer: no sentence may admit two readings.
# - One computation path, no branch that depends on an intermediate decision (v1 lesson).
# - Naive-answer guard: while the expected answer equals a generic one (first, last, sum or
#   maximum of the numbers; first or last name written; the extreme without the filter), the
#   template is generated again with the next counter, up to MAX_TRIES.
# ---------------------------------------------------------------------------------------

MAX_TRIES = 32


# ---------------------------------------------------------------------------------------
# Shared pieces
# ---------------------------------------------------------------------------------------

# Names that are not English words (no "May", "Rose", "Will"), so no name can be misread.
NAMES = (
    "Mara", "Priya", "Dario", "Ines", "Omar", "Lucia", "Teo", "Hana", "Nadia", "Ivan", "Ruth",
    "Kofi", "Leila", "Tomas", "Yuki", "Anika", "Bruno", "Chiara", "Emeka", "Farah", "Goran",
    "Ingrid", "Jonas", "Katya", "Lars", "Mehmet", "Nikos", "Olga", "Paulo", "Rafael", "Sanjay",
    "Talia", "Umar", "Vera", "Wanjiru", "Xavier", "Yara", "Zeynep", "Arjun", "Beatriz",
)

UNITS = ("zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
         "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
         "eighteen", "nineteen")
TENS = ("", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety")


def _words(n: int) -> str:
    if n < 20:
        return UNITS[n]
    return TENS[n // 10] + ("-" + UNITS[n % 10] if n % 10 else "")


def _num(rng: _Rng, n: int) -> str:
    """Half the numbers under 100 are written in words."""
    return _words(n) if n < 100 and rng.randint(0, 1) == 1 else str(n)


_WORD_VALUES = {w: i for i, w in enumerate(UNITS)}
_WORD_VALUES.update({w: 10 * i for i, w in enumerate(TENS) if w})


def _numbers_in(text: str) -> list:
    """Every number written in the prompt, digits and words, in reading order (not clock times)."""
    out = []
    for tok in re.findall(r"\d+:\d{2}|\d+|[a-z]+(?:-[a-z]+)?", text.lower()):
        if ":" in tok:
            continue
        if tok.isdigit():
            out.append(int(tok))
        elif tok in _WORD_VALUES:
            out.append(_WORD_VALUES[tok])
        elif "-" in tok:
            a, b = tok.split("-", 1)
            if a in _WORD_VALUES and b in _WORD_VALUES and _WORD_VALUES[a] >= 20:
                out.append(_WORD_VALUES[a] + _WORD_VALUES[b])
    return out


def _naive_ints(text: str) -> set:
    """Generic answers for an integer probe: first, last, sum and maximum of every number."""
    ns = _numbers_in(text)
    if not ns:
        return set()
    return {str(ns[0]), str(ns[-1]), str(sum(ns)), str(max(ns))}


def _names_in(text: str, candidates) -> list:
    """Candidate names in the order they are first mentioned."""
    found = sorted((text.index(n), n) for n in candidates if n in text)
    return [n for _, n in found]


def _naive_names(text: str, candidates) -> set:
    """First and last name mentioned (last = the one closest to the question)."""
    order = _names_in(text, candidates)
    last = max(candidates, key=lambda n: text.rfind(n))
    return {order[0], last} if order else set()


def _names_after(text: str, candidates, name: str) -> set:
    """For every mention of `name`, the next candidate name written after it."""
    out = set()
    at = text.find(name)
    while at != -1:
        after = [(text.find(c, at + len(name)), c) for c in candidates if c != name]
        after = [(i, c) for i, c in after if i != -1]
        if after:
            out.add(min(after)[1])
        at = text.find(name, at + len(name))
    return out


def _hhmm(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


INT_TAIL = " Respond with only the integer."
NAME_TAIL = " Respond with only the name."
TIME_TAIL = " Respond with only the time, in 24-hour HH:MM format."


# ---------------------------------------------------------------------------------------
# 1. ledger: transfers between people, with offers that never happened and a stale count
# ---------------------------------------------------------------------------------------

LEDGER_ITEMS = ("tokens", "coins", "stamps", "marbles", "tickets", "shells")


def _probe_ledger(rng: _Rng):
    people = rng.sample(NAMES, 3)
    target = people[0]
    item = rng.choice(LEDGER_ITEMS)
    have = {p: rng.randint(12, 60) for p in people}
    start = dict(have)
    lines = []
    # A stale count, half the time for the person asked about.
    stale = target if rng.randint(0, 1) == 1 else rng.choice(people[1:])
    old = rng.randint(5, 80)
    lines.append(f"Last month {stale} had {_num(rng, old)} {item}.")
    for p in rng.shuffle(people):
        lines.append(f"This week {p} starts with {_num(rng, have[p])} {item}.")

    real = []
    halved = []  # values that were halved: always even, so no rounding is ever involved
    for _ in range(3):
        giver = rng.choice([p for p in people if have[p] >= 3])  # can give at least 2
        taker = rng.choice([p for p in people if p != giver])
        if have[giver] % 2 == 0 and rng.randint(0, 2) == 0:
            k = have[giver] // 2
            halved.append(have[giver])
            real.append(f"{giver} gives {taker} half of the {item} {giver} has at that moment.")
        else:
            k = rng.randint(2, min(have[giver] - 1, 25))  # at least 2: 'items' is always plural
            real.append(rng.choice((
                f"{giver} gives {taker} {_num(rng, k)} {item}.",
                f"{giver} hands {_num(rng, k)} {item} to {taker}.",
                f"{taker} receives {_num(rng, k)} {item} from {giver}.",
            )))
        have[giver] -= k
        have[taker] += k

    # Transfers that never happen, written with the same verbs as the real ones. The first one
    # always involves the person asked about, so a keyword ledger gets that person wrong.
    fake = []
    for i in range(2):
        x, y = rng.sample(people, 2)
        if i == 0 and target not in (x, y):
            x = target if rng.randint(0, 1) == 1 else x
            y = target if x != target else y
        k = rng.randint(2, 30)
        fake.append(rng.choice((
            f"{x} offers to give {y} {_num(rng, k)} {item}, but {y} turns the offer down.",
            f"{x} plans to hand {_num(rng, k)} {item} to {y}, then changes plans and keeps them.",
            f"{y} asks {x} to send over {_num(rng, k)} {item}, and {x} refuses.",
        )))
    # Fake events go in random places; real ones keep their order (one computation path).
    events = list(real)
    for f in fake:
        events.insert(rng.randint(0, len(events)), f)
    lines += events
    lines.append(f"No other {item} change hands.")
    lines.append(f"How many {item} does {target} have at the end of the week?" + INT_TAIL)
    prompt = " ".join(lines)
    naive = _naive_ints(prompt) | {str(start[target])} | ({str(old)} if stale == target else set())
    return {"prompt": prompt, "expected": str(have[target]), "naive": naive, "facts": {"halved": halved}}


# ---------------------------------------------------------------------------------------
# 2. schedule: two chains of relative times, only one is asked about
# ---------------------------------------------------------------------------------------

EVENTS = ("the briefing", "the site visit", "the rehearsal", "the review", "the handover",
          "the stand-up", "the workshop", "the demo", "the budget meeting", "the safety drill",
          "the supplier call", "the interview", "the tasting", "the inspection")
HALLS = ("north hall", "south hall", "east wing", "west wing")
DURATIONS = ((10, "ten minutes"), (15, "a quarter of an hour"), (20, "twenty minutes"),
             (25, "25 minutes"), (30, "half an hour"), (35, "35 minutes"), (40, "forty minutes"),
             (45, "three quarters of an hour"), (50, "50 minutes"), (60, "an hour"),
             (90, "an hour and a half"))


def _schedule_chain(rng: _Rng, hall: str, names: list):
    t0 = rng.randint(9 * 4, 16 * 4) * 15  # anchor on a quarter hour, 09:00 to 16:00
    lines = [f"In the {hall}, {names[0]} starts at {_hhmm(t0)}."]
    times = [t0]
    for i in (1, 2):
        d, dtext = rng.choice(DURATIONS)
        sign = rng.choice((1, -1))
        times.append(times[-1] + sign * d)
        lines.append(f"{names[i][0].upper() + names[i][1:]} starts {dtext} "
                     f"{'after' if sign > 0 else 'before'} {names[i - 1]} starts.")
    return lines, times


def _probe_schedule(rng: _Rng):
    halls = rng.sample(HALLS, 2)
    names = rng.sample(EVENTS, 6)
    la, ta = _schedule_chain(rng, halls[0], names[:3])
    lb, tb = _schedule_chain(rng, halls[1], names[3:])
    moved = rng.randint(0, 1) == 1
    shift = 0
    lines = la + lb
    ask_chain = rng.randint(0, 1)
    ask_times, ask_names, ask_hall = (ta, names[:3], halls[0]) if ask_chain == 0 else (tb, names[3:], halls[1])
    ask = rng.randint(1, 2)
    if moved:
        d, dtext = rng.choice(DURATIONS)
        shift = rng.choice((1, -1)) * d
        lines.append(f"Afterwards, {ask_names[ask]} is rescheduled to start {dtext} "
                     f"{'later' if shift > 0 else 'earlier'} than planned.")
    expected = ask_times[ask] + shift
    lines.append(f"At what time does {ask_names[ask]} in the {ask_hall} start?" + TIME_TAIL)
    prompt = " ".join(lines)
    # Generic answers: every clock time written, and the first anchor moved by all offsets.
    first = ta[0]
    all_offsets = first + (ta[2] - ta[0]) + (tb[2] - tb[0]) + shift
    naive = {_hhmm(ta[0]), _hhmm(tb[0]), _hhmm(all_offsets)}
    if moved:
        naive.add(_hhmm(ask_times[ask]))  # the move ignored
    return {"prompt": prompt, "expected": _hhmm(expected), "naive": naive}


# ---------------------------------------------------------------------------------------
# 3. attribution: filter by one attribute, then take the minimum or maximum of another
# ---------------------------------------------------------------------------------------

REVISIONS = ("never revised it", "revised it once", "revised it twice", "revised it three times",
             "revised it four times")
FILTERS = (
    ("at least twice", lambda r: r >= 2),
    ("at least three times", lambda r: r >= 3),
    ("at most once", lambda r: r <= 1),
    ("exactly once", lambda r: r == 1),
)


def _probe_attribution(rng: _Rng):
    n = rng.randint(7, 8)
    people = rng.sample(NAMES, n)
    ftext, fn = rng.choice(FILTERS)
    pick_min = rng.randint(0, 1) == 1
    # Built, not searched: 2 to 4 analysts pass the filter, and the overall extreme time goes to
    # one who does NOT, so ignoring the filter always gives another person.
    k = rng.randint(2, 4)
    inside, outside = people[:k], people[k:]
    passing = [r for r in range(5) if fn(r)]
    failing = [r for r in range(5) if not fn(r)]
    revised = {p: rng.choice(passing) for p in inside}
    revised.update({p: rng.choice(failing) for p in outside})
    times = sorted(rng.sample(range(8 * 60, 11 * 60), n))
    extreme = times[0] if pick_min else times[-1]
    rest = [t for t in times if t != extreme]
    filed = {outside[0]: extreme}
    for p, t in zip(inside + outside[1:], rng.shuffle(rest)):
        filed[p] = t
    best = (min if pick_min else max)(inside, key=lambda p: filed[p])
    order = rng.shuffle(people)
    if order.index(best) in (0, n - 1):  # never the first or the last name written
        j = rng.randint(1, n - 2)
        i = order.index(best)
        order[i], order[j] = order[j], order[i]
    lines = [f"Reports came in from {_words(n)} analysts this morning."]
    for p in order:
        lines.append(f"{p} filed at {_hhmm(filed[p])} and {REVISIONS[revised[p]]}.")
    lines.append(f"Among the analysts who revised their report {ftext}, who filed "
                 f"{'earliest' if pick_min else 'latest'}?" + NAME_TAIL)
    prompt = " ".join(lines)
    unfiltered = (min if pick_min else max)(people, key=lambda p: filed[p])
    naive = _naive_names(prompt, people) | {unfiltered}
    return {"prompt": prompt, "expected": best, "naive": naive, "people": people}


# ---------------------------------------------------------------------------------------
# 4. ordering: a finishing order given only by adjacent pairs, shuffled
# ---------------------------------------------------------------------------------------

ORDINALS = ("first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth")


def _probe_ordering(rng: _Rng):
    # Always 8 (the plausible floor). The winner is given, so the chain has a fixed start and the
    # answer is 2 or 3 steps from it (calibration 1: rebuilding all 8 positions was too hard for
    # the 70B preset).
    n = 8
    people = rng.sample(NAMES, n)  # finishing order
    facts = []
    for i in range(n - 1):
        x, y = people[i], people[i + 1]
        facts.append(rng.choice((
            f"{x} finished immediately before {y}.",
            f"{y} finished immediately after {x}.",
        )))
    order = rng.shuffle(list(range(n - 1)))
    # Never in the order of the chain, forwards or backwards.
    if order == sorted(order) or order == sorted(order, reverse=True):
        order = order[1:] + order[:1]
    k = rng.randint(2, 3)  # third or fourth
    prompt = (f"In a race with {_words(n)} runners there were no ties. {people[0]} won the race. "
              + " ".join(facts[i] for i in order) + f" Who finished {ORDINALS[k]}?" + NAME_TAIL)
    naive = _naive_names(prompt, people) | {people[0], people[-1]} | _names_after(prompt, people, people[0])
    return {"prompt": prompt, "expected": people[k], "naive": naive, "people": people,
            "facts": {"order": order}}


# ---------------------------------------------------------------------------------------
# 5. delta: stock changed by events (one of them cancelled); the change of two items together
# ---------------------------------------------------------------------------------------

STOCK = ("chairs", "tables", "lamps", "desks", "shelves", "cabinets", "stools")


def _ordinal(n: int) -> str:
    suffix = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def _probe_delta(rng: _Rng):
    # Calibration 4: comparing two listings was easy for the small preset. Now only the events say
    # what changed, several of them touch items that are not asked about, and one never happened.
    items = rng.sample(STOCK, 5)
    a, b = items[0], items[1]  # the two items asked about
    start = {i: rng.randint(8, 60) for i in items}
    days = sorted(rng.sample(range(2, 28), 4))

    def some(k, must):
        return [must] + rng.sample([i for i in items if i != must], k - 1)

    def listing(parts):
        return ", ".join(parts[:-1]) + f" and {parts[-1]}"

    # Amounts first, words after: one computation path, and a change of zero is fixed before
    # anything is written.
    brought = {i: rng.randint(2, 20) for i in some(3, a)}
    removed = {i: rng.randint(2, 15) for i in some(2, b)}  # start >= 8 and removals <= 15: never below 0
    brought2 = {i: rng.randint(2, 20) for i in some(2, rng.choice((a, b)))}
    for i in removed:
        removed[i] = min(removed[i], start[i] + brought.get(i, 0) - 1)
    net = {i: brought.get(i, 0) - removed.get(i, 0) + brought2.get(i, 0) for i in items}
    if net[a] + net[b] == 0:
        brought[a] += 2
        net[a] += 2
    change = net[a] + net[b]
    ghost_item = rng.choice((a, b))
    ghost = rng.randint(3, 20)

    def amounts(d):
        return listing([f"{_num(rng, k)} {i}" for i, k in rng.shuffle(list(d.items()))])

    events = [
        f"On the {_ordinal(days[0])} a delivery brought {amounts(brought)}.",
        f"On the {_ordinal(days[1])} a clear-out removed {amounts(removed)}.",
        f"On the {_ordinal(days[2])} another delivery brought {amounts(brought2)}.",
    ]
    events.insert(rng.randint(0, len(events)),
                  f"A delivery of {_num(rng, ghost)} {ghost_item} planned for the {_ordinal(days[3])} was "
                  f"cancelled and never arrived.")
    word = "more" if change > 0 else "fewer"
    end = {i: start[i] + net[i] for i in items}
    prompt = (
        "At the start of the month the storeroom held "
        + listing([f"{_num(rng, start[i])} {i}" for i in rng.shuffle(items)]) + ". "
        + " ".join(events) + " Nothing else came in or went out. "
        + f"Counting {a} and {b} together, how many {word} of them were there at the end of the "
        + "month than at the start?" + INT_TAIL
    )
    naive = _naive_ints(prompt) | {
        str(start[a] + start[b]), str(end[a] + end[b]),
        str(abs(net[a])), str(abs(net[b])),
        str(abs(change) + ghost), str(abs(abs(change) - ghost)),  # the cancelled delivery counted
    } | {str(x) for x in _numbers_in(prompt)}  # the answer is computed: never a number written in the text
    return {"prompt": prompt, "expected": str(abs(change)), "naive": naive,
            "facts": {"word": word, "before": start[a] + start[b], "after": end[a] + end[b]}}


# The pool of configuration C1 (2026-09-24). `correction` and `quantities` left
# the pool (the small preset solved about half of them) and so did `exclusion` (the advanced one
# failed 10 %); two new state-tracking templates were tried once and did not pass. Measured with
# 100 probes per model and checked with calibration/verdict_math.py.
TEMPLATES_V2 = {
    "ledger": (_probe_ledger, "int"),
    "schedule": (_probe_schedule, "time"),
    "attribution": (_probe_attribution, "name"),
    "ordering": (_probe_ordering, "name"),
    "delta": (_probe_delta, "int"),
}


MIN_PLAUSIBLE = 4


def _plausible(out) -> int:
    """Candidates a name probe leaves once the naive answers are ruled out (the answer is one of
    them). Probes that do not answer with a name always pass."""
    if "people" not in out:
        return MIN_PLAUSIBLE
    return len([p for p in out["people"] if p not in out["naive"]])


def _guarded(rng: _Rng, build):
    """Regenerates with the next counter while the answer matches a generic one. Fixed cap and a
    guaranteed exit: builders never fail, so after MAX_TRIES the last candidate is returned.
    Returns (candidate, tries)."""
    out = None
    for tries in range(1, MAX_TRIES + 1):
        out = build(rng)
        if out["expected"] not in out["naive"] and _plausible(out) >= MIN_PLAUSIBLE:
            return out, tries
    return out, MAX_TRIES


def generate_template(name: str, rng: _Rng) -> tuple:
    """One probe of one template: (probe, tries, raw candidate). Tests use the raw candidate."""
    build, kind = TEMPLATES_V2[name]
    out, tries = _guarded(rng, build)
    return {"template": name, "kind": kind, "prompt": out["prompt"], "expected": out["expected"]}, tries, out


def generate_probes(seed_hex: str) -> list:
    """PROBES_TOTAL probes with a balanced choice of templates: every template of the pool
    floor(9 / 5) = 1 time, plus 4 different ones chosen by the seed, in an order chosen by the
    seed; every probe is generated from the same sequence."""
    rng = _Rng(seed_hex)
    pool = tuple(TEMPLATES_V2)
    base, extra = divmod(PROBES_TOTAL, len(pool))
    names = rng.shuffle([t for t in pool for _ in range(base)] + rng.sample(pool, extra))
    probes = []
    for i, name in enumerate(names):
        p = generate_template(name, rng)[0]
        p["id"] = f"p{i + 1}"
        probes.append(p)
    return probes


# ---------------------------------------------------------------------------------------
# Grading and verdict: pure code, identical in leader and validators.
#
# Normalization (finding M-02 of the audit): formatting never decides a probe. Accepted for
# every kind: surrounding spaces (also no-break and thin ones), straight or typographic quotes
# and backticks around the answer, and final punctuation. Integers also accept the Unicode
# minus sign and typographic dashes as "-", a leading "+", and thousands separators (comma,
# no-break space, thin space). Names and times ignore letter case; a time may omit the leading
# zero of the hour ("9:05" is "09:05"). Prose around the answer is never accepted.
# ---------------------------------------------------------------------------------------

_SPACES = "\u00a0\u2009\u202f"
_DASHES = "\u2010\u2011\u2012\u2013\u2014\u2015\u2212"
_QUOTES = "\"'`\u201c\u201d\u2018\u2019"
_FINAL_PUNCTUATION = ".!?,;:"


def _normalize(answer: str) -> str:
    s = answer
    for ch in _SPACES:
        s = s.replace(ch, " ")
    s = s.strip()
    changed = True
    while changed and s:
        changed = False
        if s[-1] in _FINAL_PUNCTUATION:
            s = s[:-1].strip()
            changed = True
        if len(s) >= 2 and s[0] in _QUOTES and s[-1] in _QUOTES:
            s = s[1:-1].strip()
            changed = True
    return s.lower()


def _is_int(s: str) -> bool:
    body = s[1:] if s.startswith("-") else s
    return len(body) > 0 and body.isdigit()


def _as_int(s: str) -> str:
    for ch in _DASHES:
        s = s.replace(ch, "-")
    s = s.replace(",", "").replace(" ", "")
    if s.startswith("+"):
        s = s[1:]
    return s


def _as_time(s: str) -> str:
    m = re.fullmatch(r"(\d{1,2}):(\d{2})", s)
    return f"{int(m.group(1)):02d}:{m.group(2)}" if m else s


def grade(probe: dict, answer) -> str:
    if not isinstance(answer, str):
        return ERROR
    s = _normalize(answer)
    if probe["kind"] == "int":
        s = _as_int(s)
        return PASS if _is_int(s) and int(s) == int(probe["expected"]) else FAIL
    if probe["kind"] == "time":
        return PASS if _as_time(s) == probe["expected"] else FAIL
    return PASS if s == probe["expected"].lower() else FAIL


def derive_verdict(outcomes: list) -> tuple:
    """The verdict is a statistical test with target error rates (2026-09-24),
    checked with the upper 95 % bound of the measured rates: an advanced model is INCONSISTENT in
    fewer than 0.1 % of verifications and CONSISTENT in at least 97 %; a small one is CONSISTENT
    in fewer than 1 %; an endpoint with no model, practically never."""
    if ERROR in outcomes:
        return INCONCLUSIVE, "AGENT_ERROR"
    passed = outcomes.count(PASS)
    if passed >= CONSISTENT_MIN:
        return CONSISTENT, "ENOUGH_PASSED"
    if passed <= INCONSISTENT_MAX:
        return INCONSISTENT, "TOO_FEW_PASSED"
    return INCONCLUSIVE, "BORDERLINE"


def observe(agent_url: str, verification_id: str, probes: list) -> dict:
    """One POST with every probe, then grading. Runs inside the nondet block. No timestamps
    here: gl.vm.get_timestamp() fails inside a nondet block on Studio Next (measured)."""
    payload = json.dumps({
        "verification_id": verification_id,
        "probes": [{"id": p["id"], "prompt": p["prompt"]} for p in probes],
    })
    answers = {}
    detail = ""
    try:
        res = gl.nondet.web.post(agent_url, body=payload, headers={"Content-Type": "application/json"})
        if res.status != 200:
            detail = f"http {res.status}"
        else:
            raw = (res.body or b"")[:MAX_BODY_BYTES]
            data = json.loads(raw.decode("utf-8"))
            for item in data.get("answers", []):
                if isinstance(item, dict) and isinstance(item.get("id"), str):
                    answers[item["id"]] = item.get("answer")
    except Exception as e:
        detail = (type(e).__name__ + ": " + str(e))[:200]

    outcomes = []
    heads = []
    for p in probes:
        ans = answers.get(p["id"]) if not detail else None
        outcomes.append(grade(p, ans) if not detail else ERROR)
        heads.append(ans[:ANSWER_HEAD_CHARS] if isinstance(ans, str) else "")
    if not detail and ERROR in outcomes:
        detail = "missing or non-string answer"

    verdict, reason = derive_verdict(outcomes)
    return {
        "verdict": verdict,
        "reason_code": reason,
        "agent_error_detail": detail,
        "outcomes": outcomes,
        "answer_heads": heads,
    }


class VerificationInstance(gl.contract.Contract):
    verification_id: str
    agent_url: str
    claimed_model: str
    claimed_tier: str
    requester: str
    factory: str
    seed: str
    status: str
    certificate: str
    created_at: str
    verified_at: str

    def __init__(self, verification_id: str, agent_url: str, claimed_model: str,
                 claimed_tier: str, requester: str, factory: str):
        self.verification_id = verification_id
        self.agent_url = agent_url
        self.claimed_model = claimed_model
        self.claimed_tier = claimed_tier
        # Address-like params can arrive as Address objects: always store their str form.
        self.requester = str(requester)
        self.factory = str(factory)

        # No seed yet: it needs the datetime of the run() transaction (see SEED_SCHEME).
        self.seed = ""

        self.status = STATUS_CREATED
        self.certificate = ""
        # When the verification was created, and later when run() wrote the certificate. Both are
        # inside the certificate so another contract reading get_certificate() can apply its own
        # freshness rule without depending on an indexer or on a Studio-only RPC method.
        self.created_at = tx_datetime()
        self.verified_at = ""

    @gl.public.write
    def run(self) -> dict:
        if self.status == STATUS_COMPLETED:
            raise gl.vm.UserError("already verified")

        # Read before the nondet block, so nothing about the agent call can influence it. The seed
        # and the probes exist only from here on: nobody can compute them before this transaction.
        self.verified_at = tx_datetime()
        self.seed = derive_seed(gl.message.contract_address.as_bytes, self.verification_id, self.verified_at)

        probes = generate_probes(self.seed)
        agent_url = self.agent_url
        verification_id = self.verification_id

        def leader_fn() -> dict:
            return observe(agent_url, verification_id, probes)

        def validator_fn(leaders_res: gl.vm.Result) -> bool:
            if not isinstance(leaders_res, gl.vm.Return):
                return False
            mine = observe(agent_url, verification_id, probes)
            return mine["verdict"] == leaders_res.calldata["verdict"]

        observed = gl.vm.run_nondet(leader_fn, validator_fn)

        cert = self._base_certificate()
        cert.update({
            "status": STATUS_COMPLETED,
            "verdict": observed["verdict"],
            "reason_code": observed["reason_code"],
            "agent_error_detail": observed["agent_error_detail"],
            "probes_passed": observed["outcomes"].count(PASS),
            "probes_total": PROBES_TOTAL,
            "probes": [
                {
                    "id": p["id"],
                    "template": p["template"],
                    "prompt": p["prompt"],
                    "expected": p["expected"],
                    "answer_head": observed["answer_heads"][i],
                    "outcome": observed["outcomes"][i],
                }
                for i, p in enumerate(probes)
            ],
            "run_by": str(gl.message.sender_address),
        })
        self.certificate = json.dumps(cert)
        self.status = STATUS_COMPLETED
        return cert

    def _base_certificate(self) -> dict:
        return {
            "verification_id": self.verification_id,
            "factory": self.factory,
            "requester": self.requester,
            "agent_url": self.agent_url,
            "claimed_model": self.claimed_model,
            "claimed_tier": self.claimed_tier,
            "probe_set_version": PROBE_SET_VERSION,
            "seed": self.seed,
            "seed_scheme": SEED_SCHEME,
            "seed_note": SEED_NOTE,
            "verdict_rule": VERDICT_RULE,
            "status": self.status,
            "created_at": self.created_at,
            "verified_at": self.verified_at,
        }

    @gl.public.view
    def get_status(self) -> str:
        return self.status

    @gl.public.view
    def get_certificate(self) -> str:
        if self.status == STATUS_COMPLETED:
            return self.certificate
        return json.dumps(self._base_certificate())

    @gl.public.view
    def get_probes(self) -> list:
        """The probes this verification sent, with their expected answers. Empty before run():
        the probes do not exist until the run() transaction fixes the seed."""
        if self.status != STATUS_COMPLETED:
            return []
        return [
            {"id": p["id"], "template": p["template"], "prompt": p["prompt"], "expected": p["expected"]}
            for p in json.loads(self.certificate)["probes"]
        ]
