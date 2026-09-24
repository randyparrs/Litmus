// Window 5: "Connect your agent". Everything an agent owner needs to become verifiable, made to
// be copied, not read: the protocol in two short blocks and an adapter that runs as is.

import { useState } from 'react';
import { PRESETS } from '../lib/presets';

const REQUEST = `POST https://your-agent.example.com/verify
Content-Type: application/json

{
  "verification_id": "9c2e41a7b085df36e14c72a9d0b53e7f",
  "probes": [
    { "id": "p1", "prompt": "In a race with eight runners there were no ties. Ivan won the race. Vera finished immediately after Paulo. Mara finished immediately after Yara. Leila finished immediately after Vera. Yara finished immediately after Anika. Paulo finished immediately after Mara. Katya finished immediately before Anika. Katya finished immediately after Ivan. Who finished third? Respond with only the name." },
    { "id": "p2", "prompt": "..." },
    { "id": "p9", "prompt": "..." }
  ]
}`;

const RESPONSE = `200 OK
Content-Type: application/json

{
  "answers": [
    { "id": "p1", "answer": "Anika" },
    { "id": "p2", "answer": "21" },
    { "id": "p9", "answer": "09:30" }
  ]
}`;

// Deliberately the same shape as the preset agents that run in production (presets/agent-core.mjs),
// trimmed to the essentials: one model call per probe, and the server builds the protocol JSON so a
// formatting slip by the model never becomes a protocol error.
const ADAPTER = `// Cloudflare Worker: wraps any model as a Litmus-verifiable agent.
// Deploy: npx wrangler deploy   Key: npx wrangler secret put API_KEY
const API = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "meta-llama/llama-3.3-70b-instruct";
const SYSTEM = "Solve the question step by step. Then end your reply with one last line of the " +
  "form\\nFINAL: <answer>\\nwhere <answer> is exactly what the question asks for, in the format it " +
  "asks for, and nothing else.";

async function ask(prompt, env) {
  const r = await fetch(API, {
    method: "POST",
    headers: { Authorization: \`Bearer \${env.API_KEY}\`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      max_tokens: 2048, // room to reason: with 1024 some replies were cut before the FINAL line
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
    }),
  });
  if (!r.ok) throw new Error("upstream " + r.status);
  const text = (await r.json()).choices[0].message.content ?? "";
  const i = text.lastIndexOf("FINAL:");
  return i === -1 ? text.trim() : text.slice(i + 6).split("\\n")[0].trim();
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("use POST", { status: 405 });
    const { probes } = await request.json();
    try {
      const answers = await Promise.all(
        probes.map(async (p) => ({ id: p.id, answer: await ask(p.prompt, env) })),
      );
      return Response.json({ answers });
    } catch (e) {
      // An upstream failure is infrastructure, not a wrong answer: 502 makes the verdict
      // INCONCLUSIVE instead of counting it against the model.
      return Response.json({ error: String(e.message ?? e) }, { status: 502 });
    }
  },
};`;

function CodeBlock({ title, code }: { title: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(code).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1500); },
      () => setCopied(false),
    );
  };
  return (
    <div className="code-panel bevel-groove">
      <div className="code-head">
        <span className="panel-title">{title}</span>
        <span className="step-spacer"></span>
        <button className="win-button bevel-raised" type="button" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <pre className="code-block bevel-field">{code}</pre>
    </div>
  );
}

export function ConnectAgentWindow({ onGoToVerifier }: { onGoToVerifier: () => void }) {
  return (
    <div className="window-body window-body--scroll">
      <div className="document">
        <div className="doc-heading">Put your own agent on Litmus</div>
        <p className="doc-text">
          Litmus verifies any agent, not only the three presets. Your agent needs one public URL that
          answers the Litmus protocol. If you have an API key for any model, five steps and about
          ten minutes get you there. Nothing to install, no sign-up with us.
        </p>

        {/* Same flow boxes as How it works, so the shape of the thing is clear before the steps. */}
        <div className="flow-diagram flow-diagram--three">
          <div className="flow-box bevel-raised">
            <div className="flow-box-title">Your key</div>
            <div className="flow-box-text">Your model provider key. It never leaves your worker.</div>
          </div>
          <div className="flow-arrow"><img src="/assets/arrow-right.svg" width="16" height="16" alt="" /></div>
          <div className="flow-box bevel-raised">
            <div className="flow-box-title">Your worker</div>
            <div className="flow-box-text">The adapter below: takes the probes, asks your model, answers Litmus.</div>
          </div>
          <div className="flow-arrow"><img src="/assets/arrow-right.svg" width="16" height="16" alt="" /></div>
          <div className="flow-box bevel-raised">
            <div className="flow-box-title">Litmus verifies</div>
            <div className="flow-box-text">Validators probe your URL, agree on a verdict, write the certificate.</div>
          </div>
        </div>

        <div className="doc-heading">Step 1 - Create a free Worker</div>
        <p className="doc-text">
          Open <strong>dash.cloudflare.com</strong>, go to <strong>Workers &amp; Pages</strong>,
          press <strong>Create</strong>, pick the Hello World worker and deploy it. The free plan is
          enough: a verification is 6 requests and the plan allows 100,000 a day. Each request carries
          9 probes, so one verification makes 54 calls to your model, paid with your key.
        </p>

        <div className="doc-heading">Step 2 - Paste the adapter</div>
        <p className="doc-text">
          In that worker press <strong>Edit code</strong>, delete what is there, paste this and
          deploy. Change <span className="prop-value--hash">MODEL</span> for the model you want to
          claim. It uses the same prompt and FINAL extraction as the preset agents.
        </p>
        <CodeBlock title="worker.js" code={ADAPTER} />

        <div className="doc-heading">Step 3 - Add your key</div>
        <p className="doc-text">
          In the worker's <strong>Settings</strong>, under variables, add a <strong>secret</strong>
          named <span className="prop-value--hash">API_KEY</span> with your OpenRouter key, and
          deploy again. The key stays on your side: Litmus never sees it, and the endpoint itself
          takes no authentication, because a key sent to the contract would be public on-chain.
        </p>

        <div className="doc-heading">Step 4 - Copy your URL</div>
        <p className="doc-text">
          The worker gives you one, like{' '}
          <span className="prop-value--hash">https://my-agent.my-name.workers.dev</span>. Open it in
          a browser: if it answers "use POST", it is alive.
        </p>

        <div className="doc-heading">Step 5 - Verify it</div>
        <p className="doc-text">
          In <strong>Verifier</strong>, under "Verify any agent", paste that URL, write the model
          you claim, and press VERIFY. Two signatures, about one to two minutes (67 to 130 s
          measured), and the certificate is on-chain for anyone to read.
        </p>
        <div className="properties-actions">
          <button className="win-button win-button--primary bevel-raised" type="button" onClick={onGoToVerifier}>
            Verify it now
          </button>
        </div>

        <div className="doc-rule"></div>

        <div className="doc-heading">Writing your own server instead</div>
        <p className="doc-text">
          The adapter is one way. Any server in any language works as long as it answers this, and
          the URL is https, not localhost, not an IP address and without a backslash.
        </p>
        <CodeBlock title="What the validators send" code={REQUEST} />
        <CodeBlock title="What your agent answers" code={RESPONSE} />
        <ul className="rules-list">
          <li>Answer with the exact value asked for, in its format: an integer (<span className="prop-value--hash">21</span>;
            a leading + and thousands commas are accepted), a name (<span className="prop-value--hash">Anika</span>;
            case and final punctuation do not matter) or a 24-hour time (<span className="prop-value--hash">09:30</span>).
            Burying the right answer in your working counts as a miss: following the format is part of
            what is being tested.</li>
          <li>Every request carries 9 probes; answer all of them in one JSON reply of at most 64 KB.</li>
          <li>Every verification hits your endpoint 6 times (one leader plus five validators), and
            each one grades your answers on its own.</li>
          <li>If your endpoint answers with an error, invalid JSON or a missing answer, the verdict
            is INCONCLUSIVE: an infrastructure problem is never counted as a failure of the model.</li>
        </ul>
        <p className="doc-text doc-text--last">
          Live example to compare against:{' '}
          <span className="prop-value--hash">{PRESETS[0].agentUrl}</span>
        </p>
      </div>
    </div>
  );
}
