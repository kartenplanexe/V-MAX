import { Button, type ButtonProps } from '@maxhub/max-ui';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

export function useExpired(timestamp: string | null | undefined) {
  const deadline = timestamp ? Date.parse(timestamp) : Infinity;
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!Number.isFinite(deadline)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, Math.min(2_147_483_647, deadline - Date.now() + 5)));
    return () => clearTimeout(timer); }, [deadline]);
  return deadline <= Math.max(now, Date.now());
}

export function Action({ className = '', type = 'button', innerClassNames, ...props }: ButtonProps) {
  return <Button type={type} size="medium" className={`ui-action ${className}`} innerClassNames={{ ...innerClassNames, content: `ui-action-content ${innerClassNames?.content ?? ''}` }} {...props} />;
}

type IconName = 'route' | 'pin' | 'clock' | 'calendar' | 'wallet' | 'users' | 'filters' | 'arrow' | 'close' | 'check' | 'alert' | 'map' | 'list' | 'plus' | 'refresh' | 'chevron' | 'walk';
const paths: Record<IconName, ReactNode> = {
  route: <><circle cx="6" cy="5" r="2" /><circle cx="18" cy="19" r="2" /><path d="M6 7v7a4 4 0 0 0 4 4h4M10 5h4a4 4 0 0 1 0 8h-2" /></>,
  pin: <><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 0 1 14 0Z" /><circle cx="12" cy="10" r="2.5" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  calendar: <><rect x="4" y="5" width="16" height="16" rx="3" /><path d="M8 3v4m8-4v4M4 11h16m-12 4h2m4 0h2" /></>,
  wallet: <><rect x="3" y="5" width="18" height="15" rx="3" /><path d="M17 11h4v5h-4a2.5 2.5 0 0 1 0-5ZM6 5V3h11" /></>,
  users: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-2a6 6 0 0 1 12 0v2m1-16a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v2" /></>,
  filters: <><path d="M3 6h7m4 0h7M3 12h3m4 0h11M3 18h11m4 0h3" /><circle cx="12" cy="6" r="2" /><circle cx="8" cy="12" r="2" /><circle cx="16" cy="18" r="2" /></>,
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  check: <path d="m5 12 4 4L19 6" />,
  alert: <><path d="m10 4-8 14a2 2 0 0 0 2 3h16a2 2 0 0 0 2-3L14 4a2.3 2.3 0 0 0-4 0Z" /><path d="M12 9v4m0 4h.01" /></>,
  map: <><path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5Zm6-2v16m6-14v16" /></>,
  list: <><path d="M9 6h12M9 12h12M9 18h12M3 6h.01M3 12h.01M3 18h.01" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  refresh: <><path d="M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5M4 14a8 8 0 0 0 14 5l3-3m0 5v-5h-5" /></>,
  chevron: <path d="m9 5 7 7-7 7" />,
  walk: <><circle cx="13" cy="4" r="2" /><path d="m7 12 3-4 4 1 2 4h4m-8-4-2 7-4 5m5-7 4 3 1 4" /></>,
};
export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return <svg className={`ui-icon ${className}`} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

const scrollLocks = new WeakMap<Document, { count: number; previous: string }>();
function lockPageScroll(owner: Document) {
  const lock = scrollLocks.get(owner) ?? { count: 0, previous: owner.documentElement.style.overflow };
  lock.count++; scrollLocks.set(owner, lock); owner.documentElement.style.overflow = 'hidden';
  return () => {
    // Only the last open sheet restores page scrolling.
    if (--lock.count === 0) { owner.documentElement.style.overflow = lock.previous; scrollLocks.delete(owner); }
  };
}

export function Sheet({ title, children, onClose, className = '', canClose = true }: {
  title: string; children: ReactNode; onClose: () => void; className?: string; canClose?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null), id = useId();
  useEffect(() => { const dialog = ref.current, previous = document.activeElement;
    if (dialog && !dialog.open) dialog.showModal(); const unlock = lockPageScroll(document);
    return () => { unlock(); queueMicrotask(() => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); }); };
  }, []);
  return <dialog ref={ref} className={`planner-sheet ${className}`} aria-labelledby={id} onClose={onClose} onCancel={event => { if (!canClose) event.preventDefault(); }}
    onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect();
      if (canClose && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) onClose(); } }}>
    <div className="sheet-heading"><div><span className="sheet-handle" aria-hidden="true" /><h2 id={id}>{title}</h2></div>
      <Action variant="ghost" className="icon-action" aria-label="Закрыть панель" disabled={!canClose} onClick={onClose}><Icon name="close" /></Action></div>
    {children}
  </dialog>;
}
