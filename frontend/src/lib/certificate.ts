// Shape of VerificationInstance.get_certificate() (contracts/VerificationInstance.py).

export type Verdict = 'CONSISTENT' | 'INCONSISTENT' | 'INCONCLUSIVE';
export type ReasonCode = 'ENOUGH_PASSED' | 'TOO_FEW_PASSED' | 'BORDERLINE' | 'AGENT_ERROR';
export type Outcome = 'PASS' | 'FAIL' | 'ERROR';

export interface ProbeResult {
  id: string;
  template: string;
  prompt: string;
  expected: string;
  answer_head: string;
  outcome: Outcome;
}

export interface Certificate {
  verification_id: string;
  factory: string;
  requester: string;
  agent_url: string;
  claimed_model: string;
  claimed_tier: string;
  probe_set_version: string;
  seed: string;
  seed_scheme?: string;     // how the seed is built (probe set v2)
  seed_note?: string;       // the seed depends on the run() datetime
  verdict_rule?: string;    // the thresholds of this probe set, in words
  status: 'CREATED' | 'COMPLETED';
  // Transaction datetimes written by the contract itself, so another contract reading the
  // certificate can apply its own freshness rule. Empty on certificates from older factories.
  created_at?: string;
  verified_at?: string;
  // Present only once status is COMPLETED.
  verdict?: Verdict;
  reason_code?: ReasonCode;
  agent_error_detail?: string;
  probes_passed?: number;
  probes_total?: number;
  probes?: ProbeResult[];
  run_by?: string;
}

// Fixed text shown next to every verdict (docs/ARCHITECTURE.md, Certificate).
export const DISCLAIMER = [
  'Consistent with a capability tier, NOT proof of which model runs the agent.',
  'Describes this specific verification, not a permanent guarantee.',
  'The validators agreed on the verdict; the per-probe detail is what the leader observed.',
];

export const REASON_TEXT: Record<ReasonCode, string> = {
  ENOUGH_PASSED: 'At least 7 of 9 probes passed.',
  TOO_FEW_PASSED: '4 or fewer of 9 probes passed.',
  BORDERLINE: '5 or 6 of 9 probes passed: borderline.',
  AGENT_ERROR: 'The agent did not answer correctly (HTTP error, network error, invalid JSON or a missing answer).',
};
