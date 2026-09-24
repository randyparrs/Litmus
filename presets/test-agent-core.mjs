// Tests for agent-core.mjs with OpenRouter mocked (no key, no network, no cost).
//   node test-agent-core.mjs
// Runs the cases in parallel with real timers (~35 s, bounded by the 30 s pass budget).

import { handle, makeAgents } from "./agent-core.mjs";

const ok = (content, finish = "stop") => ({
  status: 200,
  body: { provider: "Novita", choices: [{ message: { content }, finish_reason: finish }], usage: {} },
});
const err = (status) => ({ status, body: { error: { code: status, message: "Rate limit exceeded", metadata: { provider_name: "Novita", raw: "upstream says slow down" } } } });
const HANG = "hang";

// Each case scripts the replies for EVERY model call of one request, in order, keyed by prompt.
function mockFetch(script) {
  const calls = {};
  return async (url, init) => {
    const prompt = JSON.parse(init.body).messages[1].content;
    const n = (calls[prompt] = (calls[prompt] ?? 0) + 1);
    const step = script[prompt][Math.min(n - 1, script[prompt].length - 1)];
    if (step === HANG) {
      return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    }
    return { status: step.status, ok: step.status < 400, headers: new Headers(), json: async () => step.body };
  };
}

async function run(name, script, check) {
  const logs = [];
  const agents = makeAgents({ OPENROUTER_API_KEY: "test" });
  const body = JSON.stringify({ verification_id: "t", probes: Object.keys(script).map((prompt, i) => ({ id: `p${i + 1}`, prompt })) });
  const t0 = Date.now();
  const out = await handle(agents, "POST", "/agent-a", body, (r) => logs.push(r));
  const ms = Date.now() - t0;
  let failure = null;
  try { check(out, logs, ms); } catch (e) { failure = e.message; }
  console.log(`${failure ? "FAIL" : "ok  "} ${name} (${(ms / 1000).toFixed(1)} s)${failure ? " -> " + failure : ""}`);
  return !failure;
}

// Cases run in parallel and every case uses distinct prompts, so one global fetch routes each
// model call to the mock of its case by prompt.
const routes = new Map();
globalThis.fetch = (url, init) => {
  const prompt = JSON.parse(init.body).messages[1].content;
  return routes.get(prompt)(url, init);
};

function assert(c, m) { if (!c) throw new Error(m); }

const cases = [
  ["complete answer", { "q1 ok": [ok("steps\nFINAL: 112")] }, (o, l) => {
    assert(o.status === 200 && o.body.answers[0].answer === "112", "expected 200 with 112");
  }],
  ["429 then answer: retried after ~2 s", { "q2 429": [err(429), ok("FINAL: 7")] }, (o, l, ms) => {
    assert(o.status === 200 && o.body.answers[0].answer === "7", "expected 200 with 7");
    assert(ms >= 1900 && ms < 4000, `expected ~2 s, got ${ms}`);
    const reasons = JSON.parse(o.headers["X-Preset-Retry-Reasons"]);
    assert(reasons.length === 1 && reasons[0].includes("429"), `retry reason not reported: ${o.headers["X-Preset-Retry-Reasons"]}`);
  }],
  ["full 429 body is logged", { "q3 429log": [err(429), ok("FINAL: 1")] }, (o, l) => {
    const r = l.find((x) => x.event === "retry");
    assert(r && r.reason.includes("provider_name") && r.reason.includes("upstream says slow down"), "429 body not in log");
  }],
  ["truncated reply (finish_reason null) is retried, not graded", { "q4 trunc": [ok("Box A has 13 - 6 = 7 items, Box B has 13", null), ok("FINAL: 30")] }, (o) => {
    assert(o.status === 200 && o.body.answers[0].answer === "30", "expected the retried answer 30");
  }],
  ["truncated every time -> 502 (ERROR), never FAIL", { "q5 trunc-always": [ok("half an answer", null)] }, (o) => {
    assert(o.status === 502, `expected 502, got ${o.status}`);
  }],
  ["finish_reason length is an answer (the model's own doing)", { "q6 length": [ok("long rambling without final", "length")] }, (o) => {
    assert(o.status === 200 && o.body.answers[0].answer === "long rambling without final", "length should be graded as is");
    assert(o.headers["X-Preset-Finish-Reasons"] === '["length"]', `finish reason not reported: ${o.headers["X-Preset-Finish-Reasons"]}`);
    assert(o.headers["X-Preset-Final-Found"] === "[false]", `final_found not reported: ${o.headers["X-Preset-Final-Found"]}`);
  }],
  ["429 forever -> 502 after 3 retries (2+4+6 s)", { "q7 429-always": [err(429)] }, (o, l, ms) => {
    assert(o.status === 502, `expected 502, got ${o.status}`);
    assert(o.body.detail && o.body.detail.includes("429"), `502 body must carry the reason, got ${JSON.stringify(o.body)}`);
    assert(l.filter((x) => x.event === "retry").length === 3, "expected exactly 3 retries");
    assert(ms >= 11500 && ms < 15000, `expected ~12 s, got ${ms}`);
  }],
  ["hung call -> 502 within the 30 s pass budget", { "q8 hang": [HANG] }, (o, l, ms) => {
    assert(o.status === 502, `expected 502, got ${o.status}`);
    assert(ms <= 31000, `pass took ${ms} ms, over budget`);
  }],
  ["429 then hang: the pass still ends within 30 s", { "q9 429-hang": [err(429), HANG] }, (o, l, ms) => {
    assert(o.status === 502 && ms <= 31000, `expected 502 within 30 s, got ${o.status} in ${ms}`);
  }],
  ["4xx other than 429 is not retried", { "q10 400": [err(400), ok("FINAL: 1")] }, (o, l) => {
    assert(o.status === 502 && !l.some((x) => x.event === "retry"), "400 must not be retried");
  }],
  ["one probe fails, the whole request is 502", { "q11 a": [ok("FINAL: 1")], "q11 b": [err(500)] }, (o) => {
    assert(o.status === 502, `expected 502, got ${o.status}`);
  }],
];

// Agent E has no model: it must answer without a key and without calling OpenRouter (no route is
// registered for its prompt, so any fetch would fail the case).
async function agentECase() {
  const body = JSON.stringify({ verification_id: "t", probes: [{ id: "p1", prompt: "Compute ((2 * 3) - 1) * 2. Respond with only the final integer." }] });
  const out = await handle(makeAgents({}), "POST", "/agent-e", body, () => {});
  const ok = out.status === 200 && out.body.answers[0].answer === "10" && out.headers["X-Preset-Retries"] === "0";
  console.log(`${ok ? "ok  " : "FAIL"} agent-e answers from code, no model and no key`);
  return ok;
}

for (const [, script] of cases) for (const prompt of Object.keys(script)) routes.set(prompt, mockFetch(script));
const results = [...await Promise.all(cases.map(([name, script, check]) => run(name, script, check))), await agentECase()];
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
