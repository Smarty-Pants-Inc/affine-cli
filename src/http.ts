/*
 * HTTP core (CLI-003)
 *
 * Provides a single request(options) helper built on undici with:
 * - Timeouts
 * - Retries with exponential backoff (up to 3 attempts total)
 * - Auth headers (Bearer token or Cookie)
 * - Optional debug logging with secrets redacted
 * - Typed error classes
 */

import { request as undiciRequest } from 'undici';
import { redactValue, SENSITIVE_KEYS } from './credentials';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export type RequestOptions<TBody = any> = {
  // Full URL or baseUrl + path
  url?: string;
  baseUrl?: string;
  path?: string;

  method?: HttpMethod;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | null | undefined>;

  // Provide either `json` (auto-serializes and sets content-type) or raw `body`
  json?: unknown;
  body?: TBody;

  // Auth
  token?: string; // Bearer token
  cookie?: string; // Cookie header value

  // Behavior
  timeoutMs?: number; // per attempt timeout
  maxAttempts?: number; // total attempts, default 3
  retryOnStatus?: (status: number) => boolean; // default: 5xx, 408, 429

  // Response handling
  responseType?: 'json' | 'text' | 'buffer';

  // Debug logging (no secrets)
  debug?: boolean | ((msg: string, meta?: Record<string, any>) => void);
};

export type HttpResponse<T = unknown> = {
  status: number;
  headers: Record<string, string>;
  data: T;
  rawBody: Buffer;
};

// Error types
export class HttpError extends Error {
  public cause?: unknown;
  public status?: number;
  public code?: string;
  public attempt: number;
  public retryable: boolean;
  constructor(message: string, opts: { cause?: unknown; status?: number; code?: string; attempt: number; retryable?: boolean } ) {
    super(message);
    this.name = 'HttpError';
    this.cause = opts.cause;
    this.status = opts.status;
    this.code = opts.code;
    this.attempt = opts.attempt;
    this.retryable = !!opts.retryable;
  }
}

export class TimeoutError extends HttpError {
  constructor(message: string, opts: { cause?: unknown; attempt: number }) {
    super(message, { ...opts, code: 'ETIMEDOUT', retryable: true });
    this.name = 'TimeoutError';
  }
}

export class NetworkError extends HttpError {
  constructor(message: string, opts: { cause?: unknown; attempt: number; code?: string; retryable?: boolean }) {
    super(message, { ...opts });
    this.name = 'NetworkError';
  }
}

export class ResponseError extends HttpError {
  public response?: { status: number; headers: Record<string, string>; body?: Buffer };
  constructor(message: string, opts: { status: number; attempt: number; body?: Buffer; headers?: Record<string, string>; retryable?: boolean }) {
    super(message, { status: opts.status, attempt: opts.attempt, retryable: !!opts.retryable });
    this.name = 'ResponseError';
    this.response = { status: opts.status, headers: opts.headers ?? {}, body: opts.body };
  }
}

function buildUrl(opts: RequestOptions): string {
  if (opts.url) return appendQuery(opts.url, opts.query);
  const base = (opts.baseUrl ?? '').replace(/\/$/, '');
  const path = ('/' + String(opts.path ?? '').replace(/^\//, '')).replace(/\/$/, String(opts.path ?? '').endsWith('/') ? '/' : '');
  return appendQuery(base + path, opts.query);
}

function appendQuery(url: string, query: RequestOptions['query']): string {
  if (!query || Object.keys(query).length === 0) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

function normalizeHeaders(h?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    out[k.toLowerCase()] = String(v);
  }
  return out;
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase()) || k.toLowerCase() === 'authorization' || k.toLowerCase() === 'cookie') {
      redacted[k] = redactValue(v);
    } else {
      redacted[k] = v;
    }
  }
  return redacted;
}

function getLogger(debug?: RequestOptions['debug']): ((msg: string, meta?: Record<string, any>) => void) | undefined {
  if (!debug) return undefined;
  if (typeof debug === 'function') return debug;
  return (msg: string, meta?: Record<string, any>) => {
    console.debug(msg, meta ?? '');
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function defaultRetryOnStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

export async function request<T = unknown>(opts: RequestOptions): Promise<HttpResponse<T>> {
  const url = buildUrl(opts);
  const method = (opts.method ?? 'GET').toUpperCase() as HttpMethod;
  const logger = getLogger(opts.debug);
  const timeoutMs = Math.max(1, opts.timeoutMs ?? 30_000);
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const retryOnStatus = opts.retryOnStatus ?? defaultRetryOnStatus;

  // Headers
  const headers = normalizeHeaders(opts.headers);
  if (opts.token && !headers['authorization']) headers['authorization'] = `Bearer ${opts.token}`;
  if (opts.cookie && !headers['cookie']) headers['cookie'] = opts.cookie;

  let body: any = opts.body;
  // When using JSON payloads, serialize once so we can optionally log a safe preview when debug is enabled.
  let debugBodyString: string | undefined;
  if (opts.json !== undefined) {
    debugBodyString = JSON.stringify(opts.json);
    body = Buffer.from(debugBodyString);
    if (!headers['content-type']) headers['content-type'] = 'application/json';
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const isFinal = attempt === maxAttempts;
    try {
      logger?.('http:request', {
        attempt,
        method,
        url,
        headers: redactHeaders(headers),
        hasBody: !!body,
        // Log a short preview of JSON bodies to aid debugging of server-side 4xx/5xx parsing issues.
        bodyPreview:
          debugBodyString && debugBodyString.length > 256
            ? `${debugBodyString.slice(0, 256)}...`
            : debugBodyString,
        timeoutMs,
      });

      const res = await undiciRequest(url, {
        method,
        headers,
        // Cast to any to avoid tight coupling to undici internal Dispatcher types across versions
        body: body as any,
        bodyTimeout: timeoutMs,
        headersTimeout: timeoutMs,
        maxRedirections: 0,
      });

      const status = res.statusCode;
      const resHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers as Record<string, string | string[]>)) {
        resHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
      }

      const raw = Buffer.from(await res.body.arrayBuffer());

      if (status >= 200 && status < 300) {
        let data: any = raw;
        const type = (opts.responseType ?? 'json');
        try {
          if (type === 'json') {
            if (raw.length === 0) data = undefined;
            else data = JSON.parse(raw.toString('utf8')) as T;
          } else if (type === 'text') {
            data = raw.toString('utf8') as unknown as T;
          } else {
            data = raw as unknown as T;
          }
        } catch {
          // If JSON parse fails, throw ResponseError
          throw new ResponseError('Failed to parse JSON response', {
            status,
            attempt,
            body: raw,
            headers: resHeaders,
            retryable: false,
          });
        }
        logger?.('http:response', { attempt, status, headers: redactHeaders(resHeaders), size: raw.length });
        return { status, headers: resHeaders, data, rawBody: raw } as HttpResponse<T>;
      }

      // Non-2xx
      const err = new ResponseError(`HTTP ${status}`, {
        status,
        attempt,
        body: raw,
        headers: resHeaders,
        retryable: retryOnStatus(status),
      });
      logger?.('http:error_response', {
        attempt,
        status,
        retryable: err.retryable,
        // Surface a short preview of non-2xx bodies when debugging HTTP issues.
        bodyPreview:
          raw.length > 0
            ? raw.toString('utf8', 0, Math.min(raw.length, 256))
            : undefined,
      });
      if (!err.retryable || isFinal) throw err;
    } catch (err: any) {
      lastError = err;
      // undici exposes error codes like UND_ERR_HEADERS_TIMEOUT / UND_ERR_BODY_TIMEOUT, etc.
      const code = err?.code ? String(err.code) : undefined;
      const isTimeout = code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT' || code === 'ETIMEDOUT' || err instanceof TimeoutError;

      let wrapped: HttpError;
      if (err instanceof HttpError) {
        wrapped = err;
      } else if (isTimeout) {
        wrapped = new TimeoutError('Request timed out', { cause: err, attempt });
      } else if (err?.statusCode && typeof err.statusCode === 'number') {
        const status = err.statusCode as number;
        wrapped = new ResponseError(`HTTP ${status}`, { status, attempt, retryable: retryOnStatus(status) });
      } else {
        wrapped = new NetworkError(err?.message ?? 'Network error', { cause: err, attempt, code, retryable: true });
      }

      logger?.('http:error', { attempt, name: wrapped.name, code: wrapped.code, status: wrapped.status, retryable: wrapped.retryable });
      if (!wrapped.retryable || isFinal) throw wrapped;
    }

    // Exponential backoff with jitter: 200ms * 2^(attempt-1) ± 50ms
    const base = 200 * Math.pow(2, attempt - 1);
    const jitter = Math.floor(Math.random() * 100) - 50; // [-50, +49]
    await sleep(Math.max(0, base + jitter));
  }

  // Should not reach here
  throw new HttpError('Request failed', { attempt: Math.max(1, (opts.maxAttempts ?? 3)), cause: lastError });
}

export default request;

// Thin JSON POST helper for convenience consumers (e.g., GraphQL client)
export type HttpOptions = Pick<RequestOptions, 'baseUrl' | 'headers' | 'token' | 'cookie' | 'timeoutMs' | 'debug'>;

export async function postJson<T = unknown>(path: string, body: unknown, opts?: HttpOptions): Promise<HttpResponse<T>> {
  // Prefer explicit baseUrl but fall back to AFFINE_BASE_URL env for convenience
  const envBase: string | undefined = (globalThis as any)?.process?.env?.AFFINE_BASE_URL;
  const baseUrl = (opts?.baseUrl ?? envBase ?? '').replace(/\/$/, '');
  const url = baseUrl ? `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}` : path;
  return request<T>({
    url,
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(opts?.headers ?? {}) },
    json: body,
    token: (opts as any)?.token,
    cookie: (opts as any)?.cookie,
    timeoutMs: opts?.timeoutMs,
    debug: opts?.debug,
    responseType: 'json',
  });
}
