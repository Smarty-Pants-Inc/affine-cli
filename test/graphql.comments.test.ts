import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/http', () => ({
  postJson: vi.fn(),
}));

import { listComments } from '../src/graphql';
import { postJson } from '../src/http';

const postJsonMock = postJson as any;

function mkGqlResponse(payload: any) {
  return {
    status: 200,
    headers: {},
    data: payload,
    rawBody: Buffer.from(JSON.stringify(payload), 'utf8'),
  } as any;
}

describe('graphql listComments', () => {
  beforeEach(() => {
    postJsonMock.mockReset();
  });

  it('extracts plain text and metadata from rich comment content and preserves pageInfo', async () => {
    const workspaceId = 'ws-comments-1';
    const docId = 'doc-123';

    postJsonMock.mockResolvedValueOnce(mkGqlResponse({
      data: {
        workspace: {
          comments: {
            edges: [
              {
                cursor: 'cur1',
                node: {
                  id: 'c1',
                  content: {
                    type: 'paragraph',
                    content: [
                      { type: 'text', text: 'Hello' },
                      { type: 'text', text: 'world' },
                    ],
                  },
                  createdAt: '2025-01-01T00:00:00.000Z',
                  user: { id: 'u1', name: 'Alice' },
                },
              },
              {
                cursor: 'cur2',
                node: {
                  id: 'c2',
                  // Nested content tree should still be flattened into a reasonable text string
                  content: {
                    type: 'doc',
                    content: [
                      {
                        type: 'paragraph',
                        content: [
                          { type: 'text', text: 'Second' },
                          { type: 'text', text: 'line' },
                        ],
                      },
                    ],
                  },
                  createdAt: '2025-01-02T00:00:00.000Z',
                  user: { id: 'u2', name: 'Bob' },
                },
              },
            ],
            pageInfo: { hasNextPage: true, endCursor: 'cur2' },
          },
        },
      },
    }));

    const conn = await listComments(workspaceId, docId, 1, undefined, { baseUrl: 'http://example' } as any);

    // Underlying GraphQL variables should receive our pagination args
    expect(postJsonMock).toHaveBeenCalledTimes(1);
    const body = postJsonMock.mock.calls[0]?.[1] ?? {};
    expect(body.query).toContain('ListComments');
    expect(body.variables.workspaceId).toBe(workspaceId);
    expect(body.variables.docId).toBe(docId);
    expect(body.variables.pagination.first).toBe(1);

    // pageInfo is passed through from the GraphQL layer
    expect(conn.pageInfo).toBeDefined();
    expect(conn.pageInfo?.hasNextPage).toBe(true);
    expect(conn.pageInfo?.endCursor).toBe('cur2');

    // Edges are mapped to CommentEdge with flattened text and author metadata
    expect(conn.edges).toHaveLength(2);
    const [e1, e2] = conn.edges;

    expect(e1.id).toBe('c1');
    expect(e1.text).toBe('Hello world');
    expect(e1.author?.id).toBe('u1');
    expect(e1.createdAt).toBe('2025-01-01T00:00:00.000Z');

    expect(e2.id).toBe('c2');
    expect(e2.text).toBe('Second line');
    expect(e2.author?.id).toBe('u2');
    expect(e2.createdAt).toBe('2025-01-02T00:00:00.000Z');
  });

  it('respects both first and after pagination arguments in GraphQL variables', async () => {
    postJsonMock.mockResolvedValueOnce(mkGqlResponse({
      data: {
        workspace: {
          comments: {
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    }));

    const conn = await listComments('ws-paging', 'doc-paging', 2, 'cursor-123', { baseUrl: 'http://example' } as any);
    expect(Array.isArray(conn.edges)).toBe(true);

    expect(postJsonMock).toHaveBeenCalledTimes(1);
    const body = postJsonMock.mock.calls[0]?.[1] ?? {};
    expect(body.variables.pagination.first).toBe(2);
    expect(body.variables.pagination.after).toBe('cursor-123');
  });
});
