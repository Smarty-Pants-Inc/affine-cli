// E2E feature coverage for AFFiNE CLI (CLI-022)
// Gated by AFFINE_E2E=1 with AFFINE_BASE_URL, AFFINE_TOKEN|AFFINE_COOKIE, and AFFINE_WORKSPACE_ID.
import { describe, it, expect } from 'vitest';
import { fetch as undiciFetch } from 'undici';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { listDocs } from '../../src/graphql';
import { loadE2EEnv } from '../utils/env';
import { runCli } from '../utils/runCli';

const env = loadE2EEnv();
const d = env.shouldRun ? describe : describe.skip;

function extractCliErrorMessage(err: any): string {
  const stderr = typeof err?.stderr === 'string' ? err.stderr : '';
  const stdout = typeof err?.stdout === 'string' ? err.stdout : '';
  let msg = String(err?.message || stderr || stdout || '');

  // If stderr/stdout contain a JSON error envelope, prefer that message.
  const jsonSource = stderr || stdout || msg;
  const idx = jsonSource.indexOf('{');
  if (idx >= 0) {
    try {
      const parsed = JSON.parse(jsonSource.slice(idx));
      if (parsed && typeof parsed.error === 'string') {
        msg = parsed.error;
      }
    } catch {
      // ignore JSON parse failures; fall back to raw message
    }
  }

  return msg;
}

function isEmbeddingsConfigError(err: any): boolean {
  const msg = extractCliErrorMessage(err).toLowerCase();
  if (!msg) return false;
  return (
    msg.includes('embeddings are disabled') ||
    msg.includes('embeddings disabled') ||
    msg.includes('embeddings not enabled') ||
    msg.includes('enable embeddings') ||
    msg.includes('embeddings provider') ||
    msg.includes('no embeddings provider')
  );
}

async function pickDocId(): Promise<string | undefined> {
  try {
    const conn = await listDocs(env.workspaceId!, 5, undefined, env.httpOpts);
    const edges = conn?.edges ?? [];
    if (edges.length === 0) return undefined;
    return edges[0].node.id;
  } catch {
    return undefined;
  }
}

d('CLI-022: @smarty/affine-cli E2E feature coverage', () => {
  it(
    'config show outputs JSON with profile/apiBaseUrl/options and human text form',
    { timeout: env.timeoutMs + 5000 },
    async () => {
      const jsonLogs = await runCli(
        ['config', 'show', '--json'],
        { baseUrl: env.baseUrl, token: env.token, cookie: env.cookie, timeoutMs: env.timeoutMs },
      );
      expect(jsonLogs.length).toBeGreaterThan(0);
      const payload = JSON.parse(jsonLogs[0]);
      expect(payload && typeof payload === 'object').toBe(true);
      expect(payload).toHaveProperty('profile');
      expect(payload).toHaveProperty('apiBaseUrl');
      expect(payload).toHaveProperty('options');
      expect(typeof (payload as any).options).toBe('object');

      const textLogs = await runCli(
        ['config', 'show'],
        { baseUrl: env.baseUrl, token: env.token, cookie: env.cookie, timeoutMs: env.timeoutMs },
      );
      const text = (textLogs.join('\n') || '').trim();
      expect(text).toContain('AFFiNE CLI configuration');
      expect(text).toMatch(/profile\s*:/);
      expect(text).toMatch(/apiBaseUrl\s*:/);
    },
  );

  it(
    'ws list returns items[] JSON and includes current workspace when available',
    { timeout: env.timeoutMs + 5000 },
    async () => {
      const logs = await runCli(
        ['ws', 'list', '--json'],
        { baseUrl: env.baseUrl, token: env.token, cookie: env.cookie, timeoutMs: env.timeoutMs },
      );
      const payload = JSON.parse(logs[0]);
      expect(payload && Array.isArray(payload.items)).toBe(true);
      if (env.workspaceId) {
        const found = (payload.items as any[]).some((w) => w && w.id === env.workspaceId);
        expect(found).toBe(true);
      }
    },
  );

  it(
    'ws create returns a new workspace id via JSON',
    { timeout: env.timeoutMs + 15000 },
    async () => {
      const logs = await runCli(
        ['ws', 'create', '--json'],
        { baseUrl: env.baseUrl, token: env.token, cookie: env.cookie, timeoutMs: env.timeoutMs },
      );
      const payload = JSON.parse(logs[0]);
      expect(payload && typeof payload.id === 'string').toBe(true);
      // enableDocEmbedding may or may not be present depending on server
      if (Object.prototype.hasOwnProperty.call(payload, 'enableDocEmbedding')) {
        expect(typeof payload.enableDocEmbedding === 'boolean' || payload.enableDocEmbedding === null).toBe(true);
      }
    },
  );

  it(
    'ws embeddings enable/disable toggles embeddings flag and prints on/off',
    { timeout: env.timeoutMs + 20000 },
    async () => {
      const wsId = env.workspaceId!;
      const cliOpts = { baseUrl: env.baseUrl, token: env.token, cookie: env.cookie, timeoutMs: env.timeoutMs };

      const getLogs = await runCli(['ws', 'get', wsId, '--json'], cliOpts);
      const original = JSON.parse(getLogs[0]);
      const originalEnabled = Boolean(original.enableDocEmbedding === true);

      try {
        const disableJsonLogs = await runCli(['ws', 'embeddings', 'disable', wsId, '--json'], cliOpts);
        const disabled = JSON.parse(disableJsonLogs[0]);
        expect(disabled && disabled.id).toBe(wsId);
        expect(disabled.enableDocEmbedding).toBe(false);

        const disableText = (await runCli(['ws', 'embeddings', 'disable', wsId], cliOpts)).join('\n');
        expect(disableText).toContain('embeddings:off');

        const enableJsonLogs = await runCli(['ws', 'embeddings', 'enable', wsId, '--json'], cliOpts);
        const enabled = JSON.parse(enableJsonLogs[0]);
        expect(enabled && enabled.id).toBe(wsId);
        expect(enabled.enableDocEmbedding).toBe(true);

        const enableText = (await runCli(['ws', 'embeddings', 'enable', wsId], cliOpts)).join('\n');
        expect(enableText).toContain('embeddings:on');
      } finally {
        try {
          if (originalEnabled) {
            await runCli(['ws', 'embeddings', 'enable', wsId, '--json'], cliOpts);
          } else {
            await runCli(['ws', 'embeddings', 'disable', wsId, '--json'], cliOpts);
          }
        } catch {
          // best-effort restore
        }
      }
    },
  );

  it(
    'doc publish/revoke round-trip returns expected JSON shapes',
    { timeout: env.timeoutMs + 15000 },
    async () => {
      const docId = await pickDocId();
      if (!docId) return; // Graceful skip if no docs

      // Publish (explicit mode)
      const pubLogs = await runCli(
        ['doc', 'publish', docId, '--workspace-id', env.workspaceId!, '--mode', 'Page', '--json'],
        { baseUrl: env.baseUrl, token: env.token, cookie: env.cookie },
      );
      expect(pubLogs.length).toBeGreaterThan(0);
      const pub = JSON.parse(pubLogs[0]);
      expect(pub && typeof pub.id === 'string').toBe(true);
      expect(pub.id).toBe(docId);
      expect(['Page', 'Edgeless', null, undefined]).toContain(pub.mode);

      // Revoke
      const revLogs = await runCli(
        ['doc', 'revoke', docId, '--workspace-id', env.workspaceId!, '--json'],
        { baseUrl: env.baseUrl, token: env.token, cookie: env.cookie },
      );
      const rev = JSON.parse(revLogs[0]);
      expect(rev && typeof rev.id === 'string').toBe(true);
      expect(rev.id).toBe(docId);
    },
  );

  it(
    'comments: add -> list contains -> remove; JSON shapes asserted',
    { timeout: env.timeoutMs + 15000 },
    async () => {
      const docId = await pickDocId();
      if (!docId) return; // Graceful skip if no docs

      const text = `ci e2e comment ${Date.now()}`;
      // Add
      const addLogs = await runCli(
        ['comment', 'add', docId, '--workspace-id', env.workspaceId!, '--text', text, '--json'],
        { baseUrl: env.baseUrl, token: env.token, cookie: env.cookie },
      );
      const addPayload = JSON.parse(addLogs[0]);
      expect(addPayload && typeof addPayload.id === 'string').toBe(true);
      const commentId: string = addPayload.id;

      try {
        // List
        const listLogs = await runCli(
          ['comment', 'list', docId, '--workspace-id', env.workspaceId!, '--first', '20', '--json'],
          { baseUrl: env.baseUrl, token: env.token, cookie: env.cookie },
        );
        const listPayload = JSON.parse(listLogs[0]);
        expect(listPayload && Array.isArray(listPayload.items)).toBe(true);
        const found = listPayload.items.find((e: any) => e.id === commentId || e.text === text);
        expect(Boolean(found)).toBe(true);
      } finally {
        // Remove (best-effort cleanup)
        const rmLogs = await runCli(
          ['comment', 'rm', docId, '--workspace-id', env.workspaceId!, '--id', commentId, '--json'],
          { baseUrl: env.baseUrl, token: env.token, cookie: env.cookie },
        );
        const rmPayload = JSON.parse(rmLogs[0]);
        expect(typeof rmPayload.ok === 'boolean').toBe(true);
      }
    },
  );

  it(
    'blobs: upload -> get --out -> file exists -> rm; JSON shapes asserted',
    { timeout: env.timeoutMs + 20000 },
    async () => {
      const docId = await pickDocId();
      if (!docId) return; // Graceful skip if no docs; blob API is workspace-scoped but align with doc gating

      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'affine-cli-e2e-'));
      const srcPath = path.join(tmpDir, 'src.txt');
      const outPath = path.join(tmpDir, 'out.txt');
      const name = `ci-e2e-${Date.now()}.txt`;
      await fs.writeFile(srcPath, `hello ${new Date().toISOString()}`);

      // Upload
      const upLogs = await runCli(
        ['blob', 'upload', srcPath, '--workspace-id', env.workspaceId!, '--name', name, '--json'],
        { baseUrl: env.baseUrl, token: env.token, cookie: env.cookie },
      );
      const upPayload = JSON.parse(upLogs[0]);
      expect(upPayload && upPayload.ok === true).toBe(true);
      expect(upPayload.name).toBe(name);
      expect(typeof upPayload.status === 'number').toBe(true);

      try {
        // Get -> out file
        const getLogs = await runCli(
          ['blob', 'get', '--workspace-id', env.workspaceId!, '--name', name, '--out', outPath, '--json'],
          { baseUrl: env.baseUrl, token: env.token, cookie: env.cookie },
        );
        const getPayload = JSON.parse(getLogs[0]);
        expect(getPayload && getPayload.ok === true).toBe(true);
        expect(getPayload.outPath).toBe(outPath);
        const stat = await fs.stat(outPath);
        expect(stat && stat.isFile()).toBe(true);
        expect(stat.size).toBeGreaterThan(0);
      } finally {
        // Remove
        const rmLogs = await runCli(
          ['blob', 'rm', '--workspace-id', env.workspaceId!, '--name', name, '--json'],
          { baseUrl: env.baseUrl, token: env.token, cookie: env.cookie },
        );
        const rmPayload = JSON.parse(rmLogs[0]);
        expect(typeof rmPayload.ok === 'boolean').toBe(true);
      }
    },
  );

  it(
    'tokens: create -> revoke -> list shape',
    { timeout: env.timeoutMs + 15000 },
    async () => {
      const tokenName = `ci-e2e-${Date.now()}`;
      // Create
      const createLogs = await runCli(
        ['auth', 'token', 'create', '--name', tokenName, '--json'],
        { baseUrl: env.baseUrl, token: env.token, cookie: env.cookie },
      );
      const created = JSON.parse(createLogs[0]);
      expect(created && typeof created.id === 'string').toBe(true);
      const newId: string = created.id;

      try {
        // Revoke
        const revokeLogs = await runCli(
          ['auth', 'token', 'revoke', newId, '--json'],
          { baseUrl: env.baseUrl, token: env.token, cookie: env.cookie },
        );
        const revoked = JSON.parse(revokeLogs[0]);
        expect(revoked && typeof revoked.ok === 'boolean').toBe(true);
      } finally {
        // List (shape)
        const listLogs = await runCli(
          ['auth', 'token', 'list', '--json'],
          { baseUrl: env.baseUrl, token: env.token, cookie: env.cookie },
        );
        const listPayload = JSON.parse(listLogs[0]);
        expect(listPayload && Array.isArray(listPayload.items)).toBe(true);
      }
    },
  );

  it(
    'doc list returns items[] JSON and prints a table in text mode',
    { timeout: env.timeoutMs + 10000 },
    async () => {
      const jsonLogs = await runCli(
        ['doc', 'list', '--workspace-id', env.workspaceId!, '--first', '5', '--json'],
        { baseUrl: env.baseUrl, token: env.token, cookie: env.cookie, timeoutMs: env.timeoutMs },
      );
      const payload = JSON.parse(jsonLogs[0]);
      expect(payload && Array.isArray(payload.items)).toBe(true);
      if (payload.pageInfo) {
        expect(typeof payload.pageInfo.hasNextPage).toBe('boolean');
      }

      const textLogs = await runCli(
        ['doc', 'list', '--workspace-id', env.workspaceId!, '--first', '5'],
        { baseUrl: env.baseUrl, token: env.token, cookie: env.cookie, timeoutMs: env.timeoutMs },
      );
      expect(textLogs.length).toBeGreaterThan(0);
    },
  );

  it(
    'doc delete returns ok JSON and subsequent get/read-md fail',
    { timeout: env.timeoutMs + 30000 },
    async () => {
      const opts = { baseUrl: env.baseUrl, token: env.token, cookie: env.cookie, timeoutMs: env.timeoutMs };
      const marker = `ci-e2e-delete-${Date.now()}`;

      const createLogs = await runCli(
        ['doc', 'create', '--workspace-id', env.workspaceId!, '--title', marker, '--content', 'to-delete', '--json'],
        opts,
      );
      const created = JSON.parse(createLogs[0]);
      expect(created && typeof created.docId === 'string').toBe(true);
      const docId: string = created.docId;

      const delLogs = await runCli(
        ['doc', 'delete', docId, '--workspace-id', env.workspaceId!, '--json'],
        opts,
      );
      const delPayload = JSON.parse(delLogs[0]);
      expect(typeof delPayload.ok).toBe('boolean');
      expect(delPayload.ok).toBe(true);

      let getErr: any | undefined;
      try {
        await runCli(
          ['doc', 'get', docId, '--workspace-id', env.workspaceId!, '--json'],
          opts,
        );
      } catch (e) {
        getErr = e;
      }
      expect(getErr).toBeDefined();

      let readErr: any | undefined;
      try {
        await runCli(
          ['doc', 'read-md', docId, '--workspace-id', env.workspaceId!, '--json'],
          opts,
        );
      } catch (e) {
        readErr = e;
      }
      expect(readErr).toBeDefined();
    },
  );

  it(
    'Yjs doc create + multiple appends preserves paragraph order in read-md',
    { timeout: env.timeoutMs + 45000 },
    async () => {
      const opts = { baseUrl: env.baseUrl, token: env.token, cookie: env.cookie, timeoutMs: env.timeoutMs };
      const marker = `ci-e2e-yjs-${Date.now()}`;
      const initial = `${marker}-initial`;
      const append1 = `${marker}-append-1`;
      const append2 = `${marker}-append-2`;

      const createLogs = await runCli(
        ['doc', 'create', '--workspace-id', env.workspaceId!, '--title', marker, '--content', initial, '--json'],
        opts,
      );
      const created = JSON.parse(createLogs[0]);
      expect(created && typeof created.docId === 'string').toBe(true);
      const docId: string = created.docId;

      try {
        const appendLogs1 = await runCli(
          ['doc', 'append', docId, '--workspace-id', env.workspaceId!, '--text', append1, '--json'],
          opts,
        );
        const appended1 = JSON.parse(appendLogs1[0]);
        expect(appended1 && appended1.accepted === true).toBe(true);

        const appendLogs2 = await runCli(
          ['doc', 'append', docId, '--workspace-id', env.workspaceId!, '--text', append2, '--json'],
          opts,
        );
        const appended2 = JSON.parse(appendLogs2[0]);
        expect(appended2 && appended2.accepted === true).toBe(true);

        const readLogs = await runCli(
          ['doc', 'read-md', docId, '--workspace-id', env.workspaceId!, '--json'],
          opts,
        );
        const readPayload = JSON.parse(readLogs[0]);
        expect(readPayload.docId).toBe(docId);
        const markdown = String(readPayload.markdown || '');
        const i0 = markdown.indexOf(initial);
        const i1 = markdown.indexOf(append1);
        const i2 = markdown.indexOf(append2);
        expect(i0).toBeGreaterThanOrEqual(0);
        expect(i1).toBeGreaterThan(i0);
        expect(i2).toBeGreaterThan(i1);
      } finally {
        try {
          await runCli(
            ['doc', 'delete', docId, '--workspace-id', env.workspaceId!, '--json'],
            opts,
          );
        } catch {
          // best-effort cleanup
        }
      }
    },
  );

  it(
    'doc read-md surfaces MCP/embeddings hints when it fails',
    { timeout: env.timeoutMs + 45000 },
    async () => {
      const opts = { baseUrl: env.baseUrl, token: env.token, cookie: env.cookie, timeoutMs: env.timeoutMs };
      const wsId = env.workspaceId!;
      const marker = `ci-e2e-read-md-error-${Date.now()}`;

      const createLogs = await runCli(
        ['doc', 'create', '--workspace-id', wsId, '--title', marker, '--content', 'hint test', '--json'],
        opts,
      );
      const created = JSON.parse(createLogs[0]);
      expect(created && typeof created.docId === 'string').toBe(true);
      const docId: string = created.docId;

      const wsGetLogs = await runCli(['ws', 'get', wsId, '--json'], opts);
      const wsPayload = JSON.parse(wsGetLogs[0]);
      const originalEnabled = Boolean(wsPayload.enableDocEmbedding === true);

      try {
        await runCli(['ws', 'embeddings', 'disable', wsId, '--json'], opts);

        let err: any | undefined;
        try {
          await runCli(['doc', 'read-md', docId, '--workspace-id', wsId, '--json'], opts);
        } catch (e) {
          err = e;
        }
        expect(err).toBeDefined();
        const msg = extractCliErrorMessage(err);
        const lower = msg.toLowerCase();
        expect(lower).toContain('embeddings');
        expect(lower).toContain('affine ws embeddings enable');
        expect(lower).toContain('mcp');
      } finally {
        try {
          await runCli(['doc', 'delete', docId, '--workspace-id', wsId, '--json'], opts);
        } catch {
          // ignore
        }
        try {
          if (originalEnabled) {
            await runCli(['ws', 'embeddings', 'enable', wsId, '--json'], opts);
          } else {
            await runCli(['ws', 'embeddings', 'disable', wsId, '--json'], opts);
          }
        } catch {
          // best-effort restore
        }
      }
    },
  );

  it(
    'whoami returns user info when authenticated and clear message when not',
    { timeout: env.timeoutMs + 15000 },
    async () => {
      const cliOpts = { baseUrl: env.baseUrl, token: env.token, cookie: env.cookie, timeoutMs: env.timeoutMs };

      // Authenticated JSON shape
      const jsonLogs = await runCli(['whoami', '--json'], cliOpts);
      const me = JSON.parse(jsonLogs[0]);
      expect(me && typeof me.id === 'string').toBe(true);
      if (Object.prototype.hasOwnProperty.call(me, 'email') && me.email != null) {
        expect(typeof me.email === 'string').toBe(true);
      }

      // Unauthenticated text output
      const unauthEnv: NodeJS.ProcessEnv = { ...process.env };
      delete unauthEnv.AFFINE_TOKEN;
      delete unauthEnv.AFFINE_COOKIE;
      const unauthLogs = await runCli(
        ['whoami'],
        { baseUrl: env.baseUrl, timeoutMs: env.timeoutMs, env: unauthEnv },
      );
      const text = unauthLogs.join('\n').toLowerCase();
      expect(text).toContain('not authenticated');
    },
  );

  it(
    'blob get --redirect manual returns a stable JSON shape',
    { timeout: env.timeoutMs + 25000 },
    async () => {
      const opts = { baseUrl: env.baseUrl, token: env.token, cookie: env.cookie, timeoutMs: env.timeoutMs };

      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'affine-cli-e2e-blob-manual-'));
      const srcPath = path.join(tmpDir, 'src.txt');
      const outPath = path.join(tmpDir, 'out.txt');
      const name = `ci-e2e-manual-${Date.now()}.txt`;
      await fs.writeFile(srcPath, `hello-manual ${new Date().toISOString()}`);

      const upLogs = await runCli(
        ['blob', 'upload', srcPath, '--workspace-id', env.workspaceId!, '--name', name, '--json'],
        opts,
      );
      const upPayload = JSON.parse(upLogs[0]);
      expect(upPayload && upPayload.ok === true).toBe(true);

      try {
        const getLogs = await runCli(
          [
            'blob',
            'get',
            '--workspace-id',
            env.workspaceId!,
            '--name',
            name,
            '--out',
            outPath,
            '--redirect',
            'manual',
            '--json',
          ],
          opts,
        );
        const payload = JSON.parse(getLogs[0]);
        expect(typeof payload.status).toBe('number');
        expect(typeof payload.ok).toBe('boolean');
        if (payload.ok) {
          expect(typeof payload.size).toBe('number');
          expect(payload.size).toBeGreaterThan(0);
        } else if (payload.location != null) {
          expect(typeof payload.location).toBe('string');
        }
      } finally {
        const rmLogs = await runCli(
          ['blob', 'rm', '--workspace-id', env.workspaceId!, '--name', name, '--json'],
          opts,
        );
        const rmPayload = JSON.parse(rmLogs[0]);
        expect(typeof rmPayload.ok === 'boolean').toBe(true);
      }
    },
  );

  it(
    'search matrix tolerance: respect expectedIndexer/expectedEmbeddings signals',
    { timeout: env.timeoutMs + 15000 },
    async () => {
      // Keyword search shape and matrix signal (only assert when expectedIndexer=false)
      const kwLogs = await runCli(
        ['search', 'keyword', 'test', '--workspace-id', env.workspaceId!, '--json'],
        { baseUrl: env.baseUrl, token: env.token, cookie: env.cookie },
      );
      const kw = JSON.parse(kwLogs[0]);
      expect(kw && typeof kw.source === 'string').toBe(true);
      expect(Array.isArray(kw.items)).toBe(true);
      if (env.expectedIndexer === false) {
        expect(kw.source).not.toBe('graphql');
      }

      // Only call semantic search if the matrix does NOT explicitly say embeddings are off
      if (env.expectedEmbeddings !== false) {
        try {
          const semLogs = await runCli(
            ['search', 'semantic', 'test', '--workspace-id', env.workspaceId!, '--json'],
            { baseUrl: env.baseUrl, token: env.token, cookie: env.cookie },
          );
          const sem = JSON.parse(semLogs[0]);
          // Shape: { query, matches }
          if (sem && typeof sem === 'object') {
            if ('query' in sem) expect(typeof sem.query === 'string').toBe(true);
            if ('matches' in sem) expect(Array.isArray(sem.matches)).toBe(true);
          }
        } catch (err: any) {
          const msg = extractCliErrorMessage(err);
          // Tolerate only errors clearly attributable to embeddings being disabled
          // or an embeddings provider being missing.
          if (!isEmbeddingsConfigError(err)) {
            throw err;
          }
          expect(msg.toLowerCase()).toMatch(/embeddings/);
        }
      }
    },
  );

  it(
    'keyword search finds a freshly created Yjs doc by title via real server',
    { timeout: env.timeoutMs + 45000 },
    async () => {
      const opts = { baseUrl: env.baseUrl, token: env.token, cookie: env.cookie, timeoutMs: env.timeoutMs };
      const phrase = `ci-e2e-search-${Date.now()}`;
      const title = `CLI Test ${phrase}`;

      const createLogs = await runCli(
        ['doc', 'create', '--workspace-id', env.workspaceId!, '--title', title, '--content', `Body ${phrase}`, '--json'],
        opts,
      );
      const created = JSON.parse(createLogs[0]);
      expect(created && typeof created.docId === 'string').toBe(true);
      const docId: string = created.docId;

      try {
        const start = Date.now();
        let lastPayload: any = null;
        // Poll keyword search until the freshly created doc appears, allowing
        // for asynchronous indexer and metadata updates on the server.
        // If it never appears within the window, fail with the last payload.
        // This uses only the public CLI surface and real server behavior.
        //
        // Note: we do NOT special-case this test anywhere in the CLI; this
        // polling reflects the eventual consistency guarantees of the backend.
        //
        // The outer test timeout (env.timeoutMs + 45000) bounds this loop.
        // We keep our own window smaller than that.
        const maxWaitMs = 30000;
        while (true) {
          const searchLogs = await runCli(
            ['search', 'keyword', phrase, '--workspace-id', env.workspaceId!, '--json'],
            opts,
          );
          const payload = JSON.parse(searchLogs[0]);
          lastPayload = payload;
          expect(payload && Array.isArray(payload.items)).toBe(true);
          const hit = (payload.items as any[]).find((it) => it && (it.docId === docId || it.id === docId));
          if (hit) break;

          if (Date.now() - start > maxWaitMs) {
            throw new Error(
              `keyword search did not return the freshly created doc within ${maxWaitMs}ms. Last payload: ${JSON.stringify(
                lastPayload,
              )}`,
            );
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
      } finally {
        try {
          await runCli(
            ['doc', 'delete', docId, '--workspace-id', env.workspaceId!, '--json'],
            opts,
          );
        } catch {
          // best-effort cleanup
        }
      }
    },
  );

  it(
    'doc renderer HTML contains title and description for a published doc URL',
    { timeout: env.timeoutMs + 60000 },
    async () => {
      const opts = { baseUrl: env.baseUrl, token: env.token, cookie: env.cookie, timeoutMs: env.timeoutMs };
      const marker = `ci-e2e-doc-render-${Date.now()}`;
      const title = `CLI Test ${marker}`;

      const createLogs = await runCli(
        ['doc', 'create', '--workspace-id', env.workspaceId!, '--title', title, '--content', `Body ${marker}`, '--json'],
        opts,
      );
      const created = JSON.parse(createLogs[0]);
      expect(created && typeof created.docId === 'string').toBe(true);
      const docId: string = created.docId;

      try {
        const pubLogs = await runCli(
          ['doc', 'publish', docId, '--workspace-id', env.workspaceId!, '--mode', 'Page', '--json'],
          opts,
        );
        const pub = JSON.parse(pubLogs[0]);
        expect(pub && pub.id).toBe(docId);

        const url = `${env.baseUrl!.replace(/\/$/, '')}/workspace/${env.workspaceId}/${docId}`;

        const start = Date.now();
        let lastHtml = '';
        // Poll until the SSR renderer exposes the correct title (allowing for snapshot merge lag).
        // Do not add any fake success; if the title never appears, fail and dump the last HTML.
        while (true) {
          const res = await undiciFetch(url);
          const html = await res.text();
          lastHtml = html;
          if (html.includes(`<title>${title} | AFFiNE</title>`)) {
            expect(html).toContain(marker);
            break;
          }
          if (Date.now() - start > 30000) {
            // Show a snippet to aid debugging
            throw new Error(
              `Doc renderer did not expose expected title within 30s. Last HTML snippet:\n${lastHtml.slice(0, 500)}`,
            );
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
      } finally {
        try {
          await runCli(
            ['doc', 'delete', docId, '--workspace-id', env.workspaceId!, '--json'],
            opts,
          );
        } catch {
          // best-effort cleanup
        }
      }
    },
  );
});
