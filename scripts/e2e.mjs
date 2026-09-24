// On-chain end-to-end run of the frozen probe set (v2) on Studio Next.
//
//   FACTORY=0x... SIGNER_ENV=<.env with PRIVATE_KEY> PRESET_BASE_URL=https://<public-url> node e2e.mjs
//   E2E_MODE=sequential (same, plus)                    one agent after the other
//
// 1. Uses the factory at FACTORY (deploy one with deploy.mjs).
// 2. For agent-a, agent-b and agent-e: create_verification -> wait for the instance -> run() ->
//    read the certificate. E2E_MODE=parallel (default) runs the three flows AT THE SAME TIME,
//    like "Verify all" in the frontend; the writes are still sent one at a time (a wallet also
//    signs one after the other), only the waits overlap.
// 3. Checks every certificate (probe set "2", 9 probes, verdict rule, expected verdict: A
//    CONSISTENT, B and E INCONSISTENT), that the factory's get_instance_code_hash() equals the
//    keccak256 of contracts/VerificationInstance.py and that get_verifications() lists the three
//    verifications newest first. Records timings, the validators' votes and any agent error, in
//    out/e2e-<ts>.json.
//
// Signs with a funded wallet that pays the GEN fees (measured: the node debits a wallet with
// balance; it only lets a balance-0 account through). Prints the balance before and after.

import { createClient, createAccount } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";
import { keccak256 } from "viem";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT = join(HERE, "out");
const RPC = "https://studio-next.genlayer.com/api";
const EXPLORER = "https://explorer-studio-dev.genlayer.com/tx";
const BASE = (process.env.PRESET_BASE_URL || "").replace(/\/$/, "");
if (!BASE.startsWith("https://")) throw new Error("PRESET_BASE_URL must be a public https URL");
const MODE = process.env.E2E_MODE || "parallel";
if (!["parallel", "sequential"].includes(MODE)) throw new Error("E2E_MODE must be parallel or sequential");
// Agent E is an impostor: it claims the same model as A and has no model at all.
const AGENTS = [
  { agent: "agent-a", model: "llama-3.3-70b", expected: "CONSISTENT" },
  { agent: "agent-b", model: "llama-3.2-3b", expected: "INCONSISTENT" },
  { agent: "agent-e", model: "llama-3.3-70b", expected: "INCONSISTENT" },
];
mkdirSync(OUT, { recursive: true });

const FEE_OPTIONS = {
  leaderTimeunitsAllocation: 100n,
  validatorTimeunitsAllocation: 200n,
  appealRounds: 0,
  executionBudgetPerRound: 25000000000000000n,
  totalMessageFees: 0,
  rotations: [3],
};

const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2);

// A dropped connection used to kill the whole run (measured: the operator's connection dropped mid-E2E and the
// script died with EACCES). Reads and waits are retried; a WRITE is never retried blindly.
async function retry(label, fn, tries = 6) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const text = String(e?.message ?? e).toLowerCase() + " " + String(e?.details ?? "").toLowerCase();
      const transient = /fetch failed|eacces|econnreset|socket hang up|timed out|timeout|network|not valid json|doctype|busy|slots occupied|rate limit|too many requests|-32005|-32006/.test(text);
      if (!transient || attempt >= tries) throw e;
      const wait = Math.min(3000 * (attempt + 1), 15000);
      console.log(`[retry] ${label}: ${String(e?.message ?? e).slice(0, 90)} -> waiting ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Signer: SIGNER_ENV=<path to a .env with PRIVATE_KEY> (required). A funded wallet signs and pays
// the GEN fees, like any dApp; no throwaway accounts. The key is read from the file, never printed.
function signerKey() {
  if (!process.env.SIGNER_ENV) throw new Error("set SIGNER_ENV to the .env of a funded wallet (a file with a PRIVATE_KEY= line)");
  const line = readFileSync(process.env.SIGNER_ENV, "utf8").split(/\r?\n/).find((l) => /^\s*PRIVATE_KEY\s*=/.test(l));
  if (!line) throw new Error("PRIVATE_KEY not found in SIGNER_ENV");
  const pk = line.slice(line.indexOf("=") + 1).trim();
  return pk.startsWith("0x") ? pk : `0x${pk}`;
}
const account = createAccount(signerKey());
const client = createClient({ chain: studioDevnet, endpoint: RPC, account });
const report = { started: new Date().toISOString(), preset_base_url: BASE, mode: MODE, signer: account.address, verifications: [] };

// Writes go out one at a time even in parallel mode: each waits until the previous one has its hash.
let writeQueue = Promise.resolve();
function serialWrite(fn) {
  const next = writeQueue.then(fn, fn);
  writeQueue = next.catch(() => {});
  return next;
}

async function balance() {
  const r = await fetch(RPC, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [account.address, "latest"] }),
  }).then((x) => x.json());
  return BigInt(r.result);
}
const gen = (wei) => (Number(wei) / 1e18).toFixed(6);
const balanceStart = await balance();
console.log(`[signer] ${account.address} balance ${gen(balanceStart)} GEN`);

async function genericFees() {
  const est = await client.estimateTransactionFees(FEE_OPTIONS);
  return { distribution: est.distribution, feeValue: est.feeValue };
}

async function decided(hash) {
  return retry(`waiting ${hash.slice(0, 10)}`, () =>
    client.waitForTransactionReceipt({ hash, waitUntil: "decided", interval: 5000, retries: 300, fullTransaction: true }));
}

function stderrOf(rc) {
  return String(rc?.consensus_data?.leader_receipt?.[0]?.genvm_result?.stderr ?? "").slice(-1200);
}

function votes(rc) {
  const leader = (rc?.consensus_data?.leader_receipt ?? []).map((x) => `${x.mode}:${x.vote ?? "-"}:${x.execution_result}`);
  const validators = (rc?.consensus_data?.validators ?? []).map((v) => `${v.vote}:${v.execution_result}`);
  return { leader, validators };
}

async function waitInstance(address, maxMs = 10 * 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try {
      await retry("get_status", () => client.readContract({ address, functionName: "get_status", args: [] }), 2);
      return Date.now() - t0;
    } catch {
      await sleep(10000);
    }
  }
  throw new Error(`instance ${address} did not appear in ${maxMs} ms`);
}

// 1. Factory (deployed separately, with deploy.mjs)
const factory = process.env.FACTORY;
if (!/^0x[0-9a-fA-F]{40}$/.test(factory || "")) throw new Error("set FACTORY to the factory address (deploy one with deploy.mjs)");
report.factory = factory;

const localHash = keccak256(new Uint8Array(readFileSync(join(ROOT, "contracts", "VerificationInstance.py"))));
const chainHash = await retry("get_instance_code_hash", () => client.readContract({ address: factory, functionName: "get_instance_code_hash", args: [] }));
report.instance_code_hash = { local: localHash, chain: chainHash, match: String(chainHash).toLowerCase() === localHash.toLowerCase() };
console.log(`[factory] ${factory}  instance code hash ${chainHash}  ${report.instance_code_hash.match ? "matches" : "DOES NOT MATCH"} the local file`);

// 2. One verification per preset agent
async function verify({ agent, model, expected }) {
  const v = { agent, agent_url: `${BASE}/${agent}`, claimed_model: model, expected };
  const id = randomBytes(16).toString("hex");
  v.verification_id = id;
  report.verifications.push(v);
  const started = Date.now();

  const args = [id, v.agent_url, model, "advanced-reasoning"];
  let t0 = Date.now();
  const tx1 = await serialWrite(async () => {
    const est = await client.estimateTransactionFeesForWrite({ ...FEE_OPTIONS, address: factory, functionName: "create_verification", args });
    const fees = { distribution: est.distribution, feeValue: est.feeValue };
    if (est.messageAllocations?.length) fees.messageAllocations = est.messageAllocations;
    return client.writeContract({ address: factory, functionName: "create_verification", args, fees });
  });
  const rc1 = await decided(tx1);
  v.tx1 = { hash: tx1, explorer: `${EXPLORER}/${tx1}`, status: rc1.statusName, exec: rc1.txExecutionResultName, ms: Date.now() - t0 };
  if (rc1.txExecutionResultName !== "FINISHED_WITH_RETURN") {
    console.log(`[${agent}] create failed`, stderrOf(rc1));
    return;
  }
  v.instance = await retry("get_instance", () => client.readContract({ address: factory, functionName: "get_instance", args: [id] }));
  v.instance_ready_ms = (await waitInstance(v.instance)) + (Date.now() - t0 - v.tx1.ms);
  console.log(`[${agent}] instance ${v.instance} ready`);

  t0 = Date.now();
  const tx2 = await serialWrite(async () =>
    client.writeContract({ address: v.instance, functionName: "run", args: [], fees: await genericFees() }));
  const rc2 = await decided(tx2);
  v.tx2 = {
    hash: tx2, explorer: `${EXPLORER}/${tx2}`, status: rc2.statusName, exec: rc2.txExecutionResultName,
    result: rc2.result_name, ms: Date.now() - t0, votes: votes(rc2),
  };
  if (rc2.txExecutionResultName !== "FINISHED_WITH_RETURN") v.tx2.stderr = stderrOf(rc2);

  const cert = JSON.parse(await retry("get_certificate", () => client.readContract({ address: v.instance, functionName: "get_certificate", args: [] })));
  v.certificate = cert;
  v.total_ms = Date.now() - started;
  v.checks = {
    probe_set_version_2: cert.probe_set_version === "2",
    nine_probes: cert.probes_total === 9 && (cert.probes ?? []).length === 9,
    verdict_rule: typeof cert.verdict_rule === "string" && cert.verdict_rule.startsWith("9 probes"),
    expected_verdict: cert.verdict === expected,
  };
  console.log(`[${agent}] TX2 ${v.tx2.status} ${v.tx2.result} in ${Math.round(v.tx2.ms / 1000)} s -> ${cert.verdict} ` +
    `${cert.probes_passed ?? "-"}/${cert.probes_total ?? "-"} ${cert.reason_code ?? ""} ${cert.agent_error_detail ?? ""}`);
}

const flowsStarted = Date.now();
if (MODE === "parallel") {
  const results = await Promise.allSettled(AGENTS.map(verify));
  results.forEach((r, i) => { if (r.status === "rejected") console.log(`[${AGENTS[i].agent}] FAILED: ${String(r.reason?.message ?? r.reason).slice(0, 300)}`); });
  report.errors = results.map((r, i) => (r.status === "rejected" ? { agent: AGENTS[i].agent, error: String(r.reason?.message ?? r.reason) } : null)).filter(Boolean);
} else {
  for (const a of AGENTS) await verify(a);
}
report.flows_ms = Date.now() - flowsStarted;

// The history the frontend shows comes from get_verifications(): newest first, no Studio method.
const listed = await retry("get_verifications", () => client.readContract({ address: factory, functionName: "get_verifications", args: [0, 10] }));
const listedIds = (listed ?? []).map((v) => (v instanceof Map ? v.get("verification_id") : v.verification_id));
const createdIds = report.verifications.map((v) => v.verification_id);
report.get_verifications = { ids: listedIds, lists_all: createdIds.every((id) => listedIds.includes(id)) };

console.log(`\n==> ${MODE}, all flows in ${Math.round(report.flows_ms / 1000)} s`);
console.log(`  instance code hash on-chain matches the local file: ${report.instance_code_hash.match ? "PASS" : "FAIL"}`);
console.log(`  get_verifications lists the verifications of this run: ${report.get_verifications.lists_all ? "PASS" : "FAIL"}`);
for (const v of report.verifications) {
  const failed = Object.entries(v.checks ?? {}).filter(([, ok]) => !ok).map(([k]) => k);
  console.log(`  ${v.agent}: ${v.certificate?.verdict ?? "no certificate"} ${v.certificate?.probes_passed ?? "-"}/9  ` +
    `TX1 ${Math.round((v.tx1?.ms ?? 0) / 1000)} s, instance ${Math.round((v.instance_ready_ms ?? 0) / 1000)} s, ` +
    `TX2 ${Math.round((v.tx2?.ms ?? 0) / 1000)} s, total ${Math.round((v.total_ms ?? 0) / 1000)} s  ` +
    `checks ${v.checks ? (failed.length ? "FAIL: " + failed.join(", ") : "all PASS") : "not run"}`);
}

const balanceEnd = await balance();
report.balance = { start_gen: gen(balanceStart), end_gen: gen(balanceEnd), spent_gen: gen(balanceStart - balanceEnd) };
console.log(`[signer] balance ${gen(balanceStart)} -> ${gen(balanceEnd)} GEN (spent ${gen(balanceStart - balanceEnd)})`);
report.finished = new Date().toISOString();
const file = join(OUT, `e2e-${Date.now()}.json`);
writeFileSync(file, json(report));
console.log(`-> ${file}`);
