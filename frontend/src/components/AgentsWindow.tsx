// Window 4: the three presets as a folder, and one Properties sheet per agent.

import { PRESETS, type Preset } from '../lib/presets';

const ICON: Record<string, string> = {
  'agent-a': '/assets/icon-agent-a.svg',
  'agent-b': '/assets/icon-agent-b.svg',
  'agent-e': '/assets/icon-agent-e.svg',
};

export function AgentsFolder({ onOpen }: { onOpen: (key: Preset['key']) => void }) {
  return (
    <>
      <div className="folder-view bevel-field">
        <div className="folder-items">
          {PRESETS.map((a) => (
            <div className="folder-item" key={a.key} onDoubleClick={() => onOpen(a.key)} onClick={() => onOpen(a.key)}>
              <img className="folder-item-icon" src={ICON[a.key]} width="32" height="32" alt="" />
              <span className="folder-item-label">{a.name}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="status-bar bevel-groove">{PRESETS.length} object(s)</div>
    </>
  );
}

export function AgentProperties({ agent, onClose }: { agent: Preset; onClose: () => void }) {
  return (
    <div className="window-body--properties">
      <div className="properties-head">
        <img className="properties-head-icon" src={ICON[agent.key]} width="32" height="32" alt="" />
        <span className="properties-head-name">{agent.name}</span>
      </div>
      <div className="properties-grid">
        <span className="prop-key">Claimed model</span><span className="meta-value">{agent.claimedModel}</span>
        <span className="prop-key">Claimed tier</span><span className="meta-value">{agent.claimedTier}</span>
        <span className="prop-key">Provider</span><span className="prop-value">{agent.provider}</span>
        <span className="prop-key">Endpoint</span><span className="prop-value">{agent.agentUrl}</span>
      </div>
      <p className="properties-description">{agent.description}</p>
      <div className="properties-actions">
        <button className="win-button win-button--wide bevel-raised" type="button" onClick={onClose}>OK</button>
      </div>
    </div>
  );
}
