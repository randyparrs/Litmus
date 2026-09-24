// Runs Agent E from the command line, for the direct-mode tests (tests/test_agent_e.py).
//   stdin:  a JSON array of prompts
//   stdout: a JSON array of answers, same order
// No model, no network.

import { solve } from "./agent-e.mjs";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
  const prompts = JSON.parse(input);
  process.stdout.write(JSON.stringify(prompts.map((p) => solve(p))));
});
