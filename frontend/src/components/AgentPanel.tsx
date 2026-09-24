// One agent slot inside the Verifier window: its claim, the VERIFY button, and whatever the
// verification is doing right now (progress, verdict, no consensus, timeout).

import { REASON_TEXT } from '../lib/certificate';
import { explorerTx } from '../lib/config';
import {
  type Slot, TX2_PHASE_TEXT, VERDICT_SUBTITLE, elapsed, isRunning, progressFraction, stepLabel,
} from '../lib/useVerifications';

const BLOCKS = 18;

function ProgressPanel({ slot }: { slot: Slot }) {
  const p = slot.progress!;
  const on = Math.round(progressFraction(p) * BLOCKS);
  const waiting = p.phase === 'creating' || p.phase === 'reading';
  return (
    <div className="progress-panel bevel-groove">
      <div className="progress-head">
        {waiting && <img className="hourglass-icon" src="/assets/icon-hourglass.svg" width="16" height="16" alt="" />}
        <span className="step-label">{stepLabel(p.phase)}</span>
        <span className="step-spacer"></span>
        <span className="elapsed-time bevel-groove">{elapsed(p.startedAt)}</span>
      </div>
      <div className="progress-bar bevel-groove">
        {Array.from({ length: BLOCKS }, (_, i) => (
          <div key={i} className={`progress-block${i < on ? ' progress-block--on' : ''}`}></div>
        ))}
      </div>
      {p.tx2Status && <div className="phase-line">{TX2_PHASE_TEXT[p.tx2Status] ?? p.tx2Status}</div>}
      {p.notice && <div className="notice-line">{p.notice}</div>}
    </div>
  );
}

function TxLinks({ tx1, tx2 }: { tx1?: string; tx2?: string }) {
  return (
    <>
      {tx1 && <a className="tx-link" href={explorerTx(tx1)} target="_blank" rel="noreferrer">TX1</a>}
      {tx2 && <a className="tx-link" href={explorerTx(tx2)} target="_blank" rel="noreferrer">TX2</a>}
    </>
  );
}

export function AgentPanel({ name, url, model, tier, slot, canVerify, onVerify, onOpenCertificate, onReset }: {
  name: string;
  url: string;
  model: string;
  tier: string;
  slot: Slot;
  canVerify: boolean;
  onVerify: () => void;
  onOpenCertificate: () => void;
  onReset: () => void;
}) {
  const p = slot.progress;
  const running = isRunning(p);
  const cert = p?.certificate;
  const stopped = slot.noConsensusRow >= 2; // two no-consensus in a row: do not invite more

  return (
    <div className="agent-panel group-panel bevel-groove">
      <div className="agent-head">
        <span className="agent-name">{name}</span>
        <span className="agent-url" title={url}>{url.replace(/^https:\/\/[^/]+/, '...')}</span>
      </div>
      <div className="agent-meta">
        <span className="meta-key">model</span><span className="meta-value">{model}</span>
        <span className="meta-key">tier</span><span className="meta-value">{tier}</span>
      </div>
      <div className="verify-row">
        <button
          className={`win-button win-button--verify bevel-raised${!canVerify || running || stopped ? ' win-button--disabled' : ''}`}
          type="button" disabled={!canVerify || running || stopped} onClick={onVerify}
        >
          {p?.phase === 'no-consensus' ? 'VERIFY AGAIN' : 'VERIFY'}
        </button>
        {/* Clears this panel only. The verification it showed stays on-chain: it is in Certificate. */}
        {p && !running && (
          <button className="win-button bevel-raised" type="button" onClick={onReset}>Reset</button>
        )}
      </div>

      {running && <ProgressPanel slot={slot} />}

      {p?.phase === 'done' && cert?.verdict && (
        <div className="verdict-block">
          <div className={`verdict-badge verdict-badge--${cert.verdict.toLowerCase()}`}>
            <div className="verdict-name">{cert.verdict}</div>
            <div className="verdict-subtitle">{VERDICT_SUBTITLE[cert.verdict]}</div>
          </div>
          <div className="result-summary bevel-groove">
            <div className="probe-count">{cert.probes_passed}/{cert.probes_total} probes passed</div>
            <div className="reason-text">
              {cert.reason_code ? REASON_TEXT[cert.reason_code] : ''}
              {cert.agent_error_detail ? ` (${cert.agent_error_detail})` : ''}
            </div>
          </div>
          <div className="result-actions">
            <button className="win-button bevel-raised" type="button" onClick={onOpenCertificate}>Open certificate</button>
            <TxLinks tx1={p.tx1} tx2={p.tx2} />
          </div>
        </div>
      )}

      {p?.phase === 'no-consensus' && (
        <div className="ending-panel bevel-groove">
          <div className="ending-row">
            <img className="ending-icon" src="/assets/icon-warning.svg" width="24" height="24" alt="" />
            <div>
              {stopped
                ? 'Inconsistent across validators.'
                : 'No consensus: the agent answered inconsistently across validators.'}
            </div>
          </div>
          <div className="result-actions"><TxLinks tx1={p.tx1} tx2={p.tx2} /></div>
        </div>
      )}

      {p?.phase === 'timeout' && (
        <div className="ending-panel bevel-groove">
          <div className="ending-row">
            <img className="ending-icon" src="/assets/icon-hourglass.svg" width="24" height="24" alt="" />
            <div>
              Still no result. The certificate stays on-chain: look it up later with id{' '}
              <span className="prop-value--hash">{p.verificationId}</span>.
            </div>
          </div>
          <div className="result-actions"><TxLinks tx1={p.tx1} tx2={p.tx2} /></div>
        </div>
      )}
    </div>
  );
}
