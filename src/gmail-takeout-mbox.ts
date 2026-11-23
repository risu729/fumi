// Incremental splitter for Google Takeout Gmail mbox files (ADR 0004).
//
// Each Takeout entry is:
//   From <decimal Gmail message id>@xxx <Www Mmm dd hh:mm:ss +zzzz yyyy>CRLF
//   X-GM-THRID: <decimal thread id>CRLF
//   X-Gmail-Labels: <comma-separated label names>CRLF, folded onto CRLF + space lines
//     when long
//   <the original message bytes, ending in CRLF or a bare LF; Takeout adds a CRLF to
//     a message without a final line break>
//   CRLF (one separator added by Takeout)
// Body lines are escaped as in mboxrd: a line of one or more ">" followed by "From "
// gets one more ">". The splitter strips the From_ line, the two added headers and the
// separator and returns the rest unchanged; `unescapeMboxrd` (or `MboxrdUnescaper` for an
// entry streamed in chunks) then removes that one ">".
// Anything else stops with a fixed code, so a malformed or cut-off export never yields
// a silently changed message, with one accepted exception: a message whose first line
// starts with whitespace (invalid in RFC 5322) has that line read as a label fold. The format was measured on a 40,598-message export on
// 2026-11-23 (docs/gmail-import.md, "Google Takeout transport").

/** The largest chunk the runner pushes: one ranged R2 read. */
export const TAKEOUT_READ_BYTES = 8 * 1024 * 1024;
/**
 * The largest entry returned with its bytes. A larger one is returned as `large`, and the
 * importer streams it from the object instead. This bounds memory, not what is imported.
 */
export const TAKEOUT_BUFFER_BYTES = 25 * 1024 * 1024;

export type TakeoutEntry = {
  kind: "entry";
  /** Byte offset of the entry's From_ line in the whole mbox stream. */
  offset: number;
  /** Stream offset just past the entry's separator: where the next entry starts. */
  end: number;
  messageId: string;
  threadId: string;
  /** From_ date in milliseconds; second precision. */
  fromDate: number;
  /** X-Gmail-Labels value, unfolded; may be localized or RFC 2047 encoded. */
  labels: string;
  /**
   * The message bytes still mboxrd-escaped, as a view of the splitter's buffer that is
   * valid until the next `push`. Pass it to `unescapeMboxrd` for the original message.
   */
  raw: Uint8Array;
};

/** An entry over the buffer limit: the same fields, with where its bytes are instead of them. */
export type TakeoutLarge = Omit<TakeoutEntry, "kind" | "raw"> & {
  kind: "large";
  /** Stream offset of the message's first byte, after the From_ line and Gmail headers. */
  rawOffset: number;
  /** Message size after stripping, still mboxrd-escaped; above the buffer limit. */
  size: number;
};

export type TakeoutItem = TakeoutEntry | TakeoutLarge;

export type TakeoutMboxErrorCode =
  | "takeout_invalid_start"
  | "takeout_invalid_from_line"
  | "takeout_invalid_gmail_headers"
  | "takeout_missing_separator"
  | "takeout_header_limit";

export class TakeoutMboxError extends Error {
  readonly code: TakeoutMboxErrorCode;
  readonly offset: number;
  constructor(code: TakeoutMboxErrorCode, offset: number) {
    super(code);
    this.code = code;
    this.offset = offset;
  }
}

const CR = 13;
const LF = 10;
const SP = 32;
const HT = 9;
// Longest accepted From_ line and Gmail header line, in bytes before the CRLF (labels can
// be long). A valid From_ line has at most 60 bytes; the limit only ends the search.
const FROM_LINE_LIMIT = 128;
const GMAIL_HEADERS_LIMIT = 64 * 1024;
const encoder = new TextEncoder();
/** An entry boundary candidate: the separator CRLF, then a From_ line. */
const NEXT_FROM = encoder.encode("\r\nFrom ");
const THREAD_PREFIX = encoder.encode("X-GM-THRID: ");
/**
 * How far an entry may pass the buffer limit before its bytes are dropped (149). It covers
 * what a boundary check still needs: from two bytes before a candidate's separator
 * through `X-GM-THRID: `.
 */
const KEEP = NEXT_FROM.length + FROM_LINE_LIMIT + THREAD_PREFIX.length + 2;
/** The longest From_ line and Gmail headers, with their CRLFs (131,206). */
const HEAD_LIMIT = FROM_LINE_LIMIT + 2 + 2 * (GMAIL_HEADERS_LIMIT + 2);
const FROM_LINE =
  /^From ([0-9]{1,20})@xxx ([A-Z][a-z]{2}) ([A-Z][a-z]{2}) ([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([+-])([0-9]{2})([0-9]{2}) ([0-9]{4})$/;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const UINT64_MAX = (1n << 64n) - 1n;

/** Converts a decimal Gmail ID to the unpadded hex form the Gmail API uses; null if over 64 bits. */
function toHex(decimal: string): string | null {
  const value = BigInt(decimal);
  return value > UINT64_MAX ? null : value.toString(16);
}

/** Returns the From_ date in milliseconds, or NaN for an impossible date or zone. */
function parseFromDate(match: RegExpExecArray): number {
  const [day, month, date, hour, minute, second, sign, zoneHour, zoneMinute, year] = [
    DAYS.indexOf(match[2]!),
    MONTHS.indexOf(match[3]!),
    ...match.slice(4, 8).map(Number),
    match[8],
    Number(match[9]),
    Number(match[10]),
    Number(match[11]),
  ] as [number, number, number, number, number, number, string, number, number, number];
  if (month < 0 || zoneHour > 14 || zoneMinute > 59) return Number.NaN;
  // setUTCFullYear keeps years below 100 as written; Date.UTC would move them to 19xx.
  const local = new Date(0);
  local.setUTCFullYear(year, month, date);
  local.setUTCHours(hour, minute, second, 0);
  // Out-of-range fields roll over; reject them, and a weekday that does not match.
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month ||
    local.getUTCDate() !== date ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute ||
    local.getUTCSeconds() !== second ||
    local.getUTCDay() !== day
  )
    return Number.NaN;
  const zone = (zoneHour * 60 + zoneMinute) * 60_000;
  return sign === "+" ? local.getTime() - zone : local.getTime() + zone;
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array, at: number): boolean {
  if (at < 0 || at + prefix.length > bytes.length) return false;
  for (let j = 0; j < prefix.length; j++) if (bytes[at + j] !== prefix[j]) return false;
  return true;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  const last = haystack.length - needle.length;
  for (let i = from; i <= last; i++) if (startsWith(haystack, needle, i)) return i;
  return -1;
}

/** Index of the CR of the first CRLF within `limit` bytes of `from`, or -1. */
function lineEnd(bytes: Uint8Array, from: number, limit: number): number {
  for (let i = from; i < bytes.length - 1 && i - from <= limit; i++)
    if (bytes[i] === CR && bytes[i + 1] === LF) return i;
  return -1;
}

type Head = { messageId: string; threadId: string; fromDate: number; labels: string; size: number };

/**
 * Parses the From_ line and Gmail headers at the start of `bytes`. Returns null when
 * more bytes are needed; at the end of the stream, a missing part is an error.
 */
function parseHead(bytes: Uint8Array, offset: number, final: boolean): Head | null {
  const fromEnd = lineEnd(bytes, 0, FROM_LINE_LIMIT);
  if (fromEnd < 0) {
    if (final || bytes.length > FROM_LINE_LIMIT)
      throw new TakeoutMboxError("takeout_invalid_from_line", offset);
    return null;
  }
  const match = FROM_LINE.exec(latin1.decode(bytes.subarray(0, fromEnd)));
  if (!match) throw new TakeoutMboxError("takeout_invalid_from_line", offset);
  const fromDate = parseFromDate(match);
  const messageId = toHex(match[1]!);
  if (!Number.isFinite(fromDate) || !messageId)
    throw new TakeoutMboxError("takeout_invalid_from_line", offset);

  // Two headers. Takeout folds a long X-Gmail-Labels onto lines that start with a
  // space; a message cannot start with a space or tab (it would be neither a header field
  // nor the blank line before a body), so every one of them belongs to the labels.
  // Each header has at most GMAIL_HEADERS_LIMIT bytes before its last CRLF, folds
  // included.
  const headers: string[] = [];
  let cursor = fromEnd + 2;
  let headerStart = cursor;
  for (;;) {
    if (headers.length === 2) {
      if (cursor >= bytes.length) {
        if (final) throw new TakeoutMboxError("takeout_missing_separator", offset);
        return null;
      }
      if (bytes[cursor] !== SP && bytes[cursor] !== HT) break;
    }
    const folded = headers.length === 2;
    if (!folded) headerStart = cursor;
    const room = GMAIL_HEADERS_LIMIT - (cursor - headerStart);
    const end = lineEnd(bytes, cursor, room);
    if (end < 0) {
      // A line of exactly the limit whose CR ends the bytes may still get its LF, so
      // before the end of the stream the limit is passed only with one more byte.
      if (bytes.length - cursor > room + (final ? 0 : 1))
        throw new TakeoutMboxError("takeout_header_limit", offset);
      if (final) throw new TakeoutMboxError("takeout_invalid_gmail_headers", offset);
      return null;
    }
    let line: string;
    try {
      line = utf8.decode(bytes.subarray(cursor, end));
    } catch {
      throw new TakeoutMboxError("takeout_invalid_gmail_headers", offset);
    }
    // Unfolding removes the CRLF and keeps the leading whitespace (RFC 5322 2.2.3).
    if (folded) headers[1] += `\r\n${line}`;
    else headers.push(line);
    cursor = end + 2;
  }
  const thread = /^X-GM-THRID: ([0-9]{1,20})$/.exec(headers[0]!);
  const labelLine = headers[1]!.replaceAll("\r\n", "");
  const labels = /^X-Gmail-Labels: ?(.*)$/s.exec(labelLine);
  const threadId = thread ? toHex(thread[1]!) : null;
  if (!threadId || !labels) throw new TakeoutMboxError("takeout_invalid_gmail_headers", offset);
  return { messageId, threadId, fromDate, labels: labels[1]!, size: cursor };
}

/**
 * Splits a Takeout mbox stream. Push chunks in order, then call `end()` once. Each
 * returned entry's `raw` is a view of the splitter's buffer that stays valid until the
 * next `push`, so a caller handles every returned item before it pushes again, or
 * copies `raw`. An entry whose stripped size exceeds `bufferLimit` is returned as
 * `large`, with its position instead of its bytes. A call that splits entries before an error
 * returns them, and the next call throws the error; every later call throws it again.
 *
 * Between pushes the splitter keeps at most max(bufferLimit + 149, 131,206) unread bytes:
 * an entry up to the limit and what its boundary check needs, or the longest From_ line
 * and Gmail headers. With chunks of at most TAKEOUT_READ_BYTES, its buffer therefore
 * never exceeds that plus one read: 34,603,157 bytes (33.0 MiB) at the 25 MiB limit.
 * A buffer that must hold a full read is allocated at that bound at once, and only
 * smaller ones double, so growing never holds more than one read of old buffer beside
 * the new one. The buffer is released after `end()` and after an error.
 *
 * The format cannot show a stream cut right after a blank line in the last message,
 * so the caller must also check that it pushed the whole object (for example, the
 * byte count against the R2 object size).
 */
export class TakeoutMboxSplitter {
  /** Backing store; the unread bytes are #store[#start, #end). */
  #store = new Uint8Array(0);
  #start = 0;
  #end = 0;
  /** Stream offset of the first unread byte. */
  #base = 0;
  #head: (Head & { offset: number }) | null = null;
  /** Bytes of the current entry discarded because it is over the buffer limit. */
  #dropped = 0;
  /** Where the next boundary search starts, relative to the unread bytes. */
  #scanFrom = 0;
  #ended = false;
  #failed = false;
  #error: unknown = null;

  readonly #bufferLimit: number;
  /** The buffer bound for chunks of at most TAKEOUT_READ_BYTES (see the class comment). */
  readonly #bound: number;

  /**
   * `startOffset` is the stream offset of the first pushed byte; a run resumed at a
   * checkpoint starts at an entry's From_ line, so offsets stay stream-wide.
   */
  constructor(bufferLimit = TAKEOUT_BUFFER_BYTES, startOffset = 0) {
    this.#bufferLimit = bufferLimit;
    this.#base = startOffset;
    this.#bound = Math.max(bufferLimit + KEEP, HEAD_LIMIT) + TAKEOUT_READ_BYTES;
  }

  /** Bytes allocated for the buffer; tests check it against the bound. */
  get capacity(): number {
    return this.#store.length;
  }

  push(chunk: Uint8Array): TakeoutItem[] {
    if (this.#failed) throw this.#error;
    if (this.#ended) throw new Error("TakeoutMboxSplitter.push after end");
    if (chunk.length === 0) return [];
    const length = this.#end - this.#start;
    if (this.#end + chunk.length > this.#store.length) {
      const capacity = this.#store.length;
      const needed = length + chunk.length;
      // Compacting overwrites bytes behind #start, including earlier entries' raw views.
      if (needed <= capacity && (needed <= capacity / 2 || capacity >= this.#bound))
        this.#store.copyWithin(0, this.#start, this.#end);
      else {
        // Stores below one read double; one that must hold a full read gets the bound.
        let size = Math.max(needed, Math.min(capacity * 2, this.#bound));
        if (size >= TAKEOUT_READ_BYTES) size = Math.max(needed, this.#bound);
        const next = new Uint8Array(size);
        next.set(this.#store.subarray(this.#start, this.#end));
        this.#store = next;
      }
      this.#start = 0;
      this.#end = length;
    }
    this.#store.set(chunk, this.#end);
    this.#end += chunk.length;
    return this.#run(false);
  }

  end(): TakeoutItem[] {
    if (this.#failed) throw this.#error;
    if (this.#ended) return [];
    this.#ended = true;
    try {
      return this.#run(true);
    } finally {
      this.#release();
    }
  }

  /**
   * The first error is kept, so a retry or cleanup never reads a failed stream as
   * complete. Entries split before it are returned first, and the next call throws it.
   */
  #run(final: boolean): TakeoutItem[] {
    const items: TakeoutItem[] = [];
    try {
      this.#drain(final, items);
    } catch (error) {
      this.#failed = true;
      this.#error = error;
      this.#release();
      if (items.length === 0) throw error;
    }
    return items;
  }

  /** Drops the buffer once no push can follow; returned raw views keep their bytes. */
  #release() {
    this.#store = new Uint8Array(0);
    this.#start = 0;
    this.#end = 0;
  }

  get #bytes(): Uint8Array {
    return this.#store.subarray(this.#start, this.#end);
  }

  #drain(final: boolean, items: TakeoutItem[]): void {
    for (;;) {
      if (!this.#head) {
        const bytes = this.#bytes;
        if (bytes.length === 0) return;
        if (bytes.length < 5 && !final) return;
        if (latin1.decode(bytes.subarray(0, 5)) !== "From ")
          throw new TakeoutMboxError(
            this.#base === 0 ? "takeout_invalid_start" : "takeout_invalid_from_line",
            this.#base,
          );
        const head = parseHead(bytes, this.#base, final);
        if (!head) return;
        this.#head = { ...head, offset: this.#base };
        this.#consume(head.size);
        this.#dropped = 0;
        this.#scanFrom = 0;
      }
      const head = this.#head;
      const bytes = this.#bytes;
      const boundary = this.#findBoundary(bytes, final);
      if (boundary === null) {
        // No boundary yet. An entry already over the limit keeps only the bytes from
        // two before the next possible boundary on, at most KEEP.
        if (this.#dropped + bytes.length > this.#bufferLimit + KEEP) {
          const drop = Math.max(0, this.#scanFrom - 2);
          this.#dropped += drop;
          this.#consume(drop);
        }
        return;
      }
      // At the end of the stream the entry ends at the last two bytes, Takeout's
      // separator, which must follow the message's own line break.
      const size = boundary >= 0 ? boundary : bytes.length - 2;
      if (boundary < 0 && !endsWithSeparator(bytes))
        throw new TakeoutMboxError("takeout_missing_separator", head.offset);
      const total = this.#dropped + size;
      const end = this.#base + (boundary >= 0 ? boundary + 2 : bytes.length);
      const fields = {
        offset: head.offset,
        end,
        messageId: head.messageId,
        threadId: head.threadId,
        fromDate: head.fromDate,
        labels: head.labels,
      };
      if (this.#dropped > 0 || total > this.#bufferLimit)
        items.push({ kind: "large", ...fields, rawOffset: head.offset + head.size, size: total });
      // Nothing writes the buffer until the next push, so no copy is needed.
      else items.push({ kind: "entry", ...fields, raw: bytes.subarray(0, size) });
      this.#head = null;
      if (boundary < 0) {
        this.#consume(bytes.length);
        return;
      }
      this.#consume(boundary + 2);
    }
  }

  /**
   * Returns the index of the separator CRLF before the next entry, -1 when the stream
   * ended and the current entry runs to its end, or null when more bytes are needed.
   * A boundary is a CRLF followed by a valid From_ line and `X-GM-THRID: `; body text
   * such as "From the team" is skipped. A boundary not preceded by the message's own
   * line break (CRLF or a bare LF) means a message without one, which stops the run.
   */
  #findBoundary(bytes: Uint8Array, final: boolean): number | null {
    for (;;) {
      const candidate = indexOf(bytes, NEXT_FROM, this.#scanFrom);
      if (candidate < 0) {
        this.#scanFrom = Math.max(0, bytes.length - NEXT_FROM.length + 1);
        return final ? -1 : null;
      }
      const lineStart = candidate + 2;
      const end = lineEnd(bytes, lineStart, FROM_LINE_LIMIT);
      const complete = end >= 0 && end + 2 + THREAD_PREFIX.length <= bytes.length;
      if (
        !complete &&
        !final &&
        bytes.length - lineStart <= FROM_LINE_LIMIT + 2 + THREAD_PREFIX.length
      ) {
        // The candidate is not complete yet; look here again after the next chunk.
        this.#scanFrom = candidate;
        return null;
      }
      if (
        complete &&
        FROM_LINE.test(latin1.decode(bytes.subarray(lineStart, end))) &&
        startsWith(bytes, THREAD_PREFIX, end + 2)
      ) {
        if (candidate < 1 || bytes[candidate - 1] !== LF)
          throw new TakeoutMboxError("takeout_missing_separator", this.#base + lineStart);
        return candidate;
      }
      this.#scanFrom = candidate + 1;
    }
  }

  #consume(count: number) {
    this.#start += count;
    this.#base += count;
    this.#scanFrom = Math.max(0, this.#scanFrom - count);
  }
}

/** True when the bytes end with the message's line break (CRLF or LF) and Takeout's CRLF. */
function endsWithSeparator(bytes: Uint8Array): boolean {
  const n = bytes.length;
  return n >= 3 && bytes[n - 3] === LF && bytes[n - 2] === CR && bytes[n - 1] === LF;
}

const GT = 0x3e;
const FROM_SPACE = encoder.encode("From ");

/**
 * Removes one ">" from each line that is one or more ">" followed by "From " (mboxrd).
 * Returns the same view when no line is escaped, otherwise a copy.
 */
export function unescapeMboxrd(raw: Uint8Array): Uint8Array {
  // Count first, so an unescaped message costs one copy and no list of positions.
  let count = 0;
  for (let start = 0; start >= 0 && start < raw.length;) {
    if (escapedFrom(raw, start)) count++;
    const next = raw.indexOf(LF, start);
    start = next < 0 ? -1 : next + 1;
  }
  if (count === 0) return raw;
  const out = new Uint8Array(raw.length - count);
  let to = 0;
  for (let start = 0; start >= 0 && start < raw.length;) {
    const next = raw.indexOf(LF, start);
    const end = next < 0 ? raw.length : next + 1;
    const from = escapedFrom(raw, start) ? start + 1 : start;
    out.set(raw.subarray(from, end), to);
    to += end - from;
    start = next < 0 ? -1 : end;
  }
  return out;
}

/** True when the line at `start` is one or more ">" followed by "From ". */
function escapedFrom(raw: Uint8Array, start: number): boolean {
  if (raw[start] !== GT) return false;
  let i = start + 1;
  while (i < raw.length && raw[i] === GT) i++;
  return startsWith(raw, FROM_SPACE, i);
}

/**
 * `unescapeMboxrd` for a message pushed in chunks of any size, in constant memory. At
 * most six bytes are held back between pushes: the first ">" of a line and the part of
 * "From " seen after its run of ">". Removing one ">" from a run of them gives the same
 * bytes whichever one is removed, so the rest of the run is passed on at once.
 */
export class MboxrdUnescaper {
  #lineStart = true;
  /** The first ">" of the current line is held back. */
  #held = false;
  /** Bytes of "From " matched after the held ">" and the rest of its run. */
  #matched = 0;

  push(chunk: Uint8Array): Uint8Array {
    const out = new Uint8Array(chunk.length + 1 + FROM_SPACE.length);
    let to = 0;
    const emit = (bytes: Uint8Array) => {
      out.set(bytes, to);
      to += bytes.length;
    };
    for (let i = 0; i < chunk.length;) {
      if (this.#held) {
        const byte = chunk[i]!;
        if (this.#matched === 0 && byte === GT) {
          emit(chunk.subarray(i, i + 1));
          i++;
          continue;
        }
        if (byte === FROM_SPACE[this.#matched]) {
          this.#matched++;
          i++;
          if (this.#matched === FROM_SPACE.length) {
            // An escaped line: the held ">" is dropped.
            emit(FROM_SPACE);
            this.#held = false;
            this.#matched = 0;
            this.#lineStart = false;
          }
          continue;
        }
        // Not escaped: give back what was held, then read this byte as usual.
        this.#flush(emit);
        continue;
      }
      if (this.#lineStart && chunk[i] === GT) {
        this.#held = true;
        this.#lineStart = false;
        i++;
        continue;
      }
      // Copy through the end of the line.
      const next = chunk.indexOf(LF, i);
      const end = next < 0 ? chunk.length : next + 1;
      emit(chunk.subarray(i, end));
      this.#lineStart = next >= 0;
      i = end;
    }
    return out.subarray(0, to);
  }

  /** Returns what was held back at the end of the message. */
  end(): Uint8Array {
    const out = new Uint8Array(1 + FROM_SPACE.length);
    let to = 0;
    this.#flush((bytes) => {
      out.set(bytes, to);
      to += bytes.length;
    });
    return out.subarray(0, to);
  }

  #flush(emit: (bytes: Uint8Array) => void) {
    if (this.#held) {
      emit(GT_BYTE);
      emit(FROM_SPACE.subarray(0, this.#matched));
    }
    this.#held = false;
    this.#matched = 0;
    this.#lineStart = false;
  }
}

const GT_BYTE = new Uint8Array([GT]);
