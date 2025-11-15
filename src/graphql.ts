/**
 * Minimal GraphQL client and helpers for AFFiNE.
 * Uses src/http.ts postJson helper to POST to /graphql.
 */

import { postJson, type HttpOptions } from './http';
import { readDocument } from './mcp';

export interface GqlErrorLocation {
  line: number;
  column: number;
}

export interface GqlError {
  message: string;
  locations?: GqlErrorLocation[];
  path?: (string | number)[];
  extensions?: Record<string, unknown>;
}

export interface GqlEnvelope<T> {
  data?: T;
  errors?: GqlError[];
}

export async function gql<T = any>(
  query: string,
  variables?: Record<string, unknown>,
  opts?: HttpOptions,
): Promise<T> {
  let res: { data?: GqlEnvelope<T> };
  try {
    res = await postJson<GqlEnvelope<T>>('/graphql', { query, variables }, opts);
  } catch (err: any) {
    const rawBody = err?.response?.body;
    const body: Buffer | undefined = Buffer.isBuffer(rawBody)
      ? rawBody
      : typeof rawBody === 'string'
        ? Buffer.from(rawBody, 'utf8')
        : undefined;
    // Try to parse GraphQL-style errors from a 4xx body to improve diagnostics
    if (body) {
      try {
        const parsed = JSON.parse(body.toString('utf8')) as GqlEnvelope<unknown>;
        if (parsed?.errors && parsed.errors.length) {
          const e = new Error(parsed.errors.map((er: any) => er?.message || 'error').join('; '));
          (e as any).errors = parsed.errors;
          throw e;
        }
      } catch {
        // fall through: non-JSON body
      }
    }
    throw err;
  }
  const { data, errors } = res.data || {};
  if (errors && errors.length) {
    const e = new Error(errors.map((er) => er.message).join('; '));
    (e as any).errors = errors;
    throw e;
  }
  return (data as T) ?? ({} as T);
}

// === Helpers ===

// Workspaces
export interface Workspace {
  id: string;
  enableDocEmbedding?: boolean;
}

export async function listWorkspaces(opts?: HttpOptions): Promise<Workspace[]> {
  const query = /* GraphQL */ `
    query ListWorkspaces {
      workspaces { id enableDocEmbedding }
    }
  `;
  const data = await gql<{ workspaces: Workspace[] }>(query, undefined, opts);
  return data.workspaces;
}

export async function getWorkspace(id: string, opts?: HttpOptions): Promise<Workspace | null> {
  const query = /* GraphQL */ `
    query GetWorkspace($id: String!) {
      workspace(id: $id) { id enableDocEmbedding }
    }
  `;
  const data = await gql<{ workspace: Workspace | null }>(query, { id }, opts);
  return data.workspace ?? null;
}

export async function createWorkspace(opts?: HttpOptions): Promise<Workspace> {
  const query = /* GraphQL */ `
    mutation CreateWorkspace {
      createWorkspace { id enableDocEmbedding }
    }
  `;
  const data = await gql<{ createWorkspace: Workspace }>(query, undefined, opts);
  return data.createWorkspace;
}

export async function updateWorkspace(
  input: { id: string; enableDocEmbedding?: boolean },
  opts?: HttpOptions,
): Promise<Workspace> {
  const query = /* GraphQL */ `
    mutation UpdateWorkspace($input: UpdateWorkspaceInput!) {
      updateWorkspace(input: $input) { id enableDocEmbedding }
    }
  `;
  const data = await gql<{ updateWorkspace: Workspace }>(query, { input }, opts);
  return data.updateWorkspace;
}

// Docs (metadata)
export interface DocNode {
  id: string;
  guid?: string | null;
  title?: string | null;
  public?: boolean | null;
  mode?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface PageInfo {
  hasNextPage: boolean;
  endCursor?: string | null;
}

export interface DocConnection {
  edges: { cursor: string; node: DocNode }[];
  pageInfo: PageInfo;
}

export async function listDocs(
  workspaceId: string,
  first?: number,
  after?: string,
  opts?: HttpOptions,
): Promise<DocConnection> {
  const query = /* GraphQL */ `
    query ListDocs($workspaceId: String!, $pagination: PaginationInput!) {
      workspace(id: $workspaceId) {
        id
        docs(pagination: $pagination) {
          edges { cursor node { id title createdAt updatedAt } }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  `;
  const pagination: Record<string, any> = {};
  if (typeof first === 'number') pagination.first = first;
  if (after) pagination.after = after;
  const data = await gql<{ workspace: { id: string; docs: DocConnection } }>(
    query,
    { workspaceId, pagination },
    opts,
  );
  return data.workspace.docs;
}

export async function listRecentlyUpdatedDocs(
  workspaceId: string,
  first?: number,
  after?: string,
  opts?: HttpOptions,
): Promise<DocConnection> {
  const query = /* GraphQL */ `
    query ListRecentlyUpdatedDocs($workspaceId: String!, $pagination: PaginationInput!) {
      workspace(id: $workspaceId) {
        id
        recentlyUpdatedDocs(pagination: $pagination) {
          edges { cursor node { id title createdAt updatedAt } }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  `;
  const pagination: Record<string, any> = {};
  if (typeof first === 'number') pagination.first = first;
  if (after) pagination.after = after;
  const data = await gql<{ workspace: { id: string; recentlyUpdatedDocs: DocConnection } }>(
    query,
    { workspaceId, pagination },
    opts,
  );
  return data.workspace.recentlyUpdatedDocs;
}

export async function getDoc(
  workspaceId: string,
  docId: string,
  opts?: HttpOptions,
): Promise<DocNode | null> {
  const query = /* GraphQL */ `
    query GetDoc($workspaceId: String!, $docId: String!) {
      workspace(id: $workspaceId) {
        id
        doc(docId: $docId) { id title public mode createdAt updatedAt }
      }
    }
  `;
  const data = await gql<{ workspace: { id: string; doc: DocNode | null } }>(
    query,
    { workspaceId, docId },
    opts,
  );
  const doc = data.workspace.doc ?? null;
  if (!doc) return null;

  // Cross-check against MCP read_document so that docs deleted from the
  // realtime Yjs layer are treated as missing even if legacy metadata still
  // exists in GraphQL.
  try {
    const { markdown } = await readDocument(workspaceId, docId, opts);
    const text = String(markdown || '').toLowerCase();
    if (text.includes('doc with id') && text.includes('not found')) {
      return null;
    }
  } catch {
    // If MCP is unavailable or fails for other reasons, fall back to the
    // GraphQL metadata view and let callers handle any subsequent errors.
  }

  return doc;
}

// Search
export interface SearchDoc {
  docId: string;
  title: string;
  highlight: string;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export async function searchDocsByKeyword(
  workspaceId: string,
  keyword: string,
  limit?: number,
  opts?: HttpOptions,
): Promise<SearchDoc[]> {
  const query = /* GraphQL */ `
    query SearchDocs($workspaceId: String!, $input: SearchDocsInput!) {
      workspace(id: $workspaceId) {
        searchDocs(input: $input) {
          docId
          title
          highlight
          createdAt
          updatedAt
        }
      }
    }
  `;
  const input: Record<string, any> = { keyword };
  if (typeof limit === 'number') input.limit = limit;
  const data = await gql<{ workspace: { searchDocs: SearchDoc[] } }>(
    query,
    { workspaceId, input },
    opts,
  );
  return data.workspace.searchDocs;
}

// Doc mutations
export async function deleteDoc(
  workspaceId: string,
  docId: string,
  opts?: HttpOptions,
): Promise<boolean> {
  // Best-effort mutation name; server may return boolean or deleted id/object
  const query = /* GraphQL */ `
    mutation DeleteDoc($workspaceId: String!, $docId: String!) {
      deleteDoc(workspaceId: $workspaceId, docId: $docId)
    }
  `;
  const data = await gql<{ deleteDoc: unknown }>(query, { workspaceId, docId }, opts);
  const v: any = (data as any).deleteDoc;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return true;
  if (v && typeof v === 'object' && 'id' in v) return true;
  return Boolean(v);
}

export async function publishDoc(
  workspaceId: string,
  docId: string,
  mode: 'Page' | 'Edgeless' = 'Page',
  opts?: HttpOptions,
): Promise<DocNode> {
  const query = /* GraphQL */ `
    mutation PublishDoc($workspaceId: String!, $docId: String!, $mode: PublicDocMode) {
      publishDoc(workspaceId: $workspaceId, docId: $docId, mode: $mode) {
        id
        mode
      }
    }
  `;
  const data = await gql<{ publishDoc: DocNode }>(
    query,
    { workspaceId, docId, mode },
    opts,
  );
  return data.publishDoc;
}

export async function revokePublicDoc(
  workspaceId: string,
  docId: string,
  opts?: HttpOptions,
): Promise<DocNode> {
  const query = /* GraphQL */ `
    mutation RevokePublicDoc($workspaceId: String!, $docId: String!) {
      revokePublicDoc(workspaceId: $workspaceId, docId: $docId) {
        id
        mode
      }
    }
  `;
  const data = await gql<{ revokePublicDoc: DocNode }>(
    query,
    { workspaceId, docId },
    opts,
  );
  return data.revokePublicDoc;
}

// Comments (CLI-013)
export interface CommentAuthor {
  id: string;
  name?: string | null;
}

export interface CommentEdge {
  id: string;
  text: string;
  author?: CommentAuthor | null;
  createdAt?: string | null;
}

export interface CommentConnection {
  edges: CommentEdge[];
  pageInfo?: PageInfo; // Some servers may include pagination info
}

export async function listComments(
  workspaceId: string,
  docId: string,
  first?: number,
  after?: string,
  opts?: HttpOptions,
): Promise<CommentConnection> {
  const query = /* GraphQL */ `
    query ListComments($workspaceId: String!, $docId: String!, $pagination: PaginationInput!) {
      workspace(id: $workspaceId) {
        id
        comments(docId: $docId, pagination: $pagination) {
          edges {
            cursor
            node {
              id
              content
              createdAt
              user { id name }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  `;
  const pagination: Record<string, any> = {};
  if (typeof first === 'number') pagination.first = first;
  if (after) pagination.after = after;
  const data = await gql<{
    workspace: {
      comments: {
        edges: { cursor: string; node: { id: string; content: any; createdAt?: string | null; user?: CommentAuthor | null } }[];
        pageInfo: PageInfo;
      };
    };
  }>(query, { workspaceId, docId, pagination }, opts);

  const edges: CommentEdge[] = (data.workspace.comments.edges ?? []).map((e) => {
    const node = e.node as any;
    const content = node?.content as any;
    let text = '';
    // Best-effort extraction of plain text from rich JSON content
    try {
      const gather = (n: any, acc: string[]): void => {
        if (!n) return;
        if (typeof n.text === 'string') acc.push(n.text);
        if (Array.isArray(n.content)) {
          for (const child of n.content) gather(child, acc);
        }
      };
      if (content) {
        const acc: string[] = [];
        gather(content, acc);
        text = acc.join(' ').trim();
      }
    } catch {
      // ignore and fallback to empty text
    }
    return {
      id: String(node?.id ?? ''),
      text,
      author: node?.user ?? null,
      createdAt: node?.createdAt ?? null,
    };
  });

  return { edges, pageInfo: data.workspace.comments.pageInfo };
}

export async function addComment(
  workspaceId: string,
  docId: string,
  text: string,
  opts?: HttpOptions,
): Promise<string> {
  const query = /* GraphQL */ `
    mutation AddComment($input: CommentCreateInput!) {
      createComment(input: $input) { id }
    }
  `;
  const input: any = {
    workspaceId,
    docId,
    docMode: 'page',
    docTitle: text.slice(0, 80) || 'Comment',
    content: {
      type: 'paragraph',
      content: [{ type: 'text', text }],
    },
  };
  const data = await gql<{ createComment: { id: string } }>(query, { input }, opts);
  const v: any = (data as any).createComment;
  if (v && typeof v === 'object' && typeof (v as any).id === 'string') return (v as any).id as string;
  throw new Error('Unexpected createComment response');
}

export async function removeComment(
  workspaceId: string,
  docId: string,
  commentId: string,
  opts?: HttpOptions,
): Promise<boolean> {
  const query = /* GraphQL */ `
    mutation RemoveComment($id: String!) {
      deleteComment(id: $id)
    }
  `;
  const data = await gql<{ deleteComment: unknown }>(
    query,
    { id: commentId },
    opts,
  );
  const v: any = (data as any).deleteComment;
  if (typeof v === 'boolean') return v;
  return Boolean(v);
}

// Access tokens (current user)
export interface AccessToken {
  id: string;
  name?: string | null;
  token?: string | null; // only present on create
  createdAt?: string | null;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
}

export async function listAccessTokens(opts?: HttpOptions): Promise<AccessToken[]> {
  const query = /* GraphQL */ `
    query ListAccessTokens { accessTokens { id name createdAt expiresAt } }
  `;
  const data = await gql<{ accessTokens: AccessToken[] }>(query, undefined, opts);
  return data.accessTokens;
}

export async function createAccessToken(
  name: string,
  expiresAt?: string,
  opts?: HttpOptions,
): Promise<AccessToken> {
  const query = /* GraphQL */ `
    mutation CreateAccessToken($input: GenerateAccessTokenInput!) {
      generateUserAccessToken(input: $input) {
        id
        name
        token
        createdAt
        expiresAt
      }
    }
  `;
  const input: Record<string, unknown> = { name };
  if (expiresAt) input['expiresAt'] = expiresAt;
  const data = await gql<{ generateUserAccessToken: AccessToken }>(
    query,
    { input },
    opts,
  );
  return data.generateUserAccessToken;
}

export async function revokeAccessToken(id: string, opts?: HttpOptions): Promise<boolean> {
  const query = /* GraphQL */ `
    mutation RevokeAccessToken($id: String!) { revokeUserAccessToken(id: $id) }
  `;
  const data = await gql<{ revokeUserAccessToken: boolean }>(query, { id }, opts);
  return Boolean(data.revokeUserAccessToken);
}

export default {
  gql,
  listWorkspaces,
  getWorkspace,
  createWorkspace,
  updateWorkspace,
  listDocs,
  listRecentlyUpdatedDocs,
  getDoc,
  searchDocsByKeyword,
  deleteDoc,
  publishDoc,
  revokePublicDoc,
  listComments,
  addComment,
  removeComment,
  listAccessTokens,
  createAccessToken,
  revokeAccessToken,
};
