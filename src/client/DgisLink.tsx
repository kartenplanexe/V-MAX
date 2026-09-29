import type { ReactNode } from 'react';

export function DgisLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return <a className={className} href={href} target="_blank" rel="noopener noreferrer" onClick={event => {
    if (window.WebApp?.openLink) {
      try { window.WebApp.openLink(href); event.preventDefault(); } catch { return; }
    }
  }}>{children}</a>;
}
