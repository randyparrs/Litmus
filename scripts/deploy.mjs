// Deploys VerifierFactory with the current VerificationInstance code on Studio Next, and checks
// that the factory reports the same instance code hash as the local file.
//
//   SIGNER_ENV=<.env with PRIVATE_KEY> node deploy.mjs
//
// Prints the factory address, the deploy transaction and the keccak256 of the instance code
// (local and on-chain), and records them in out/deploy-<ts>.json. The end-to-end run is a
// separate script: FACTORY=<address> ... node e2e.mjs.

import { createAccount, createClient } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256 } from "viem";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT = join(HERE, "out");
const RPC = "https://studio-next.genlayer.com/api";
const EXPLORER = "https://explorer-studio-dev.genlayer.com/tx";
mkdirSync(OUT, { recursive: true });

const FEE_OPTIONS = {
  leaderTimeunitsAllocation: 100n,
  validatorTimeunitsAllocation: 200n,
  appealRounds: 0,
  executionBudgetPerRound: 25000000000000000n,
  totalMessageFees: 0,
  rotations: [3],
};

// The key is read from the file, never printed.
function signerKey() {
  if (!process.env.SIGNER_ENV) throw new Error("set SIGNER_ENV to the .env of a funded wallet (a file with a PRIVATE_KEY= line)");
  const line = readFileSync(process.env.SIGNER_ENV, "utf8").split(/\r?\n/).find((l) => /^\s*PRIVATE_KEY\s*=/.test(l));
  if (!line) throw new Error("PRIVATE_KEY not found in SIGNER_ENV");
  const pk = line.slice(line.indexOf("=") + 1).trim();
  return pk.startsWith("0x") ? pk : `0x${pk}`;
}

// Reads are retried on transient network and node errors; the deploy itself is sent once.
async function retry(label, fn, tries = 6) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const text = `${e?.message ?? e} ${e?.details ?? ""}`.toLowerCase();
      const transient = /fetch failed|econnreset|socket hang up|timed out|timeout|network|not valid json|doctype|busy|slots occupied|rate limit|too many requests|not found|-32005|-32006/.test(text);
      if (!transient || attempt >= tries) throw e;
      const wait = Math.min(3000 * (attempt + 1), 15000);
      console.log(`[retry] ${label}: ${String(e?.message ?? e).slice(0, 90)} -> waiting ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

const account = createAccount(signerKey());
const client = createClient({ chain: studioDevnet, endpoint: RPC, account });

const instanceCode = new Uint8Array(readFileSync(join(ROOT, "contracts", "VerificationInstance.py")));
const factoryCode = new Uint8Array(readFileSync(join(ROOT, "contracts", "VerifierFactory.py")));
const localHash = keccak256(instanceCode);

const est = await client.estimateTransactionFees(FEE_OPTIONS);
const tx = await client.deployContract({ code: factoryCode, args: [instanceCode], fees: { distribution: est.distribution, feeValue: est.feeValue } });
console.log(`[deploy] ${EXPLORER}/${tx}`);
const rc = await retry("waiting for the deploy", () =>
  client.waitForTransactionReceipt({ hash: tx, waitUntil: "decided", interval: 5000, retries: 300, fullTransaction: true }));
if (rc.txExecutionResultName !== "FINISHED_WITH_RETURN") {
  console.log(String(rc?.consensus_data?.leader_receipt?.[0]?.genvm_result?.stderr ?? "").slice(-1200));
  throw new Error(`deploy ended as ${rc.statusName} / ${rc.txExecutionResultName}`);
}
const factory = rc.data?.contract_address;
const chainHash = await retry("get_instance_code_hash", () =>
  client.readContract({ address: factory, functionName: "get_instance_code_hash", args: [] }));
const match = String(chainHash).toLowerCase() === localHash.toLowerCase();

console.log(`[factory] ${factory}`);
console.log(`[instance code] local ${localHash}`);
console.log(`[instance code] chain ${chainHash}  ${match ? "MATCH" : "DOES NOT MATCH"}`);

const file = join(OUT, `deploy-${Date.now()}.json`);
writeFileSync(file, JSON.stringify({
  deployed: new Date().toISOString(), signer: account.address, factory, tx, status: rc.statusName,
  instance_code_hash: { local: localHash, chain: chainHash, match },
}, null, 2));
console.log(`-> ${file}`);
if (!match) process.exit(1);
