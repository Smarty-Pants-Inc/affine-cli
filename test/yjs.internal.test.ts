import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';

import { buildInitialPageUpdate, createDoc, appendText, type RealtimeTransport } from '../src/yjs';

class FakeTransport implements RealtimeTransport {
  public events: { event: string; payload: any }[] = [];
  private updatesByDocId = new Map<string, Uint8Array[]>();

  async connect(): Promise<void> {
    // no-op
  }

  async close(): Promise<void> {
    // no-op
  }

  async emit<T = unknown>(event: string, payload?: Record<string, any>): Promise<T | void> {
    this.events.push({ event, payload });

    if (event === 'space:push-doc-update') {
      const docId = String(payload?.docId ?? '');
      const raw = payload?.update;
      const buf: Buffer = Buffer.isBuffer(raw)
        ? (raw as Buffer)
        : Buffer.from(String(raw ?? ''), 'base64');
      const existing = this.updatesByDocId.get(docId) ?? [];
      existing.push(new Uint8Array(buf));
      this.updatesByDocId.set(docId, existing);
      return { accepted: true, timestamp: Date.now() } as any as T;
    }

    if (event === 'space:pull-doc-update') {
      const docId = String(payload?.docId ?? '');
      const updates = this.updatesByDocId.get(docId) ?? [];
      if (!updates.length) {
        return { update: Buffer.alloc(0) } as any as T;
      }
      const doc = new Y.Doc();
      for (const u of updates) Y.applyUpdate(doc, u);
      const combined = Y.encodeStateAsUpdate(doc);
      return { update: Buffer.from(combined) } as any as T;
    }

    // space:join and other events are ignored for tests
    return undefined;
  }

  getCombinedUpdate(docId: string): Uint8Array {
    const updates = this.updatesByDocId.get(docId) ?? [];
    if (!updates.length) return new Uint8Array();
    const doc = new Y.Doc();
    for (const u of updates) Y.applyUpdate(doc, u);
    return Y.encodeStateAsUpdate(doc);
  }
}

describe('yjs internal page scaffolding', () => {
  it('buildInitialPageUpdate creates affine:page -> affine:note -> affine:paragraph hierarchy', async () => {
    const title = 'My Page';
    const content = 'Hello world';

    const update = await buildInitialPageUpdate(title, content);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, update);

    const blocks = doc.getMap('blocks');
    let pageId: string | null = null;
    let pageBlock: any = null;

    blocks.forEach((block: any, id: string) => {
      if (block.get('sys:flavour') === 'affine:page') {
        pageId = id;
        pageBlock = block;
      }
    });

    expect(pageId).not.toBeNull();
    const pageChildren = (pageBlock!.get('sys:children') as any).toArray();
    expect(Array.isArray(pageChildren)).toBe(true);
    expect(pageChildren.length).toBe(1);

    const noteId = pageChildren[0] as string;
    const noteBlock: any = blocks.get(noteId);
    expect(noteBlock).toBeDefined();
    expect(noteBlock.get('sys:flavour')).toBe('affine:note');

    const noteChildren = (noteBlock.get('sys:children') as any).toArray();
    expect(noteChildren.length).toBe(1);
    const paraId = noteChildren[0] as string;
    const paraBlock: any = blocks.get(paraId);
    expect(paraBlock).toBeDefined();
    expect(paraBlock.get('sys:flavour')).toBe('affine:paragraph');

    const yText = paraBlock.get('prop:text');
    const text = typeof yText?.toString === 'function' ? yText.toString() : '';
    expect(text).toBe(content);
  });

  it('createDoc + appendText produce multiple paragraphs under the note block', async () => {
    const transport = new FakeTransport();
    const workspaceId = 'ws-yjs-1';

    const firstContent = 'First paragraph';
    const secondContent = 'Second paragraph';

    const { docId } = await createDoc({
      workspaceId,
      title: 'Test Page',
      content: firstContent,
      transport,
    } as any);

    // Apply initial update to inspect baseline structure
    const initialUpdate = transport.getCombinedUpdate(docId);
    const doc1 = new Y.Doc();
    Y.applyUpdate(doc1, initialUpdate);
    const blocks1 = doc1.getMap('blocks');

    let noteId1: string | null = null;
    blocks1.forEach((block: any, id: string) => {
      if (block.get('sys:flavour') === 'affine:note') noteId1 = id;
    });
    expect(noteId1).not.toBeNull();
    const noteBlock1: any = blocks1.get(noteId1!);
    const baseChildren = (noteBlock1.get('sys:children') as any).toArray();
    expect(baseChildren.length).toBe(1);

    // Append a second paragraph
    await appendText({
      workspaceId,
      docId,
      text: secondContent,
      transport,
    } as any);

    const finalUpdate = transport.getCombinedUpdate(docId);
    const doc2 = new Y.Doc();
    Y.applyUpdate(doc2, finalUpdate);
    const blocks2 = doc2.getMap('blocks');

    let noteId2: string | null = null;
    blocks2.forEach((block: any, id: string) => {
      if (block.get('sys:flavour') === 'affine:note') noteId2 = id;
    });
    expect(noteId2).not.toBeNull();
    const noteBlock2: any = blocks2.get(noteId2!);
    const children2 = (noteBlock2.get('sys:children') as any).toArray();
    expect(children2.length).toBeGreaterThanOrEqual(2);

    const texts = children2.map((pid: string) => {
      const para: any = blocks2.get(pid);
      const yText = para?.get('prop:text');
      return typeof yText?.toString === 'function' ? yText.toString() : '';
    });

    // Order is not strictly important, but both contents must be present
    expect(texts).toContain(firstContent);
    expect(texts).toContain(secondContent);
  });
});
