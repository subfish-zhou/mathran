/**
 * Authentication shim for the standalone runtime.
 *
 * Mathub authenticates web users via NextAuth. mathran runs as a local,
 * single-operator workstation (PRD §3b) with no web session layer, so there is
 * no ambient user session: `auth()` resolves to `null`. The Agent Gateway's
 * `resolvePrincipal` treats a null session as "no authenticated user", which is
 * the correct default for the standalone build. Tests stub this module.
 */

export interface Session {
  user?: {
    id?: string | null;
    name?: string | null;
    email?: string | null;
  } | null;
}

export async function auth(): Promise<Session | null> {
  return null;
}
