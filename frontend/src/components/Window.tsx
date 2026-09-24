import { useEffect, useRef, type ReactNode } from 'react';

// Window chrome from the design: title bar with icon, minimize and close.
export function Window({ title, icon, variant, active = true, onMinimize, onClose, children }: {
  title: string;
  icon?: string;
  variant: string;         // verifier | certificate | how-it-works | agents | properties | dialog
  active?: boolean;
  onMinimize?: () => void;
  onClose?: () => void;
  children: ReactNode;
}) {
  // Open windows stack down the desktop, so the one just focused is scrolled into view.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { if (active) box.current?.scrollIntoView({ block: 'nearest' }); }, [active]);

  return (
    <div ref={box} className={`window window--${variant} bevel-raised`}>
      <div className={`title-bar${active ? '' : ' title-bar--inactive'}`}>
        {icon && <img className="title-bar-icon" src={icon} width="14" height="14" alt="" />}
        <span className="title-bar-text">{title}</span>
        {onMinimize && (
          <button className="title-button title-button--minimize bevel-raised" type="button" aria-label="Minimize" onClick={onMinimize}>
            <span className="minimize-glyph"></span>
          </button>
        )}
        {onClose && (
          <button className="title-button bevel-raised" type="button" aria-label="Close" onClick={onClose}>&#10005;</button>
        )}
      </div>
      {children}
    </div>
  );
}
