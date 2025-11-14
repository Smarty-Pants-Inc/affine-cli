import { describe, it, expect, vi } from 'vitest';

var requestMock: any;
vi.mock('../src/http', () => {
  const fn = vi.fn();
  requestMock = fn;
  return { default: fn, request: fn };
});

import { toolsList } from '../src/mcp';

function mkRes(headers: Record<string, string>, body: string) {
  return {
    status: 200,
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    data: body,
    rawBody: Buffer.from(body, 'utf8'),
  } as any;
}

describe('mcp headers', () => {
  it('sets Accept: application/json, text/event-stream on requests', async () => {
    const sse = 'data: {"jsonrpc":"2.0","id":"1","result":{"tools":[]}}\n\n';
    requestMock.mockResolvedValueOnce(mkRes({ 'content-type': 'text/event-stream' }, sse));
    await toolsList('w1');
    expect(requestMock).toHaveBeenCalled();
    const callArgs = requestMock.mock.calls[0]?.[0] ?? {};
    const h = (callArgs.headers ?? {}) as Record<string, string>;
    const accept = String(h.accept || '');
    expect(accept.includes('application/json')).toBe(true);
    expect(accept.includes('text/event-stream')).toBe(true);
  });
});
