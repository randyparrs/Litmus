// The Litmus desktop: icon dock, windows, taskbar. Every window reads from the logic in
// src/lib; nothing here talks to the chain directly.

import { useState } from 'react';
import { PRESETS, type Preset } from './lib/presets';
import { useVerifications, type SlotKey } from './lib/useVerifications';
import { useWallet } from './lib/useWallet';
import type { VerifyInput } from './lib/verify';
import { AgentPanelDialogs } from './components/Dialogs';
import { AgentProperties, AgentsFolder } from './components/AgentsWindow';
import { CertificateWindow } from './components/CertificateWindow';
import { ConnectAgentWindow } from './components/ConnectAgentWindow';
import { HowItWorksWindow } from './components/HowItWorksWindow';
import { VerifierWindow } from './components/VerifierWindow';
import { WalletHeader } from './components/WalletHeader';
import { Window } from './components/Window';

type WindowId = 'verifier' | 'certificate' | 'connect-agent' | 'how-it-works' | 'agents'
  | 'props-agent-a' | 'props-agent-b' | 'props-agent-e';

const DOCK: { id: WindowId; label: string; icon: string }[] = [
  { id: 'verifier', label: 'Verifier', icon: '/assets/icon-verifier.svg' },
  { id: 'certificate', label: 'Certificate', icon: '/assets/icon-certificate.svg' },
  { id: 'connect-agent', label: 'Connect agent', icon: '/assets/icon-connect-agent.svg' },
  { id: 'how-it-works', label: 'How it works', icon: '/assets/icon-how-it-works.svg' },
  { id: 'agents', label: 'Agents', icon: '/assets/icon-agents.svg' },
];

const TITLE: Record<WindowId, string> = {
  verifier: 'Verifier',
  certificate: 'Certificate',
  'connect-agent': 'Connect your agent',
  'how-it-works': 'How it works',
  agents: 'Agents',
  'props-agent-a': 'Agent A Properties',
  'props-agent-b': 'Agent B Properties',
  'props-agent-e': 'Agent E Properties',
};

const TITLE_ICON: Partial<Record<WindowId, string>> = {
  verifier: '/assets/title-icon-verifier.svg',
  certificate: '/assets/title-icon-certificate.svg',
  'connect-agent': '/assets/title-icon-connect-agent.svg',
  'how-it-works': '/assets/title-icon-how-it-works.svg',
  agents: '/assets/title-icon-agents.svg',
};

export default function App() {
  const wallet = useWallet();
  const { slots, start, dismiss, reset } = useVerifications();
  const [open, setOpen] = useState<WindowId[]>(['verifier']);   // order = z-order, last is active
  const [minimized, setMinimized] = useState<WindowId[]>([]);
  const [certificateId, setCertificateId] = useState<string | undefined>();

  const active = open.filter((w) => !minimized.includes(w)).at(-1);
  // One window on screen at a time: opening or focusing one minimizes the rest to the taskbar,
  // so the new window lands centred instead of stacking on top of the others.
  const focus = (id: WindowId) => {
    setOpen((o) => {
      const next = [...o.filter((w) => w !== id), id];
      setMinimized(next.filter((w) => w !== id));
      return next;
    });
  };
  const close = (id: WindowId) => {
    setOpen((o) => o.filter((w) => w !== id));
    setMinimized((m) => m.filter((w) => w !== id));
  };

  // The wallet pays the GEN fees, so VERIFY stays disabled until it can actually sign.
  const canVerify = !!wallet.signer && wallet.hasGas;
  const gateNote = !wallet.connected
    ? 'Connect your wallet to verify: every call is signed by you and pays its GEN fees.'
    : wallet.wrongChain ? 'Switch your wallet to GenLayer Studio Next.'
    : !wallet.hasGas ? 'You need GEN to pay the fees (fund the wallet on Studio Next).'
    : '';

  const verify = (key: SlotKey, input: VerifyInput) => {
    if (wallet.signer) void start(key, input, wallet.signer);
  };
  // The three presets at once. Measured on-chain (E2E 2026-09-24): three flows from the same
  // signer, writes signed one after the other, consensus as clean as one at a time.
  const verifyAll = () => {
    const signer = wallet.signer;
    if (!signer) return;
    for (const p of PRESETS) {
      void start(p.key, { agentUrl: p.agentUrl, claimedModel: p.claimedModel, claimedTier: p.claimedTier }, signer);
    }
  };
  const openCertificate = (key: SlotKey) => {
    setCertificateId(slots[key].progress?.verificationId);
    focus('certificate');
  };

  const body = (id: WindowId) => {
    switch (id) {
      case 'verifier':
        return <VerifierWindow
          slots={slots} gateNote={gateNote} canVerify={canVerify}
          onVerify={verify} onVerifyAll={verifyAll} onOpenCertificate={openCertificate} onReset={reset}
        />;
      case 'certificate':
        return <CertificateWindow selectedId={certificateId} onSelect={setCertificateId} />;
      case 'connect-agent':
        return <ConnectAgentWindow onGoToVerifier={() => focus('verifier')} />;
      case 'how-it-works':
        return <HowItWorksWindow />;
      case 'agents':
        return <AgentsFolder onOpen={(key) => focus(`props-${key}` as WindowId)} />;
      case 'props-agent-a':
      case 'props-agent-b':
      case 'props-agent-e': {
        const agent = PRESETS.find((p) => id.endsWith(p.key)) as Preset;
        return <AgentProperties agent={agent} onClose={() => close(id)} />;
      }
    }
  };

  const variant = (id: WindowId) => (id.startsWith('props-') ? 'properties' : id);

  return (
    <div className="desktop">
      <div className="desktop-header bevel-raised">
        <div className="brand">
          <span className="brand-name">Litmus</span>
          <span className="brand-tagline">consensus proof of agent capability</span>
        </div>
        <div className="header-spacer"></div>
        <WalletHeader wallet={wallet} />
      </div>

      <div className="desktop-main">
        <div className="icon-dock">
          {DOCK.map((item) => (
            <a
              key={item.id} href="#" className={`dock-item${active === item.id ? ' dock-item--active' : ''}`}
              onClick={(e) => { e.preventDefault(); focus(item.id); }}
            >
              <img className="dock-icon" src={item.icon} width="32" height="32" alt="" />
              <span className="dock-label">{item.label}</span>
            </a>
          ))}
        </div>
        <img className="desktop-watermark" src="/assets/watermark-litmus.svg" width="330" height="64" alt="" />

        <div className="window-area">
          {open.filter((id) => !minimized.includes(id)).map((id) => (
            <Window
              key={id} title={TITLE[id]} icon={TITLE_ICON[id]} variant={variant(id)} active={active === id}
              onMinimize={id.startsWith('props-') ? undefined : () => setMinimized((m) => [...m, id])}
              onClose={() => close(id)}
            >
              {body(id)}
            </Window>
          ))}
          <AgentPanelDialogs slots={slots} onDismiss={dismiss} onRetry={verify} />
        </div>
      </div>

      <div className="taskbar">
        <div className="start-button bevel-raised">
          <img className="start-logo" src="/assets/icon-start.svg" width="16" height="16" alt="" />
          <span>Start</span>
        </div>
        <div className="taskbar-divider"></div>
        {open.map((id) => (
          <button
            key={id} type="button"
            className={`taskbar-item ${active === id ? 'taskbar-item--active bevel-pressed' : 'bevel-raised'}`}
            onClick={() => (active === id ? setMinimized((m) => [...m, id]) : focus(id))}
          >
            {TITLE[id]}
          </button>
        ))}
      </div>
    </div>
  );
}
