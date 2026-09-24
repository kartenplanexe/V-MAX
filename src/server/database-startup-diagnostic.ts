/** Keep startup logs actionable without emitting PostgreSQL error messages or credentials. */
export function databaseStartupDiagnostic(error: unknown) {
  if (!error || typeof error !== 'object') return { code: 'UNKNOWN', name: 'Unknown' };
  const candidate = error as { code?: unknown; name?: unknown; message?: unknown };
  const code = typeof candidate.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(candidate.code)
    ? candidate.code : 'UNKNOWN';
  const name = typeof candidate.name === 'string' && /^[A-Za-z]{1,40}$/.test(candidate.name)
    ? candidate.name : 'Unknown';
  const symptom = typeof candidate.message === 'string' && /connection timeout/i.test(candidate.message)
    ? 'CONNECTION_TIMEOUT' : undefined;
  return { code, name, ...(symptom ? { symptom } : {}) };
}
