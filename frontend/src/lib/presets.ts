import { PRESETS_BASE } from './config';

export interface Preset {
  key: 'agent-a' | 'agent-b' | 'agent-e';
  name: string;
  agentUrl: string;
  claimedModel: string;
  claimedTier: string;
  provider: string;
  description: string;
}

// The same values the on-chain E2E used, so the certificates read the same.
export const PRESETS: Preset[] = [
  {
    key: 'agent-a',
    name: 'Agent A',
    agentUrl: `${PRESETS_BASE}/agent-a`,
    claimedModel: 'llama-3.3-70b',
    claimedTier: 'advanced-reasoning',
    provider: 'CoreWeave (fp16), fixed, no fallback',
    description: 'A strong real model (Llama 3.3 70B) that claims advanced reasoning.',
  },
  {
    key: 'agent-b',
    name: 'Agent B',
    agentUrl: `${PRESETS_BASE}/agent-b`,
    claimedModel: 'llama-3.2-3b',
    claimedTier: 'advanced-reasoning',
    provider: 'Cloudflare (quantization not published), fixed, no fallback',
    description: 'A small real model (Llama 3.2 3B) that claims the same tier.',
  },
  {
    // The impostor: it claims the same model as Agent A and has no model at all
    // (presets/agent-e.mjs, a parser; it solved 24 of 24 probes of the first probe set).
    key: 'agent-e',
    name: 'Agent E',
    agentUrl: `${PRESETS_BASE}/agent-e`,
    claimedModel: 'llama-3.3-70b',
    claimedTier: 'advanced-reasoning',
    provider: 'None: a script, no model',
    description: 'A script with no model behind it that claims to be Llama 3.3 70B.',
  },
];
