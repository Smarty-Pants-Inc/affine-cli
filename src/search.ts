import type { HttpOptions } from './http';
import { listDocs, listRecentlyUpdatedDocs, searchDocsByKeyword } from './graphql';
import { keywordSearch, toolsList, readDocument } from './mcp';

export type KeywordSearchSource = 'graphql' | 'mcp' | 'fallback';

export type KeywordSearchItem = {
  docId: string;
  title?: string | null;
  highlight?: string | null;
  snippet?: string | null;
  [k: string]: any;
};

export type KeywordSearchResult = {
  query: string;
  source: KeywordSearchSource;
  items: KeywordSearchItem[];
};

/**
 * Internal helper implementing the keyword search resolution order used by the CLI:
 * 1) GraphQL searchDocs indexer
 * 2) MCP keyword_search tool (if available)
 * 3) Title-scan fallback over listDocs
 */
export async function keywordSearchWithFallback(
  workspaceId: string,
  query: string,
  first?: number,
  httpOpts?: HttpOptions,
): Promise<KeywordSearchResult> {
  let source: KeywordSearchSource = 'fallback';
  let items: any[] = [];
  let docsConn: any | undefined;

  // 1) Try GraphQL indexer search first
  try {
    const gqlItems = await searchDocsByKeyword(workspaceId, query, first, httpOpts);
    items = (gqlItems ?? []).map((d) => ({
      docId: d.docId,
      title: d.title,
      highlight: d.highlight,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    }));
    source = 'graphql';
  } catch {
    // GraphQL path unsupported or failed; try MCP
    try {
      const tools = await toolsList(workspaceId, httpOpts);
      if (tools.find((t) => t.name === 'keyword_search')) {
        items = await keywordSearch(workspaceId, query, undefined, httpOpts);
        source = 'mcp';
      }
    } catch {
      // ignore and fall through to fallback
    }
  }

  // 3) Fallback: filter titles from listDocs when upstream layers are empty or failed
  if (items.length === 0) {
    let conn;
    try {
      conn = await listRecentlyUpdatedDocs(workspaceId, first, undefined, httpOpts);
    } catch {
      // Older servers may not support recentlyUpdatedDocs; fall back to docs
      conn = await listDocs(workspaceId, first, undefined, httpOpts);
    }
    docsConn = conn;
    const q = String(query).toLowerCase();
    items = (conn.edges ?? [])
      .map((e) => e.node)
      .filter((n) => (n.title ?? '').toLowerCase().includes(q))
      .map((n) => ({ docId: n.id, title: n.title ?? null }));
    source = 'fallback';
  }

  // 4) Last-resort fallback: scan markdown content of recently updated docs via MCP read_document
  //    This compensates for indexer lag or configs where searchDocs only indexes titles/summary.
  const maxItems = typeof first === 'number' && first > 0 ? first : undefined;
  const shouldScanContent =
    // Always scan when upstream layers returned nothing, and also
    // supplement GraphQL results to compensate for indexer lag.
    (items.length === 0 || source === 'graphql') &&
    (typeof maxItems === 'undefined' || items.length < maxItems);

  if (shouldScanContent) {
    try {
      const tools = await toolsList(workspaceId, httpOpts);
      if (tools.find((t) => t.name === 'read_document')) {
        const conn = docsConn ?? (await listRecentlyUpdatedDocs(workspaceId, first, undefined, httpOpts));
        const q = String(query).toLowerCase();
        const matches: KeywordSearchItem[] = [];
        const itemsBeforeScan = items.length;
        const seen = new Set<string>();
        for (const it of items as any[]) {
          const id = (it?.docId ?? it?.id) as string | undefined;
          if (id) seen.add(String(id));
        }
        const remaining = typeof maxItems === 'number' ? Math.max(0, maxItems - items.length) : Number.POSITIVE_INFINITY;
        for (const edge of conn.edges ?? []) {
          const node = edge.node;
          const docId = node.id;
          if (seen.has(docId)) continue;
          try {
            const { markdown } = await readDocument(workspaceId, docId, httpOpts);
            const text = String(markdown || '');
            const lower = text.toLowerCase();
            const idx = lower.indexOf(q);
            if (idx >= 0) {
              const start = Math.max(0, idx - 40);
              const end = Math.min(text.length, idx + q.length + 40);
              const snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
              matches.push({
                docId,
                title: node.title ?? null,
                snippet,
              });
              if (matches.length >= remaining) break;
            }
          } catch {
            // ignore per-doc failures and continue scanning others
          }
        }
        if (matches.length > 0) {
          items = itemsBeforeScan ? items.concat(matches) : matches;
          if (itemsBeforeScan === 0 && source !== 'mcp') {
            source = 'fallback';
          }
        }
      }
    } catch {
      // ignore; if MCP is unavailable or fails, we keep items as-is
    }
  }

  return { query, source, items };
}

export default {
  keywordSearchWithFallback,
};
