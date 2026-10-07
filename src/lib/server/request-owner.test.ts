import { afterEach, describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { requestOwner } from '../../../server/owner';

const as = (email?: string) => ({ headers: email ? { 'x-forwarded-email': email } : {} }) as unknown as IncomingMessage;

afterEach(() => {
  delete process.env.POLICY_OWNER_SCOPE;
  delete process.env.DATABRICKS_APP_NAME;
  delete process.env.POLICY_OWNER_EMAIL;
});

describe('whose papers a request may see', () => {
  it('is the one configured owner unless per-user scope is on', () => {
    process.env.POLICY_OWNER_EMAIL = 'team@example.org';
    expect(requestOwner(as('someone@example.org'))).toBe('team@example.org');
  });

  it('is the signed-in reader, lower-cased, with per-user scope on Apps', () => {
    process.env.POLICY_OWNER_SCOPE = 'user';
    process.env.DATABRICKS_APP_NAME = 'policy-red-team';
    expect(requestOwner(as('Alice@Example.org'))).toBe('alice@example.org');
  });

  it('refuses rather than falling back, with no reader or off Apps', () => {
    process.env.POLICY_OWNER_SCOPE = 'user';
    expect(() => requestOwner(as('alice@example.org'))).toThrow(/Databricks Apps/);
    process.env.DATABRICKS_APP_NAME = 'policy-red-team';
    expect(() => requestOwner(as())).toThrow(/sign-in/);
    expect(() => requestOwner(as('not-an-email'))).toThrow(/sign-in/);
  });
});
