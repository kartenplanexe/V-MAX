import { describe, expect, it } from 'vitest';
import { databaseStartupDiagnostic } from './database-startup-diagnostic.js';

describe('databaseStartupDiagnostic', () => {
  it('reports a PostgreSQL error code without including its message', () => {
    expect(databaseStartupDiagnostic({ name: 'DatabaseError', code: '28P01', message: 'password leaked here' }))
      .toEqual({ code: '28P01', name: 'DatabaseError' });
  });

  it('does not copy arbitrary error fields into logs', () => {
    expect(databaseStartupDiagnostic({ name: 'Bad name', code: 'secret:password', message: 'secret:password' }))
      .toEqual({ code: 'UNKNOWN', name: 'Unknown' });
  });

  it('identifies a timeout with no standard code', () => {
    expect(databaseStartupDiagnostic(new Error('Connection terminated due to connection timeout')))
      .toEqual({ code: 'UNKNOWN', name: 'Error', symptom: 'CONNECTION_TIMEOUT' });
  });
});
