/**
 * WHOSE ASSESSMENTS A REQUEST MAY SEE.
 *
 * The store scopes every read and write by an owner, and on a laptop there is
 * one: `POLICY_OWNER_EMAIL`, or `local@localhost`. On Databricks Apps that made
 * every signed-in reader the same owner, so everyone saw, opened and could
 * delete everyone's papers, and shared one persona library built from all of
 * them.
 *
 * `POLICY_OWNER_SCOPE=user` makes the owner the person signed in: the email the
 * Apps proxy puts in `X-Forwarded-Email`, which it sets itself and overwrites
 * if a caller sends one (checked on the live app, 2026-10-05). Each reader then
 * sees only what they submitted, has their own limit of active runs, and their
 * own persona library.
 *
 * FAILS CLOSED. Per-user scope with no signed-in user is a refusal, never a
 * fall back to the shared owner, which would hand a request with a missing
 * header every paper in the install. The header is believed only on Apps.
 */
import type { IncomingMessage } from 'node:http';
import { getOwnerEmails } from '$lib/server/access';
import { HttpError } from './http';

export function perUserOwners(): boolean {
  return process.env.POLICY_OWNER_SCOPE?.trim().toLowerCase() === 'user';
}

export function requestOwner(req: IncomingMessage): string {
  if (!perUserOwners()) return getOwnerEmails()[0];
  if (!process.env.DATABRICKS_APP_NAME) {
    throw new HttpError(500, 'POLICY_OWNER_SCOPE=user needs the Databricks Apps sign-in, and this is not running as an App.');
  }
  const raw = req.headers['x-forwarded-email'];
  const email = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase();
  if (!email || !email.includes('@')) throw new HttpError(401, 'Your sign-in did not reach the app. Reload the page to sign in again.');
  return email;
}
