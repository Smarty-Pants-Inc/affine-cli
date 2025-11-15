import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/http', () => {
  const fn = vi.fn();
  return { default: fn, request: fn };
});

import request from '../src/http';
import { readDocument, semanticSearch } from '../src/mcp';

const requestMock = request as any;

function mkRes(headers: Record<string, string>, body: string) {
  return {
    status: 200,
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    data: body,
    rawBody: Buffer.from(body, 'utf8'),
  } as any;
}

describe('mcp error handling', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it('readDocument surfaces JSON-RPC errors from SSE streams with tool-specific messages', async () => {
    const sse = 'data: {"jsonrpc":"2.0","id":"1","error":{"code":-32601,"message":"tool read_document not found"}}\n\n';
    requestMock.mockResolvedValueOnce(mkRes({ 'content-type': 'text/event-stream' }, sse));

    await expect(readDocument('ws-rpc', 'doc-404')).rejects.toMatchObject({
      message: 'tool read_document not found',
      code: -32601,
    } as any);
  });

  it('semanticSearch propagates JSON-RPC errors from JSON responses', async () => {
    const payload = {
      jsonrpc: '2.0',
      id: '1',
      error: { code: 42, message: 'semantic_search disabled for this workspace' },
    };
    const body = JSON.stringify(payload);
    requestMock.mockResolvedValueOnce(mkRes({ 'content-type': 'application/json' }, body));

    await expect(semanticSearch('ws-sem', 'test query', undefined, { baseUrl: 'http://example' } as any)).rejects
      .toMatchObject({
        message: 'semantic_search disabled for this workspace',
        code: 42,
      } as any);
  });
});
