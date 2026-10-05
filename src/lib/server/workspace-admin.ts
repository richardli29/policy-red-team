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
 * SCIM API, read as the App's service principal. SCIM provisioning from Entra
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

export type GroupLookup = (email: string, group: string) => Promise<boolean>;

/** Whether `email` is a direct member of `group`, asked of the workspace as the App's service principal. */
export const scimLookup: GroupLookup = async (email, group) => {
  const host = normaliseHost(process.env.DATABRICKS_HOST);
  if (!host) throw new Error('DATABRICKS_HOST is not set, so group membership cannot be checked.');
  const token = workspaceToken({
    host,
    clientId: process.env.DATABRICKS_CLIENT_ID ?? '',
    clientSecret: process.env.DATABRICKS_CLIENT_SECRET ?? '',
  });
  const bearer = typeof token === 'string' ? token : await token();
  const filter = encodeURIComponent(`userName eq "${email.replace(/"/g, '')}"`);
  const response = await fetch(`${host}/api/2.0/preview/scim/v2/Users?filter=${filter}&attributes=userName,groups`, {
    headers: { authorization: `Bearer ${bearer}`, accept: 'application/scim+json' },
  });
  if (!response.ok) throw new Error(`The workspace refused the group lookup: ${response.status} ${(await response.text()).slice(0, 200)}`);
  const body = (await response.json()) as { Resources?: { userName?: string; groups?: { display?: string }[] }[] };
  const user = body.Resources?.find((r) => r.userName?.toLowerCase() === email.toLowerCase());
  return !!user?.groups?.some((g) => g.display === group);
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
  try {
    const member = await lookup(email, group);
    memberships.set(key, { member, until: Date.now() + MEMBERSHIP_TTL_MS });
    return member;
  } catch (err) {
    console.warn(`admin: could not check ${email} against group ${group}: ${(err as Error).message}`);
    return false;
  }
}
