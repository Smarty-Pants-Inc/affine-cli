import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/http', () => {
  const fn = vi.fn();
  return {
    default: fn,
    request: fn,
  };
});

import { get, rm } from '../src/blobs';
import request from '../src/http';

const requestMock = request as any;

function mkJsonResponse(payload: any) {
  return {
    status: 200,
    headers: {},
    data: payload,
    rawBody: Buffer.from(JSON.stringify(payload), 'utf8'),
  } as any;
}

describe('blobs alias resolution', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it('uses workspace.blobs GraphQL lookup and resolved key when fetching a blob', async () => {
    const workspaceId = 'ws-blobs-1';
    const alias = 'alias-key.txt';

    // First call: GraphQL workspace.blobs listing
    requestMock
      .mockImplementationOnce(async (opts: any) => {
        expect(opts.path).toBe('/graphql');
        const q = String(opts.json?.query ?? '');
        expect(q).toContain('ListBlobs');
        const payload = {
          data: {
            workspace: {
              blobs: [{ key: alias }],
            },
          },
        };
        return mkJsonResponse(payload);
      })
      // Second call: REST GET using resolved key
      .mockImplementationOnce(async (opts: any) => {
        expect(opts.method).toBe('GET');
        expect(opts.path).toBe(`/api/workspaces/${encodeURIComponent(workspaceId)}/blobs/${encodeURIComponent(alias)}`);
        const buf = Buffer.from('ok', 'utf8');
        return {
          status: 200,
          headers: {},
          data: buf,
          rawBody: buf,
        } as any;
      });

    const res = await get(workspaceId, alias, { baseUrl: 'http://example' } as any);
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(res.ok).toBe(true);
    if ('buffer' in res && res.buffer) {
      expect(res.buffer.toString('utf8')).toBe('ok');
    }
  });

  it('falls back to treating alias as key when workspace.blobs GraphQL returns errors, and does not fabricate success', async () => {
    const workspaceId = 'ws-blobs-err';
    const alias = 'secret-alias';

    // First call: GraphQL workspace.blobs with a GraphQL-style error payload
    requestMock
      .mockImplementationOnce(async (opts: any) => {
        expect(opts.path).toBe('/graphql');
        const payload = {
          errors: [{ message: 'You must sign in first' }],
        };
        return mkJsonResponse(payload);
      })
      // Second call: REST GET using alias as key, which fails with a non-redirect error
      .mockImplementationOnce(async (opts: any) => {
        expect(opts.method).toBe('GET');
        expect(opts.path).toBe(`/api/workspaces/${encodeURIComponent(workspaceId)}/blobs/${encodeURIComponent(alias)}`);
        const err: any = new Error('Not found');
        err.status = 404;
        throw err;
      });

    await expect(get(workspaceId, alias, { baseUrl: 'http://example' } as any)).rejects.toThrow('Not found');
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('uses resolved key for rm and returns the underlying deleteBlob result', async () => {
    const workspaceId = 'ws-blobs-2';
    const alias = 'alias-to-delete';

    requestMock
      // workspace.blobs listing
      .mockImplementationOnce(async (opts: any) => {
        expect(opts.path).toBe('/graphql');
        const q = String(opts.json?.query ?? '');
        expect(q).toContain('ListBlobs');
        const payload = {
          data: {
            workspace: {
              blobs: [{ key: alias }],
            },
          },
        };
        return mkJsonResponse(payload);
      })
      // deleteBlob mutation
      .mockImplementationOnce(async (opts: any) => {
        expect(opts.path).toBe('/graphql');
        const q = String(opts.json?.query ?? '');
        expect(q).toContain('DeleteBlob');
        expect(opts.json?.variables).toEqual({ workspaceId, key: alias });
        const payload = { data: { deleteBlob: true } };
        return mkJsonResponse(payload);
      });

    const ok = await rm(workspaceId, alias, { baseUrl: 'http://example' } as any);
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(ok).toBe(true);
  });

  it('surfaces deleteBlob GraphQL errors instead of pretending rm succeeded', async () => {
    const workspaceId = 'ws-blobs-3';
    const alias = 'alias-error';

    requestMock
      // workspace.blobs listing (success so alias resolution itself does not fail)
      .mockImplementationOnce(async () => {
        const payload = {
          data: {
            workspace: {
              blobs: [{ key: alias }],
            },
          },
        };
        return mkJsonResponse(payload);
      })
      // deleteBlob mutation returns GraphQL-level errors
      .mockImplementationOnce(async (opts: any) => {
        expect(opts.path).toBe('/graphql');
        const payload = {
          errors: [{ message: 'You must sign in first' }],
        };
        return mkJsonResponse(payload);
      });

    await expect(rm(workspaceId, alias, { baseUrl: 'http://example' } as any)).rejects.toThrow('You must sign in first');
    expect(requestMock).toHaveBeenCalledTimes(2);
  });
});
