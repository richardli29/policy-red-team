import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { adminGroup, isGroupAdmin, scimWhoIs, setWhoIs, workspaceUser } from './workspace-admin';

const as = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;

beforeEach(() => {
  process.env.DATABRICKS_APP_NAME = 'policy-red-team';
  process.env.POLICY_ADMIN_GROUP = 'admins';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.DATABRICKS_APP_NAME;
  delete process.env.POLICY_ADMIN_GROUP;
  delete process.env.DATABRICKS_HOST;
  setWhoIs(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Each token belongs to one person, as the workspace's /Me would say.
const people: Record<string, { userName: string; groups: string[] }> = {
  'admin-token': { userName: 'admin@example.org', groups: ['readers', 'admins'] },
  'reader-token': { userName: 'reader@example.org', groups: ['readers', 'admins-old'] },
};
const workspace = async (token: string) => {
  const who = people[token];
  if (!who) throw new Error('401');
  return who;
};

describe('who is an admin on Databricks Apps', () => {
  it('names a group only on Apps', () => {
    delete process.env.DATABRICKS_APP_NAME;
    expect(adminGroup()).toBeNull();
    process.env.DATABRICKS_APP_NAME = 'policy-red-team';
    expect(adminGroup()).toBe('admins');
    expect(workspaceUser(as({ 'x-forwarded-email': 'a@example.org' }))).toBe('a@example.org');
  });

  it('admits a member and refuses everyone else, matching the group name exactly', async () => {
    setWhoIs(workspace);
    expect(await isGroupAdmin(as({ 'x-forwarded-access-token': 'admin-token', 'x-forwarded-email': 'admin@example.org' }))).toBe(true);
    expect(await isGroupAdmin(as({ 'x-forwarded-access-token': 'reader-token', 'x-forwarded-email': 'reader@example.org' }))).toBe(false);
  });

  it('refuses with no token, a token the workspace rejects, or an email the token does not belong to', async () => {
    setWhoIs(workspace);
    expect(await isGroupAdmin(as({ 'x-forwarded-email': 'admin@example.org' }))).toBe(false);
    expect(await isGroupAdmin(as({ 'x-forwarded-access-token': 'forged', 'x-forwarded-email': 'admin@example.org' }))).toBe(false);
    expect(await isGroupAdmin(as({ 'x-forwarded-access-token': 'admin-token', 'x-forwarded-email': 'someone@example.org' }))).toBe(false);
  });

  it('never lets a claimed email ride on someone else’s remembered answer', async () => {
    setWhoIs(workspace);
    expect(await isGroupAdmin(as({ 'x-forwarded-access-token': 'admin-token', 'x-forwarded-email': 'admin@example.org' }))).toBe(true);
    // The admin's answer is remembered against the admin's token, not the email.
    expect(await isGroupAdmin(as({ 'x-forwarded-access-token': 'reader-token', 'x-forwarded-email': 'admin@example.org' }))).toBe(false);
  });

  it('asks /Me with the user’s own token', async () => {
    process.env.DATABRICKS_HOST = 'x.cloud.databricks.com';
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push(`${url} ${(init.headers as Record<string, string>).authorization}`);
      return new Response(JSON.stringify({ userName: 'a@example.org', groups: [{ display: 'admins' }] }));
    });
    expect(await scimWhoIs('user-token')).toEqual({ userName: 'a@example.org', groups: ['admins'] });
    expect(seen).toEqual(['https://x.cloud.databricks.com/api/2.0/preview/scim/v2/Me?attributes=userName,groups Bearer user-token']);
  });
});
