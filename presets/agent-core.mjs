// Preset agent logic shared by the local Node server (server.mjs, used for calibration) and the
// Cloudflare Worker (worker.mjs, the public URL). One implementation, so what was calibrated is
// exactly what is deployed. No dependencies, no Node-only APIs: fetch, AbortController,
// setTimeout, JSON.
//
// Protocol (docs/ARCHITECTURE.md, Agent protocol):
//   request   { "verification_id": "...", "probes": [ { "id": "p1", "prompt": "..." } ] }
//   response  { "answers": [ { "id": "p1", "answer": "..." } ] }
//
// Each probe is sent to the model as its own chat request, in parallel (Promise.all: a POST
// takes as long as its slowest call, not the sum), and this code builds the protocol JSON
// itself. The model never has to produce JSON: a small model's formatting mistakes must not
// turn a wrong answer into a protocol error.
//
// Models go through OpenRouter with temperature 0, a fixed seed and
// provider.require_parameters=true, so no provider silently ignores a parameter we send.
// Every response reports how many reasoning tokens the model actually used.
//
// Config keys (process.env on Node, the Worker env on Cloudflare): OPENROUTER_API_KEY (secret,
// never in a file), AGENT_A_MODEL, AGENT_B_MODEL, AGENT_A_PROVIDER, AGENT_B_PROVIDER (comma
// list), AGENT_A_EXTRA, AGENT_B_EXTRA (JSON).

import { solve as solveAgentE } from "./agent-e.mjs";

const COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
export const SEED = 7;
const MODEL_TIMEOUT_MS = 45000;
export const MAX_BODY_BYTES = 64 * 1024;
const MAX_PROBES = 10;
const MAX_PROMPT_CHARS = 4000;

function extra(env, name, fallback) {
  const raw = env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
}

// One pinned OpenRouter provider per agent (no fallbacks), so the 6 passes of a verification
// hit the same deployment: pinned + bounded retries (see RETRY_WAITS_MS), no fallback.
// Agent A: CoreWeave fp16 (a deliberate decision, 2026-09-23). Novita bf16, the earlier
// provider, answered 429 from its shared upstream pool in 8 of 48 calibration passes and in 33 of 36
// requests of the provider measurement. Of the 9 endpoints of the
// model that declare seed, CoreWeave was the only full-precision one that was deterministic and
// error-free, also in a burst of 18 simultaneous requests. Next option if it fails: Groq, which
// does not publish its quantization. Changing provider changes the build: recalibrate.
function pinned(env, name, fallback) {
  const order = (env[name] || fallback).split(",").map((x) => x.trim()).filter(Boolean);
  // No provider named: let OpenRouter route freely. Only the calibrated agents (A and B) need a
  // pinned deployment; a demo agent does not.
  if (!order.length) return { require_parameters: true };
  return { order, allow_fallbacks: false };
}

export function makeAgents(env) {
  return {
    "/agent-a": {
      name: "agent-a",
      model: env.AGENT_A_MODEL || "meta-llama/llama-3.3-70b-instruct",
      maxTokens: 2048,  // 2026-09-24, was 1024: replies without FINAL were measured
      provider: pinned(env, "AGENT_A_PROVIDER", "coreweave/fp16"),
      extra: extra(env, "AGENT_A_EXTRA", {}),
      apiKey: env.OPENROUTER_API_KEY,
    },
    "/agent-b": {
      name: "agent-b",
      model: env.AGENT_B_MODEL || "meta-llama/llama-3.2-3b-instruct",
      maxTokens: 2048,  // 2026-09-24, was 1024: replies without FINAL were measured
      // Agent B: Cloudflare (a deliberate decision, 2026-09-24). Parasail answered 429 from its shared
      // pool in 54 of 81 calls of three bursts of 27; Cloudflare 27/27 in the burst, same answers.
      // Cloudflare does NOT publish its quantization. The 3B model has only these two providers.
      provider: pinned(env, "AGENT_B_PROVIDER", "cloudflare"),
      extra: extra(env, "AGENT_B_EXTRA", {}),
      apiKey: env.OPENROUTER_API_KEY,
    },
    // Demo agent for the manual form: a model from another family, NOT part of the calibrated
    // set. No pinned provider (see pinned()); it exists to show that any endpoint can be verified.
    "/agent-c": {
      name: "agent-c",
      model: env.AGENT_C_MODEL || "deepseek/deepseek-v4-flash",
      maxTokens: 1024,
      provider: pinned(env, "AGENT_C_PROVIDER", ""),
      extra: extra(env, "AGENT_C_EXTRA", {}),
      apiKey: env.OPENROUTER_API_KEY,
    },
    // Second demo agent, same idea as /agent-c: another model family, no pinned provider.
    "/agent-d": {
      name: "agent-d",
      model: env.AGENT_D_MODEL || "google/gemma-4-31b-it",
      maxTokens: 1024,
      provider: pinned(env, "AGENT_D_PROVIDER", ""),
      extra: extra(env, "AGENT_D_EXTRA", {}),
      apiKey: env.OPENROUTER_API_KEY,
    },
    // The cheap attacker of the calibration (criterion 7): no model, no key, no network. It
    // answers with agent-e.mjs, frozen before probe set v2 was written; it must never pass.
    "/agent-e": {
      name: "agent-e",
      model: "none (Agent E: a parser, no model)",
      solver: solveAgentE,
    },
  };
}

export function describeAgents(agents) {
  return Object.fromEntries(Object.values(agents).map((a) => [a.name, { model: a.model, provider: a.provider ?? null, extra: a.extra ?? null }]));
}

// Same system prompt for both agents. The model reasons step by step and ends with a
// "FINAL: <answer>" line; the server returns only what follows FINAL: to the verifier.
// Measured: forbidden to write steps, the 70B model answered 62 where 112 was correct; allowed
// to show them, a correct answer was graded FAIL because the verifier grades the exact format.
// If the model writes no FINAL: line, the raw reply is returned as is and the probe fails:
// nothing is invented. This is plain string parsing, no LLM involved.
export const SYSTEM_PROMPT =
  "Solve the question step by step. Then end your reply with one last line of the form\n" +
  "FINAL: <answer>\n" +
  "where <answer> is exactly what the question asks for, in the format it asks for, and nothing else.";
const FINAL_MARKER = "FINAL:";

// Text after the LAST "FINAL:" marker, first line only. No marker: the raw reply, untouched.
export function extractFinal(content) {
  const i = content.lastIndexOf(FINAL_MARKER);
  if (i === -1) return { answer: content.trim(), finalFound: false };
  return { answer: content.slice(i + FINAL_MARKER.length).split("\n")[0].trim(), finalFound: true };
}

// Returns the validated probe list, or a string describing why the body is invalid.
function parseRequest(raw) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return "body is not valid JSON";
  }
  if (!body || !Array.isArray(body.probes) || body.probes.length === 0) return "probes must be a non-empty array";
  if (body.probes.length > MAX_PROBES) return `at most ${MAX_PROBES} probes`;
  for (const p of body.probes) {
    if (!p || typeof p.id !== "string" || typeof p.prompt !== "string") return "each probe needs string id and prompt";
    if (p.prompt.length > MAX_PROMPT_CHARS) return `prompt longer than ${MAX_PROMPT_CHARS} characters`;
  }
  return { verificationId: typeof body.verification_id === "string" ? body.verification_id : null, probes: body.probes };
}

// Bounded patience (approved 2026-09-22, after Novita answered 429s, hung calls and truncated
// replies on chain). Up to 3 retries per model call, waiting 2, 4 and 6 s, all on the same
// pinned provider. Retried: a 429, a 5xx, a 200 without content, a TRUNCATED reply and a
// connection failure. Everything, waits included, fits in a PASS_BUDGET_MS budget per request
// (one "pass" of a validator): when the budget runs out the call stops and the request answers
// 502, which the verifier records as ERROR (INCONCLUSIVE), never as FAIL. A slow agent blocks
// the verification queue on chain (Phase 0), so no pass may hang longer than that.
const RETRY_WAITS_MS = [2000, 4000, 6000];
const PASS_BUDGET_MS = 30000;
const MIN_CALL_MS = 3000; // not worth starting a model call with less time than this left

class Retryable extends Error {}

// OpenRouter normalizes finish_reason to stop | length | tool_calls | content_filter | error.
// "stop" is a complete answer; "length" means the model used up its token budget, which is the
// model's own doing and is graded as an answer. Anything else (null, "error", missing) is a reply
// cut off by the provider: measured on 2026-09-22, Novita returned ~200 characters with
// finish_reason null. Grading that would count infrastructure against the model.
export const COMPLETE_FINISH = new Set(["stop", "length"]);

async function callOnce(agent, prompt, timeoutMs) {
  const key = agent.apiKey;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let r;
  try {
    r = await fetch(COMPLETIONS_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: agent.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0,
        seed: SEED,
        max_tokens: agent.maxTokens,
        provider: { require_parameters: true, ...agent.provider },
        ...agent.extra,
      }),
    });
  } catch (e) {
    clearTimeout(timer);
    if (e?.name === "AbortError") throw new Error(`model call timed out after ${timeoutMs} ms`);
    throw new Retryable(`connection failed: ${String(e?.message ?? e)}`);
  }
  try {
    const data = await r.json().catch(() => null);
    // The full error body (message + metadata: provider, raw upstream error) tells whether a
    // limit comes from the provider or from the OpenRouter account.
    if (r.status === 429) throw new Retryable(`OpenRouter 429: ${JSON.stringify(data?.error ?? data).slice(0, 600)}`);
    if (r.status >= 500) throw new Retryable(`OpenRouter ${r.status}: ${JSON.stringify(data?.error ?? data).slice(0, 600)}`);
    if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${JSON.stringify(data?.error ?? data).slice(0, 600)}`);
    const message = data?.choices?.[0]?.message;
    if (typeof message?.content !== "string" || message.content.length === 0) {
      throw new Retryable("OpenRouter response without message content");
    }
    const finish = data.choices[0].finish_reason ?? null;
    if (!COMPLETE_FINISH.has(finish)) {
      throw new Retryable(`truncated reply (finish_reason ${finish}, ${message.content.length} chars, provider ${data.provider ?? "?"})`);
    }
    const { answer, finalFound } = extractFinal(message.content);
    return {
      answer,
      final_found: finalFound,
      raw_chars: message.content.length,
      finish_reason: data.choices[0].finish_reason ?? null,
      provider: data.provider ?? null,
      reasoning_tokens: data.usage?.completion_tokens_details?.reasoning_tokens ?? null,
      reasoning_returned: typeof message.reasoning === "string" && message.reasoning.length > 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function askModel(agent, prompt, log, deadline) {
  const reasons = [];
  for (let retries = 0; ; retries++) {
    const left = deadline - Date.now();
    if (left < MIN_CALL_MS) throw new Error(`pass budget of ${PASS_BUDGET_MS} ms exhausted after ${retries} retries`);
    try {
      return { ...(await callOnce(agent, prompt, Math.min(MODEL_TIMEOUT_MS, left))), retries, retryReasons: reasons };
    } catch (e) {
      if (e instanceof Retryable) reasons.push(e.message);
      if (!(e instanceof Retryable) || retries >= RETRY_WAITS_MS.length) throw e;
      const wait = RETRY_WAITS_MS[retries];
      if (deadline - Date.now() - wait < MIN_CALL_MS) {
        throw new Error(`pass budget of ${PASS_BUDGET_MS} ms would be exceeded; last error: ${e.message}`);
      }
      log({ event: "retry", agent: agent.name, model: agent.model, attempt: retries + 1, reason: e.message, wait_ms: wait });
      await new Promise((res) => setTimeout(res, wait));
    }
  }
}

// JSON that is safe as an HTTP header value: every non-ASCII character escaped as \uXXXX.
function asciiJson(value) {
  return JSON.stringify(value).replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

// Handles one request. Returns { status, headers, body } and never throws; `log` receives one
// object per event (the platform decides where it goes).
export async function handle(agents, method, path, bodyText, log) {
  if (method === "GET" && path === "/health") {
    return { status: 200, headers: {}, body: { ok: true, agents: describeAgents(agents) } };
  }
  const agent = agents[path];
  if (!agent) return { status: 404, headers: {}, body: { error: "not found" } };
  if (method !== "POST") return { status: 405, headers: {}, body: { error: "use POST" } };
  if (bodyText.length > MAX_BODY_BYTES) return { status: 413, headers: {}, body: { error: "body too large" } };

  const started = Date.now();
  const parsed = parseRequest(bodyText);
  if (typeof parsed === "string") {
    log({ agent: agent.name, status: 400, error: parsed });
    return { status: 400, headers: {}, body: { error: parsed } };
  }
  if (agent.solver) {
    // No model behind this agent: the answers come from code, same protocol and same headers.
    const answers = parsed.probes.map((p) => ({ id: p.id, answer: agent.solver(p.prompt) }));
    log({ agent: agent.name, model: agent.model, status: 200, verification_id: parsed.verificationId,
      elapsed_ms: Date.now() - started, probes: answers.map((a) => ({ id: a.id, answer: a.answer.slice(0, 200) })) });
    return { status: 200, headers: { "X-Preset-Providers": JSON.stringify(answers.map(() => "none")), "X-Preset-Retries": "0" }, body: { answers } };
  }
  try {
    const deadline = started + PASS_BUDGET_MS;
    const results = await Promise.all(parsed.probes.map((p) => askModel(agent, p.prompt, log, deadline)));
    const answers = parsed.probes.map((p, i) => ({ id: p.id, answer: results[i].answer }));
    log({
      agent: agent.name, model: agent.model, status: 200, verification_id: parsed.verificationId,
      elapsed_ms: Date.now() - started,
      probes: parsed.probes.map((p, i) => ({
        id: p.id,
        answer: results[i].answer.slice(0, 200),
        final_found: results[i].final_found,
        raw_chars: results[i].raw_chars,
        finish_reason: results[i].finish_reason,
        provider: results[i].provider,
        reasoning_tokens: results[i].reasoning_tokens,
        reasoning_returned: results[i].reasoning_returned,
        retries: results[i].retries,
      })),
    });
    // Not part of the protocol (the verifier ignores headers): calibration reads them.
    return {
      status: 200,
      headers: {
        "X-Preset-Providers": JSON.stringify(results.map((r) => r.provider)),
        // Why each model reply ended ("stop", or "length" when it used up max_tokens), one per
        // probe in request order: tells a format failure from a reply cut by the token cap.
        "X-Preset-Finish-Reasons": asciiJson(results.map((r) => r.finish_reason)),
        "X-Preset-Final-Found": asciiJson(results.map((r) => r.final_found)),
        "X-Preset-Retries": String(results.reduce((n, r) => n + r.retries, 0)),
        // The full message of every 429 / 5xx / truncated reply that a retry rescued.
        "X-Preset-Retry-Reasons": asciiJson(results.flatMap((r) => r.retryReasons).slice(0, 12).map((m) => m.slice(0, 600))),
      },
      body: { answers },
    };
  } catch (e) {
    // An upstream failure is an infrastructure error, not a wrong answer: answer 502 so the
    // verifier classifies it as INCONCLUSIVE instead of counting it against the model.
    log({ agent: agent.name, model: agent.model, status: 502, verification_id: parsed.verificationId, error: String(e?.message ?? e), elapsed_ms: Date.now() - started });
    // The full reason travels in the body too (the verifier ignores it): calibration logs it.
    return { status: 502, headers: {}, body: { error: "upstream model error", detail: String(e?.message ?? e) } };
  }
}
