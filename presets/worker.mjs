// Preset agents as a Cloudflare Worker (the public URL). All the agent logic lives in
// agent-core.mjs, shared with the local Node server used for calibration, so the deployed
// agents are exactly the calibrated ones.
//
// Config: [vars] in wrangler.toml; the OpenRouter key is a Worker secret
// (`npx wrangler secret put OPENROUTER_API_KEY`, typed by the operator). Logs: `npx wrangler tail`.

import { handle, makeAgents } from "./agent-core.mjs";

function log(record) {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...record }));
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const bodyText = request.method === "POST" ? await request.text() : "";
    const out = await handle(makeAgents(env), request.method, path, bodyText, log);
    return new Response(JSON.stringify(out.body), {
      status: out.status,
      headers: { ...out.headers, "Content-Type": "application/json" },
    });
  },
};
