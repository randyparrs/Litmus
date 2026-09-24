// Verification state for the whole desktop: one run per slot (the presets and manual), kept
// here so switching windows does not lose a run in progress and so the Certificate window can
// read the result of any slot.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Signer } from './node';
import { type Progress, type VerifyInput, runVerification } from './verify';

export type SlotKey = 'agent-a' | 'agent-b' | 'agent-e' | 'manual';

export interface Slot {
  progress: Progress | null;
  input: VerifyInput | null;
  /** Consecutive no-consensus results (docs/ARCHITECTURE.md, Frontend: after two, stop inviting retries). */
  noConsensusRow: number;
}

const EMPTY: Slot = { progress: null, input: null, noConsensusRow: 0 };
const RUNNING_PHASES = ['creating', 'waiting-instance', 'running', 'reading'];
export const isRunning = (p: Progress | null) => !!p && RUNNING_PHASES.includes(p.phase);

export function useVerifications() {
  const [slots, setSlots] = useState<Record<SlotKey, Slot>>({
    'agent-a': EMPTY, 'agent-b': EMPTY, 'agent-e': EMPTY, manual: EMPTY,
  });
  const busy = useRef<Set<SlotKey>>(new Set());

  // One tick per second while anything is running: the elapsed time and the progress bar move.
  const [, setTick] = useState(0);
  const anyRunning = (Object.keys(slots) as SlotKey[]).some((k) => isRunning(slots[k].progress));
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [anyRunning]);

  const patch = useCallback((key: SlotKey, s: Partial<Slot>) => {
    setSlots((prev) => ({ ...prev, [key]: { ...prev[key], ...s } }));
  }, []);

  /** Runs one verification. Resolves when it finishes, so callers can chain A then B. */
  const start = useCallback(async (key: SlotKey, input: VerifyInput, signer: Signer) => {
    if (busy.current.has(key)) return;
    busy.current.add(key);
    patch(key, { input, progress: null });
    try {
      const final = await runVerification(input, (p) => patch(key, { progress: { ...p } }), signer);
      setSlots((prev) => ({
        ...prev,
        [key]: {
          input,
          progress: { ...final },
          noConsensusRow: final.phase === 'no-consensus' ? prev[key].noConsensusRow + 1 : 0,
        },
      }));
    } finally {
      busy.current.delete(key);
    }
  }, [patch]);

  const dismiss = useCallback((key: SlotKey) => {
    setSlots((prev) => (prev[key].progress?.phase === 'error' ? { ...prev, [key]: { ...prev[key], progress: null } } : prev));
  }, []);

  /** Clears one panel. The verification itself stays on-chain and in the Certificate window. */
  const reset = useCallback((key: SlotKey) => {
    if (!busy.current.has(key)) setSlots((prev) => ({ ...prev, [key]: EMPTY }));
  }, []);

  return { slots, start, dismiss, reset, anyRunning };
}

// ---------------- Presentation helpers (shared by the windows) ----------------

export const VERDICT_SUBTITLE: Record<string, string> = {
  CONSISTENT: 'Behaves like its claimed tier',
  INCONSISTENT: 'Does not behave like its claimed tier',
  INCONCLUSIVE: 'Could not decide',
};

/** The four steps the user sees, and the typical duration of each. Measured on Studio Next with
 *  probe set v2 (E2E 2026-09-24, A, B and E at once): TX 1 9-16 s, instance 64 s, TX 2 18-35 s. */
const STEPS: { phase: Progress['phase']; label: string; typicalMs: number }[] = [
  { phase: 'creating', label: 'Step 1 of 4 - Creating the verification on-chain...', typicalMs: 14_000 },
  { phase: 'waiting-instance', label: 'Step 2 of 4 - Deploying the verification contract...', typicalMs: 65_000 },
  { phase: 'running', label: 'Step 3 of 4 - Validators are probing the agent...', typicalMs: 35_000 },
  { phase: 'reading', label: 'Step 4 of 4 - Reading the certificate...', typicalMs: 3_000 },
];
const WEIGHTS = [0.12, 0.56, 0.30, 0.02]; // share of the bar each step owns

export function stepLabel(phase: Progress['phase']): string {
  return STEPS.find((s) => s.phase === phase)?.label ?? '';
}

/** How full the progress bar is (0..1). Within a step it creeps up to that step's share and
 *  stops there, so a slow step never looks finished. */
export function progressFraction(p: Progress): number {
  const i = STEPS.findIndex((s) => s.phase === p.phase);
  if (i < 0) return p.phase === 'done' ? 1 : 0;
  const before = WEIGHTS.slice(0, i).reduce((a, b) => a + b, 0);
  const inStep = Math.min((Date.now() - p.phaseStartedAt) / STEPS[i].typicalMs, 1);
  return before + WEIGHTS[i] * inStep;
}

export const TX2_PHASE_TEXT: Record<string, string> = {
  PENDING: 'Queued on the network',
  PROPOSING: 'Leader is running the probes',
  COMMITTING: 'Validators are running the probes',
  REVEALING: 'Validators are revealing their votes',
  ACCEPTED: 'Consensus reached',
};

export function elapsed(from: number, until?: number): string {
  return `${(((until ?? Date.now()) - from) / 1000).toFixed(1)}s`;
}
