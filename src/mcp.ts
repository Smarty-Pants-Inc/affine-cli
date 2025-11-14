/**
 * Native MCP client over HTTP (CLI-008)
 *
 * POST /api/workspaces/:id/mcp with JSON-RPC 2.0 envelope.
 * Accept: application/json, text/event-stream
 * Content-Type: application/json
 */

import request, { type HttpOptions, type HttpResponse } from './http';

export type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, any>;
};

export type JsonRpcSuccess<T = any> = {
  jsonrpc: '2.0';
  id: string | number | null;
  result: T;
};

export type JsonRpcError = {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data?: any };
};

export type McpTool = {
  name: string;
  description?: string | null;
  inputSchema?: any;
};

export type ToolCallResult = any;

export type SearchMatch = {
  id?: string;
  score?: number;
  snippet?: string;
  [k: string]: any;
};

function buildPath(workspaceId: string): string {
  const id = encodeURIComponent(workspaceId);
  return `/api/workspaces/${id}/mcp`;
}

function newId(): string {
  return Math.random().toString(36).slice(2);
}

function headers(opts?: HttpOptions): Record<string, string> {
  return {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    ...(opts?.headers ?? {}),
  };
}

function isEventStream(res: HttpResponse<any>): boolean {
  const ct = res.headers['content-type'] || '';
  return ct.toLowerCase().includes('text/event-stream');
}

function parseSsePayload(text: string): any | undefined {
  // Collect last JSON object from lines beginning with "data:"
  const lines = text.split(/\r?\n/);
  let last: any | undefined;
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const json = line.slice(5).trim();
    if (!json) continue;
    try {
      last = JSON.parse(json);
    } catch {
      // ignore malformed chunk, continue
    }
  }
  return last;
}

function unwrapRpc<T = any>(payload: any): T {
  if (payload && typeof payload === 'object') {
    if ('error' in payload && payload.error) {
      const e = new Error(payload.error.message || 'MCP error');
      (e as any).code = payload.error.code;
      (e as any).data = payload.error.data;
      throw e;
    }
    if ('result' in payload) return payload.result as T;
  }
  return payload as T;
}

async function rpc<T = any>(workspaceId: string, method: string, params?: Record<string, any>, opts?: HttpOptions): Promise<T> {
  const body: JsonRpcRequest = { jsonrpc: '2.0', id: newId(), method, params };
  const res = await request<string>({
    baseUrl: (opts as any)?.baseUrl,
    path: buildPath(workspaceId),
    method: 'POST',
    headers: headers(opts),
    json: body,
    token: (opts as any)?.token,
    cookie: (opts as any)?.cookie,
    timeoutMs: (opts as any)?.timeoutMs,
    debug: (opts as any)?.debug,
    responseType: 'text',
  });

  let payload: any;
  if (isEventStream(res)) {
    const text = res.data ?? res.rawBody.toString('utf8');
    payload = parseSsePayload(String(text));
  } else {
    // JSON fallback
    const str = res.data ?? res.rawBody.toString('utf8');
    try {
      payload = JSON.parse(String(str));
    } catch (e) {
      const err = new Error('Failed to parse JSON response');
      (err as any).cause = e;
      throw err;
    }
  }
  return unwrapRpc<T>(payload);
}

export async function toolsList(workspaceId: string, opts?: HttpOptions): Promise<McpTool[]> {
  const result = await rpc<{ tools: McpTool[] } | McpTool[]>(workspaceId, 'tools/list', {}, opts);
  if (Array.isArray(result)) return result;
  if (result && Array.isArray((result as any).tools)) return (result as any).tools as McpTool[];
  return [];
}

export async function callTool(workspaceId: string, name: string, params?: Record<string, any>, opts?: HttpOptions): Promise<ToolCallResult> {
  const result = await rpc<any>(workspaceId, 'tools/call', { name, arguments: params ?? {} }, opts);
  return result;
}

export async function readDocument(workspaceId: string, docId: string, opts?: HttpOptions): Promise<{ docId: string; markdown: string }> {
  const out = await callTool(workspaceId, 'read_document', { docId }, opts);
  let markdown = '';
  if (typeof out === 'string') {
    markdown = out;
  } else if (out && typeof out.markdown === 'string') {
    markdown = out.markdown;
  } else if (Array.isArray(out?.content)) {
    const texts: string[] = [];
    for (const c of out.content) {
      if (c && typeof c.text === 'string') texts.push(c.text);
      else if (typeof c === 'string') texts.push(c);
    }
    markdown = texts.join('\n');
  } else if (out && typeof out.text === 'string') {
    markdown = out.text;
  }
  return { docId, markdown };
}

export async function semanticSearch(
  workspaceId: string,
  query: string,
  searchOpts?: Record<string, any>,
  opts?: HttpOptions,
): Promise<SearchMatch[]> {
  const out = await callTool(workspaceId, 'semantic_search', { query, ...(searchOpts ?? {}) }, opts);
  return normalizeMatches(out);
}

export async function keywordSearch(
  workspaceId: string,
  query: string,
  searchOpts?: Record<string, any>,
  opts?: HttpOptions,
): Promise<SearchMatch[]> {
  const out = await callTool(workspaceId, 'keyword_search', { query, ...(searchOpts ?? {}) }, opts);
  return normalizeMatches(out);
}

function normalizeMatches(out: any): SearchMatch[] {
  if (!out) return [];
  const arr = Array.isArray(out?.results) ? out.results : Array.isArray(out?.items) ? out.items : Array.isArray(out) ? out : [];
  return arr.map((v: any) => {
    if (v && typeof v === 'object') return v as SearchMatch;
    return { snippet: String(v ?? '') } as SearchMatch;
  });
}

export default {
  toolsList,
  callTool,
  readDocument,
  semanticSearch,
  keywordSearch,
};
