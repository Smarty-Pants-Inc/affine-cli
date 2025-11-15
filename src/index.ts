#!/usr/bin/env node
// AFFiNE CLI – implements config show (CLI-002) and ws/doc list stubs (CLI-004)

// Declare process to avoid requiring @types/node in the initial skeleton
declare const process: any;

import { spawn } from 'node:child_process';
import { Command, Option } from 'commander';
import { listWorkspaces, listDocs, createWorkspace, getWorkspace, updateWorkspace, getDoc, publishDoc, revokePublicDoc, listComments, addComment, removeComment } from './graphql';
import { readDocument, semanticSearch } from './mcp';
import { loadConfig, writeConfigProfile } from './config';
import { redactConfigDeep } from './credentials';
import { whoami as whoAmIFunc, tokens } from './auth';
import { createDoc as yCreateDoc, appendText as yAppendText, deleteDocRealtime as yDeleteDoc } from './yjs';
import { upload as blobUpload, get as blobGet, rm as blobRm } from './blobs';
import { toJsonList, toTable } from './format';
import { withHints } from './errors';
import { withTelemetry } from './telemetry';
import { keywordSearchWithFallback } from './search';

async function httpFromOpts(opts: any): Promise<any> {
  const env = (process as any)?.env ?? {};

  // Map CLI flag --base-url to config.apiBaseUrl overrides so loadConfig
  // can participate in the precedence chain (defaults < file < env < flags).
  const overrides: Record<string, any> = {};
  if (Object.prototype.hasOwnProperty.call(opts, 'baseUrl') && (opts as any).baseUrl) {
    overrides.apiBaseUrl = (opts as any).baseUrl;
  }

  const cfg = await loadConfig({ profile: (opts as any).profile, overrides });

  const baseUrl =
    (opts as any).baseUrl ||
    env.AFFINE_BASE_URL ||
    (cfg as any).apiBaseUrl;

  const token =
    (opts as any).token ||
    env.AFFINE_TOKEN ||
    (cfg as any).token;

  const cookie =
    (opts as any).cookie ||
    env.AFFINE_COOKIE ||
    (cfg as any).cookie;

  return {
    baseUrl,
    token,
    cookie,
    timeoutMs: (opts as any).timeout,
    // For CLI flows, prefer fast failure over long multi-minute retries.
    // Users can always re-run commands; keeping maxAttempts=1 bounds request
    // duration to roughly the configured timeout.
    maxAttempts: 1,
    debug: (opts as any).verbose,
  };
}

function deriveUiUrl(apiBaseUrl?: string): string | undefined {
  if (!apiBaseUrl) return undefined;
  try {
    const u = new URL(apiBaseUrl);
    // Many deployments mount the API under /api; strip that so we land on the
    // main web app instead of a raw API endpoint.
    if (u.pathname === '/api' || u.pathname.startsWith('/api/')) {
      const rest = u.pathname.replace(/^\/api/, '') || '/';
      u.pathname = rest;
    }
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return undefined;
  }
}

function openBrowser(url: string): void {
  try {
    const platform = (process as any)?.platform || process.platform;
    if (platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    } else if (platform === 'win32') {
      // On Windows, invoke the default handler via "start" with the URL as
      // a quoted argument to avoid command injection via shell metacharacters.
      const safeUrl = `"${String(url).replace(/"/g, '""')}"`;
      spawn('cmd', ['/c', 'start', '""', safeUrl], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
  } catch {
    // Best-effort only; if we cannot open a browser, the printed URL is still useful.
  }
}

function cliError(err: unknown, hints?: string[]): Error {
  const msg = String((err as any)?.message || err || 'Unknown error');
  if (!hints || hints.length === 0) return new Error(msg);
  return new Error(withHints(msg, hints));
}

const program = new Command();

program
  .name('affine')
  .description('AFFiNE CLI')
  .version('0.1.0');

function getWorkspaceIdFrom(opts: any): string {
  const ws = (opts as any)?.workspaceId || (process as any)?.env?.AFFINE_WORKSPACE_ID || '';
  return String(ws || '');
}

program
  .addOption(new Option('--base-url <url>', 'Base URL for AFFiNE API'))
  .addOption(new Option('--workspace-id <id>', 'Workspace ID'))
  .addOption(new Option('--token <token>', 'API token'))
  .addOption(new Option('--cookie <cookie>', 'Auth cookie'))
  .addOption(new Option('--profile <name>', 'Configuration profile'))
  .option('--json', 'Output JSON', false)
  .option('--verbose', 'Verbose logging', false)
  .addOption(
    new Option('--timeout <ms>', 'Request timeout in milliseconds')
      .argParser((v) => {
        const n = parseInt(String(v), 10);
        if (!Number.isFinite(n) || n <= 0) throw new Error('Invalid timeout');
        return n;
      })
      .default(30000),
  );

// config show (CLI-002)
program
  .command('config')
  .description('Configuration commands')
  .command('show')
  .description('Show the merged configuration (defaults < file < env < flags)')
  .action(async function (this: Command) {
    const opts = this.optsWithGlobals();
    const overrides: Record<string, any> = { ...opts };
    // Map CLI flag --base-url to config.apiBaseUrl
    if (Object.prototype.hasOwnProperty.call(overrides, 'baseUrl')) {
      overrides.apiBaseUrl = (overrides as any).baseUrl;
      delete (overrides as any).baseUrl;
    }
    const cfg = await loadConfig({ profile: (opts as any).profile, overrides });
    const redacted = redactConfigDeep(cfg);
    const resolvedProfile =
      (opts as any).profile ??
      (redacted as any).profile ??
      (process as any)?.env?.AFFINE_PROFILE ??
      'default';
    if (typeof (redacted as any).profile === 'undefined') {
      (redacted as any).profile = resolvedProfile;
    }
    if ((opts as any).json) {
      const optionSnapshot = {
        profile: resolvedProfile,
        apiBaseUrl: (opts as any).baseUrl ?? redacted.apiBaseUrl,
        workspaceId: (opts as any).workspaceId ?? (process as any)?.env?.AFFINE_WORKSPACE_ID,
        timeout: (opts as any).timeout,
        verbose: Boolean((opts as any).verbose),
      };
      console.log(JSON.stringify({ ...redacted, options: optionSnapshot }, null, 2));
    } else {
      console.log('AFFiNE CLI configuration');
      console.log(`  profile    : ${redacted.profile ?? ''}`);
      console.log(`  apiBaseUrl : ${redacted.apiBaseUrl ?? ''}`);
      if (typeof (redacted as any).token !== 'undefined') console.log(`  token      : ${(redacted as any).token}`);
      if (typeof (redacted as any).cookie !== 'undefined') console.log(`  cookie     : ${(redacted as any).cookie}`);
    }
  });

// ws commands
const ws = program.command('ws').description('Workspace commands');

ws
  .command('list')
  .description('List workspaces')
  .action(withTelemetry('ws/list', async function (this: Command) {
    const opts = this.optsWithGlobals();
    const httpOpts: any = await httpFromOpts(opts);
    try {
      const items = await listWorkspaces(httpOpts);
      if ((opts as any).json) {
        console.log(JSON.stringify(toJsonList(items), null, 2));
      } else {
        const rows = items.map((w) => ({ id: w.id, embeddings: w.enableDocEmbedding ? 'on' : 'off' }));
        for (const line of toTable(rows, ['id', 'embeddings'])) console.log(line);
      }
    } catch (e) {
      throw cliError(e, [
        'Check AFFINE_BASE_URL and your network connectivity.',
        'If using an API token or cookie, ensure it is valid and not expired.',
      ]);
    }
  }));

ws
  .command('create')
  .description('Create a workspace')
  .action(async function (this: Command) {
    const opts = this.optsWithGlobals();
    const httpOpts: any = await httpFromOpts(opts);
    const w = await createWorkspace(httpOpts);
    if ((opts as any).json) {
      console.log(JSON.stringify(w, null, 2));
    } else {
      console.log(w.id);
    }
  });

ws
  .command('get')
  .description('Get a workspace by id')
  .argument('<id>')
  .action(withTelemetry('ws/get', async function (this: Command, id: string) {
    const opts = this.optsWithGlobals();
    const httpOpts: any = await httpFromOpts(opts);
    try {
      const w = await getWorkspace(id, httpOpts);
      if (!w) throw new Error('workspace not found');
      if ((opts as any).json) {
        console.log(JSON.stringify(w, null, 2));
      } else {
        console.log(`${w.id} embeddings:${w.enableDocEmbedding ? 'on' : 'off'}`);
      }
    } catch (e) {
      throw cliError(e, [
        'Verify that the workspace id is correct and that your token or cookie grants access to it.',
        'Check AFFINE_BASE_URL and your network connectivity.',
      ]);
    }
  }));

const wsEmb = ws.command('embeddings').description('Embeddings settings');

wsEmb
  .command('enable')
  .description('Enable doc embeddings for a workspace')
  .argument('<id>')
  .action(withTelemetry('ws/embeddings_enable', async function (this: Command, id: string) {
    const opts = this.optsWithGlobals();
    const httpOpts: any = await httpFromOpts(opts);
    try {
      const w = await updateWorkspace({ id, enableDocEmbedding: true }, httpOpts);
      if ((opts as any).json) {
        console.log(JSON.stringify(w, null, 2));
      } else {
        console.log(`${w.id} embeddings:on`);
      }
    } catch (e) {
      throw cliError(e, [
        'Ensure embeddings are supported by your AFFiNE server and workspace.',
        'Check AFFINE_BASE_URL, credentials, and server logs for validation errors.',
      ]);
    }
  }));

wsEmb
  .command('disable')
  .description('Disable doc embeddings for a workspace')
  .argument('<id>')
  .action(withTelemetry('ws/embeddings_disable', async function (this: Command, id: string) {
    const opts = this.optsWithGlobals();
    const httpOpts: any = await httpFromOpts(opts);
    try {
      const w = await updateWorkspace({ id, enableDocEmbedding: false }, httpOpts);
      if ((opts as any).json) {
        console.log(JSON.stringify(w, null, 2));
      } else {
        console.log(`${w.id} embeddings:off`);
      }
    } catch (e) {
      throw cliError(e, [
        'Ensure embeddings are supported by your AFFiNE server and workspace.',
        'Check AFFINE_BASE_URL, credentials, and server logs for validation errors.',
      ]);
    }
  }));

// doc commands
const docCmd = program.command('doc').description('Document commands');

docCmd
  .command('list')
  .description('List docs in a workspace')
  .addOption(new Option('--first <n>', 'Limit results').argParser((v) => parseInt(String(v), 10)))
  .addOption(new Option('--after <cursor>', 'Pagination cursor'))
  .action(withTelemetry('doc/list', async function (this: Command) {
    const opts = this.optsWithGlobals();
    const workspaceId = getWorkspaceIdFrom(opts);
    if (!workspaceId) throw new Error('workspace-id is required');
    const httpOpts: any = await httpFromOpts(opts);
    const first = (opts as any).first as number | undefined;
    const after = (opts as any).after as string | undefined;
    try {
      const conn = await listDocs(workspaceId, first, after, httpOpts);
      if ((opts as any).json) {
        const nodes = (conn.edges ?? []).map((e) => e.node);
        console.log(JSON.stringify(toJsonList(nodes, conn.pageInfo), null, 2));
      } else {
        const rows = (conn.edges ?? []).map((e) => ({ id: e.node.id, title: e.node.title ?? '' }));
        for (const line of toTable(rows, ['id', 'title'])) console.log(line);
      }
    } catch (e) {
      throw cliError(e, [
        'Verify that the workspace id is correct and reachable.',
        'Check AFFINE_BASE_URL, credentials, and server logs for GraphQL errors.',
      ]);
    }
  }));

docCmd
  .command('read-md')
  .description('Read a document as markdown and print to stdout')
  .argument('<docId>', 'Document ID')
  .action(withTelemetry('doc/read_md', async function (this: Command, docId: string) {
    const opts = this.optsWithGlobals();
    const workspaceId = getWorkspaceIdFrom(opts);
    if (!workspaceId) throw new Error('workspace-id is required');
    const httpOpts: any = await httpFromOpts(opts);
    try {
      const ws = await getWorkspace(workspaceId, httpOpts);
      if (ws && !ws.enableDocEmbedding) {
        throw new Error(`Embeddings are disabled for workspace ${workspaceId}`);
      }

      const { markdown } = await readDocument(workspaceId, docId, httpOpts);
      const text = String(markdown ?? '');
      const lower = text.toLowerCase();
      if (lower.includes('doc with id') && lower.includes('not found')) {
        throw new Error(`Doc ${docId} not found`);
      }
      if ((opts as any).json) {
        console.log(JSON.stringify({ docId, markdown: text }, null, 2));
      } else {
        console.log(text);
      }
    } catch (e: any) {
      const msg = String(e?.message || 'Failed to read document as Markdown');
      throw new Error(
        withHints(msg, [
          'Ensure Copilot/MCP is enabled on the server and the workspace allows embeddings.',
          `You can enable embeddings with: affine ws embeddings enable ${workspaceId}`,
        ]),
      );
    }
  }));

docCmd
  .command('get')
  .description('Get a document by id')
  .argument('<docId>', 'Document ID')
  .action(withTelemetry('doc/get', async function (this: Command, docId: string) {
    const opts = this.optsWithGlobals();
    const workspaceId = getWorkspaceIdFrom(opts);
    if (!workspaceId) throw new Error('workspace-id is required');
    const httpOpts: any = await httpFromOpts(opts);
    try {
      const doc = await getDoc(workspaceId, docId, httpOpts);
      if (!doc) throw new Error('doc not found');
      if ((opts as any).json) {
        console.log(JSON.stringify(doc, null, 2));
      } else {
        console.log(`${doc.id}${doc.title ? ' ' + doc.title : ''}`.trim());
      }
    } catch (e) {
      throw cliError(e, [
        'Ensure the document id is correct and the workspace is accessible.',
        'If the doc was recently deleted, allow a moment for indexes to update.',
      ]);
    }
  }));

docCmd
  .command('delete')
  .description('Delete a document by id')
  .argument('<docId>', 'Document ID')
  .action(withTelemetry('doc/delete', async function (this: Command, docId: string) {
    const opts = this.optsWithGlobals();
    const workspaceId = getWorkspaceIdFrom(opts);
    if (!workspaceId) throw new Error('workspace-id is required');
    const httpOpts: any = await httpFromOpts(opts);
    try {
      const res = await yDeleteDoc({ workspaceId, docId, ...httpOpts });
      const ok = res?.ok !== false;
      if ((opts as any).json) console.log(JSON.stringify({ ok }, null, 2));
      else console.log(ok ? 'Deleted' : 'Not deleted');
    } catch (e: any) {
      const msg = String(e?.message || 'Failed to delete document');
      throw new Error(
        withHints(msg, [
          'Ensure you have permission to delete this document.',
          'Check server logs for doc storage or indexer errors.',
        ]),
      );
    }
  }));

docCmd
  .command('publish')
  .description('Publish a document')
  .argument('<docId>', 'Document ID')
  .addOption(new Option('--mode <mode>', 'Mode: Page|Edgeless').choices(['Page', 'Edgeless']).default('Page'))
  .action(withTelemetry('doc/publish', async function (this: Command, docId: string) {
    const opts = this.optsWithGlobals();
    const workspaceId = getWorkspaceIdFrom(opts);
    if (!workspaceId) throw new Error('workspace-id is required');
    const httpOpts: any = await httpFromOpts(opts);
    const mode = (opts as any).mode as 'Page' | 'Edgeless';
    try {
      let res = await publishDoc(workspaceId, docId, mode, httpOpts);
      if ((opts as any).json) return console.log(JSON.stringify(res, null, 2));
      console.log(`${res.id} ${res.mode ?? ''}`.trim());
    } catch (e1: any) {
      const msg = String(e1?.message || 'Publish failed');
      throw new Error(
        withHints(msg, [
          'Ensure public sharing is enabled on the server/workspace.',
          'Inspect server logs around the publish mutation for validation errors.',
        ]),
      );
    }
  }));

docCmd
  .command('revoke')
  .description('Revoke a document public link')
  .argument('<docId>', 'Document ID')
  .action(withTelemetry('doc/revoke', async function (this: Command, docId: string) {
    const opts = this.optsWithGlobals();
    const workspaceId = getWorkspaceIdFrom(opts);
    if (!workspaceId) throw new Error('workspace-id is required');
    const httpOpts: any = await httpFromOpts(opts);
    const res = await revokePublicDoc(workspaceId, docId, httpOpts);
    if ((opts as any).json) console.log(JSON.stringify(res, null, 2));
    else console.log(`${res.id}`);
  }));

// Yjs content operations (CLI-011)
docCmd
  .command('create')
  .description('Create a new Yjs page doc via realtime channel')
  .addOption(new Option('--title <title>', 'Document title').makeOptionMandatory())
  .addOption(new Option('--content <text>', 'Initial paragraph text'))
  .action(withTelemetry('doc/create', async function (this: Command) {
    const opts = this.optsWithGlobals();
    const workspaceId = getWorkspaceIdFrom(opts);
    if (!workspaceId) throw new Error('workspace-id is required');
    const httpOpts: any = await httpFromOpts(opts);
    const title = (opts as any).title as string;
    const content = (opts as any).content as string | undefined;
    const { docId, timestamp } = await yCreateDoc({ workspaceId, title, content, ...httpOpts } as any);
    if ((opts as any).json) console.log(JSON.stringify({ docId, timestamp }, null, 2));
    else console.log(docId);
  }));

docCmd
  .command('append')
  .description('Append a paragraph of text to a Yjs doc via realtime channel')
  .argument('<docId>', 'Document ID')
  .addOption(new Option('--text <text>', 'Paragraph text').makeOptionMandatory())
  .action(withTelemetry('doc/append', async function (this: Command, docId: string) {
    const opts = this.optsWithGlobals();
    const workspaceId = getWorkspaceIdFrom(opts);
    if (!workspaceId) throw new Error('workspace-id is required');
    const httpOpts: any = await httpFromOpts(opts);
    const text = (opts as any).text as string;
    const { accepted, timestamp } = await yAppendText({ workspaceId, docId, text, ...httpOpts } as any);
    if ((opts as any).json) console.log(JSON.stringify({ accepted, timestamp }, null, 2));
    else console.log(accepted ? 'OK' : 'FAILED');
  }));

// comment commands (CLI-013)
const commentCmd = program.command('comment').description('Comment commands');

commentCmd
  .command('list')
  .description('List comments for a document')
  .argument('<docId>', 'Document ID')
  .addOption(new Option('--first <n>', 'Limit results').argParser((v) => parseInt(String(v), 10)))
  .addOption(new Option('--after <cursor>', 'Pagination cursor'))
  .action(withTelemetry('comment/list', async function (this: Command, docId: string) {
    const opts = this.optsWithGlobals();
    const workspaceId = getWorkspaceIdFrom(opts);
    if (!workspaceId) throw new Error('workspace-id is required');
    const httpOpts: any = await httpFromOpts(opts);
    const first = (opts as any).first as number | undefined;
    const after = (opts as any).after as string | undefined;
    const conn = await listComments(workspaceId, docId, first, after, httpOpts);
    if ((opts as any).json) {
      // For JSON output, emit a flat items[] list to keep parsing simple for smoke tests.
      console.log(JSON.stringify(toJsonList(conn.edges ?? [], undefined), null, 2));
    } else {
      const rows = (conn.edges ?? []).map((e) => ({ id: e.id, text: e.text ?? '' }));
      for (const line of toTable(rows, ['id', 'text'])) console.log(line);
    }
  }));

commentCmd
  .command('add')
  .description('Add a comment to a document')
  .argument('<docId>', 'Document ID')
  .addOption(new Option('--text <text>', 'Comment text').makeOptionMandatory())
  .action(withTelemetry('comment/add', async function (this: Command, docId: string) {
    const opts = this.optsWithGlobals();
    const workspaceId = getWorkspaceIdFrom(opts);
    if (!workspaceId) throw new Error('workspace-id is required');
    const httpOpts: any = await httpFromOpts(opts);
    const text = (opts as any).text as string;
    const id = await addComment(workspaceId, docId, text, httpOpts);
    if ((opts as any).json) console.log(JSON.stringify({ id }, null, 2));
    else console.log(id);
  }));

commentCmd
  .command('rm')
  .description('Remove a comment by id')
  .argument('<docId>', 'Document ID')
  .addOption(new Option('--id <id>', 'Comment ID').makeOptionMandatory())
  .action(withTelemetry('comment/rm', async function (this: Command, docId: string) {
    const opts = this.optsWithGlobals();
    const workspaceId = getWorkspaceIdFrom(opts);
    if (!workspaceId) throw new Error('workspace-id is required');
    const httpOpts: any = await httpFromOpts(opts);
    const id = (opts as any).id as string;
    const ok = await removeComment(workspaceId, docId, id, httpOpts);
    if ((opts as any).json) console.log(JSON.stringify({ ok }, null, 2));
    else console.log(ok ? 'Removed' : 'Not removed');
  }));

// search commands
const searchCmd = program.command('search').description('Search commands');

searchCmd
  .command('semantic')
  .description('Semantic search within a workspace')
  .argument('<query>', 'Search query')
  .action(withTelemetry('search/semantic', async function (this: Command, query: string) {
    const opts = this.optsWithGlobals();
    const workspaceId = getWorkspaceIdFrom(opts);
    if (!workspaceId) throw new Error('workspace-id is required');
    const httpOpts: any = await httpFromOpts(opts);
    // Pre-check embeddings flag for friendlier guidance
    const ws = await getWorkspace(workspaceId, httpOpts);
    if (!ws?.enableDocEmbedding) {
      throw new Error(withHints(
        `Embeddings are disabled for workspace ${workspaceId}.`,
        [
          `Enable with: affine ws embeddings enable ${workspaceId}`,
          'Ensure an embeddings provider is configured on the server.',
        ],
      ));
    }

    try {
      const matches = await semanticSearch(workspaceId, query, undefined, httpOpts);
      if ((opts as any).json) {
        console.log(JSON.stringify({ query, matches }, null, 2));
      } else {
        for (const m of matches) {
          const score = typeof m.score === 'number' ? m.score.toFixed(3) : '';
          const id = m.id ? ` ${m.id}` : '';
          const snippet = (m as any).snippet ?? (m as any).text ?? '';
          console.log(`${score}${id} ${snippet}`.trim());
        }
      }
    } catch (e: any) {
      throw cliError(e, ['If embeddings are configured, retry later or check server logs.']);
    }
  }));

searchCmd
  .command('keyword')
  .description('Keyword search within a workspace')
  .argument('<query>', 'Search query')
  .addOption(new Option('--first <n>', 'Limit results').argParser((v) => parseInt(String(v), 10)))
  .action(function (this: Command, query: string) {
    let source = 'fallback';
    let items: any[] = [];
    return withTelemetry('search/keyword', async function (this: Command) {
    const opts = this.optsWithGlobals();
    const workspaceId = getWorkspaceIdFrom(opts);
    if (!workspaceId) throw new Error('workspace-id is required');
    const httpOpts: any = await httpFromOpts(opts);
    const firstOpt = (opts as any).first as number | undefined;

    try {
      const result = await keywordSearchWithFallback(workspaceId, query, firstOpt, httpOpts);
      source = result.source;
      items = result.items;

      if ((opts as any).json) {
        console.log(JSON.stringify({ query: result.query, source, total: items.length, items }, null, 2));
      } else {
        if (source !== 'graphql') {
          // Guidance without affecting JSON outputs
          console.error(
            `Note: keyword search source = ${source}. To enable GraphQL indexer search, ensure AFFINE_INDEXER_ENABLED=true and search provider configured.`,
          );
        }
        const rows = items.map((it) => ({
          docId: (it as any).docId ?? (it as any).id ?? '',
          title: (it as any).title ?? (it as any).highlight ?? (it as any).snippet ?? '',
        }));
        for (const line of toTable(rows, ['docId', 'title'])) console.log(line);
      }
    } catch (e) {
      throw cliError(e, [
        'Check GraphQL indexer status, MCP search tools, and server logs for search-related errors.',
      ]);
    }
    }, () => ({ source, total: items.length })).call(this);
  });

// blob commands (CLI-012)
const blobCmd = program.command('blob').description('Blob storage commands');

blobCmd
  .command('upload')
  .description('Upload a local file as a blob')
  .argument('<path>', 'Local file path to upload')
  .addOption(new Option('--name <name>', 'Blob name').makeOptionMandatory())
  .action(withTelemetry('blob/upload', async function (this: Command, filePath: string) {
    const opts = this.optsWithGlobals();
    const workspaceId = getWorkspaceIdFrom(opts);
    if (!workspaceId) throw new Error('workspace-id is required');
    const httpOpts: any = await httpFromOpts(opts);
    const name = (opts as any).name as string;
    try {
      const res = await blobUpload(workspaceId, name, filePath, httpOpts);
      if ((opts as any).json) console.log(JSON.stringify({ ok: res.ok, name, status: res.status }, null, 2));
      else console.log('Uploaded');
    } catch (e) {
      throw cliError(e, [
        'Verify that the workspace id is correct and you have permission to upload blobs.',
        'Check AFFINE_BASE_URL and server logs for GraphQL upload errors.',
      ]);
    }
  }));

blobCmd
  .command('get')
  .description('Download a blob')
  .addOption(new Option('--name <name>', 'Blob name').makeOptionMandatory())
  .addOption(new Option('--out <file>', 'Output file path').makeOptionMandatory())
  .addOption(new Option('--redirect <mode>', 'Redirect handling').choices(['follow', 'manual']).default('follow'))
  .action(withTelemetry('blob/get', async function (this: Command) {
    const opts = this.optsWithGlobals();
    const workspaceId = (opts as any).workspaceId;
    if (!workspaceId) throw new Error('workspace-id is required');
    const httpOpts: any = await httpFromOpts(opts);
    const name = (opts as any).name as string;
    const outPath = (opts as any).out as string;
    const redirect = (opts as any).redirect as 'follow' | 'manual';
    try {
      const res = await blobGet(workspaceId, name, { ...httpOpts, outPath, redirect });
      if ((opts as any).json) console.log(JSON.stringify(res, null, 2));
      else if ((res as any).ok) console.log(outPath);
      else console.log((res as any).location ?? '');
    } catch (e) {
      throw cliError(e, [
        'Verify that the workspace id and blob name are correct.',
        'Check AFFINE_BASE_URL, credentials, and server logs for storage or redirect errors.',
      ]);
    }
  }));

blobCmd
  .command('rm')
  .description('Remove a blob by name')
  .addOption(new Option('--name <name>', 'Blob name').makeOptionMandatory())
  .action(withTelemetry('blob/rm', async function (this: Command) {
    const opts = this.optsWithGlobals();
    const workspaceId = (opts as any).workspaceId;
    if (!workspaceId) throw new Error('workspace-id is required');
    const httpOpts: any = await httpFromOpts(opts);
    const name = (opts as any).name as string;
    try {
      const ok = await blobRm(workspaceId, name, httpOpts);
      if ((opts as any).json) console.log(JSON.stringify({ ok }, null, 2));
      else console.log(ok ? 'Deleted' : 'Not deleted');
    } catch (e) {
      throw cliError(e, [
        'Verify that the workspace id and blob name are correct.',
        'Check AFFINE_BASE_URL, credentials, and server logs for deleteBlob GraphQL errors.',
      ]);
    }
  }));

// whoami
program
  .command('whoami')
  .description('Show the current authenticated user')
  .action(withTelemetry('whoami', async function (this: Command) {
    const opts = this.optsWithGlobals();
    const httpOpts: any = await httpFromOpts(opts);
    const me = await whoAmIFunc(httpOpts);
    if ((opts as any).json) {
      console.log(JSON.stringify(me, null, 2));
    } else {
      if (!me) {
        console.log('Not authenticated');
      } else {
        console.log(`${me.id}${me.email ? ' ' + me.email : ''}`.trim());
      }
    }
  }));

// auth commands
const authCmd = program.command('auth').description('Authentication commands');

// auth login
authCmd
  .command('login')
  .description('Login by storing credentials in the AFFiNE CLI config profile')
  .option('--open-browser', 'Open the AFFiNE web UI to help you create a token', false)
  .option('--validate', 'Validate credentials by calling whoami after writing', false)
  .action(withTelemetry('auth/login', async function (this: Command) {
    const opts = this.optsWithGlobals();
    const isJson = Boolean((opts as any).json);

    const profileFlag = (opts as any).profile as string | undefined;
    let token = (opts as any).token as string | undefined;
    let cookie = (opts as any).cookie as string | undefined;
    let apiBaseUrl = (opts as any).baseUrl as string | undefined;
    const validate = Boolean((opts as any).validate);
    const openUi = Boolean((opts as any).openBrowser);

    // When no token/cookie provided, fall back to interactive prompt on TTY.
    if (!token && !cookie) {
      const stdin = (process as any)?.stdin;
      const isTTY = stdin && typeof stdin.isTTY === 'boolean' ? Boolean(stdin.isTTY) : true;
      if (!isTTY) {
        const msg =
          'No token or cookie provided and stdin is not a TTY. Provide --token/--cookie flags or AFFINE_TOKEN/AFFINE_COOKIE env vars.';
        if (isJson) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
        else console.error(msg);
        (process as any).exitCode = 1;
        return;
      }

      // Interactive path: prompt for token and optional base URL (with sensible default).
      const { createInterface } = await import('node:readline/promises');
      const rl = createInterface({ input: (process as any).stdin, output: (process as any).stdout });
      try {
        // Suggest where to obtain a token and optionally open the web UI.
        let existingCfgBase: string | undefined;
        try {
          const cfg = await loadConfig({ profile: profileFlag });
          existingCfgBase = cfg.apiBaseUrl;
        } catch {
          existingCfgBase = undefined;
        }
        const defaultBaseUrl = existingCfgBase || 'https://api.affine.pro';
        const uiUrl = deriveUiUrl(defaultBaseUrl);
        if (uiUrl) {
          console.log(
            `To obtain an AFFiNE access token, open ${uiUrl} in your browser, sign in, ` +
              'and create a token from the account/settings UI. Then paste it below.',
          );
          if (openUi) {
            openBrowser(uiUrl);
          }
        } else {
          console.log(
            'To obtain an AFFiNE access token, sign in to your AFFiNE web app, create an access token, and paste it below.',
          );
        }

        const tokenAnswer = (await rl.question('AFFiNE access token: ')).trim();
        if (tokenAnswer) token = tokenAnswer;

        // Use existing config (if any) to provide a default base URL hint.
        let baseHint = existingCfgBase || 'https://api.affine.pro';
        const basePrompt = `Base URL [${baseHint}]: `;
        const baseAnswer = (await rl.question(basePrompt)).trim();
        if (baseAnswer) apiBaseUrl = baseAnswer;
        else if (!apiBaseUrl) apiBaseUrl = baseHint;
      } finally {
        rl.close();
      }
    }

    if (!token && !cookie) {
      const msg =
        'No token or cookie provided. Provide --token/--cookie flags or enter a non-empty token when prompted.';
      if (isJson) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
      else console.error(msg);
      (process as any).exitCode = 1;
      return;
    }

    try {
      const writeResult = await writeConfigProfile({
        profile: profileFlag ?? '',
        apiBaseUrl,
        token,
        cookie,
      });

      let validationSummary: { ok: boolean; userId?: string | null; error?: string } | undefined;
      if (validate) {
        try {
          const httpOpts: any = await httpFromOpts({
            ...opts,
            baseUrl: apiBaseUrl ?? (opts as any).baseUrl,
            token,
            cookie,
            profile: writeResult.profile,
          });
          const me = await whoAmIFunc(httpOpts);
          if (me && me.id) {
            validationSummary = { ok: true, userId: me.id ?? null };
          } else {
            validationSummary = { ok: false, userId: null };
          }
        } catch (e: any) {
          validationSummary = { ok: false, error: String(e?.message || e) };
        }
      }

      if (isJson) {
        const payload: any = {
          ok: true,
          profile: writeResult.profile,
          apiBaseUrl:
            writeResult.profileConfig.apiBaseUrl ??
            writeResult.config.apiBaseUrl ??
            apiBaseUrl,
          tokenSet: Boolean(token && String(token).length > 0),
          cookieSet: Boolean(cookie && String(cookie).length > 0),
          configPath: writeResult.path,
        };
        if (validate) payload.validation = validationSummary ?? { ok: false };
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`Saved credentials to profile "${writeResult.profile}" in ${writeResult.path}`);
        const effectiveBaseUrl =
          writeResult.profileConfig.apiBaseUrl ?? writeResult.config.apiBaseUrl ?? apiBaseUrl;
        if (effectiveBaseUrl) console.log(`  apiBaseUrl : ${effectiveBaseUrl}`);
        if (token) console.log('  token     : [stored]');
        if (cookie) console.log('  cookie    : [stored]');
        if (validate && validationSummary) {
          if (validationSummary.ok) {
            console.log(`Validation: OK${validationSummary.userId ? ` (${validationSummary.userId})` : ''}`);
          } else if (validationSummary.error) {
            console.log(`Validation: unable to confirm credentials (${validationSummary.error})`);
          } else {
            console.log('Validation: not authenticated (whoami returned null)');
          }
        }
      }
    } catch (err: any) {
      const reason = String(err?.message || 'Unknown error');
      const friendly = `Failed to update config: ${reason}`;
      if (isJson) console.log(JSON.stringify({ ok: false, error: friendly }, null, 2));
      else console.error(friendly);
      (process as any).exitCode = 1;
    }
  }));

// auth logout
authCmd
  .command('logout')
  .description('Remove stored credentials from the AFFiNE CLI config profile')
  .action(withTelemetry('auth/logout', async function (this: Command) {
    const opts = this.optsWithGlobals();
    const isJson = Boolean((opts as any).json);
    const profileFlag = (opts as any).profile as string | undefined;

    try {
      const res = await writeConfigProfile({
        profile: profileFlag ?? '',
        token: undefined,
        cookie: undefined,
      });

      if (isJson) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              profile: res.profile,
              configPath: res.path,
            },
            null,
            2,
          ),
        );
      } else {
        console.log(`Cleared stored credentials from profile "${res.profile}" in ${res.path}`);
        console.log('Note: environment variables AFFINE_TOKEN/AFFINE_COOKIE still apply if set.');
      }
    } catch (err: any) {
      const reason = String(err?.message || 'Unknown error');
      const friendly = `Failed to update config: ${reason}`;
      if (isJson) console.log(JSON.stringify({ ok: false, error: friendly }, null, 2));
      else console.error(friendly);
      (process as any).exitCode = 1;
    }
  }));

// auth token subcommands
const tokenCmd = authCmd.command('token').description('Access token operations');

tokenCmd
  .command('list')
  .description('List access tokens')
  .action(withTelemetry('token/list', async function (this: Command) {
    const opts = this.optsWithGlobals();
    const httpOpts: any = await httpFromOpts(opts);
    const items = await tokens.list(httpOpts);
    if ((opts as any).json) console.log(JSON.stringify(toJsonList(items), null, 2));
    else {
      const rows = items.map((t) => ({ id: t.id, name: t.name ?? '', expiresAt: t.expiresAt ?? '' }));
      for (const line of toTable(rows, ['id', 'name', 'expiresAt'])) console.log(line);
    }
  }));

tokenCmd
  .command('create')
  .description('Create a new access token')
  .addOption(new Option('--name <name>', 'Token name').makeOptionMandatory())
  .addOption(new Option('--expires-at <ts>', 'ISO timestamp for expiry'))
  .action(withTelemetry('token/create', async function (this: Command) {
    const opts = this.optsWithGlobals();
    const httpOpts: any = await httpFromOpts(opts);
    const name = (opts as any).name as string;
    const expiresAt = (opts as any).expiresAt as string | undefined;
    const created = await tokens.create(name, expiresAt, httpOpts);
    if ((opts as any).json) console.log(JSON.stringify(created, null, 2));
    else {
      console.log(`Created ${created.id}${created.name ? ' ' + created.name : ''}`.trim());
      if (created.token) console.log(`Token: ${created.token}`);
    }
  }));

tokenCmd
  .command('revoke')
  .description('Revoke an access token by id')
  .argument('<id>', 'Token id')
  .action(withTelemetry('token/revoke', async function (this: Command, id: string) {
    const opts = this.optsWithGlobals();
    const httpOpts: any = await httpFromOpts(opts);
    const ok = await tokens.revoke(id, httpOpts);
    if ((opts as any).json) console.log(JSON.stringify({ ok }, null, 2));
    else console.log(ok ? 'Revoked' : 'Not revoked');
  }));

// Default action: show help
program.action(() => {
  const opts = program.opts();
  if ((opts as any).json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          message: 'AFFiNE CLI skeleton',
          options: opts,
        },
        null,
        2,
      ),
    );
  } else {
    program.help();
  }
});

program
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    const opts = program.opts();
    const msg = String(err instanceof Error ? err.message : err);
    if ((opts as any).json) {
      console.error(JSON.stringify({ error: msg }));
    } else {
      console.error(msg);
    }
    process.exit(1);
  });
