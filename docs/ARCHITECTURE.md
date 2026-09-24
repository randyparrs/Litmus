# Litmus architecture

Current state of the system: probe set `"2"`, deployed on GenLayer Studio Next. The README is
the overview; this document is the reference the code points to, section by section.

## Overview

Litmus checks whether an AI agent endpoint behaves consistently with the capability tier it
claims, and writes the result on-chain as a certificate. It does not identify the model behind
the endpoint: a black-box test cannot, and the certificate says so.

One verification = one `VerificationInstance` contract, created by `VerifierFactory`. The
instance sends 9 probes to the agent in one POST, grades every answer in code, derives the
verdict from fixed thresholds, and the validators agree on that verdict through GenLayer
consensus. No LLM judges anything.

## Contracts

### VerifierFactory

Deployed at `0xdaFb8Ec9696b8A03c4157AAbd9C1ebA5582023c9` (Studio Next, chain 61997).

- The constructor stores the instance code once. Every verification is deployed from that
  code, so no caller can supply different instance code.
- `get_instance_code_hash()` returns the keccak256 of that code:
  `0x4aee5618b78b5741c11e33cf3aaaf160506f4b16a746e9aaab4aeb618c110e6a`, which is the keccak256
  of `contracts/VerificationInstance.py` in this repository.
- `create_verification(verification_id, agent_url, claimed_model, claimed_tier)` validates the
  input, deploys the instance with `gl.contract.deploy` (deterministic salt, `on="finalized"`)
  and registers it. Input rules:
  - `verification_id`: 32 lowercase hex characters, never reused.
  - `agent_url`: `https://` (scheme case-insensitive, stored lowercased), at most 512
    characters, no whitespace, no backslash, a host with at least one dot, not `localhost` and
    not an IP address in any form: dotted, decimal (`2130706433`), hexadecimal (`0x7f000001`),
    short (`127.1`), with a trailing dot, behind `user@`, or bracketed IPv6. A host whose last
    label is a number is always treated as an IP address.
  - `claimed_model`: at most 64 characters. It is recorded, never verified.
  - `claimed_tier`: `advanced-reasoning` (the only tier).
- `get_instance(verification_id)` returns the instance address.
- `get_verifications(offset, limit)` lists verifications newest first, at most 50 per call,
  from contract storage alone: `verification_id`, `instance`, `agent_url`, `claimed_model`,
  `claimed_tier`, `requester`, `created_at`.

### VerificationInstance

- The constructor records the verification and `created_at` (the transaction datetime).
- `run()` fixes `verified_at`, derives the seed, generates the probes, runs the nondeterministic
  block and writes the certificate. A second `run()` after a certificate exists reverts with
  `already verified`.
- `get_status()`: `CREATED` or `COMPLETED`. `get_certificate()`: the certificate as JSON (the
  base fields while `CREATED`). `get_probes()`: the probes with their expected answers, empty
  before `run()`, because the probes do not exist until then.
- Every datetime comes from `gl.message.raw["datetime"]`, read in deterministic code. A
  transaction without a datetime fails instead of deriving a seed from an empty string.

## Verification flow

1. The requester's wallet signs `create_verification` (TX 1). Its fees use the simulated
   estimate, which includes the message allocation of the child deploy.
2. The instance is deployed by an internal message when TX 1 finalizes. It becomes readable
   64 to 151 s after TX 1 in the final end-to-end runs.
3. The wallet signs `run()` (TX 2). Its fees use the generic estimate: a simulated estimate
   would execute `run()` and call the agent.
4. The leader and the validators each POST the 9 probes to the agent and grade the answers.
5. When the validators agree, the certificate is written and the instance is `COMPLETED`.

Three verifications started at once (A, B and E) finished in 77 s and in 130 s in two measured
runs (67 to 130 s per verification), depending on Studio Next load, and cost 0.30 and 0.20 GEN.

## Agent protocol

```
POST <agent_url>
{ "verification_id": "<32 hex>", "probes": [ { "id": "p1", "prompt": "..." }, ... 9 probes ] }

200 OK
{ "answers": [ { "id": "p1", "answer": "..." }, ... ] }
```

- One POST per pass carries all 9 probes. A verification makes 6 passes (1 leader + 5
  validators), so the endpoint receives 6 requests.
- The reply is read up to 64 KB. The first 200 characters of each answer go into the
  certificate.
- A status other than 200, a network error, invalid JSON or a missing or non-string answer
  makes the verdict `INCONCLUSIVE` with reason `AGENT_ERROR`: an infrastructure problem is never
  counted as a wrong answer.
- The endpoint takes no authentication: anything sent by the contract is public on-chain.

## Probe set v2

- Seed: `keccak256(instance_address || verification_id || verified_at)`, where `verified_at`
  is the datetime of the `run()` transaction. The probes do not exist before `run()`, and a new
  `run()` after a failed consensus uses new probes. The certificate records the scheme.
- Generator: keccak-based, no `random`, identical on every validator.
- Pool of 5 templates, all in prose: `ledger` (transfers between people, with refusals and data
  that does not count), `schedule` (chained relative times), `attribution` (who did what),
  `ordering` (finishing order from relative clues) and `delta` (stock changes, with a cancelled
  delivery). Each template carries distractors, and a naive-answer guard regenerates a probe
  whose answer equals a generic one (first, last, sum or maximum of the numbers written).
- Selection: every template once plus 4 distinct templates a second time, in seed order.
- Answers are an integer, a name or a 24-hour `HH:MM` time.
- Grading is code. Formatting never decides a probe: Unicode minus and typographic dashes, a
  leading `+`, thousands commas, thin and non-breaking spaces, case, surrounding quotes and final
  punctuation are normalized; `9:30` equals `09:30`.
- `tests/fixtures/probe_set_v2.json` records the generator output on fixed seeds;
  `tests/test_probe_set_v2.py` fails if any template changes.

## Verdict

| Probes passed (of 9) | Verdict | Reason code |
|---|---|---|
| 7, 8 or 9 | `CONSISTENT` | `ENOUGH_PASSED` |
| 5 or 6 | `INCONCLUSIVE` | `BORDERLINE` |
| 0 to 4 | `INCONSISTENT` | `TOO_FEW_PASSED` |
| any agent error | `INCONCLUSIVE` | `AGENT_ERROR` |

The thresholds are a statistical test with target error rates per verification, checked with
the upper bound of the 95 % Clopper-Pearson interval of the measured per-template rates:

- strong model (Llama 3.3 70B): `INCONSISTENT` below 0.1 % and `CONSISTENT` at least 97 %;
- small model (Llama 3.2 3B): `CONSISTENT` below 1 %;
- no model (Agent E): `CONSISTENT` practically never.

Measured with 100 probes per template and model (`calibration/difficulty-v2.jsonl`) and
computed by `calibration/verdict_math.py --measured`: A `CONSISTENT` 97.1 %, A `INCONSISTENT`
0.023 %, B `CONSISTENT` 0.277 %, E `CONSISTENT` 0.000 % (upper bounds).

## Consensus

- Equivalence principle: the validator repeats the POST and the grading on its own and agrees
  when it reaches the same verdict as the leader. Only the verdict is compared, not the answers:
  models are not deterministic even at temperature 0 with a fixed provider.
- The leader is part of the committee of 5; the leader's result is accepted with 3 of 5 votes.
  When the majority rejects it, the leader is rotated. The frontend and the scripts fund 3
  rotations and 0 appeals.
- No consensus: the transaction ends without writing anything and the instance stays
  `CREATED`.
- The per-probe detail in the certificate is what the leader observed.

## Certificate

Fields: `verification_id`, `factory`, `requester`, `agent_url`, `claimed_model`,
`claimed_tier`, `probe_set_version`, `seed`, `seed_scheme`, `seed_note`, `verdict_rule`,
`status`, `created_at`, `verified_at`, and once `COMPLETED`: `verdict`, `reason_code`,
`agent_error_detail`, `probes_passed`, `probes_total`, `probes` (id, template, prompt, expected,
answer head, outcome) and `run_by`.

Fixed text shown next to every verdict:
- Consistent with a capability tier, NOT proof of which model runs the agent.
- Describes this specific verification, not a permanent guarantee.
- The validators agreed on the verdict; the per-probe detail is what the leader observed.

## Calibration

Preset agents (`presets/`): A = Llama 3.3 70B on CoreWeave fp16, B = Llama 3.2 3B on Cloudflare,
both pinned with no fallback, temperature 0, `max_tokens` 2048; E = Agent E, a script with no
model (`presets/agent-e.mjs`), frozen before the templates of probe set v2 were written.

`calibration/test_calibration.py` runs the real contract code in gltest direct mode against the
live presets: 16 rounds, 6 passes per round (1 leader + 5 validators), the same probes for every
agent in a round, and a strong model of another family (DeepSeek V4 Flash) as an ambiguity
check. Per round, the verdict is the one shared by at least 4 of the 6 passes (3 of the 5 votes
agree with the leader); a leader in the minority counts as a rotation, and no verdict with 4 of
6 is a tie.

Freeze rule, the only criteria that decide: A never `INCONSISTENT`, B never `CONSISTENT`, E never
`CONSISTENT` (a tie violates them when the forbidden verdict is one of the tied ones).
`INCONCLUSIVE`, rotations and ties are reported, with a sanity cap of 4 in 16 per agent. Before
the run, `calibration/freeze_prob.py` computed the probability of passing this rule from the
variation between passes measured in an earlier attempt (`results-v2-freeze1.jsonl`, run under a
stricter unanimity rule): 0.976.

Freeze run, salt `c88c03e8c265de47` (`calibration/results-v2-freeze2.jsonl`): A `CONSISTENT` in
16 of 16 rounds, B and E `INCONSISTENT` in 16 of 16, the 6 passes agreed in every round, 0
rotations, 0 ties, 0 `INCONCLUSIVE`, ambiguity check 0. `probe_set_version` was frozen as `"2"`.

## Frontend

- Reads use `readContract`, no indexer. The history comes from `get_verifications()`. Explorer
  links for TX 1 and TX 2 come from `sim_getTransactionsForAddress`, a Studio method; they are
  optional.
- Polling every 10 s or more (the RPC allows 30 requests per minute). The instance is awaited
  up to 10 minutes; TX 2 is followed up to 40 minutes, then the page shows "still no result" with
  the verification id: the certificate stays on-chain.
- Transient node errors (busy, rate limit, HTML instead of JSON, network) are retried for
  reads. A write is never resent blindly: the chain state is read again instead.
- After two no-consensus results in a row for the same agent, the page stops offering to verify
  it again and shows "Inconsistent across validators".
- The wallet signs every write and pays its GEN fees; VERIFY stays disabled without a wallet on
  chain 61997 with GEN.

## Network

Studio Next, chain 61997, RPC `https://studio-next.genlayer.com/api`, explorer
`https://explorer-studio-dev.genlayer.com`, runner
`py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng`, genlayer-js 2.0.0-rc.1
(`studioDevnet` with the RPC replaced: the bundled one points at another host).

Measured on this network, and possibly different elsewhere:
- The child deploy runs when the parent transaction finalizes.
- About 3 transactions execute at once across the whole node; under load a verification waits.
- Slow agents are not cut off: the node waited at least 125 s, and the timeunit budget is not
  enforced, so the contract cannot impose a timeout.
- All agent requests come from one IP with a fixed user agent: an agent can tell it is being
  tested, which is why the certificate claims no more than how the agent answered this time.
- Fees must be attached; a funded wallet is charged.
