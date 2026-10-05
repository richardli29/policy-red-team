import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { adminGroup, isGroupAdmin, scimLookup, setGroupLookup, workspaceUser } from './workspace-admin';

const as = (email?: string) => ({ headers: email ? { 'x-forwarded-email': email } : {} }) as IncomingMessage;

afterEach(() => {
  delete process.env.DATABRICKS_APP_NAME;
  delete process.env.POLICY_ADMIN_GROUP;
  delete process.env.DATABRICKS_HOST;
  setGroupLookup(null);
  vi.unstubAllGlobals();
});

describe('who is an admin on Databricks Apps', () => {
  it('names a group only on Apps, where the sign-in header can be trusted', () => {
    process.env.POLICY_ADMIN_GROUP = 'policy-red-team-admins';
    expect(adminGroup()).toBeNull();
    process.env.DATABRICKS_APP_NAME = 'policy-red-team';
    expect(adminGroup()).toBe('policy-red-team-admins');
  });

  it('reads the signed-in user from the proxy header', () => {
    expect(workspaceUser(as('a@example.org'))).toBe('a@example.org');
    expect(workspaceUser(as())).toBeNull();
  });

  it('admits members, refuses others, and refuses when the lookup fails', async () => {
    process.env.DATABRICKS_APP_NAME = 'policy-red-team';
    process.env.POLICY_ADMIN_GROUP = 'admins';
    setGroupLookup(async (email) => {
      if (email === 'broken@example.org') throw new Error('500');
      return email === 'admin@example.org';
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await isGroupAdmin(as('admin@example.org'))).toBe(true);
    expect(await isGroupAdmin(as('reader@example.org'))).toBe(false);
    expect(await isGroupAdmin(as('broken@example.org'))).toBe(false);
    expect(await isGroupAdmin(as())).toBe(false);
  });

  it('asks the workspace for the user’s own groups and matches the name exactly', async () => {
    process.env.DATABRICKS_HOST = 'x.cloud.databricks.com';
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/oidc/v1/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
      urls.push(url);
      return new Response(JSON.stringify({ Resources: [{ id: 'u1', userName: 'A@example.org', groups: [{ display: 'admins-old' }, { display: 'admins' }] }] }));
    });
    expect(await scimLookup('a@example.org', 'admins')).toBe(true);
    expect(await scimLookup('a@example.org', 'admin')).toBe(false);
    expect(decodeURIComponent(urls[0])).toContain('/api/2.0/preview/scim/v2/Users?filter=userName eq "a@example.org"');
  });

  it('asks as the signed-in user, with the token Apps forwards, before the app’s own principal', async () => {
    process.env.DATABRICKS_HOST = 'x.cloud.databricks.com';
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push(`${url.split('/v2/')[1]} ${(init.headers as Record<string, string>).authorization}`);
      return new Response(JSON.stringify({ userName: 'a@example.org', groups: [{ display: 'admins' }] }));
    });
    expect(await scimLookup('a@example.org', 'admins', 'user-token')).toBe(true);
    expect(seen).toEqual(['Me?attributes=userName,groups Bearer user-token']);
  });

  it('reads the group’s members when the workspace hides a user’s groups from the app', async () => {
    // What a workspace on 2026-10-05 showed an App's service principal.
    process.env.DATABRICKS_HOST = 'x.cloud.databricks.com';
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/oidc/v1/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
      if (url.includes('/Users?')) return new Response(JSON.stringify({ Resources: [{ id: 'u1', userName: 'a@example.org' }] }));
      return new Response(JSON.stringify({ Resources: [{ displayName: 'admins', members: [{ value: 'u0' }, { value: 'u1' }] }] }));
    });
    expect(await scimLookup('a@example.org', 'admins')).toBe(true);
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('/Users?')) return new Response(JSON.stringify({ Resources: [{ id: 'u2', userName: 'b@example.org' }] }));
      return new Response(JSON.stringify({ Resources: [{ displayName: 'admins', members: [{ value: 'u1' }] }] }));
    });
    expect(await scimLookup('b@example.org', 'admins')).toBe(false);
  });
});
