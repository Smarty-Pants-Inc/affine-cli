/**
 * Yjs + BlockSuite realtime client (CLI-011)
 *
 * Implements real BlockSuite page scaffolding and paragraph appends by
 * constructing proper Yjs updates and sending them over the Socket.IO channel.
 */

import type { HttpOptions } from './http';
// Use dynamic import for Yjs to avoid ESM/CJS build friction
async function getY() {
  return (await import('yjs')) as any;
}

export type RealtimeTransport = {
  connect(): Promise<void>;
  emit<T = unknown>(event: string, payload?: Record<string, any>): Promise<T | void>;
  close(): Promise<void>;
};

export type RealtimeOptions = Pick<HttpOptions, 'baseUrl' | 'headers' | 'token' | 'cookie' | 'timeoutMs' | 'debug'> & {
  workspaceId: string;
  clientVersion?: string;
  transport?: RealtimeTransport;
};

function randId(len = 16): string {
  // Not cryptographic; sufficient for doc id generation client-side.
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

// Create a minimal page with an affine:page root, an affine:note hub, and a paragraph using pure Yjs
export async function buildInitialPageUpdate(title?: string, content?: string): Promise<Uint8Array> {
  const Y = await getY();
  const spaceDoc = new Y.Doc();
  const yBlocks = spaceDoc.getMap('blocks');

  const pageId = randId(20);
  const noteId = randId(20);
  const paraId = content ? randId(20) : undefined;

  const yPage: any = new Y.Map();
  yPage.set('sys:id', pageId);
  yPage.set('sys:flavour', 'affine:page');
  yPage.set('sys:version', 2);
  yPage.set('sys:children', Y.Array.from([noteId]));
  if (title) yPage.set('prop:title', new Y.Text(String(title)));
  yBlocks.set(pageId, yPage);

  const yNote: any = new Y.Map();
  yNote.set('sys:id', noteId);
  yNote.set('sys:flavour', 'affine:note');
  yNote.set('sys:version', 1);
  yNote.set('sys:children', Y.Array.from(paraId ? [paraId] : []));
  // Minimal required props; leave most defaults to server/editor
  yNote.set('prop:xywh', '[0,0,600,400]');
  yBlocks.set(noteId, yNote);

  if (paraId) {
    const yPara: any = new Y.Map();
    yPara.set('sys:id', paraId);
    yPara.set('sys:flavour', 'affine:paragraph');
    yPara.set('sys:version', 1);
    yPara.set('sys:children', Y.Array.from([]));
    yPara.set('prop:type', 'text');
    yPara.set('prop:collapsed', false);
    yPara.set('prop:text', new Y.Text(String(content ?? '')));
    yBlocks.set(paraId, yPara);
  }

  return Y.encodeStateAsUpdate(spaceDoc);
}

/**
 * Default Socket.IO transport (dynamic import). Not used in tests.
 * If socket.io-client is missing at runtime, throws a clear error.
 */
export class SocketIoTransport implements RealtimeTransport {
  private socket: any | null = null;
  constructor(private readonly opts: RealtimeOptions) {}

  async connect(): Promise<void> {
    if (this.socket) return;
    const base = (this.opts.baseUrl ?? '').replace(/\/$/, '');
    if (!base) throw new Error('baseUrl is required to open realtime transport');

    // Dynamic import to avoid build-time dependency.
    let io: any;
    try {
      io = (await import('socket.io-client')).io;
    } catch {
      throw new Error('socket.io-client is required for realtime operations at runtime');
    }

    const extraHeaders: Record<string, string> = { ...(this.opts.headers ?? {}) };
    // Prefer cookie for realtime; fall back to Bearer
    if (this.opts.cookie && !extraHeaders['cookie']) extraHeaders['cookie'] = this.opts.cookie;
    if (this.opts.token && !extraHeaders['authorization']) extraHeaders['authorization'] = `Bearer ${this.opts.token}`;

    this.socket = io(base, {
      transports: ['websocket'],
      extraHeaders,
      // Provide cookie-like handshake auth compatibility if a cookie string is present
      auth: this.opts.cookie
        ? { token: this.opts.cookie, userId: '' }
        : undefined,
      timeout: Math.max(1, this.opts.timeoutMs ?? 30_000),
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('realtime connect timeout')), Math.max(1, this.opts.timeoutMs ?? 30_000));
      this.socket!.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket!.once('connect_error', (err: any) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  async emit<T = unknown>(event: string, payload?: Record<string, any>): Promise<T | void> {
    if (!this.socket) throw new Error('transport not connected');
    return await new Promise<T | void>((resolve, reject) => {
      try {
        // Socket.IO ack: last arg is callback(err, data?)
        this.socket.emit(event, payload ?? {}, (ack: any) => {
          if (!ack || typeof ack !== 'object' || 'data' in ack) return resolve(ack?.data as T);
          resolve(ack as T);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  async close(): Promise<void> {
    if (!this.socket) return;
    const s = this.socket;
    this.socket = null;
    try {
      await new Promise<void>((res) => {
        s.once('disconnect', () => res());
        s.disconnect();
        // Fallback: resolve after microtask if no event is fired
        queueMicrotask(() => res());
      });
    } catch {
      // ignore
    }
  }
}

async function ensureTransport(opts: RealtimeOptions): Promise<RealtimeTransport> {
  if (opts.transport) return opts.transport;
  const t = new SocketIoTransport(opts);
  await t.connect();
  return t;
}

async function joinWorkspace(transport: RealtimeTransport, workspaceId: string, clientVersion = '1.0.0') {
  await transport.emit('space:join', {
    spaceType: 'workspace',
    spaceId: workspaceId,
    clientVersion,
  });
}

function extractRealtimeError(ack: any): string | undefined {
  if (!ack || typeof ack !== 'object') return undefined;
  const raw = (ack as any).error;
  if (!raw) return undefined;
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    if (typeof (raw as any).message === 'string') return (raw as any).message;
    try {
      return JSON.stringify(raw);
    } catch {
      return String(raw);
    }
  }
  return String(raw);
}

function ensureAckOk(ack: any, op: string): void {
  const msg = extractRealtimeError(ack);
  if (!msg) return;
  const err = new Error(`realtime ${op} failed: ${msg}`);
  (err as any).ack = ack;
  throw err;
}

async function appendDocMetaToWorkspaceRoot(
  transport: RealtimeTransport,
  workspaceId: string,
  docId: string,
  title?: string,
) {
  const Y = await getY();
  const rootDoc = new Y.Doc({ guid: workspaceId });
  let snapshotB64: string | undefined;

  try {
    const res = await transport.emit<any>('space:load-doc', {
      spaceType: 'workspace',
      spaceId: workspaceId,
      docId: workspaceId,
    });
    if (!res || typeof res !== 'object' || 'error' in res) {
      return;
    }
    snapshotB64 = res.missing || res.state;
  } catch {
    return;
  }

  if (!snapshotB64) return;

  try {
    const buf = Buffer.from(snapshotB64, 'base64');
    if (!buf.length) return;
    Y.applyUpdate(rootDoc, new Uint8Array(buf));

    const meta = rootDoc.getMap('meta');
    let pages = meta.get('pages');
    if (!pages || !(pages instanceof Y.Array)) {
      pages = new Y.Array();
      meta.set('pages', pages);
    }

    const existingIds = pages
      .toArray()
      .map((entry: any) => (entry && typeof entry.get === 'function' ? entry.get('id') : undefined))
      .filter(Boolean);
    if (existingIds.includes(docId)) {
      return;
    }

    const yDocMeta: any = new Y.Map();
    yDocMeta.set('id', docId);
    yDocMeta.set('title', title ?? '');
    yDocMeta.set('createDate', Date.now());
    yDocMeta.set('tags', new Y.Array());
    pages.push([yDocMeta]);

    const update = Y.encodeStateAsUpdate(rootDoc);
    await transport.emit('space:push-doc-update', {
      spaceType: 'workspace',
      spaceId: workspaceId,
      docId: workspaceId,
      update: Buffer.from(update).toString('base64'),
    });
  } catch {
    // ignore; doc creation already succeeded at this point
  }
}

export type CreateDocOptions = RealtimeOptions & {
  title: string;
  content?: string;
};

export async function createDoc(opts: CreateDocOptions): Promise<{ docId: string; timestamp?: number }>{
  const workspaceId = opts.workspaceId;
  const transport = await ensureTransport(opts);
  const clientVersion = opts.clientVersion ?? '1.0.0';
  let needClose = !opts.transport;
  try {
    await joinWorkspace(transport, workspaceId, clientVersion);
    const docId = randId(20);
    // Build a real BlockSuite page scaffold with optional title/content (deterministic ids)
    const update = await (async () => {
      const Y = await getY();
      const spaceDoc = new Y.Doc();
      const yBlocks = spaceDoc.getMap('blocks');

      const pageId = `page:${docId}`;
      const noteId = `note:${docId}`;
      const paraId = opts.content ? `p:${Date.now().toString(36)}${randId(6)}` : undefined;

      const yPage: any = new Y.Map();
      yPage.set('sys:id', pageId);
      yPage.set('sys:flavour', 'affine:page');
      yPage.set('sys:version', 2);
      yPage.set('sys:children', Y.Array.from([noteId]));
      if (opts.title) yPage.set('prop:title', new Y.Text(String(opts.title)));
      yBlocks.set(pageId, yPage);

      const yNote: any = new Y.Map();
      yNote.set('sys:id', noteId);
      yNote.set('sys:flavour', 'affine:note');
      yNote.set('sys:version', 1);
      yNote.set('sys:children', Y.Array.from(paraId ? [paraId] : []));
      yNote.set('prop:xywh', '[0,0,600,400]');
      yBlocks.set(noteId, yNote);

      if (paraId) {
        const yPara: any = new Y.Map();
        yPara.set('sys:id', paraId);
        yPara.set('sys:flavour', 'affine:paragraph');
        yPara.set('sys:version', 1);
        yPara.set('sys:children', Y.Array.from([]));
        yPara.set('prop:type', 'text');
        yPara.set('prop:collapsed', false);
        yPara.set('prop:text', new Y.Text(String(opts.content ?? '')));
        yBlocks.set(paraId, yPara);
      }

      return Y.encodeStateAsUpdate(spaceDoc);
    })();
    const res = await transport.emit<{ accepted?: boolean; timestamp?: number; error?: any }>('space:push-doc-update', {
      spaceType: 'workspace',
      spaceId: workspaceId,
      docId,
      // Socket.IO supports binary; send Buffer to preserve bytes
      update: Buffer.from(update).toString('base64'),
    });
    ensureAckOk(res, 'space:push-doc-update');
    await appendDocMetaToWorkspaceRoot(transport, workspaceId, docId, opts.title);
    return { docId, timestamp: (res as any)?.timestamp };
  } finally {
    if (needClose) await transport.close();
  }
}

export type AppendTextOptions = RealtimeOptions & {
  docId: string;
  text: string;
};

export async function appendText(opts: AppendTextOptions): Promise<{ accepted: boolean; timestamp?: number }>{
  const workspaceId = opts.workspaceId;
  const transport = await ensureTransport(opts);
  const clientVersion = opts.clientVersion ?? '1.0.0';
  let needClose = !opts.transport;
  try {
    await joinWorkspace(transport, workspaceId, clientVersion);
    const withTimeout = <T>(p: Promise<T>, ms = 3000) => new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('pull timeout')), ms);
      p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
    });

    const Y = await getY();
    const doc = new Y.Doc();
    let havePulled = false;
    try {
      const pulled = await withTimeout(
        transport.emit<any>('space:load-doc', {
          spaceType: 'workspace',
          spaceId: workspaceId,
          docId: opts.docId,
        }) as Promise<any>,
      );
      const snapBase64 =
        typeof (pulled as any)?.missing === 'string'
          ? (pulled as any).missing
          : typeof (pulled as any)?.state === 'string'
            ? (pulled as any).state
            : undefined;
      if (snapBase64) {
        const buf = Buffer.from(snapBase64, 'base64');
        if (buf.length) {
          Y.applyUpdate(doc, new Uint8Array(buf));
          havePulled = true;
        }
      }
    } catch {
      // Fallback: rely on deterministic ids from create
      havePulled = false;
    }

    const yBlocks = doc.getMap('blocks');
    const noteId = havePulled ? (() => {
      let pid: string | null = null; let nid: string | null = null;
      yBlocks.forEach((yBlock: any, id: string) => { if (yBlock.get('sys:flavour') === 'affine:page') pid = id; });
      if (pid) {
        const yPage: any = yBlocks.get(pid);
        const children: any = yPage?.get('sys:children');
        const arr = Array.isArray(children?.toArray?.()) ? children.toArray() : [];
        for (const cid of arr) { const child = yBlocks.get(cid); if (child?.get('sys:flavour') === 'affine:note') { nid = cid; break; } }
      }
      return nid;
    })() : `note:${opts.docId}`;

    if (!noteId) throw new Error('append failed: could not locate note block under page');

    const paraId = `p:${Date.now().toString(36)}${randId(6)}`;
    Y.transact(doc, () => {
      const yPara: any = new Y.Map();
      yPara.set('sys:id', paraId);
      yPara.set('sys:flavour', 'affine:paragraph');
      yPara.set('sys:version', 1);
      yPara.set('sys:children', Y.Array.from([]));
      yPara.set('prop:type', 'text');
      yPara.set('prop:collapsed', false);
      yPara.set('prop:text', new Y.Text(String(opts.text ?? '')));
      yBlocks.set(paraId, yPara);

      // If we didn't pull, the note won't exist in our local doc; create a minimal stub so the child push is well-formed
      if (!yBlocks.get(noteId)) {
        const yNote: any = new Y.Map();
        yNote.set('sys:id', noteId);
        yNote.set('sys:flavour', 'affine:note');
        yNote.set('sys:version', 1);
        yNote.set('sys:children', Y.Array.from([]));
        yBlocks.set(noteId, yNote);
      }
      const yNote: any = yBlocks.get(noteId);
      const yChildren = yNote.get('sys:children');
      yChildren.push([paraId]);
    });

    const update = Y.encodeStateAsUpdate(doc);
    const res = await transport.emit<{ accepted?: boolean; timestamp?: number; error?: any }>('space:push-doc-update', {
      spaceType: 'workspace',
      spaceId: workspaceId,
      docId: opts.docId,
      update: Buffer.from(update).toString('base64'),
    });
    ensureAckOk(res, 'space:push-doc-update');
    const accepted = (res as any)?.accepted !== false;
    return { accepted, timestamp: (res as any)?.timestamp };
  } finally {
    if (needClose) await transport.close();
  }
}

export type DeleteDocRealtimeOptions = RealtimeOptions & {
  docId: string;
};

export async function deleteDocRealtime(
  opts: DeleteDocRealtimeOptions,
): Promise<{ ok: boolean }>{
  const workspaceId = opts.workspaceId;
  const transport = await ensureTransport(opts);
  const clientVersion = opts.clientVersion ?? '1.0.0';
  let needClose = !opts.transport;
  try {
    await joinWorkspace(transport, workspaceId, clientVersion);
    const ack = await transport.emit('space:delete-doc', {
      spaceType: 'workspace',
      spaceId: workspaceId,
      docId: opts.docId,
    });
    ensureAckOk(ack, 'space:delete-doc');
    return { ok: true };
  } finally {
    if (needClose) await transport.close();
  }
}

export default { createDoc, appendText, deleteDocRealtime, SocketIoTransport };
