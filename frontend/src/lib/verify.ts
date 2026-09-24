// The one-click verification flow (docs/ARCHITECTURE.md, Verification flow), as a state machine that reports
// progress through a callback. No UI here: any screen can subscribe to the progress.
//
//   TX 1 factory.create_verification -> wait for the instance -> TX 2 instance.run()
//   -> re-read the instance status -> read the certificate.

import { FACTORY, FEE_OPTIONS, INSTANCE_TIMEOUT_MS, MAX_MODEL_CHARS, MAX_URL_CHARS, POLL_MS, RUN_TIMEOUT_MS, TIERS } from './config';
import type { Certificate } from './certificate';
import {
  type Hash, type Signer, isContractNotFound, isNetworkError, isNodeRefusal, makeClient, readView, sendWrite, sleep, withReadRetry,
} from './node';

export interface VerifyInput {
  agentUrl: string;
  claimedModel: string;
  claimedTier: string;
}

export type Phase =
  | 'creating'          // TX 1 sent, waiting for it to be decided
  | 'waiting-instance'  // TX 1 decided, the instance is being deployed (~70 s)
  | 'running'           // TX 2 sent, validators are probing the agent
  | 'reading'           // TX 2 decided, reading the certificate
  | 'done'              // certificate available
  | 'no-consensus'      // TX 2 decided but the validators did not agree: instance still CREATED
  | 'timeout'           // still no result after 40 minutes
  | 'error';            // rejected before running, or the node failed in a way we cannot recover

export interface Progress {
  phase: Phase;
  verificationId: string;
  startedAt: number;        // ms, when VERIFY was pressed
  phaseStartedAt: number;   // ms, when the current phase began
  finishedAt?: number;      // ms, set on a final phase so the clocks stop
  tx1?: Hash;
  instance?: string;
  tx2?: Hash;
  tx2Status?: string;       // real TX 2 phase: PENDING, PROPOSING, COMMITTING, REVEALING, ACCEPTED...
  notice?: string;          // transient node message ("Node is busy, retrying in 6s..."), not an error
  certificate?: Certificate;
  error?: string;
}

// ---------------- Input validation (same rules as contracts/VerifierFactory.py) ----------------

function hostOf(url: string): string {
  const rest = url.slice('https://'.length);
  const authority = rest.split(/[/?#]/)[0];
  const hostPort = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
  if (hostPort.startsWith('[')) return hostPort;
  return hostPort.split(':')[0].toLowerCase().replace(/\.+$/, '');
}

/** Any form an HTTP client reads as an IP address: a host whose last label is a number
 *  (2130706433, 0x7f000001, 127.1, 127.0.0.1) or a bracketed IPv6 literal. */
function isIpLiteral(host: string): boolean {
  if (host.startsWith('[') || host.includes(':')) return true;
  const last = host.split('.').pop() ?? '';
  return /^\d+$/.test(last) || /^0x[0-9a-f]*$/.test(last);
}

/** Returns an error message, or null when the factory would accept the input. */
export function validateInput(input: VerifyInput): string | null {
  const url = input.agentUrl;
  if (url.slice(0, 'https://'.length).toLowerCase() !== 'https://') return 'The agent URL must start with https://';
  if (url.length > MAX_URL_CHARS || /\s/.test(url)) return `The agent URL is too long (max ${MAX_URL_CHARS}) or contains spaces`;
  if (url.includes('\\')) return 'The agent URL cannot contain a backslash';
  const host = hostOf(url);
  if (host === 'localhost' || host.endsWith('.localhost') || isIpLiteral(host)) return 'The agent URL cannot be localhost or an IP address';
  if (!host || !host.includes('.')) return 'The agent URL has no valid host';
  if (input.claimedModel.length > MAX_MODEL_CHARS) return `The model name is too long (max ${MAX_MODEL_CHARS} characters)`;
  if (!(TIERS as readonly string[]).includes(input.claimedTier)) return 'Unsupported capability tier';
  return null;
}

export function newVerificationId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------- Flow ----------------

const FINAL: Phase[] = ['done', 'no-consensus', 'timeout', 'error'];
const DECIDED = ['ACCEPTED', 'UNDETERMINED', 'LEADER_TIMEOUT', 'VALIDATORS_TIMEOUT', 'CANCELED', 'FINALIZED'];

export class VerificationAborted extends Error {}

/** Runs one verification end to end. Resolves with the final progress (done, no-consensus,
 *  timeout or error); never throws except when aborted. */
export async function runVerification(
  input: VerifyInput,
  onProgress: (p: Progress) => void,
  signer: Signer,
  signal?: AbortSignal,
): Promise<Progress> {
  const now = Date.now();
  let p: Progress = { phase: 'creating', verificationId: newVerificationId(), startedAt: now, phaseStartedAt: now };
  const emit = (patch: Partial<Progress>) => {
    if (patch.phase && patch.phase !== p.phase) patch.phaseStartedAt = Date.now();
    if (patch.phase && FINAL.includes(patch.phase)) patch.finishedAt = Date.now();
    p = { ...p, ...patch };
    onProgress(p);
  };
  const notify = (notice: string) => emit({ notice });
  const checkAbort = () => { if (signal?.aborted) throw new VerificationAborted(); };
  const fail = (error: string): Progress => { emit({ phase: 'error', error, notice: '' }); return p; };

  const invalid = validateInput(input);
  if (invalid) return fail(invalid);

  // The user's wallet signs both transactions and pays the GEN fees (measured 2026-09-22: 0.22 GEN
  // for 5 transactions). Two verifications at once with the SAME wallet are not measured yet:
  // sign them one after the other until they are.
  const client = makeClient(signer.address, signer.provider);
  const id = p.verificationId;
  const args = [id, input.agentUrl, input.claimedModel, input.claimedTier];
  emit({});

  try {
    // ---- TX 1: create_verification. Its fees need the simulated estimate (message allocation
    // of the child deploy); simulating create_verification does not touch the agent.
    const est: any = await withReadRetry(
      () => client.estimateTransactionFeesForWrite({ ...FEE_OPTIONS, address: FACTORY, functionName: 'create_verification', args }),
      notify,
    );
    const fees1: any = { distribution: est.distribution, feeValue: est.feeValue };
    if (est.messageAllocations?.length) fees1.messageAllocations = est.messageAllocations;

    let tx1: Hash | undefined;
    try {
      tx1 = await sendWrite(() => client.writeContract({ address: FACTORY, functionName: 'create_verification', args, fees: fees1 }), notify);
      emit({ tx1 });
    } catch (err) {
      // Ambiguous: the write may have gone through. Never resend blindly; the factory registry
      // tells us (below) whether the instance exists.
      if (!isNetworkError(err)) throw err;
    }

    if (tx1) {
      const tx = await waitDecided(client, tx1, 5000, INSTANCE_TIMEOUT_MS, notify, signal, () => {});
      if (!tx) return fail('The create transaction was not decided in time. Try again.');
      if (tx.txExecutionResultName && tx.txExecutionResultName !== 'FINISHED_WITH_RETURN') {
        return fail('The factory rejected the verification.');
      }
    }

    // ---- Instance address from the registry (the verification_id is ours, so no return-value decoding).
    let instance = '';
    const t0 = Date.now();
    while (!instance) {
      checkAbort();
      instance = String(await readView(client, FACTORY, 'get_instance', [id], notify) || '');
      if (instance) break;
      if (Date.now() - t0 > (tx1 ? POLL_MS * 3 : 60_000)) {
        return fail(tx1 ? 'The factory did not register the verification.' : 'Could not reach the node to create the verification. Try again.');
      }
      await sleep(POLL_MS);
    }
    emit({ instance, phase: 'waiting-instance' });

    // ---- Wait until the instance exists. "contract not found" and "server busy" are normal here.
    const t1 = Date.now();
    for (;;) {
      checkAbort();
      try {
        await client.readContract({ address: instance, functionName: 'get_status', args: [] });
        notify('');
        break;
      } catch (err) {
        if (!(isContractNotFound(err) || isNodeRefusal(err) || isNetworkError(err))) throw err;
      }
      if (Date.now() - t1 > INSTANCE_TIMEOUT_MS) return fail('The verification could not be created: the instance never appeared.');
      await sleep(POLL_MS);
    }

    // ---- TX 2: run(). Generic fee estimate: the simulated one would execute run() and hit the agent.
    emit({ phase: 'running', notice: '' });
    const gen: any = await withReadRetry(() => client.estimateTransactionFees(FEE_OPTIONS), notify);
    const fees2 = { distribution: gen.distribution, feeValue: gen.feeValue };
    let tx2: Hash | undefined;
    try {
      tx2 = await sendWrite(() => client.writeContract({ address: instance, functionName: 'run', args: [], fees: fees2 }), notify);
      emit({ tx2 });
    } catch (err) {
      if (!isNetworkError(err)) throw err;
      // Ambiguous send: do not call run() again (it would repeat the same probes). Follow the
      // instance status instead; if it never completes, the user starts a new verification.
    }

    if (tx2) {
      const tx = await waitDecided(client, tx2, POLL_MS, RUN_TIMEOUT_MS, notify, signal, (s) => emit({ tx2Status: s }));
      if (!tx) { emit({ phase: 'timeout', notice: '' }); return p; }
    } else {
      const deadline = Date.now() + RUN_TIMEOUT_MS;
      while (Date.now() < deadline) {
        checkAbort();
        if (await readView(client, instance, 'get_status', [], notify) === 'COMPLETED') break;
        await sleep(POLL_MS);
      }
    }

    // ---- Re-read chain state: the certificate exists only if the instance is COMPLETED.
    emit({ phase: 'reading', notice: '' });
    const status = await readView(client, instance, 'get_status', [], notify);
    if (status !== 'COMPLETED') {
      emit({ phase: tx2 ? 'no-consensus' : 'timeout', notice: '' });
      return p;
    }
    const certificate = JSON.parse(String(await readView(client, instance, 'get_certificate', [], notify))) as Certificate;
    emit({ phase: 'done', certificate, notice: '' });
    return p;
  } catch (err: any) {
    if (err instanceof VerificationAborted) throw err;
    return fail(`The node returned an error: ${String(err?.shortMessage || err?.message || err).slice(0, 200)}`);
  }
}

/** Polls a transaction until it is decided, reporting its real status. Returns null on timeout. */
async function waitDecided(
  client: any, hash: Hash, intervalMs: number, timeoutMs: number,
  notify: (m: string) => void, signal: AbortSignal | undefined, onStatus: (s: string) => void,
): Promise<any | null> {
  const t0 = Date.now();
  let last = '';
  for (;;) {
    if (signal?.aborted) throw new VerificationAborted();
    let tx: any = null;
    try {
      tx = await withReadRetry(() => client.getTransaction({ hash }), notify, 2);
    } catch (err) {
      // A transaction the node has not indexed yet, or a transient error: keep polling.
      if (!(isContractNotFound(err) || isNodeRefusal(err) || isNetworkError(err) || /transaction/.test(String(err)))) throw err;
    }
    const status = tx?.statusName ? String(tx.statusName) : '';
    if (status && status !== last) { last = status; onStatus(status); }
    if (status && DECIDED.includes(status)) return tx;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(intervalMs);
  }
}

// ---------------- Reading a past verification ----------------

/** Looks up an existing verification by id: instance address and current certificate. */
export async function lookupVerification(verificationId: string): Promise<{ instance: string; certificate: Certificate } | null> {
  const client = makeClient();
  const instance = String(await readView(client, FACTORY, 'get_instance', [verificationId]) || '');
  if (!instance) return null;
  const certificate = JSON.parse(String(await readView(client, instance, 'get_certificate', []))) as Certificate;
  return { instance, certificate };
}
