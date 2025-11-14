// Utilities to read E2E environment for AFFiNE CLI tests
import type { HttpOptions } from '../../src/http';

export type E2EEnv = {
  enabled: boolean;
  shouldRun: boolean;
  baseUrl?: string;
  token?: string;
  cookie?: string;
  workspaceId?: string;
  timeoutMs: number;
  httpOpts?: HttpOptions;
  expectedIndexer?: boolean;
  expectedEmbeddings?: boolean;
};

export function loadE2EEnv(): E2EEnv {
  const enabled = process.env.AFFINE_E2E === '1';
  const baseUrl = process.env.AFFINE_BASE_URL;
  const token = process.env.AFFINE_TOKEN;
  const cookie = process.env.AFFINE_COOKIE;
  const workspaceId = process.env.AFFINE_WORKSPACE_ID;
  const timeoutMs = Number(process.env.AFFINE_TIMEOUT_MS ?? '') || 15000;
  const idxSignal = process.env.AFFINE_E2E_INDEXER;
  const embSignal = process.env.AFFINE_E2E_EMBEDDINGS;

  function parseOnOff(v?: string): boolean | undefined {
    if (!v) return undefined;
    const s = String(v).trim().toLowerCase();
    if (s === 'on' || s === '1' || s === 'true' || s === 'yes') return true;
    if (s === 'off' || s === '0' || s === 'false' || s === 'no') return false;
    return undefined;
  }

  const expectedIndexer = parseOnOff(idxSignal);
  const expectedEmbeddings = parseOnOff(embSignal);

  const shouldRun = Boolean(enabled && baseUrl && (token || cookie) && workspaceId);
  const httpOpts: HttpOptions | undefined = shouldRun
    ? { baseUrl: baseUrl!, token, cookie, timeoutMs }
    : undefined;

  return {
    enabled,
    shouldRun,
    baseUrl,
    token,
    cookie,
    workspaceId,
    timeoutMs,
    httpOpts,
    expectedIndexer,
    expectedEmbeddings,
  };
}
