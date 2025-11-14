import type { HttpOptions } from './http';
import { gql, listAccessTokens, createAccessToken, revokeAccessToken, type AccessToken } from './graphql';

export type WhoAmI = { id: string; email?: string | null } | null;

async function tryQuery(query: string, field: 'me' | 'currentUser' | 'viewer', opts?: HttpOptions): Promise<WhoAmI> {
  try {
    const data = await gql<Record<string, { id: string; email?: string | null } | null>>(query, undefined, opts);
    const user = data[field];
    if (!user) return null;
    return { id: user.id, email: user.email ?? null };
  } catch (err: any) {
    const msg = String(err?.message || '').toLowerCase();
    // Treat obvious auth failures as "not authenticated" so the CLI can
    // surface a clear message instead of a generic probe error.
    if (
      msg.includes('unauthenticated') ||
      msg.includes('unauthorized') ||
      msg.includes('forbidden') ||
      msg.includes('not authenticated')
    ) {
      return null;
    }
    return undefined as unknown as WhoAmI; // Signal to caller to try next probe
  }
}

export async function whoami(opts?: HttpOptions): Promise<WhoAmI> {
  // Probe in order: me, currentUser, viewer
  const qMe = /* GraphQL */ `query WhoAmIMe { me { id email } }`;
  const qCurrent = /* GraphQL */ `query WhoAmICurrent { currentUser { id email } }`;
  const qViewer = /* GraphQL */ `query WhoAmIViewer { viewer { id email } }`;

  const r1 = await tryQuery(qMe, 'me', opts);
  if (r1 !== (undefined as unknown as WhoAmI)) return r1;
  const r2 = await tryQuery(qCurrent, 'currentUser', opts);
  if (r2 !== (undefined as unknown as WhoAmI)) return r2;
  const r3 = await tryQuery(qViewer, 'viewer', opts);
  if (r3 !== (undefined as unknown as WhoAmI)) return r3;
  throw new Error('Unable to determine current user (no compatible GraphQL user field)');
}

export type { AccessToken };
export const tokens = {
  list: (opts?: HttpOptions): Promise<AccessToken[]> => listAccessTokens(opts),
  create: (name: string, expiresAt?: string, opts?: HttpOptions): Promise<AccessToken> =>
    createAccessToken(name, expiresAt, opts),
  revoke: (id: string, opts?: HttpOptions): Promise<boolean> => revokeAccessToken(id, opts),
};

export default { whoami, tokens };
