// Window 2: the on-chain proof. The list and every certificate are read from the chain (see
// lib/history.ts), so it shows the same thing on any machine, for anyone, after a cache wipe.

import { useEffect, useState } from 'react';
import { DISCLAIMER, REASON_TEXT } from '../lib/certificate';
import { explorerTx } from '../lib/config';
import { type HistoryRow, type LoadedCertificate, fetchHistory, loadCertificate } from '../lib/history';
import { VERDICT_SUBTITLE } from '../lib/useVerifications';

const short = (h: string) => `${h.slice(0, 6)}...${h.slice(-4)}`;
const when = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleString();
};
const agentOf = (url: string) => url.replace(/^https:\/\/[^/]+/, '...') || url;

export function CertificateWindow({ selectedId, onSelect }: {
  selectedId?: string;                 // opened from Verifier, or the last one picked here
  onSelect: (verificationId: string) => void;
}) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [loaded, setLoaded] = useState<LoadedCertificate | null>(null);
  const [error, setError] = useState('');
  const [reloads, setReloads] = useState(0);
  // Probe rows showing the whole question (prose probes are 400-650 characters long).
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setExpanded((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  useEffect(() => {
    let alive = true;
    setError('');
    fetchHistory().then(
      (list) => {
        if (!alive) return;
        setRows(list);
        if (!selectedId && list.length) onSelect(list[0].verificationId);
      },
      (e) => alive && setError(String(e?.message ?? e)),
    );
    return () => { alive = false; };
  }, [reloads]);

  useEffect(() => {
    const row = rows?.find((r) => r.verificationId === selectedId);
    if (!row) { setLoaded(null); return; }
    let alive = true;
    setError('');
    setExpanded(new Set());
    loadCertificate(row).then(
      (data) => alive && setLoaded(data),
      (e) => alive && setError(String(e?.message ?? e)),
    );
    return () => { alive = false; };
  }, [rows, selectedId]);

  const cert = loaded?.certificate;

  return (
    <div className="window-body window-body--scroll">
      <div className="history-panel bevel-groove">
        <div className="history-head">
          <span className="panel-title">Verifications on-chain</span>
          <span className="step-spacer"></span>
          <button className="win-button bevel-raised" type="button" onClick={() => setReloads((n) => n + 1)}>Refresh</button>
        </div>
        <div className="history-table bevel-field">
          <div className="history-row history-row--head">
            <div className="history-cell">When</div>
            <div className="history-cell">Agent</div>
            <div className="history-cell">Claimed model</div>
            <div className="history-cell">Verification ID</div>
          </div>
          {rows === null && <div className="history-empty">Reading the chain...</div>}
          {rows?.length === 0 && <div className="history-empty">No verifications yet. Run one in Verifier.</div>}
          {rows?.map((row) => (
            <div
              key={row.verificationId}
              className={`history-row${row.verificationId === selectedId ? ' history-row--selected' : ''}`}
              onClick={() => onSelect(row.verificationId)}
            >
              <div className="history-cell">{when(row.createdAt)}</div>
              <div className="history-cell" title={row.agentUrl}>{agentOf(row.agentUrl)}</div>
              <div className="history-cell">{row.claimedModel}</div>
              <div className="history-cell prop-value--hash">{row.verificationId}</div>
            </div>
          ))}
        </div>
      </div>

      {error && (
        <div className="warning-callout bevel-groove">
          <img className="warning-icon" src="/assets/icon-warning.svg" width="16" height="16" alt="Warning" />
          <span>{error}</span>
        </div>
      )}

      {!cert && !error && (
        <div className="ending-panel bevel-groove">
          <div className="ending-row">
            <img className="ending-icon" src="/assets/icon-hourglass.svg" width="24" height="24" alt="" />
            <div>{selectedId ? 'Reading the certificate...' : 'Pick a verification above.'}</div>
          </div>
        </div>
      )}

      {cert && !cert.verdict && (
        <div className="ending-panel bevel-groove">
          <div className="ending-row">
            <img className="ending-icon" src="/assets/icon-warning.svg" width="24" height="24" alt="" />
            <div>This verification has no certificate: it was created but never reached consensus.</div>
          </div>
        </div>
      )}

      {cert?.verdict && (
        <>
          <div className="certificate-head">
            <div className={`verdict-badge verdict-badge--large verdict-badge--${cert.verdict.toLowerCase()}`}>
              <div className="verdict-name">{cert.verdict}</div>
              <div className="verdict-subtitle">{VERDICT_SUBTITLE[cert.verdict]}</div>
              <div className="verdict-meta">{cert.probes_passed}/{cert.probes_total} probes passed</div>
              <div className="reason-text">
                {cert.reason_code ? REASON_TEXT[cert.reason_code] : ''}
                {cert.agent_error_detail ? ` (${cert.agent_error_detail})` : ''}
              </div>
            </div>
            <div className="disclaimer-panel bevel-groove">
              <div className="disclaimer-row">
                <img className="warning-icon" src="/assets/icon-warning.svg" width="16" height="16" alt="" />
                <div className="disclaimer-text">
                  {DISCLAIMER.map((line, i) => <span key={i}>{line}<br /></span>)}
                </div>
              </div>
            </div>
          </div>

          <div className="help-line probe-table-hint">Click a row to read the whole question.</div>
          <div className="probe-table bevel-field">
            <div className="probe-table-head">
              <div className="probe-cell">Probe</div>
              <div className="probe-cell">Question</div>
              <div className="probe-cell">Expected</div>
              <div className="probe-cell">Agent answered</div>
              <div className="probe-cell">Result</div>
            </div>
            {cert.probes?.map((probe) => (
              <div
                className={`probe-row${expanded.has(probe.id) ? ' probe-row--expanded' : ''}`}
                key={probe.id} onClick={() => toggle(probe.id)} title={expanded.has(probe.id) ? '' : 'Click to read the whole question'}
              >
                <div className="probe-cell probe-cell--template">{probe.template}</div>
                <div className="probe-cell probe-cell--question"><span className="probe-text">{probe.prompt}</span></div>
                <div className="probe-cell probe-cell--expected">{probe.expected}</div>
                <div className="probe-cell probe-cell--answer"><span className="probe-text">{probe.answer_head || '-'}</span></div>
                <div className="probe-cell probe-cell--result">
                  <img
                    className="result-icon" width="14" height="14" alt={probe.outcome}
                    src={`/assets/icon-${probe.outcome === 'PASS' ? 'pass' : probe.outcome === 'FAIL' ? 'fail' : 'warning'}.svg`}
                  />
                  <span className="result-label">{probe.outcome}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="certificate-foot">
            <div className="properties-panel bevel-groove">
              <div className="panel-title">Properties</div>
              <div className="properties-grid">
                <span className="prop-key">Agent URL</span><span className="prop-value">{cert.agent_url}</span>
                <span className="prop-key">Claimed model</span>
                <span className="prop-value">{cert.claimed_model} <span className="prop-note">(declared, not verified)</span></span>
                <span className="prop-key">Claimed tier</span><span className="prop-value">{cert.claimed_tier}</span>
                <span className="prop-key">Probe set version</span><span className="prop-value">{cert.probe_set_version}</span>
                {cert.verdict_rule && <>
                  <span className="prop-key">Verdict rule</span><span className="prop-value prop-value--sentence">{cert.verdict_rule}</span>
                </>}
                {cert.created_at && <>
                  <span className="prop-key">Created at</span>
                  <span className="prop-value">{when(cert.created_at)} <span className="prop-note">(written by the contract)</span></span>
                </>}
                {cert.verified_at && <>
                  <span className="prop-key">Verified at</span>
                  <span className="prop-value">{when(cert.verified_at)} <span className="prop-note">(written by the contract)</span></span>
                </>}
                <span className="prop-key">Seed</span><span className="prop-value prop-value--hash">{cert.seed}</span>
                {cert.seed_scheme && <>
                  <span className="prop-key">Seed scheme</span>
                  <span className="prop-value">{cert.seed_scheme}{cert.seed_note && <> <span className="prop-note">({cert.seed_note})</span></>}</span>
                </>}
                <span className="prop-key">Verification ID</span><span className="prop-value prop-value--hash">{cert.verification_id}</span>
                <span className="prop-key">Instance</span><span className="prop-value prop-value--hash">{loaded?.instance}</span>
              </div>
            </div>
            <div className="onchain-panel bevel-groove">
              <div className="panel-title">On-chain</div>
              <div className="onchain-list">
                {loaded?.tx1 && <>
                  <a href={explorerTx(loaded.tx1)} target="_blank" rel="noreferrer">View TX1 (create) on explorer</a>
                  <span className="hash-short">{short(loaded.tx1)}</span>
                </>}
                {loaded?.tx2 && <>
                  <a href={explorerTx(loaded.tx2)} target="_blank" rel="noreferrer">View TX2 (run) on explorer</a>
                  <span className="hash-short">{short(loaded.tx2)}</span>
                </>}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
