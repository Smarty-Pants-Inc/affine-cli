import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/graphql', () => ({
  searchDocsByKeyword: vi.fn(),
  listDocs: vi.fn(),
  listRecentlyUpdatedDocs: vi.fn(),
}));

vi.mock('../src/mcp', () => ({
  keywordSearch: vi.fn(),
  toolsList: vi.fn(),
  readDocument: vi.fn(),
}));

import { keywordSearchWithFallback } from '../src/search';
import { searchDocsByKeyword, listDocs, listRecentlyUpdatedDocs } from '../src/graphql';
import { keywordSearch, toolsList, readDocument } from '../src/mcp';

const searchDocsByKeywordMock = searchDocsByKeyword as any;
const listDocsMock = listDocs as any;
const listRecentlyUpdatedDocsMock = listRecentlyUpdatedDocs as any;
const keywordSearchMock = keywordSearch as any;
const toolsListMock = toolsList as any;
const readDocumentMock = readDocument as any;

describe('keywordSearchWithFallback', () => {
  beforeEach(() => {
    searchDocsByKeywordMock.mockReset();
    listDocsMock.mockReset();
    listRecentlyUpdatedDocsMock.mockReset();
    keywordSearchMock.mockReset();
    toolsListMock.mockReset();
    readDocumentMock.mockReset();
  });

  it('prefers GraphQL searchDocs when it succeeds with results', async () => {
    searchDocsByKeywordMock.mockResolvedValueOnce([
      { docId: 'd1', title: 'Doc 1', highlight: 'hit', createdAt: 't1', updatedAt: 'u1' },
    ]);

    const result = await keywordSearchWithFallback('ws1', 'Doc', 5, { baseUrl: 'http://example' } as any);

    expect(searchDocsByKeywordMock).toHaveBeenCalledTimes(1);
    const vars = searchDocsByKeywordMock.mock.calls[0];
    expect(vars[0]).toBe('ws1');
    expect(vars[1]).toBe('Doc');
    expect(vars[2]).toBe(5);

    expect(result.source).toBe('graphql');
    expect(result.items).toEqual([
      { docId: 'd1', title: 'Doc 1', highlight: 'hit', createdAt: 't1', updatedAt: 'u1' },
    ]);
    expect(keywordSearchMock).not.toHaveBeenCalled();
    expect(listRecentlyUpdatedDocsMock).not.toHaveBeenCalled();
    expect(listDocsMock).not.toHaveBeenCalled();
  });

  it('falls back to MCP keyword_search when GraphQL search throws', async () => {
    searchDocsByKeywordMock.mockRejectedValueOnce(new Error('GraphQL unavailable'));
    toolsListMock.mockResolvedValueOnce([{ name: 'other' }, { name: 'keyword_search' }]);
    keywordSearchMock.mockResolvedValueOnce([
      { docId: 'm1', title: 'From MCP', snippet: 'snippet' },
    ]);

    const result = await keywordSearchWithFallback('ws2', 'query', undefined, { baseUrl: 'http://example' } as any);

    expect(searchDocsByKeywordMock).toHaveBeenCalledTimes(1);
    expect(toolsListMock).toHaveBeenCalledTimes(1);
    expect(keywordSearchMock).toHaveBeenCalledTimes(1);
    expect(listRecentlyUpdatedDocsMock).not.toHaveBeenCalled();
    expect(listDocsMock).not.toHaveBeenCalled();

    expect(result.source).toBe('mcp');
    expect(result.items).toEqual([
      { docId: 'm1', title: 'From MCP', snippet: 'snippet' },
    ]);
  });

  it('uses title-scan fallback when GraphQL and MCP both fail', async () => {
    searchDocsByKeywordMock.mockRejectedValueOnce(new Error('GraphQL down'));
    toolsListMock.mockResolvedValueOnce([{ name: 'keyword_search' }]);
    keywordSearchMock.mockRejectedValueOnce(new Error('MCP error'));

    listRecentlyUpdatedDocsMock.mockResolvedValueOnce({
      edges: [
        { cursor: 'c1', node: { id: 'd1', title: 'First doc' } },
        { cursor: 'c2', node: { id: 'd2', title: 'Other thing' } },
        { cursor: 'c3', node: { id: 'd3', title: 'Doc about query' } },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    });

    const result = await keywordSearchWithFallback('ws3', 'doc', 10, { baseUrl: 'http://example' } as any);

    expect(searchDocsByKeywordMock).toHaveBeenCalledTimes(1);
    expect(toolsListMock).toHaveBeenCalledTimes(1);
    expect(keywordSearchMock).toHaveBeenCalledTimes(1);
    expect(listRecentlyUpdatedDocsMock).toHaveBeenCalledTimes(1);
    expect(listDocsMock).not.toHaveBeenCalled();

    // Title match should be case-insensitive and only include docs whose titles contain the query
    expect(result.source).toBe('fallback');
    expect(result.items).toEqual([
      { docId: 'd1', title: 'First doc' },
      { docId: 'd3', title: 'Doc about query' },
    ]);
  });

  it('treats empty GraphQL results as a miss and still applies title-scan fallback', async () => {
    searchDocsByKeywordMock.mockResolvedValueOnce([]);
    listRecentlyUpdatedDocsMock.mockResolvedValueOnce({
      edges: [
        { cursor: 'c1', node: { id: 'd1', title: 'Hello world' } },
        { cursor: 'c2', node: { id: 'd2', title: 'Another doc' } },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    });

    const result = await keywordSearchWithFallback('ws4', 'hello', undefined, { baseUrl: 'http://example' } as any);

    expect(searchDocsByKeywordMock).toHaveBeenCalledTimes(1);
    expect(toolsListMock).not.toHaveBeenCalled();
    expect(keywordSearchMock).not.toHaveBeenCalled();
    expect(listRecentlyUpdatedDocsMock).toHaveBeenCalledTimes(1);
    expect(listDocsMock).not.toHaveBeenCalled();

    expect(result.source).toBe('fallback');
    expect(result.items).toEqual([
      { docId: 'd1', title: 'Hello world' },
    ]);
  });

  it('falls back to content scan via MCP read_document when titles and indexer miss', async () => {
    searchDocsByKeywordMock.mockResolvedValueOnce([]);
    // No title contains the query
    listRecentlyUpdatedDocsMock.mockResolvedValueOnce({
      edges: [
        { cursor: 'c1', node: { id: 'd1', title: 'First' } },
        { cursor: 'c2', node: { id: 'd2', title: 'Second' } },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
    toolsListMock.mockResolvedValueOnce([{ name: 'read_document' }]);
    readDocumentMock
      .mockResolvedValueOnce({ docId: 'd1', markdown: 'nothing here' })
      .mockResolvedValueOnce({ docId: 'd2', markdown: 'this has the Query term inside' });

    const result = await keywordSearchWithFallback('ws5', 'query', undefined, { baseUrl: 'http://example' } as any);

    expect(searchDocsByKeywordMock).toHaveBeenCalledTimes(1);
    expect(listRecentlyUpdatedDocsMock).toHaveBeenCalledTimes(1);
    expect(toolsListMock).toHaveBeenCalledTimes(1);
    expect(readDocumentMock).toHaveBeenCalledTimes(2);
    expect(keywordSearchMock).not.toHaveBeenCalled();

    expect(result.source).toBe('fallback');
    expect(result.items).toEqual([
      {
        docId: 'd2',
        title: 'Second',
        snippet: expect.stringContaining('Query term inside'),
      },
    ]);
  });
});
