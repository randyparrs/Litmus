// Preset agents, local Node server (used for calibration). All the agent logic lives in
// agent-core.mjs, shared with the Cloudflare Worker (worker.mjs) that serves the public URL.
//
//   POST /agent-a   advanced model
//   POST /agent-b   small model
//   GET  /health
//
// Env: OPENROUTER_API_KEY (typed in the terminal, never in a file) and the optional config
// keys listed in agent-core.mjs; PORT (default 8080). Every request is logged to stdout as one
// JSON line.

import http from "node:http";
import { handle, makeAgents, describeAgents, MAX_BODY_BYTES } from "./agent-core.mjs";

const PORT = Number(process.env.PORT || 8080);
const AGENTS = makeAgents(process.env);

function log(record) {
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n");
}

const server = http.createServer((req, res) => {
  const path = new URL(req.url, "http://preset.local").pathname;
  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size <= MAX_BODY_BYTES) chunks.push(c);
  });
  req.on("end", async () => {
    const bodyText = size > MAX_BODY_BYTES ? "x".repeat(MAX_BODY_BYTES + 1) : Buffer.concat(chunks).toString("utf8");
    const out = await handle(AGENTS, req.method, path, bodyText, log);
    const payload = Buffer.from(JSON.stringify(out.body));
    res.writeHead(out.status, { ...out.headers, "Content-Type": "application/json", "Content-Length": payload.length });
    res.end(payload);
  });
});

server.listen(PORT, () => {
  log({ event: "listening", port: PORT, agents: describeAgents(AGENTS) });
});
