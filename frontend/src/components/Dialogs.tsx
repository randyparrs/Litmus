// Error dialogs: one per slot that ended in `error`. The message is the one the logic produced
// (see verify.ts); "Try again" starts a fresh verification, never a blind retry of the write.

import type { Slot, SlotKey } from '../lib/useVerifications';
import type { VerifyInput } from '../lib/verify';
import { Window } from './Window';

export function AgentPanelDialogs({ slots, onDismiss, onRetry }: {
  slots: Record<SlotKey, Slot>;
  onDismiss: (key: SlotKey) => void;
  onRetry: (key: SlotKey, input: VerifyInput) => void;
}) {
  const failed = (Object.keys(slots) as SlotKey[]).filter((k) => slots[k].progress?.phase === 'error');
  if (!failed.length) return null;

  return (
    <>
      {failed.map((key) => (
        <Window key={key} title="Litmus" variant="dialog" onClose={() => onDismiss(key)}>
          <div className="dialog-body">
            <img className="dialog-icon" src="/assets/icon-dialog-error.svg" width="32" height="32" alt="Error" />
            <div className="dialog-text">{slots[key].progress?.error}</div>
          </div>
          <div className="dialog-actions">
            <button
              className="win-button win-button--primary bevel-raised" type="button"
              onClick={() => { const input = slots[key].input; onDismiss(key); if (input) onRetry(key, input); }}
            >
              Try again
            </button>
          </div>
        </Window>
      ))}
    </>
  );
}
