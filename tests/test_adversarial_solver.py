"""Regression for finding C-01 of the audit: no model, no pass.

Two attackers with no model behind them answer REAL verifications of the contract (run() with the
agent mocked), and the certificate must be INCONSISTENT for each of them (with the 9 probes of
configuration C1: at most 4 of 9 passed; CONSISTENT needs 7):

- Agent E (presets/agent-e.mjs), the generic cheap attacker, frozen 2026-09-23 before probe set
  v2 was written (hash pinned in test_agent_e.py).
- The solver below, written for the v1 templates: evaluate the arithmetic expression, follow the
  repeated rule, simulate the boxes, and as a last resort evaluate the longest expression.

Against probe set v1 BOTH scored 3/3 in 8 of 8 verifications, 24 of 24 probes: that was the
finding. Against probe set v2 each must be INCONSISTENT in every verification.
"""

import ast
import json
import os
import re
import subprocess
import sys

import pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
INSTANCE = os.path.join(ROOT, "contracts", "VerificationInstance.py")
AGENT_E_CLI = os.path.join(ROOT, "presets", "agent-e-cli.mjs")

URL = "https://agent.example.com/agent"
REQUESTER = "0x1111111111111111111111111111111111111111"
FACTORY = "0x2222222222222222222222222222222222222222"
ROUNDS = 8


# ---------------------------------------------------------------------------------------
# The attacker
# ---------------------------------------------------------------------------------------

def _eval_expression(text: str):
    """Evaluates an arithmetic expression with the standard library, never exec of user code."""
    try:
        tree = ast.parse(text, mode="eval")
    except SyntaxError:
        return None
    allowed = (ast.Expression, ast.BinOp, ast.UnaryOp, ast.Constant, ast.Add, ast.Sub,
               ast.Mult, ast.Div, ast.FloorDiv, ast.Mod, ast.Pow, ast.USub, ast.UAdd)
    for node in ast.walk(tree):
        if not isinstance(node, allowed):
            return None
        if isinstance(node, ast.Constant) and not isinstance(node.value, (int, float)):
            return None
    try:
        return eval(compile(tree, "<expr>", "eval"), {"__builtins__": {}}, {})
    except Exception:
        return None


def _solve_arithmetic(prompt: str):
    m = re.search(r"Compute\s+(.+?)\.\s", prompt)
    if not m:
        return None
    value = _eval_expression(m.group(1))
    return None if value is None else str(int(value))


def _solve_sequence(prompt: str):
    m = re.search(
        r"Start with the number (-?\d+)\. Apply this rule (\d+) times in a row: multiply "
        r"the current number by (\d+) and then subtract (\d+)", prompt)
    if not m:
        return None
    n, times, mul, sub = (int(g) for g in m.groups())
    for _ in range(times):
        n = n * mul - sub
    return str(n)


def _solve_state(prompt: str):
    if "starts with" not in prompt:
        return None
    boxes = {}
    for name, count in re.findall(r"Box ([A-Z]) starts with (\d+) item", prompt):
        boxes[name] = int(count)
    if not boxes:
        return None
    # Operations, in the order they appear in the text.
    for sentence in re.findall(r"(Move [^.]+|Double [^.]+|Add [^.]+|Remove [^.]+)\.", prompt):
        move = re.match(r"Move (\d+) item[s]? from box ([A-Z]) to box ([A-Z])", sentence)
        double = re.match(r"Double the number of items in box ([A-Z])", sentence)
        add = re.match(r"Add (\d+) item[s]? to box ([A-Z])", sentence)
        remove = re.match(r"Remove (\d+) item[s]? from box ([A-Z])", sentence)
        if move:
            k, src, dst = int(move.group(1)), move.group(2), move.group(3)
            boxes[src] -= k
            boxes[dst] += k
        elif double:
            boxes[double.group(1)] *= 2
        elif add:
            boxes[add.group(2)] += int(add.group(1))
        elif remove:
            boxes[remove.group(2)] -= int(remove.group(1))
    target = re.search(r"How many items are in box ([A-Z]) at the end", prompt)
    if not target or target.group(1) not in boxes:
        return None
    return str(boxes[target.group(1)])


def _solve_fallback(prompt: str):
    """Longest arithmetic looking substring, evaluated. The lazy last resort."""
    best = None
    for candidate in re.findall(r"[-+*/()\d\s]{5,}", prompt):
        value = _eval_expression(candidate.strip())
        if value is not None and (best is None or len(candidate) > best[0]):
            best = (len(candidate), value)
    return None if best is None else str(int(best[1]))


def solve(prompt: str) -> str:
    """What Agent E answers. No model, no network, no key."""
    for strategy in (_solve_arithmetic, _solve_sequence, _solve_state, _solve_fallback):
        answer = strategy(prompt)
        if answer is not None:
            return answer
    return "0"


def agent_e(prompts: list) -> list:
    out = subprocess.run(["node", AGENT_E_CLI], input=json.dumps(prompts), capture_output=True,
                         text=True, encoding="utf-8", check=True)
    return json.loads(out.stdout)


# ---------------------------------------------------------------------------------------
# The measurement
# ---------------------------------------------------------------------------------------

ATTACKERS = {
    "agent-e": agent_e,
    "v1-solver": lambda prompts: [solve(p) for p in prompts],
}


@pytest.mark.parametrize("attacker", tuple(ATTACKERS))
@pytest.mark.parametrize("round_index", range(ROUNDS))
def test_attacker_without_model_does_not_pass(direct_vm, direct_deploy, attacker, round_index):
    """One real verification per round: the run() datetime changes per round, so the seed and
    the probes do. gltest loads the contract once per test, so rounds are parametrized."""
    at = f"2026-09-23T12:00:{round_index:02d}.000000Z"
    vid = f"{round_index:032x}"
    direct_vm.warp(at)  # before deploying: direct mode fixes gl.message.raw at load time
    contract = direct_deploy(INSTANCE, vid, URL, "gpt-4o", "advanced-reasoning", REQUESTER, FACTORY)
    mod = sys.modules["_contract_VerificationInstance"]
    probes = mod.generate_probes(mod.derive_seed(bytes(direct_vm._contract_address), vid, at))
    answers = ATTACKERS[attacker]([p["prompt"] for p in probes])
    body = json.dumps({"answers": [{"id": p["id"], "answer": a} for p, a in zip(probes, answers)]})
    direct_vm.mock_web(r".*agent\.example\.com.*", {"method": "POST", "status": 200, "body": body})

    cert = contract.run()
    print(f"\n{attacker} round {round_index}: {cert['probes_passed']}/{cert['probes_total']} " + json.dumps(
        [{"template": p["template"], "expected": p["expected"], "answered": p["answer_head"]} for p in cert["probes"]]))
    assert cert["probes_passed"] <= mod.INCONSISTENT_MAX
    assert cert["verdict"] == "INCONSISTENT"
