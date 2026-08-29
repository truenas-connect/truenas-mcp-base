import { describe, expect, it, vi } from 'vitest';
import { Observable, of, throwError } from 'rxjs';
import type { TrueNasApiClient } from '@truenas/api-client';
import { ApiSurface, ReadOnlyTool, SystemHandle } from '@/catalog/tool';
import { createDownloadContentReader, FileContentError } from '@/content/file-content';
import { ContentByteReader, ContentFetcher, ContentFetchResponse, Role } from '@/interfaces';

const encoder = new TextEncoder();

/** The URL `core.download` mints, token and all. Nothing may echo it back. */
const TOKEN = 'ba5eba11deadbeef';
const MINTED = `/_download/41?auth_token=${TOKEN}&filename=app.log`;
const BASE = 'https://nas.local';

/**
 * A client answering `filesystem.stat` and `core.download` from canned
 * observables. Only `api.call` is stubbed: the reader uses no other seam, and
 * a test that had to stub `query` too would be asserting something this file
 * does not do.
 */
function fakeClient(handlers: Partial<Record<string, () => Observable<unknown>>>): {
  client: TrueNasApiClient<ApiSurface>;
  call: ReturnType<typeof vi.fn>;
} {
  const call = vi.fn(
    (method: string) =>
      handlers[method]?.() ?? throwError(() => new Error(`unstubbed method ${method}`)),
  );
  return { client: { api: { call } } as unknown as TrueNasApiClient<ApiSurface>, call };
}

/** `filesystem.stat`'s answer, trimmed to the two fields the reader reads. */
function statOf(size: number, type = 'FILE'): () => Observable<unknown> {
  return () => of({ size, type });
}

/** `core.download`'s `[job_id, url]`. */
function downloadOf(url: unknown = MINTED): () => Observable<unknown> {
  return () => of([41, url]);
}

/** A reader over `bytes`, handed out `chunkSize` at a time, counting cancels. */
function readerOf(
  bytes: Uint8Array,
  chunkSize = bytes.length || 1,
): ContentByteReader & { cancels: () => number } {
  let at = 0;
  let cancels = 0;
  return {
    read: () => {
      if (at >= bytes.length) return Promise.resolve({ done: true });
      const chunk = bytes.subarray(at, at + chunkSize);
      at += chunk.length;
      return Promise.resolve({ done: false, value: chunk });
    },
    cancel: () => {
      cancels += 1;
      return Promise.resolve(undefined);
    },
    cancels: () => cancels,
  };
}

/** A fetcher answering one canned response, recording the URL it was given. */
function fetcherOf(response: ContentFetchResponse): ContentFetcher & { urls: string[] } {
  const urls: string[] = [];
  const fetch = (url: string) => {
    urls.push(url);
    return Promise.resolve(response);
  };
  return Object.assign(fetch, { urls });
}

/** The common case: a system holding one file of `text`. */
function readerFor(
  text: string,
  options: { maxBytes?: number; chunkSize?: number; size?: number } = {},
) {
  const bytes = encoder.encode(text);
  const body = readerOf(bytes, options.chunkSize);
  const fetch = fetcherOf({ status: 200, body });
  const { client, call } = fakeClient({
    'filesystem.stat': statOf(options.size ?? bytes.length),
    'core.download': downloadOf(),
  });
  const files = createDownloadContentReader({
    client,
    baseUrl: BASE,
    fetch,
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  });
  return { files, body, fetch, call };
}

describe('createDownloadContentReader', () => {
  describe('construction', () => {
    it('rejects a base URL that cannot be parsed', () => {
      const { client } = fakeClient({});
      expect(() =>
        createDownloadContentReader({ client, baseUrl: 'nas.local', fetch: fetcherOf({ status: 200, body: null }) }),
      ).toThrow(/Invalid URL/);
    });

    it.each([0, -1, 1.5, Number.NaN])('rejects maxBytes %s', (maxBytes) => {
      const { client } = fakeClient({});
      expect(() =>
        createDownloadContentReader({
          client,
          baseUrl: BASE,
          fetch: fetcherOf({ status: 200, body: null }),
          maxBytes,
        }),
      ).toThrow(RangeError);
    });
  });

  describe('the bounded tail', () => {
    it('returns the last N lines, oldest first', async () => {
      const { files } = readerFor('a\nb\nc\nd\ne\n');
      await expect(files.readTail('/var/log/app.log', 3)).resolves.toEqual({
        path: '/var/log/app.log',
        lines: ['c', 'd', 'e'],
        truncated: true,
      });
    });

    it('returns the whole file, untruncated, when it holds fewer lines than asked for', async () => {
      const { files } = readerFor('a\nb\nc\n');
      await expect(files.readTail('/var/log/app.log', 10)).resolves.toEqual({
        path: '/var/log/app.log',
        lines: ['a', 'b', 'c'],
        truncated: false,
      });
    });

    it('reads a last line that has no trailing newline', async () => {
      const { files } = readerFor('a\nb');
      await expect(files.readTail('/var/log/app.log', 10)).resolves.toMatchObject({
        lines: ['a', 'b'],
      });
    });

    it('reassembles lines split across chunks', async () => {
      const { files } = readerFor('alpha\nbeta\ngamma\n', { chunkSize: 3 });
      await expect(files.readTail('/var/log/app.log', 2)).resolves.toMatchObject({
        lines: ['beta', 'gamma'],
      });
    });

    it.each([0, -1, 2.5, Number.NaN])('rejects maxLines %s', async (maxLines) => {
      const { files } = readerFor('a\n');
      await expect(files.readTail('/var/log/app.log', maxLines)).rejects.toThrow(RangeError);
    });

    it('asks the system for the file it was given, by basename', async () => {
      const { files, call } = readerFor('a\n');
      await files.readTail('/var/log/app.log', 1);
      expect(call).toHaveBeenCalledWith('core.download', [
        'filesystem.get',
        ['/var/log/app.log'],
        'app.log',
      ]);
    });

    it('resolves the minted URL against the base URL', async () => {
      const { files, fetch } = readerFor('a\n');
      await files.readTail('/var/log/app.log', 1);
      expect(fetch.urls).toEqual([`${BASE}${MINTED}`]);
    });
  });

  describe('the byte bound', () => {
    const THREE = 'aaaa\nbbbb\ncccc\n';

    it('drops the partial line a window opening mid-line begins with', async () => {
      // 15 bytes, an 8-byte ceiling: the window opens inside "bbbb", and half
      // a line is not a line.
      const { files } = readerFor(THREE, { maxBytes: 8 });
      await expect(files.readTail('/var/log/app.log', 10)).resolves.toEqual({
        path: '/var/log/app.log',
        lines: ['cccc'],
        truncated: true,
      });
    });

    it('drops the first line of a window that opens exactly on a boundary too', async () => {
      // A 10-byte ceiling opens the window exactly where "bbbb" begins. There
      // is no byte before it to prove that, so "bbbb" goes unread rather than
      // being reported as whole on an assumption.
      const { files } = readerFor(THREE, { maxBytes: 10 });
      await expect(files.readTail('/var/log/app.log', 10)).resolves.toMatchObject({
        lines: ['cccc'],
        truncated: true,
      });
    });

    it('reads to the end of a bounded file whose last line has no newline', async () => {
      // The newest line is the one a tail is for: a window that stopped even a
      // byte short of the end would silently shorten it.
      const { files } = readerFor('aaaa\nbbbb\nlast', { maxBytes: 9 });
      await expect(files.readTail('/var/log/app.log', 10)).resolves.toMatchObject({
        lines: ['last'],
        truncated: true,
      });
    });

    it('answers no lines, truncated, for a line longer than the ceiling', async () => {
      const { files } = readerFor('x'.repeat(40) + '\n', { maxBytes: 8 });
      await expect(files.readTail('/var/log/app.log', 10)).resolves.toEqual({
        path: '/var/log/app.log',
        lines: [],
        truncated: true,
      });
    });

    it('discards whole chunks that fall entirely before the window', async () => {
      // Ten 4-byte lines, a 10-byte ceiling: seven chunks are discarded whole
      // and an eighth in part. Nothing from them may be retained — a discarded
      // chunk held even as an empty view keeps its whole buffer alive, which
      // would make a large file cost memory in proportion to its size.
      const lines = ['l01', 'l02', 'l03', 'l04', 'l05', 'l06', 'l07', 'l08', 'l09', 'l10'];
      const { files } = readerFor(lines.join('\n') + '\n', { maxBytes: 10, chunkSize: 4 });
      await expect(files.readTail('/var/log/app.log', 10)).resolves.toMatchObject({
        lines: ['l09', 'l10'],
        truncated: true,
      });
    });

    it('does not return the half line the ceiling stopped on', async () => {
      // stat said 10 bytes and the body is 20 — the file grew, or the system
      // contradicted itself — so the read fills and stops inside "ccc". Two
      // whole lines is the honest answer; "cc" is not a line.
      const { files } = readerFor('aaa\nbbb\nccc\nddd\neee\n', { size: 10, maxBytes: 10 });
      await expect(files.readTail('/var/log/app.log', 10)).resolves.toEqual({
        path: '/var/log/app.log',
        lines: ['aaa', 'bbb'],
        truncated: true,
      });
    });

    it('keeps the last line when the ceiling fell exactly on a newline', async () => {
      const { files } = readerFor('aaa\nbbb\nccc\n', { size: 8, maxBytes: 8 });
      await expect(files.readTail('/var/log/app.log', 10)).resolves.toMatchObject({
        lines: ['aaa', 'bbb'],
        truncated: true,
      });
    });

    it('bounds a server that returns far more than its own stat reported', async () => {
      // stat says 20 bytes; the body is 200. Nothing about the answer may grow
      // with the body — that is the whole point of bounding on this side.
      const { files, body } = readerFor('x'.repeat(99) + '\nlast line\n', {
        size: 20,
        maxBytes: 16,
        chunkSize: 8,
      });
      const tail = await files.readTail('/var/log/app.log', 100);
      expect(tail.truncated).toBe(true);
      expect(tail.lines.join('\n').length).toBeLessThanOrEqual(16);
      expect(body.cancels()).toBe(1);
    });

    it('reads through a chunk that carried no bytes at all', async () => {
      // `{ done: false }` with no value is what the reader contract permits and
      // what a stream flushing an empty chunk produces; it is not the end of
      // the body and must not be read as one.
      const bytes = encoder.encode('a\nb\n');
      const inner = readerOf(bytes, 2);
      let flushed = false;
      const body: ContentByteReader = {
        ...inner,
        read: () => {
          if (flushed) return inner.read();
          flushed = true;
          return Promise.resolve({ done: false });
        },
      };
      const { client } = fakeClient({
        'filesystem.stat': statOf(bytes.length),
        'core.download': downloadOf(),
      });
      const files = createDownloadContentReader({
        client,
        baseUrl: BASE,
        fetch: fetcherOf({ status: 200, body }),
      });
      await expect(files.readTail('/var/log/app.log', 10)).resolves.toMatchObject({
        lines: ['a', 'b'],
      });
    });

    it('releases the body even when the whole of it was read', async () => {
      const { files, body } = readerFor('a\n');
      await files.readTail('/var/log/app.log', 1);
      expect(body.cancels()).toBe(1);
    });

    it.each([
      ['rejects', () => Promise.reject(new Error('socket already gone'))],
      [
        'throws where it should have rejected',
        () => {
          throw new Error('socket already gone');
        },
      ],
    ])('does not let a cancel that %s replace the answer', async (_name, cancel) => {
      const bytes = encoder.encode('a\nb\n');
      const body: ContentByteReader = { ...readerOf(bytes), cancel };
      const { client } = fakeClient({
        'filesystem.stat': statOf(bytes.length),
        'core.download': downloadOf(),
      });
      const files = createDownloadContentReader({
        client,
        baseUrl: BASE,
        fetch: fetcherOf({ status: 200, body }),
      });
      await expect(files.readTail('/var/log/app.log', 2)).resolves.toMatchObject({
        lines: ['a', 'b'],
      });
    });
  });

  describe('what a reported size does and does not settle', () => {
    it('is an empty result rather than an error, when the file really is empty', async () => {
      const { files } = readerFor('', { size: 0 });
      await expect(files.readTail('/var/log/app.log', 10)).resolves.toEqual({
        path: '/var/log/app.log',
        lines: [],
        truncated: false,
      });
    });

    it('is still read rather than assumed from a size of zero', async () => {
      // `/proc` and `/sys` report `st_size` 0 over real content, so a size of
      // zero is not evidence of an empty file and must not answer without the
      // download. Answering from `stat` alone would report this file — which
      // has three lines — as holding nothing.
      const { files, call } = readerFor('MemTotal: 1\nMemFree: 2\nBuffers: 3\n', { size: 0 });
      await expect(files.readTail('/proc/meminfo', 10)).resolves.toEqual({
        path: '/proc/meminfo',
        lines: ['MemTotal: 1', 'MemFree: 2', 'Buffers: 3'],
        truncated: false,
      });
      expect(call).toHaveBeenCalledWith('core.download', [
        'filesystem.get',
        ['/proc/meminfo'],
        'meminfo',
      ]);
    });

    it('bounds a size-zero path that turns out to be larger than the ceiling', async () => {
      // Nothing said how big it was, so `skip` is 0 and what is kept is the
      // front of the body. The bound still holds and the answer still says so.
      const { files } = readerFor('aaa\nbbb\nccc\nddd\n', { size: 0, maxBytes: 8 });
      await expect(files.readTail('/proc/big', 10)).resolves.toEqual({
        path: '/proc/big',
        lines: ['aaa', 'bbb'],
        truncated: true,
      });
    });

    it.each([null, Number.NaN, -1])(
      'is not what a size of %s is read as — that is unreadable, not empty',
      async (size) => {
        const { client } = fakeClient({ 'filesystem.stat': () => of({ size, type: 'FILE' }) });
        const files = createDownloadContentReader({
          client,
          baseUrl: BASE,
          fetch: fetcherOf({ status: 200, body: null }),
        });
        await expect(files.readTail('/var/log/app.log', 10)).rejects.toMatchObject({
          reason: 'UNREADABLE',
          path: '/var/log/app.log',
        });
      },
    );
  });

  describe('a path that cannot be read', () => {
    async function failing(stat: () => Observable<unknown>) {
      const { client } = fakeClient({ 'filesystem.stat': stat });
      const files = createDownloadContentReader({
        client,
        baseUrl: BASE,
        fetch: fetcherOf({ status: 200, body: null }),
      });
      return files.readTail('/var/log/absent.log', 10).catch((error: unknown) => error);
    }

    it('names the path, and says it was not found, when the system says ENOENT', async () => {
      const error = await failing(() =>
        throwError(() => Object.assign(new Error('[ENOENT] Path does not exist'), { errname: 'ENOENT' })),
      );
      expect(error).toBeInstanceOf(FileContentError);
      expect(error).toMatchObject({ reason: 'NOT_FOUND', path: '/var/log/absent.log' });
      expect((error as Error).message).toContain('/var/log/absent.log');
    });

    it('names the path, and says only that it is unreadable, when the system says why in prose', async () => {
      const error = await failing(() => throwError(() => new Error('Permission denied')));
      expect(error).toMatchObject({ reason: 'UNREADABLE', path: '/var/log/absent.log' });
      expect((error as Error).message).toContain('Permission denied');
    });

    it('refuses a directory before downloading anything', async () => {
      const { client, call } = fakeClient({ 'filesystem.stat': statOf(4096, 'DIRECTORY') });
      const files = createDownloadContentReader({
        client,
        baseUrl: BASE,
        fetch: fetcherOf({ status: 200, body: null }),
      });
      await expect(files.readTail('/var/log', 10)).rejects.toMatchObject({
        reason: 'NOT_A_FILE',
        path: '/var/log',
      });
      expect(call).toHaveBeenCalledTimes(1);
    });
  });

  describe('a transport failure', () => {
    /** Every one of these must reject — never resolve to an empty file. */
    async function transportFailure(
      handlers: Partial<Record<string, () => Observable<unknown>>>,
      fetch: ContentFetcher,
    ) {
      const { client } = fakeClient({ 'filesystem.stat': statOf(8), ...handlers });
      const files = createDownloadContentReader({ client, baseUrl: BASE, fetch });
      const error = await files.readTail('/var/log/app.log', 10).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FileContentError);
      expect(error).toMatchObject({ reason: 'TRANSPORT', path: '/var/log/app.log' });
      return error as FileContentError;
    }

    it('is reported when the download cannot be started', async () => {
      const error = await transportFailure(
        { 'core.download': () => throwError(() => new Error('websocket closed')) },
        fetcherOf({ status: 200, body: null }),
      );
      expect(error.message).toContain('websocket closed');
    });

    it('is reported when the system returns no URL', async () => {
      await transportFailure(
        { 'core.download': downloadOf(null) },
        fetcherOf({ status: 200, body: null }),
      );
    });

    it('is reported, rather than thrown raw, when the system answers no list at all', async () => {
      await transportFailure(
        { 'core.download': () => of('not a list') },
        fetcherOf({ status: 200, body: null }),
      );
    });

    it('is reported when the system returns a URL that cannot be parsed', async () => {
      await transportFailure(
        { 'core.download': downloadOf('http://[::1') },
        fetcherOf({ status: 200, body: null }),
      );
    });

    it('is reported when the fetch itself rejects', async () => {
      // A fetch implementation names the URL it was given in its own message,
      // so that message is carried on `cause` and never interpolated into
      // one the audit trail will record.
      const reason = new Error(`request to ${BASE}${MINTED} failed: ECONNREFUSED`);
      const error = await transportFailure({ 'core.download': downloadOf() }, () =>
        Promise.reject(reason),
      );
      expect(error.message).not.toContain(TOKEN);
      expect(error.cause).toBe(reason);
    });

    it('is reported when the download answers with an error status', async () => {
      const error = await transportFailure(
        { 'core.download': downloadOf() },
        fetcherOf({ status: 403, body: null }),
      );
      expect(error.message).toContain('403');
    });

    it('is reported when the download carries no body', async () => {
      await transportFailure(
        { 'core.download': downloadOf() },
        fetcherOf({ status: 200, body: null }),
      );
    });

    it('is reported when the body fails part-way through', async () => {
      const reason = new Error(`reading ${BASE}${MINTED} failed: stream reset`);
      const body: ContentByteReader = {
        read: () => Promise.reject(reason),
        cancel: () => Promise.resolve(undefined),
      };
      const error = await transportFailure(
        { 'core.download': downloadOf() },
        fetcherOf({ status: 200, body }),
      );
      expect(error.message).not.toContain(TOKEN);
      expect(error.cause).toBe(reason);
    });
  });

  describe('the credential boundary', () => {
    it('keeps the minted URL out of the result', async () => {
      const { files } = readerFor('a\n');
      const tail = await files.readTail('/var/log/app.log', 1);
      expect(JSON.stringify(tail)).not.toContain(TOKEN);
    });

    it.each([
      ['an error status', fetcherOf({ status: 500, body: null })],
      ['no body', fetcherOf({ status: 200, body: null })],
    ])('keeps the minted URL out of the failure for %s', async (_name, fetch) => {
      const { client } = fakeClient({
        'filesystem.stat': statOf(8),
        'core.download': downloadOf(),
      });
      const files = createDownloadContentReader({ client, baseUrl: BASE, fetch });
      const error = await files.readTail('/var/log/app.log', 10).catch((e: unknown) => e);
      expect(String((error as Error).message)).not.toContain(TOKEN);
    });

    it('does not put the URL where an unparseable one is reported either', async () => {
      const { client } = fakeClient({
        'filesystem.stat': statOf(8),
        'core.download': downloadOf(`http://[::1?auth_token=${TOKEN}`),
      });
      const files = createDownloadContentReader({
        client,
        baseUrl: BASE,
        fetch: fetcherOf({ status: 200, body: null }),
      });
      const error = await files.readTail('/var/log/app.log', 10).catch((e: unknown) => e);
      expect(String((error as Error).message)).not.toContain(TOKEN);
    });
  });

  describe('through a read-only tool', () => {
    /**
     * Not a shipped tool — `vm_logs` is #36 and out of scope here. This is the
     * acceptance criterion itself: given a path and a line count, a read-only
     * handler holding nothing but a {@link SystemHandle} can obtain the tail.
     */
    const logTail: ReadOnlyTool = {
      name: 'file_log_tail',
      description: 'The last lines of a file.',
      inputSchema: { type: 'object', properties: {} },
      requiredRole: Role.ReadOnly,
      mutating: false,
      async handler({ system }, args) {
        if (!system.files) throw new Error(`System "${system.name}" has no content reader`);
        return system.files.readTail(String(args['path']), Number(args['lines']));
      },
    };

    it('obtains the last N lines of a named path', async () => {
      const { files } = readerFor('one\ntwo\nthree\n');
      const system = { name: 'nas', client: {}, files } as unknown as SystemHandle;
      await expect(
        logTail.handler({ system }, { path: '/var/log/app.log', lines: 2 }),
      ).resolves.toMatchObject({ lines: ['two', 'three'] });
    });

    it('says so when the adapter wired up no content reader', async () => {
      const system = { name: 'nas', client: {} } as unknown as SystemHandle;
      await expect(
        logTail.handler({ system }, { path: '/var/log/app.log', lines: 2 }),
      ).rejects.toThrow('no content reader');
    });
  });
});
