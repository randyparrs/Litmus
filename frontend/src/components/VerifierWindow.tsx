// Window 1: the one-click flow. The three presets side by side (A CONSISTENT next to B and E
// INCONSISTENT is the point of the demo) and a form for any other agent.

import { useState } from 'react';
import { TIERS } from '../lib/config';
import { PRESETS } from '../lib/presets';
import type { Slot, SlotKey } from '../lib/useVerifications';
import { isRunning } from '../lib/useVerifications';
import { type VerifyInput, validateInput } from '../lib/verify';
import { AgentPanel } from './AgentPanel';

export function VerifierWindow({ slots, gateNote, canVerify, onVerify, onVerifyAll, onOpenCertificate, onReset }: {
  slots: Record<SlotKey, Slot>;
  gateNote: string;              // why VERIFY is blocked (wallet), empty when it is not
  canVerify: boolean;
  onVerify: (key: SlotKey, input: VerifyInput) => void;
  onVerifyAll: () => void;
  onOpenCertificate: (key: SlotKey) => void;
  onReset: (key: SlotKey) => void;
}) {
  const [manual, setManual] = useState<VerifyInput>({ agentUrl: 'https://', claimedModel: '', claimedTier: TIERS[0] });
  const manualError = validateInput(manual);
  const presetsBusy = PRESETS.some((p) => isRunning(slots[p.key].progress));

  return (
    <div className="window-body window-body--scroll">
      <div className="verify-both-row">
        <button
          className={`win-button win-button--primary bevel-raised${!canVerify || presetsBusy ? ' win-button--disabled' : ''}`}
          type="button" disabled={!canVerify || presetsBusy} onClick={onVerifyAll}
        >
          Verify all
        </button>
        {gateNote && <span className="gate-note">{gateNote}</span>}
      </div>

      <div className="agent-grid">
        {PRESETS.map((preset) => (
          <AgentPanel
            key={preset.key}
            name={preset.name}
            url={preset.agentUrl}
            model={preset.claimedModel}
            tier={preset.claimedTier}
            slot={slots[preset.key]}
            canVerify={canVerify}
            onVerify={() => onVerify(preset.key, {
              agentUrl: preset.agentUrl, claimedModel: preset.claimedModel, claimedTier: preset.claimedTier,
            })}
            onOpenCertificate={() => onOpenCertificate(preset.key)}
            onReset={() => onReset(preset.key)}
          />
        ))}
      </div>

      <div className="group-panel-manual bevel-groove">
        <div className="group-title">Verify any agent</div>
        <div className="field-row">
          <span className="field-label">Agent URL</span>
          <input
            className="text-input text-input--url bevel-field" type="text" maxLength={512} placeholder="https://..."
            value={manual.agentUrl} onChange={(e) => setManual({ ...manual, agentUrl: e.target.value })}
          />
        </div>
        <div className="field-row field-row--inline">
          <span className="field-label">Claimed model</span>
          <input
            className="text-input text-input--model bevel-field" type="text" maxLength={64} placeholder="llama-3.3-70b"
            value={manual.claimedModel} onChange={(e) => setManual({ ...manual, claimedModel: e.target.value })}
          />
          <span className="field-label field-label--loose">Tier</span>
          <select
            className="select-input bevel-field" value={manual.claimedTier}
            onChange={(e) => setManual({ ...manual, claimedTier: e.target.value })}
          >
            {TIERS.map((t) => <option key={t}>{t}</option>)}
          </select>
        </div>

        {manualError && (
          <div className="warning-callout bevel-groove">
            <img className="warning-icon" src="/assets/icon-warning.svg" width="16" height="16" alt="Warning" />
            <span>{manualError}</span>
          </div>
        )}

        <div className="verify-row">
          <button
            className={`win-button win-button--verify bevel-raised${!canVerify || !!manualError || isRunning(slots.manual.progress) ? ' win-button--disabled' : ''}`}
            type="button" disabled={!canVerify || !!manualError || isRunning(slots.manual.progress)}
            onClick={() => onVerify('manual', manual)}
          >
            VERIFY
          </button>
          <span className="help-line">The agent must answer the verification protocol (see Connect agent).</span>
        </div>

        {slots.manual.progress && (
          <AgentPanel
            name="Manual agent"
            url={slots.manual.input?.agentUrl ?? manual.agentUrl}
            model={slots.manual.input?.claimedModel || '(none)'}
            tier={slots.manual.input?.claimedTier ?? manual.claimedTier}
            slot={slots.manual}
            canVerify={canVerify && !manualError}
            onVerify={() => onVerify('manual', slots.manual.input ?? manual)}
            onOpenCertificate={() => onOpenCertificate('manual')}
            onReset={() => onReset('manual')}
          />
        )}
      </div>
    </div>
  );
}
