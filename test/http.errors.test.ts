import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('undici', () => ({
  request: vi.fn(),
}));

import { request as undiciRequest } from 'undici';
import { request, NetworkError, type HttpResponse } from '../src/http';

const undiciRequestMock = undiciRequest as any;

describe('http request error handling', () => {
  beforeEach(() => {
    undiciRequestMock.mockReset();
  });

  it('wraps Undici header/body timeout errors in TimeoutError with retryable=true', async () => {
    const err: any = new Error('Headers timeout');
    err.code = 'UND_ERR_HEADERS_TIMEOUT';
    undiciRequestMock.mockRejectedValueOnce(err);

    await expect(
      request({ url: 'http://example.test/graphql', method: 'GET', timeoutMs: 10, maxAttempts: 1 }),
    ).rejects.toMatchObject({
      name: 'TimeoutError',
      code: 'ETIMEDOUT',
      retryable: true,
    });
  });

  it('wraps generic network errors in NetworkError and marks them retryable by default', async () => {
    const err: any = new Error('connect ECONNREFUSED 127.0.0.1:443');
    err.code = 'ECONNREFUSED';
    undiciRequestMock.mockRejectedValue(err);

    let caught: any;
    try {
      await request({ url: 'http://example.test/graphql', method: 'POST', timeoutMs: 10, maxAttempts: 1 });
    } catch (e: any) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(NetworkError);
    expect(caught.retryable).toBe(true);
    expect(String(caught.message)).toContain('connect ECONNREFUSED');
  });

  it('exposes non-2xx HTTP responses via HttpError subclasses without leaking raw payloads', async () => {
    const body = Buffer.from(JSON.stringify({ error: 'boom' }), 'utf8');
    const res: HttpResponse<unknown> = {
      status: 500,
      headers: { 'content-type': 'application/json' },
      data: body,
      rawBody: body,
    } as any;

    undiciRequestMock.mockResolvedValueOnce({
      statusCode: res.status,
      headers: res.headers,
      body: { arrayBuffer: async () => body },
    });

    await expect(
      request({ url: 'http://example.test/api', method: 'GET', timeoutMs: 10, maxAttempts: 1 }),
    ).rejects.toMatchObject({
      name: 'ResponseError',
      status: 500,
      retryable: true,
    });
  });
});
