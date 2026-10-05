/**
 * ADMIN BY WORKSPACE GROUP, on Databricks Apps.
 *
 * Every request to an App has already passed the workspace sign-in, and the
 * platform's proxy tells the app who it was in `X-Forwarded-Email`. So the
 * panel needs no password of its own: `POLICY_ADMIN_GROUP` names a workspace
 * group, and its members are the admins. Where users are provisioned from
 * Entra ID (or any IdP) over SCIM, that group is the IdP's own group, and
 * granting or removing an admin happens there with no redeploy.
 *
 * THE HEADER IS ONLY BELIEVED ON APPS. Anywhere else a caller can send
 * whatever headers it likes, so outside an App (`DATABRICKS_APP_NAME` unset)
 * the group setting is ignored and the password gate applies as before.
 *
 * MEMBERSHIP IS DIRECT. The lookup is the user's own `groups` in the workspace
 * SCIM API, read with the user's own forwarded token. SCIM provisioning from Entra
 * does not carry nested groups, so put admins in the named group itself.
 */
import type { IncomingMessage } from 'node:http';
import { normaliseHost, workspaceToken } from '$lib/llm/providers';

/** How long one answer about one person is trusted. A removal takes effect within this. */
const MEMBERSHIP_TTL_MS = 60_000;
const memberships = new Map<string, { member: boolean; until: number }>();

export function adminGroup(): string | null {
  if (!process.env.DATABRICKS_APP_NAME) return null;
  return process.env.POLICY_ADMIN_GROUP?.trim() || null;
}

/** The signed-in workspace user, as the Apps proxy reported them. */
export function workspaceUser(req: IncomingMessage): string | null {
  const raw = req.headers['x-forwarded-email'];
  const email = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return email || null;
}

export type GroupLookup = (email: string, group: string, userToken?: string | null) => Promise<boolean>;

/** Whether `email` is a direct member of `group`, asked of the workspace as the App's service principal. */
export const scimLookup: GroupLookup = async (email, group, userToken) => {
  const host = normaliseHost(process.env.DATABRICKS_HOST);
  if (!host) throw new Error('DATABRICKS_HOST is not set, so group membership cannot be checked.');

  /*
   * ASKED AS THE USER FIRST. A workspace shows an App's service principal its
   * users but neither their groups nor a group's members (measured
   * 2026-10-05). Any user can read their own groups, and Apps forwards the
   * signed-in user's token with the `iam.current-user:read` scope it grants by
   * default. The service principal is only the fallback, for a workspace that
   * shows it more.
   */
  if (userToken) {
    const response = await fetch(`${host}/api/2.0/preview/scim/v2/Me?attributes=userName,groups`, {
      headers: { authorization: `Bearer ${userToken}`, accept: 'application/scim+json' },
    });
    if (response.ok) {
      const me = (await response.json()) as { userName?: string; groups?: { display?: string }[] };
      if (me.userName?.toLowerCase() === email.toLowerCase() && me.groups) return me.groups.some((g) => g.display === group);
    } else {
      console.warn(`admin: the user's own token could not read their groups (${response.status}); asking as the app`);
    }
  }

  const token = workspaceToken({
    host,
    clientId: process.env.DATABRICKS_CLIENT_ID ?? '',
    clientSecret: process.env.DATABRICKS_CLIENT_SECRET ?? '',
  });
  const bearer = typeof token === 'string' ? token : await token();
  const get = async (path: string) => {
    const response = await fetch(`${host}/api/2.0/preview/scim/v2/${path}`, {
      headers: { authorization: `Bearer ${bearer}`, accept: 'application/scim+json' },
    });
    if (!response.ok) throw new Error(`the workspace refused the group lookup: ${response.status} ${(await response.text()).slice(0, 200)}`);
    return response.json();
  };
  const quoted = (value: string) => encodeURIComponent(`"${value.replace(/"/g, '')}"`);

  const users = (await get(`Users?filter=userName%20eq%20${quoted(email)}&attributes=id,userName,groups`)) as {
    Resources?: { id?: string; userName?: string; groups?: { display?: string }[] }[];
  };
  const user = users.Resources?.find((r) => r.userName?.toLowerCase() === email.toLowerCase());
  // Said aloud rather than read as "not a member", so the log says which.
  if (!user?.id) throw new Error('the workspace did not return this user to the app');
  // An admin principal sees a user's groups; the App's own principal is not
  // one and is shown the user without them. The group's member list is the
  // same fact from the other side.
  if (user.groups) return user.groups.some((g) => g.display === group);

  const groups = (await get(`Groups?filter=displayName%20eq%20${quoted(group)}&attributes=id,displayName,members`)) as {
    Resources?: { displayName?: string; members?: { value?: string }[] }[];
  };
  const found = groups.Resources?.find((g) => g.displayName === group);
  if (!found) throw new Error(`the workspace has no group called ${group}, or did not show it to the app`);
  if (!found.members) throw new Error('the workspace returned the group without its members');
  return found.members.some((m) => m.value === user.id);
};

let lookup: GroupLookup = scimLookup;

/** Tests swap the workspace out. */
export function setGroupLookup(next: GroupLookup | null): void {
  lookup = next ?? scimLookup;
  memberships.clear();
}

/**
 * True when the caller is in the admin group. A failed lookup is a refusal,
 * logged for the operator, never an opening.
 */
export async function isGroupAdmin(req: IncomingMessage): Promise<boolean> {
  const group = adminGroup();
  const email = workspaceUser(req);
  if (!group || !email) return false;
  const key = email.toLowerCase();
  const hit = memberships.get(key);
  if (hit && hit.until > Date.now()) return hit.member;
  const forwarded = req.headers['x-forwarded-access-token'];
  const userToken = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.trim() || null;
  try {
    const member = await lookup(email, group, userToken);
    memberships.set(key, { member, until: Date.now() + MEMBERSHIP_TTL_MS });
    return member;
  } catch (err) {
    console.warn(`admin: could not check ${email} against group ${group}: ${(err as Error).message}`);
    return false;
  }
}
