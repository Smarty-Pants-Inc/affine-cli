import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/graphql', () => ({
  gql: vi.fn(),
}));

import { gql } from '../src/graphql';
import { whoami } from '../src/auth';

const gqlMock = gql as any;

describe('auth.whoami', () => {
  beforeEach(() => {
    gqlMock.mockReset();
  });

  it('returns id and email when a compatible user field is present', async () => {
    gqlMock.mockResolvedValueOnce({ me: { id: 'u1', email: 'user@example.com' } });

    const me = await whoami({ baseUrl: 'http://example' } as any);
    expect(me).toEqual({ id: 'u1', email: 'user@example.com' });
    expect(gqlMock).toHaveBeenCalledTimes(1);
  });

  it('treats auth failures as not authenticated instead of throwing', async () => {
    gqlMock.mockRejectedValueOnce(new Error('Unauthenticated'));

    const me = await whoami({ baseUrl: 'http://example' } as any);
    expect(me).toBeNull();
    expect(gqlMock).toHaveBeenCalledTimes(1);
  });

  it('throws when no compatible user field can be resolved', async () => {
    gqlMock.mockRejectedValue(new Error('GraphQL schema mismatch'));

    await expect(whoami({ baseUrl: 'http://example' } as any)).rejects.toThrow(
      'Unable to determine current user',
    );
    expect(gqlMock).toHaveBeenCalledTimes(3);
  });
});
