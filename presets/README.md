# Preset agents

One dependency-free Node server whose agents implement the Litmus protocol (see the main
`README.md`):

```
POST /agent-a   advanced model (AGENT_A_MODEL, default meta-llama/llama-3.3-70b-instruct)
POST /agent-b   small model    (AGENT_B_MODEL, default meta-llama/llama-3.2-3b-instruct)
POST /agent-c   demo agent     (AGENT_C_MODEL, default deepseek/deepseek-v4-flash, not calibrated)
POST /agent-d   demo agent     (AGENT_D_MODEL, default google/gemma-4-31b-it, not calibrated)
POST /agent-e   Agent E: a script with no model (claims to be Llama 3.3 70B in the demo)
GET  /health    status, model, provider and extra parameters of every agent
```

Model provider: OpenRouter.

## How it answers

- Every probe goes to the model as an independent chat request, in parallel. The server builds
  the JSON reply itself: the model never has to produce JSON, so a formatting slip by the small
  model never becomes a protocol error.
- `temperature: 0`, `seed: 7`, `max_tokens: 2048` and `provider.require_parameters: true`, so
  OpenRouter only uses providers that honour every parameter sent.
- One fixed provider per calibrated agent, no fallback (`provider.order` +
  `allow_fallbacks: false`): A on CoreWeave (fp16, since 2026-09-23; Novita before, which got
  saturated), B on Cloudflare (since 2026-09-24; Parasail before, which could not take the load;
  Cloudflare does not publish its quantization). The 70B model is served by 11 providers with
  different precisions; pinning one keeps every pass on the same deployment. Override with
  `AGENT_A_PROVIDER` / `AGENT_B_PROVIDER`. The demo agents C and D are not pinned.
- The model reasons step by step and ends with a `FINAL: <answer>` line; only that value is
  returned. A reply without the line is returned untouched.
- Retries: a 429, a 5xx, a 200 without content, a truncated reply or a connection failure is
  retried up to 3 times (after 2, 4 and 6 s), all within a budget of 30 s per request. When the
  budget runs out the server answers 502, which the verifier records as
  `INCONCLUSIVE / AGENT_ERROR`, never as a wrong answer.
- Diagnostic headers, not part of the protocol (the verifier ignores them; the calibration
  records them): `X-Preset-Providers`, `X-Preset-Retries`, `X-Preset-Retry-Reasons`,
  `X-Preset-Finish-Reasons` and `X-Preset-Final-Found`.
- Extra parameters per agent (`AGENT_A_EXTRA`, `AGENT_B_EXTRA`, ..., as JSON). None are needed
  with the current models. Every reply logs `reasoning_tokens`, the reasoning tokens the model
  actually used.
- Every request is logged to the console as one JSON line.

## Running locally (operator)

1. Create an API key at https://openrouter.ai. Never paste it into a file.
2. In a PowerShell terminal, set the key for that terminal only:

   ```powershell
   $env:OPENROUTER_API_KEY = "<your-key>"
   ```

3. In the same terminal, start the server from the repository root:

   ```powershell
   node presets/server.mjs
   ```

4. Check it from another terminal:

   ```powershell
   curl <server URL>/health
   ```

## Layout

- `agent-core.mjs`: all the agent logic (prompt, `FINAL:` extraction, pinned provider, bounded
  retries). No dependencies and no Node-only APIs.
- `agent-e.mjs`: Agent E, the cheap attacker with NO model (finding C-01 of the external audit),
  frozen on 2026-09-23 before probe set v2 was written (hash pinned in `tests/test_agent_e.py`).
  Served at `/agent-e` with no key and no network. `agent-e-cli.mjs` exposes it to the Python
  tests.
- `server.mjs`: local Node server, used for calibration.
- `worker.mjs` + `wrangler.toml`: the Cloudflare Worker, the public URL.

Both use the same `agent-core.mjs`: what was calibrated is exactly what is deployed.

## Public URL: Cloudflare Workers (operator)

Free plan: 100,000 requests a day (one verification uses 6), no cold starts, and the time spent
waiting for OpenRouter does not count as CPU. Over the limit, requests are refused; nothing is
charged. (Fly.io was ruled out: it asks for a card.)

From the `presets` folder:

1. `npx wrangler login` (opens the browser to authorize the Cloudflare account).
2. `npx wrangler deploy` (prints the URL `https://acv-presets.<subdomain>.workers.dev`).
3. `npx wrangler secret put OPENROUTER_API_KEY` (prompts for the key).
4. Check: `curl https://acv-presets.<subdomain>.workers.dev/health`.

Live logs: `npx wrangler tail`.
