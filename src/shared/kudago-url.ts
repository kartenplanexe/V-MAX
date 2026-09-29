export function kudagoSourceUrl(value: string | null | undefined): string | undefined {
  try {
    const url = new URL(value ?? '');
    const host = url.hostname;
    return url.protocol === 'https:' && (host === 'kudago.com' || host.endsWith('.kudago.com')) &&
      !url.username && !url.password && !url.port && !url.hash && !url.search ? url.href : undefined;
  } catch { return undefined; }
}

export function kudagoEventUrl(value: string | null | undefined): string | undefined {
  const safe = kudagoSourceUrl(value);
  return safe && /^\/(?:[a-z0-9-]+\/)?event\/[a-z0-9_-]+\/$/u.test(new URL(safe).pathname) ? safe : undefined;
}
