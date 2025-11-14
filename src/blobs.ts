/*
 * Blobs over REST (CLI-012)
 *
 * Endpoints:
 *   - PUT   /api/workspaces/:id/blobs/:name    (upload)
 *   - GET   /api/workspaces/:id/blobs/:name    (get; may 302/307 redirect)
 *   - DELETE/api/workspaces/:id/blobs/:name    (remove)
 *
 * Uses the existing request() helper from http.ts. For GET, handles 302/307
 * redirects explicitly (follow or manual). When writing to file, we persist
 * the downloaded buffer to disk; we intentionally avoid logging secrets.
 */

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import request, { type RequestOptions, type HttpOptions } from './http';

// Avoid depending on @types/node for process
declare const process: any;

function apiPath(workspaceId: string, name: string): string {
  const ws = encodeURIComponent(workspaceId);
  const nm = encodeURIComponent(name);
  return `/api/workspaces/${ws}/blobs/${nm}`;
}

function guessContentType(nameOrPath: string): string {
  const ext = path.extname(nameOrPath).toLowerCase();
  switch (ext) {
    case '.txt':
      return 'text/plain';
    case '.md':
      return 'text/markdown';
    case '.json':
      return 'application/json';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.pdf':
      return 'application/pdf';
    default:
      return 'application/octet-stream';
  }
}

// --- Local alias mapping ----------------------------------------------------

type BlobAliasMap = Record<string, Record<string, string>>; // workspaceId -> alias -> key

function aliasFilePath(): string {
  // Store aliases alongside the CLI package by default so multiple invocations
  // (e.g., smoke tests) can share them.
  const cwd = typeof process?.cwd === 'function' ? process.cwd() : '.';
  return path.resolve(cwd, '.affine-cli-blobs.json');
}

async function loadAliasMap(): Promise<BlobAliasMap> {
  try {
    const raw = await fs.readFile(aliasFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as BlobAliasMap;
  } catch {
    // treat missing/invalid file as empty map
  }
  return {};
}

async function saveAliasMap(map: BlobAliasMap): Promise<void> {
  const file = aliasFilePath();
  const dir = path.dirname(file);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // ignore mkdir errors; writeFile below will surface issues
  }
  await fs.writeFile(file, JSON.stringify(map, null, 2), 'utf8');
}

async function registerAlias(workspaceId: string, alias: string, key: string): Promise<void> {
  const map = await loadAliasMap();
  if (!map[workspaceId]) map[workspaceId] = {};
  map[workspaceId][alias] = key;
  await saveAliasMap(map);
}

async function resolveBlobKey(
  workspaceId: string,
  aliasOrKey: string,
  opts?: HttpOptions,
): Promise<string> {
  const map = await loadAliasMap();
  const byWorkspace = map[workspaceId] ?? {};
  if (byWorkspace[aliasOrKey]) return byWorkspace[aliasOrKey];

  // Best-effort fallback: if server exposes blobs over GraphQL, see if aliasOrKey
  // already matches an existing key; otherwise, treat alias as key directly.
  try {
    const res = await request<{ data?: { workspace?: { blobs?: { key: string }[] } }; errors?: any }>(
      {
        baseUrl: (opts as any)?.baseUrl,
        path: '/graphql',
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(opts as any)?.headers },
        json: {
          query: /* GraphQL */ `
            query ListBlobs($workspaceId: String!) {
              workspace(id: $workspaceId) {
                blobs { key }
              }
            }
          `,
          variables: { workspaceId },
        },
        token: (opts as any)?.token,
        cookie: (opts as any)?.cookie,
        timeoutMs: (opts as any)?.timeoutMs,
        debug: (opts as any)?.debug,
        responseType: 'json',
      },
    );
    const payload: any = res.data ?? {};
    const errors = payload?.errors;
    if (Array.isArray(errors) && errors.length) {
      return aliasOrKey;
    }
    const blobs = payload?.data?.workspace?.blobs ?? [];
    if (blobs.some((b: any) => b?.key === aliasOrKey)) return aliasOrKey;
  } catch {
    // ignore GraphQL failures; fall through to treating alias as key
  }

  return aliasOrKey;
}

export type UploadResult = { ok: true; status: number; location?: string };

export async function upload(
  workspaceId: string,
  name: string,
  filePathOrBuffer: string | Buffer,
  opts?: HttpOptions & { contentType?: string },
): Promise<UploadResult> {
  const isPath = typeof filePathOrBuffer === 'string';
  const body = isPath ? await fs.readFile(filePathOrBuffer) : (filePathOrBuffer as Buffer);
  const ct = (opts as any)?.contentType || guessContentType(isPath ? filePathOrBuffer : name);
  const baseUrl = (opts as any)?.baseUrl as string | undefined;

  // Use GraphQL setBlob(blob: Upload!, workspaceId: String!): String! for uploads.
  const boundary = `----affine-cli-${crypto.randomBytes(8).toString('hex')}`;
  const query = /* GraphQL */ `
    mutation SetBlob($file: Upload!, $workspaceId: String!) {
      setBlob(blob: $file, workspaceId: $workspaceId)
    }
  `;
  const operations = JSON.stringify({
    query,
    variables: { file: null, workspaceId },
  });
  const map = JSON.stringify({ '0': ['variables.file'] });

  const parts: Buffer[] = [];
  const push = (s: string) => parts.push(Buffer.from(s, 'utf8'));

  push(`--${boundary}\r\n`);
  push('Content-Disposition: form-data; name="operations"\r\n');
  push('Content-Type: application/json\r\n\r\n');
  push(`${operations}\r\n`);

  push(`--${boundary}\r\n`);
  push('Content-Disposition: form-data; name="map"\r\n');
  push('Content-Type: application/json\r\n\r\n');
  push(`${map}\r\n`);

  push(`--${boundary}\r\n`);
  push(`Content-Disposition: form-data; name="0"; filename="${path.basename(isPath ? filePathOrBuffer : name)}"\r\n`);
  push(`Content-Type: ${ct}\r\n\r\n`);
  parts.push(body);
  push(`\r\n--${boundary}--\r\n`);

  const multipartBody = Buffer.concat(parts);

  const res = await request<{ data?: { setBlob?: string }; errors?: any }>(
    {
      baseUrl,
      path: '/graphql',
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        ...(opts as any)?.headers,
      },
      body: multipartBody,
      token: (opts as any)?.token,
      cookie: (opts as any)?.cookie,
      timeoutMs: (opts as any)?.timeoutMs,
      debug: (opts as any)?.debug,
      responseType: 'json',
    },
  );

  const payload: any = res.data ?? {};
  const gqlErrors = payload?.errors;
  if (Array.isArray(gqlErrors) && gqlErrors.length) {
    throw new Error(gqlErrors.map((e: any) => e?.message || 'Blob upload failed').join('; '));
  }
  const key = payload?.data?.setBlob;
  if (!key || typeof key !== 'string') {
    throw new Error('Unexpected setBlob response');
  }

  // Persist alias -> key mapping so subsequent CLI commands can resolve by name.
  try {
    await registerAlias(workspaceId, name, key);
  } catch {
    // Alias persistence failures should not fail the upload itself.
  }

  return { ok: true, status: 200 };
}

export type GetOptions = (HttpOptions & { outPath?: string; redirect?: 'follow' | 'manual' });
export type GetFollowResult = { ok: true; status: number; size: number; outPath?: string; buffer?: Buffer };
export type GetManualRedirect = { ok: false; status: number; location?: string };

function isRedirectStatus(s?: number): s is 302 | 307 {
  return s === 302 || s === 307;
}

export async function get(
  workspaceId: string,
  name: string,
  options?: GetOptions,
): Promise<GetFollowResult | GetManualRedirect> {
  const opts = options ?? {};
  const follow = (opts.redirect ?? 'follow') === 'follow';

  const key = await resolveBlobKey(workspaceId, name, opts);

  const baseReq: RequestOptions = {
    baseUrl: (opts as any).baseUrl,
    path: apiPath(workspaceId, key),
    method: 'GET',
    headers: { ...(opts as any).headers },
    token: (opts as any).token,
    cookie: (opts as any).cookie,
    timeoutMs: (opts as any).timeoutMs,
    debug: (opts as any).debug,
    responseType: 'buffer',
    // Do not auto-follow redirects in http.ts; we handle explicitly
  };

  let resUrl: string | undefined;
  try {
    const res = await request<Buffer>(baseReq);
    const buf = (res.data as unknown as Buffer) ?? res.rawBody;
    if (opts.outPath) {
      await fs.writeFile(opts.outPath, buf);
      return { ok: true, status: res.status, size: buf.length, outPath: opts.outPath };
    }
    return { ok: true, status: res.status, size: buf.length, buffer: buf };
  } catch (err: any) {
    const status: number | undefined = (err && typeof err.status === 'number') ? err.status : undefined;
    const loc = err?.response?.headers?.location || err?.response?.headers?.Location;
    if (isRedirectStatus(status)) {
      if (!follow) return { ok: false, status: status!, location: loc };
      // Follow the redirect URL (absolute)
      if (!loc) return { ok: false, status: status!, location: undefined };
      resUrl = String(loc);
    } else {
      throw err;
    }
  }

  // Followed path
  const res2 = await request<Buffer>({
    url: resUrl!,
    method: 'GET',
    headers: { ...(opts as any).headers },
    timeoutMs: (opts as any).timeoutMs,
    debug: (opts as any).debug,
    responseType: 'buffer',
  });
  const buf2 = (res2.data as unknown as Buffer) ?? res2.rawBody;
  if (opts.outPath) {
    await fs.writeFile(opts.outPath, buf2);
    return { ok: true, status: res2.status, size: buf2.length, outPath: opts.outPath };
  }
  return { ok: true, status: res2.status, size: buf2.length, buffer: buf2 };
}

export async function rm(
  workspaceId: string,
  name: string,
  opts?: HttpOptions,
): Promise<boolean> {
  const key = await resolveBlobKey(workspaceId, name, opts);
  const res = await request<{ data?: { deleteBlob?: boolean }; errors?: any }>(
    {
      baseUrl: (opts as any)?.baseUrl,
      path: '/graphql',
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(opts as any)?.headers },
      json: {
        query: /* GraphQL */ `
          mutation DeleteBlob($workspaceId: String!, $key: String!) {
            deleteBlob(workspaceId: $workspaceId, key: $key)
          }
        `,
        variables: { workspaceId, key },
      },
      token: (opts as any)?.token,
      cookie: (opts as any)?.cookie,
      timeoutMs: (opts as any)?.timeoutMs,
      debug: (opts as any)?.debug,
      responseType: 'json',
    },
  );
  const payload: any = res.data ?? {};
  const gqlErrors = payload?.errors;
  if (Array.isArray(gqlErrors) && gqlErrors.length) {
    throw new Error(gqlErrors.map((e: any) => e?.message || 'Blob delete failed').join('; '));
  }
  const v = payload?.data?.deleteBlob;
  if (typeof v === 'boolean') return v;
  return Boolean(v);
}

export default { upload, get, rm };
