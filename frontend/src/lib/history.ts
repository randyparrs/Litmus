// Verification history, read from the CHAIN, not from this browser: the factory's
// get_verifications(offset, limit) lists every verification newest first, from contract storage
// alone. The explorer links (TX1, TX2) come from sim_getTransactionsForAddress, a Studio RPC
// method; they are optional and the history works without them.
//
// Measured shapes of the Studio transactions (2026-09-22):
//   create_verification -> type 2 on the FACTORY, args = [id, agent_url, model, tier].
//   run()                -> type 2 on the INSTANCE, method "run".
// The SDK's calldata decoder returns a Map: the method name under "" and the arguments under "args".

import { abi } from 'genlayer-js';
import type { Certificate } from './certificate';
import { FACTORY, RPC } from './config';
import { makeClient, readView, withReadRetry } from './node';

export interface HistoryRow {
  verificationId: string;
  instance: string;
  agentUrl: string;
  claimedModel: string;
  claimedTier: string;
  createdAt: string;   // ISO, the create transaction datetime written by the factory
  requester: string;
}

/** A dict returned by a contract view: the SDK gives a Map, plain objects are accepted too. */
function field(item: unknown, key: string): string {
  const value = item instanceof Map ? item.get(key) : (item as Record<string, unknown>)?.[key];
  return value == null ? '' : String(value);
}

/** The latest verifications created by the factory that have a certificate, newest first. A
 *  verification whose run() never completed (status CREATED) has nothing to show and is left out.
 *  One status read per row: keep `limit` small, the RPC allows 30 requests per minute. */
export async function fetchHistory(limit = 12): Promise<HistoryRow[]> {
  const client = makeClient();
  const items = (await readView(client, FACTORY, 'get_verifications', [0, limit])) as unknown[];
  const rows = (items ?? [])
    .map((item) => ({
      verificationId: field(item, 'verification_id'),
      instance: field(item, 'instance'),
      agentUrl: field(item, 'agent_url'),
      claimedModel: field(item, 'claimed_model'),
      claimedTier: field(item, 'claimed_tier'),
      createdAt: field(item, 'created_at'),
      requester: field(item, 'requester'),
    }))
    .filter((row) => row.verificationId && row.instance);
  const statuses = await Promise.all(rows.map((row) => readView(client, row.instance, 'get_status', [])));
  return rows.filter((_, i) => statuses[i] === 'COMPLETED');
}

// ---------------- Explorer links (Studio only, optional) ----------------

async function rpc(method: string, params: unknown[]): Promise<any> {
  const res = await withReadRetry(() =>
    fetch(RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }).then((r) => r.json()),
  );
  return res?.result ?? [];
}

/** The decoded call of a transaction: its method name and its arguments. */
function decodeCall(base64: string): { method: string; args: unknown[] } | null {
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const decoded = abi.calldata.decode(bytes) as Map<string, unknown>;
    if (!(decoded instanceof Map)) return null;
    return { method: String(decoded.get('') ?? ''), args: (decoded.get('args') as unknown[]) ?? [] };
  } catch {
    return null;
  }
}

const succeeded = (tx: any) => !tx?.txExecutionResultName || tx.txExecutionResultName === 'FINISHED_WITH_RETURN';

/** TX1 (create_verification) and TX2 (run) of a verification, when the node can list them. */
async function fetchTxLinks(row: HistoryRow): Promise<{ tx1?: string; tx2?: string }> {
  try {
    const [factoryTxs, instanceTxs]: any[][] = await Promise.all([
      rpc('sim_getTransactionsForAddress', [FACTORY]),
      rpc('sim_getTransactionsForAddress', [row.instance]),
    ]);
    const create = factoryTxs.find((tx) => {
      const call = decodeCall(tx?.data?.calldata ?? '');
      return succeeded(tx) && call?.method === 'create_verification' && String(call.args[0]) === row.verificationId;
    });
    const run = instanceTxs.find((tx) =>
      tx?.type === 2 && succeeded(tx) && decodeCall(tx?.data?.calldata ?? '')?.method === 'run');
    return { tx1: create?.hash, tx2: run?.hash };
  } catch {
    return {};
  }
}

export interface LoadedCertificate {
  certificate: Certificate;
  instance: string;
  tx1?: string;
  tx2?: string;
}

/** Everything the Certificate window shows for one verification, all read from the chain. */
export async function loadCertificate(row: HistoryRow): Promise<LoadedCertificate> {
  const client = makeClient();
  const [raw, links] = await Promise.all([
    readView(client, row.instance, 'get_certificate', []),
    fetchTxLinks(row),
  ]);
  return { certificate: JSON.parse(String(raw)) as Certificate, instance: row.instance, ...links };
}
