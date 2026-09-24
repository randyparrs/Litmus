// Talking to the Studio Next node: client, reads with retry, and error classification.

import { createClient } from 'genlayer-js';
import { studioDevnet } from 'genlayer-js/chains';
import { RPC } from './config';

export type Address = `0x${string}`;
export type Hash = `0x${string}`;

// studioDevnet carries chain id 61997 and the consensus metadata writeContract needs, but its
// rpcUrls point at studio-dev, another node. One chain object with the studio-next RPC, shared
// by this client and the wallet, keeps both on the same node.
export const genlayerChain = {
  ...studioDevnet,
  name: 'GenLayer Studio Next',
  rpcUrls: { default: { http: [RPC] } },
};

/** Who signs the writes: always the user's browser wallet, like any web3 dApp (Synarch's method:
 *  account = address, provider = window.ethereum). The network charges the GEN fees, so the
 *  wallet must be on chain 61997 and hold GEN. Reads need no signer. */
export interface Signer {
  address: Address;
  provider: any;
}

export function makeClient(account?: Address, provider?: any) {
  return createClient({ chain: genlayerChain, endpoint: RPC, account, provider } as any) as any;
}

// viem wraps RPC errors and moves the real cause into details / shortMessage / cause, so every
// text field is flattened before matching.
export function errorText(err: any): string {
  const parts = [
    err?.message, err?.shortMessage, err?.details, err?.reason,
    err?.cause?.message, err?.cause?.shortMessage, err?.cause?.details,
    err?.error?.message, err?.data?.message,
  ];
  return parts.filter(Boolean).join(' | ').toLowerCase();
}

function codes(err: any): unknown[] {
  return [err?.code, err?.cause?.code, err?.error?.code, err?.data?.code, err?.cause?.cause?.code];
}

/** The node answered and refused the request (busy, rate limit, gateway page). Nothing was
 *  accepted, so repeating it is safe, even for a write. */
export function isNodeRefusal(err: any): boolean {
  if (codes(err).some((c) => c === -32005 || c === -32006)) return true;
  return /-32005|-32006|at capacity|slots occupied|server busy|rate limit|too many requests|not valid json|doctype/.test(errorText(err));
}

/** The request may never have reached the node, or its answer was lost. Safe to repeat for a
 *  read; for a write it is ambiguous and the caller must re-read chain state instead. */
export function isNetworkError(err: any): boolean {
  return /failed to fetch|fetch failed|network ?error|networkerror|load failed|connection|econnreset|socket hang up|timed out|timeout/.test(errorText(err));
}

/** Expected while the instance is being deployed (~70 s after TX 1). Not an error. */
export function isContractNotFound(err: any): boolean {
  return /contract .* not found|not found/.test(errorText(err));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Notify = (message: string) => void;

function backoff(err: any, attempt: number): number {
  // Rate limit and busy are counted per minute or need the node to drain: wait longer.
  return isNodeRefusal(err) ? Math.min(6000 + 4000 * attempt, 15000) : Math.min(1200 * 2 ** attempt, 8000) + 200;
}

function retryMessage(err: any, wait: number): string {
  const s = Math.round(wait / 1000);
  if (/rate limit|too many requests/.test(errorText(err))) return `Node at its request limit, retrying in ${s}s...`;
  if (/slots occupied|at capacity|server busy/.test(errorText(err))) return `Node is busy, retrying in ${s}s...`;
  return `Node did not answer, retrying in ${s}s...`;
}

/** Retries a READ on transient errors. Never use it around a write. */
export async function withReadRetry<T>(fn: () => Promise<T>, notify?: Notify, maxRetries = 6): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await fn();
      if (attempt > 0) notify?.('');
      return out;
    } catch (err) {
      const transient = isNodeRefusal(err) || isNetworkError(err);
      if (!transient || attempt >= maxRetries) { notify?.(''); throw err; }
      const wait = backoff(err, attempt);
      notify?.(retryMessage(err, wait));
      await sleep(wait);
    }
  }
}

/** Sends a write, repeating it ONLY when the node explicitly refused it (nothing accepted).
 *  An ambiguous network failure is rethrown so the caller re-reads chain state. */
export async function sendWrite<T>(fn: () => Promise<T>, notify?: Notify, maxRetries = 4): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await fn();
      if (attempt > 0) notify?.('');
      return out;
    } catch (err) {
      if (!isNodeRefusal(err) || attempt >= maxRetries) { notify?.(''); throw err; }
      const wait = backoff(err, attempt);
      notify?.(retryMessage(err, wait));
      await sleep(wait);
    }
  }
}

export async function readView(client: any, address: string, functionName: string, args: any[] = [], notify?: Notify) {
  return withReadRetry(() => client.readContract({ address, functionName, args }), notify);
}
