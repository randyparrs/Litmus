// Network and deployment constants. Everything here was measured or deployed on Studio Next;
// see docs/ARCHITECTURE.md, Network, before moving to another network.

export const RPC = 'https://studio-next.genlayer.com/api';
export const EXPLORER_TX = 'https://explorer-studio-dev.genlayer.com/tx/';
// Deployed 2026-09-24: probe set v2, instance code keccak256
// 0x4aee5618b78b5741c11e33cf3aaaf160506f4b16a746e9aaab4aeb618c110e6a (get_instance_code_hash()),
// history from get_verifications(). E2E green the same day with A, B and E at once: A CONSISTENT
// 9/9, B INCONSISTENT 1/9, E INCONSISTENT 0/9 (scripts/e2e.mjs).
export const FACTORY = '0xdaFb8Ec9696b8A03c4157AAbd9C1ebA5582023c9' as const;

export const PRESETS_BASE = 'https://acv-presets.randyparra.workers.dev';

// Supported tiers: must match TIERS in contracts/VerifierFactory.py.
export const TIERS = ['advanced-reasoning'] as const;
export const MAX_URL_CHARS = 512;
export const MAX_MODEL_CHARS = 64;

// Polling. The RPC allows 30 requests per minute, so nothing polls faster than every 10 s.
export const POLL_MS = 10_000;
// The instance appears ~66-70 s after TX 1 (measured); give up after this.
export const INSTANCE_TIMEOUT_MS = 10 * 60_000;
// docs/ARCHITECTURE.md, Frontend: keep polling TX 2 up to 40 minutes, then report "still no result".
export const RUN_TIMEOUT_MS = 40 * 60_000;

// Fee options for the generic estimate used by run(). run() must NOT use the simulated
// estimate: it would execute the call and hit the agent endpoint (measured).
export const FEE_OPTIONS = {
  leaderTimeunitsAllocation: 100n,
  validatorTimeunitsAllocation: 200n,
  appealRounds: 0,
  executionBudgetPerRound: 25_000_000_000_000_000n,
  totalMessageFees: 0,
  rotations: [3],
};

export const explorerTx = (hash: string) => EXPLORER_TX + hash;
