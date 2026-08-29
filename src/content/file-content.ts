import type { TrueNasApiClient } from '@truenas/api-client';
import { firstValueFrom } from 'rxjs';
import type { ApiSurface } from '@/catalog/tool';
import { toSystemError } from '@/execution/fanout';
import type {
  ContentFetchResponse,
  ContentFetcher,
  FileContentReader,
  FileTail,
} from '@/interfaces';

/**
 * Bounded file content over `core.download` — route (a) of #72. `CLAUDE.md`
 * carries the decision and why the event-source route was not taken.
 *
 * The shape of the route: `core.download('filesystem.get', [path], filename)`
 * mints a one-shot download URL on the system, and an injected
 * {@link ContentFetcher} GETs it. Two properties are load-bearing.
 *
 * THE BOUND IS ENFORCED HERE, NOT ASKED FOR. `filesystem.get` takes a path and
 * nothing else — no offset, no line count — so the server always offers the
 * whole file and the only bound that exists is the one this file applies while
 * consuming the body: at most `maxBytes` are kept, the read stops the moment
 * that ceiling is reached, and the caller is handed at most `maxLines` lines.
 * A server that sends more than was expected cannot make the result larger; it
 * can only make it `truncated`.
 *
 * THE URL NEVER LEAVES THIS FILE. `core.download` embeds a single-use auth
 * token in the URL it returns, and tool arguments and results are recorded
 * verbatim in the audit trail (S3.3). So the seam a tool holds is
 * {@link FileContentReader} — a path in, lines out — and no message thrown
 * from here quotes the URL, only the path the caller already supplied.
 */

/** Why a read failed. Each is a distinct thing a caller can say to a user. */
export type FileContentFailure =
  /** `filesystem.stat` reported the path absent. */
  | 'NOT_FOUND'
  /** The path is a directory. */
  | 'NOT_A_FILE'
  /** `filesystem.stat` failed for some other reason — permission, or the call itself. */
  | 'UNREADABLE'
  /** The download did not happen, or did not complete. */
  | 'TRANSPORT';

/**
 * A file that could not be read. Always names the path; never the download URL
 * (see the file header).
 */
export class FileContentError extends Error {
  constructor(
    readonly reason: FileContentFailure,
    readonly path: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'FileContentError';
  }
}

export interface DownloadContentReaderOptions {
  client: TrueNasApiClient<ApiSurface>;
  /**
   * Origin the minted download URL is resolved against, e.g.
   * `https://nas.local`. The client knows the hostname it connected to but
   * keeps it `protected`, so the caller that built the client supplies it.
   */
  baseUrl: string;
  fetch: ContentFetcher;
  /**
   * Ceiling on the bytes any one read may keep. The seam owns this rather than
   * the caller: a tool asks for lines, and a line has no length limit, so a
   * line bound alone is not a bound at all. Defaults to 256 KiB.
   */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 256 * 1024;

const NO_BYTES = new Uint8Array(0);

/** The window of bytes a bounded read kept, and whether the ceiling ended it. */
interface ByteWindow {
  bytes: Uint8Array;
  stoppedAtBound: boolean;
}

/** A {@link FileContentReader} for one system. */
export function createDownloadContentReader(
  options: DownloadContentReaderOptions,
): FileContentReader {
  const { client, fetch, maxBytes = DEFAULT_MAX_BYTES } = options;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError(`maxBytes must be a positive integer, got ${String(maxBytes)}`);
  }
  // Parsed once, at construction: a base URL that cannot be parsed is a
  // wiring mistake, and finding it here names the system being registered
  // rather than the first file some tool happens to read.
  const base = new URL(options.baseUrl);

  return {
    async readTail(path: string, maxLines: number): Promise<FileTail> {
      if (!Number.isInteger(maxLines) || maxLines < 1) {
        throw new RangeError(`maxLines must be a positive integer, got ${String(maxLines)}`);
      }

      const stat = await statPath(client, path);
      if (stat.type === 'DIRECTORY') {
        throw new FileContentError('NOT_A_FILE', path, `"${path}" is a directory, not a file`);
      }
      // A file of no bytes is an empty answer, not a failure — and answering
      // it from `stat` alone is also what keeps a zero-length file from
      // costing a download. `> 0` rather than `!== 0` so a size the system
      // reported as something other than a number lands here too, where the
      // answer is "no content read", instead of poisoning the arithmetic
      // below into an unbounded skip.
      if (!(stat.size > 0)) {
        return { path, lines: [], truncated: false };
      }

      const url = await mintDownloadUrl(client, base, path);
      // The whole file is on offer, so the tail is reached by discarding the
      // front of it. `stat.size` is the size a moment ago: a log file that
      // rotated or was appended to since will land the window somewhere other
      // than its exact end, which `truncated` already covers.
      const from = Math.max(0, stat.size - maxBytes);
      // One byte earlier than the tail proper, where there is one. That byte
      // says whether the window opens on a line boundary: if it is a newline
      // the window's first line is whole, and without it a window that happens
      // to start exactly at a boundary would lose a whole line to the
      // fragment rule in `toTail`. It comes out of the same `maxBytes`
      // budget rather than extending it.
      const window = await readWindow(fetch, url, path, from > 0 ? from - 1 : 0, maxBytes);
      return toTail(path, window, from > 0, maxLines);
    },
  };
}

/** `filesystem.stat`, with a failure that names the path either way. */
async function statPath(client: TrueNasApiClient<ApiSurface>, path: string) {
  try {
    return await firstValueFrom(client.api.call('filesystem.stat', [path]));
  } catch (error) {
    // The client flattens a JSON-RPC error to a plain message before it
    // reaches the core, so `errname` is usually absent (see `SystemError`).
    // Read it where it is present and report the path where it is not, rather
    // than guessing "not found" from a message.
    const { message, errname } = toSystemError(error);
    const reason: FileContentFailure = errname === 'ENOENT' ? 'NOT_FOUND' : 'UNREADABLE';
    throw new FileContentError(reason, path, `Could not read "${path}": ${message}`, {
      cause: error,
    });
  }
}

/** Asks the system for a download URL and resolves it against `base`. */
async function mintDownloadUrl(
  client: TrueNasApiClient<ApiSurface>,
  base: URL,
  path: string,
): Promise<string> {
  let answer: unknown[];
  try {
    answer = await firstValueFrom(
      // The filename only sets the attachment name on a response whose headers
      // are discarded, so the basename is enough — and it is what makes the
      // download recognisable in the system's own job list.
      client.api.call('core.download', [
        'filesystem.get',
        [path],
        path.slice(path.lastIndexOf('/') + 1),
      ]),
    );
  } catch (error) {
    throw new FileContentError(
      'TRANSPORT',
      path,
      `Could not start a download of "${path}": ${toSystemError(error).message}`,
      { cause: error },
    );
  }
  // `core.download` is typed `unknown[]` and answers `[job_id, url]`.
  const minted = answer[1];
  if (typeof minted !== 'string' || minted.length === 0) {
    throw new FileContentError(
      'TRANSPORT',
      path,
      `The system did not return a download URL for "${path}"`,
    );
  }
  try {
    return new URL(minted, base).toString();
  } catch {
    // The URL is deliberately not quoted here or anywhere else: it carries a
    // single-use auth token.
    throw new FileContentError(
      'TRANSPORT',
      path,
      `The system returned a download URL for "${path}" that could not be parsed`,
    );
  }
}

/**
 * Discards the first `skip` bytes of the body and keeps at most `maxBytes` of
 * what follows, stopping the read there. This is the bound: every path out of
 * this function has kept at most `maxBytes`, whatever the server sent.
 */
async function readWindow(
  fetch: ContentFetcher,
  url: string,
  path: string,
  skip: number,
  maxBytes: number,
): Promise<ByteWindow> {
  let response: ContentFetchResponse;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new FileContentError(
      'TRANSPORT',
      path,
      `Downloading "${path}" failed: ${toSystemError(error).message}`,
      { cause: error },
    );
  }
  if (response.status < 200 || response.status > 299) {
    throw new FileContentError(
      'TRANSPORT',
      path,
      `Downloading "${path}" failed with HTTP ${response.status}`,
    );
  }
  const body = response.body;
  if (body === null) {
    throw new FileContentError('TRANSPORT', path, `The download of "${path}" carried no body`);
  }

  const chunks: Uint8Array[] = [];
  let skipped = 0;
  let kept = 0;
  let stoppedAtBound = false;
  try {
    for (;;) {
      const { done, value } = await body.read();
      if (done) break;
      let chunk = value ?? NO_BYTES;
      if (skipped < skip) {
        const dropping = Math.min(skip - skipped, chunk.length);
        skipped += dropping;
        chunk = chunk.subarray(dropping);
      }
      if (kept + chunk.length > maxBytes) {
        chunks.push(chunk.subarray(0, maxBytes - kept));
        kept = maxBytes;
        stoppedAtBound = true;
        break;
      }
      chunks.push(chunk);
      kept += chunk.length;
    }
  } catch (error) {
    throw new FileContentError(
      'TRANSPORT',
      path,
      `Reading the download of "${path}" failed: ${toSystemError(error).message}`,
      { cause: error },
    );
  } finally {
    // Always, not only on the bounded exit: a body left unread holds the
    // connection open, and the ceiling is precisely the case that leaves one.
    // A cancel that itself fails must not replace the reason we stopped.
    await body.cancel().catch(() => undefined);
  }

  const bytes = new Uint8Array(kept);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return { bytes, stoppedAtBound };
}

/** The kept bytes as at most `maxLines` whole lines. */
function toTail(path: string, window: ByteWindow, partial: boolean, maxLines: number): FileTail {
  const candidates = new TextDecoder().decode(window.bytes).split('\n');
  // A file ending in a newline splits to a trailing empty element, which is
  // the end of the last line rather than a line of its own.
  if (candidates[candidates.length - 1] === '') {
    candidates.pop();
  }
  // A window that began mid-file opens on the boundary byte read for that
  // purpose: either a newline, which splits to a leading empty element, or the
  // tail of the line before, which is a fragment. Both are dropped by the same
  // shift, and what follows is a whole line either way.
  if (partial) {
    candidates.shift();
  }
  const lines = candidates.slice(-maxLines);
  return {
    path,
    lines,
    truncated: partial || window.stoppedAtBound || lines.length < candidates.length,
  };
}
