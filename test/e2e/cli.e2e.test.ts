// E2E smoke tests for AFFiNE; gated by AFFINE_E2E=1 with AFFINE_BASE_URL, AFFINE_TOKEN|AFFINE_COOKIE, and AFFINE_WORKSPACE_ID.
import { describe, it, expect } from 'vitest';

import { listWorkspaces, getWorkspace, listDocs, getDoc, updateWorkspace } from '../../src/graphql';
import { readDocument, semanticSearch, keywordSearch } from '../../src/mcp';
import { loadE2EEnv } from '../utils/env';
import { runCli } from '../utils/runCli';

const env = loadE2EEnv();
const d = env.shouldRun ? describe : describe.skip;

d('CLI-010: @smarty/affine-cli E2E smoke', () => {
  it(
    'workspaces: list and get include provided workspace id',
    { timeout: env.timeoutMs + 5000 },
    async () => {
      const list = await listWorkspaces(env.httpOpts);
      expect(Array.isArray(list)).toBe(true);

      const w = await getWorkspace(env.workspaceId!, env.httpOpts);
      expect(w && typeof w.id === 'string').toBe(true);
      expect(w?.id).toBe(env.workspaceId);

      // CLI probe for embeddings state
      const logs = await runCli(['ws', 'get', env.workspaceId!, '--json'], {
        baseUrl: env.baseUrl,
        token: env.token,
        cookie: env.cookie,
      });
      expect(logs.length).toBeGreaterThan(0);
      const payload = JSON.parse(logs[0]);
      expect(payload && payload.id).toBe(env.workspaceId);
      // embeddings flag should be boolean in JSON and also printable as on/off in text output
      expect(typeof payload.enableDocEmbedding === 'boolean').toBe(true);
      const text = (await runCli(['ws', 'get', env.workspaceId!], {
        baseUrl: env.baseUrl,
        token: env.token,
        cookie: env.cookie,
      }))[0] || '';
      expect(/embeddings:(on|off)/.test(text)).toBe(true);
    },
  );

  it(
    'docs: list connection; if any, get and read via CLI returns expected shapes',
    { timeout: env.timeoutMs + 5000 },
    async () => {
      const conn = await listDocs(env.workspaceId!, 5, undefined, env.httpOpts);
      expect(conn && typeof conn === 'object').toBe(true);
      expect(conn).toHaveProperty('edges');
      expect(Array.isArray(conn.edges)).toBe(true);

      if (conn.edges.length > 0) {
        const docId = conn.edges[0].node.id;
        // CLI doc get (GraphQL)
        const getOut = await getDoc(env.workspaceId!, docId, env.httpOpts);
        expect(getOut?.id).toBe(docId);
        // CLI doc read-md (MCP)
        const out = await readDocument(env.workspaceId!, docId, env.httpOpts);
        expect(typeof out.markdown).toBe('string');

        // Via CLI JSON outputs
        const getLogs = await runCli(['doc', 'get', docId, '--workspace-id', env.workspaceId!, '--json'], {
          baseUrl: env.baseUrl,
          token: env.token,
          cookie: env.cookie,
        });
        const getPayload = JSON.parse(getLogs[0]);
        expect(getPayload.id).toBe(docId);

        const readLogs = await runCli(['doc', 'read-md', docId, '--workspace-id', env.workspaceId!, '--json'], {
          baseUrl: env.baseUrl,
          token: env.token,
          cookie: env.cookie,
        });
        const readPayload = JSON.parse(readLogs[0]);
        expect(readPayload.docId).toBe(docId);
        expect(typeof readPayload.markdown).toBe('string');
      }
    },
  );

  it(
    'search: detect indexer (graphql) and embeddings (ws flag); MCP semantic available',
    { timeout: env.timeoutMs + 5000 },
    async () => {
      // If the matrix provided an embeddings expectation, set the workspace flag first
      if (typeof env.expectedEmbeddings === 'boolean') {
        await updateWorkspace({ id: env.workspaceId!, enableDocEmbedding: env.expectedEmbeddings }, env.httpOpts);
      }

      // MCP semantic path should respond (may be empty array)
      const sem = await semanticSearch(env.workspaceId!, 'test', undefined, env.httpOpts);
      expect(Array.isArray(sem)).toBe(true);

      // Keyword search detection via CLI: prefer GraphQL
      const key = await keywordSearch(env.workspaceId!, 'test', undefined, env.httpOpts);
      expect(Array.isArray(key)).toBe(true);

      const kwLogs = await runCli(['search', 'keyword', 'test', '--workspace-id', env.workspaceId!, '--json'], {
        baseUrl: env.baseUrl,
        token: env.token,
        cookie: env.cookie,
      });
      const kwPayload = JSON.parse(kwLogs[0]);
      expect(['graphql', 'mcp', 'fallback']).toContain(kwPayload.source);
      const indexerEnabled = kwPayload.source === 'graphql';
      expect(typeof indexerEnabled).toBe('boolean');
      // If provided by matrix, assert expected indexer source tolerance
      if (typeof env.expectedIndexer === 'boolean') {
        if (env.expectedIndexer) {
          expect(kwPayload.source).toBe('graphql');
        } else {
          expect(['mcp', 'fallback']).toContain(kwPayload.source);
        }
      }

      // Embeddings detection via ws get output (on/off)
      const wLogs = await runCli(['ws', 'get', env.workspaceId!, '--json'], {
        baseUrl: env.baseUrl,
        token: env.token,
        cookie: env.cookie,
      });
      const wPayload = JSON.parse(wLogs[0]);
      const embeddingsEnabled = Boolean(wPayload.enableDocEmbedding === true);
      expect(typeof embeddingsEnabled).toBe('boolean');
      if (typeof env.expectedEmbeddings === 'boolean') {
        expect(embeddingsEnabled).toBe(env.expectedEmbeddings);
      }
    },
  );
});
