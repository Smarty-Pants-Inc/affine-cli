// Placeholder generated types for @smarty/affine-cli
// This file will be overwritten by GraphQL Code Generator when `npm run codegen` is executed.

export type Maybe<T> = T | null;

export type Workspace = { id: string; enableDocEmbedding?: boolean };

export type PageInfo = { hasNextPage: boolean; endCursor?: Maybe<string> };

export type DocNode = {
  id: string;
  guid?: Maybe<string>;
  title?: Maybe<string>;
  public?: Maybe<boolean>;
  mode?: Maybe<string>;
  createdAt?: Maybe<string>;
  updatedAt?: Maybe<string>;
};

export type DocEdge = { cursor: string; node: DocNode };
export type DocConnection = { edges: DocEdge[]; pageInfo: PageInfo };

export type SearchDoc = { docId: string; title: string; highlight: string; createdAt?: Maybe<string>; updatedAt?: Maybe<string> };

export type CommentAuthor = { id: string; name?: Maybe<string> };
export type CommentEdge = { id: string; text: string; author?: Maybe<CommentAuthor>; createdAt?: Maybe<string> };
export type CommentConnection = { edges: CommentEdge[]; pageInfo?: Maybe<PageInfo> };

export type AccessToken = { id: string; name?: Maybe<string>; token?: Maybe<string>; createdAt?: Maybe<string>; expiresAt?: Maybe<string>; lastUsedAt?: Maybe<string> };
