/**
 * ADMIN BY WORKSPACE GROUP, on Databricks Apps.
 *
 * Every request to an App has already passed the workspace sign-in. So the
 * panel needs no password of its own: `POLICY_ADMIN_GROUP` names a workspace
 * group, and its members are the admins. Where users are provisioned from
 * Entra ID (or any IdP) over SCIM, that group is the IdP's own group, and
 * granting or removing an admin happens there with no redeploy.
 *
 * THE TOKEN IS THE ONLY PROOF OF WHO SOMEONE IS. Apps forwards the signed-in
 * user's own token in `X-Forwarded-Access-Token`, with the
 * `iam.current-user:read` scope it grants by default, and the workspace's
 * `/Me` answers who that token belongs to and which groups they are in. The
 * email header is never trusted on its own: it is only checked to agree with
 * the token. Measured on 2026-10-05, the App's own service principal is shown
 * neither a user's groups nor a group's members, so there is no fallback to
 * it, and a lookup that fails is a refusal.
 *
 * THE ANSWER IS REMEMBERED AGAINST THE TOKEN, hashed, for a minute: never
 * against an email, which a request can claim. A removal from the group
 * takes effect within that minute plus the workspace's own delay.
 *
 * OUTSIDE AN APP (`DATABRICKS_APP_NAME` unset) the group setting is ignored and
 * the password gate applies as before.
 *
 * MEMBERSHIP IS DIRECT. SCIM provisioning from Entra does not carry nested
 * groups, so put admins in the named group itself.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { normaliseHost } from '$lib/llm/providers';

const MEMBERSHIP_TTL_MS = 60_000;
const MAX_REMEMBERED = 500;
const memberships = new Map<string, { member: boolean; until: number }>();

export function adminGroup(): string | null {
  if (!process.env.DATABRICKS_APP_NAME) return null;
  return process.env.POLICY_ADMIN_GROUP?.trim() || null;
}

function header(req: IncomingMessage, name: string): string | null {
  const raw = req.headers[name];
  return (Array.isArray(raw) ? raw[0] : raw)?.trim() || null;
}

/** The signed-in workspace user, as the Apps proxy reported them. For messages only. */
export function workspaceUser(req: IncomingMessage): string | null {
  return header(req, 'x-forwarded-email');
}

/** Who a user token belongs to, and the names of the groups they are directly in. */
export type Identity = { userName: string; groups: string[] };
export type WhoIs = (userToken: string) => Promise<Identity>;

export const scimWhoIs: WhoIs = async (userToken) => {
  const host = normaliseHost(process.env.DATABRICKS_HOST);
  if (!host) throw new Error('DATABRICKS_HOST is not set, so group membership cannot be checked.');
  const response = await fetch(`${host}/api/2.0/preview/scim/v2/Me?attributes=userName,groups`, {
    headers: { authorization: `Bearer ${userToken}`, accept: 'application/scim+json' },
  });
  if (!response.ok) throw new Error(`the workspace refused the user's own token: ${response.status}`);
  const me = (await response.json()) as { userName?: string; groups?: { display?: string }[] };
  if (!me.userName) throw new Error('the workspace did not say who the token belongs to');
  return { userName: me.userName, groups: (me.groups ?? []).map((g) => g.display ?? '').filter(Boolean) };
};

let whoIs: WhoIs = scimWhoIs;

/** Tests swap the workspace out. */
export function setWhoIs(next: WhoIs | null): void {
  whoIs = next ?? scimWhoIs;
  memberships.clear();
}

/**
 * True when the caller's own token says they are in the admin group. Anything
 * missing, mismatched or failed is a refusal, logged for the operator, never
 * an opening.
 */
export async function isGroupAdmin(req: IncomingMessage): Promise<boolean> {
  const group = adminGroup();
  const token = header(req, 'x-forwarded-access-token');
  if (!group) return false;
  if (!token) {
    console.warn('admin: no user token reached the app, so nobody can be checked against the admin group. Is user authorisation allowed for Apps in this workspace?');
    return false;
  }
  const key = createHash('sha256').update(token).digest('hex');
  const hit = memberships.get(key);
  if (hit && hit.until > Date.now()) return hit.member;

  let member = false;
  try {
    const me = await whoIs(token);
    const email = workspaceUser(req);
    if (email && email.toLowerCase() !== me.userName.toLowerCase()) {
      console.warn(`admin: the sign-in header said ${email} but the token belongs to ${me.userName}; refused`);
    } else {
      member = me.groups.includes(group);
    }
  } catch (err) {
    console.warn(`admin: could not check against group ${group}: ${(err as Error).message}`);
    return false;
  }
  if (memberships.size >= MAX_REMEMBERED) memberships.delete(memberships.keys().next().value!);
  memberships.set(key, { member, until: Date.now() + MEMBERSHIP_TTL_MS });
  return member;
}
