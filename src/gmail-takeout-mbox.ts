// Incremental splitter for Google Takeout Gmail mbox files (ADR 0004).
//
// Each Takeout entry is:
//   From <decimal Gmail message id>@xxx <Www Mmm dd hh:mm:ss +zzzz yyyy>CRLF
//   X-GM-THRID: <decimal thread id>CRLF
//   X-Gmail-Labels: <comma-separated label names>CRLF
//   <the original message bytes, ending in CRLF>
//   CRLF (one separator added by Takeout)
// The splitter strips the From_ line, the two added headers and the separator, and
// returns the remaining bytes unchanged. Anything else stops with a fixed code, so a
// malformed or cut-off export never yields a silently changed message.

import { GMAIL_IMPORT_RAW_LIMIT } from "./gmail-transport.ts";

export type TakeoutEntry = {
  kind: "entry";
  /** Byte offset of the entry's From_ line in the whole mbox stream. */
  offset: number;
  messageId: string;
  threadId: string;
  /** From_ date in milliseconds; second precision. */
  fromDate: number;
  /** X-Gmail-Labels value as stored; may be localized or RFC 2047 encoded. */
  labels: string;
  raw: Uint8Array;
};

export type TakeoutOversize = {
  kind: "oversize";
  offset: number;
  messageId: string;
  /** Raw size after stripping, above the limit when reported. */
  size: number;
};

export type TakeoutItem = TakeoutEntry | TakeoutOversize;

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
// Longest accepted From_ line, and the longest X-Gmail-Labels line (labels can be long).
const FROM_LINE_LIMIT = 128;
const GMAIL_HEADERS_LIMIT = 64 * 1024;
const encoder = new TextEncoder();
/** An entry boundary candidate: the separator CRLF, then a From_ line. */
const NEXT_FROM = encoder.encode("\r\nFrom ");
const THREAD_PREFIX = encoder.encode("X-GM-THRID: ");
const FROM_LINE =
  /^From ([0-9]{1,20})@xxx ([A-Z][a-z]{2}) ([A-Z][a-z]{2}) ([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([+-])([0-9]{2})([0-9]{2}) ([0-9]{4})$/;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const UINT64_MAX = (1n << 64n) - 1n;

/** Converts a decimal Gmail ID to the 16-digit hex form the Gmail API uses; null if over 64 bits. */
function toHex(decimal: string): string | null {
  const value = BigInt(decimal);
  return value > UINT64_MAX ? null : value.toString(16).padStart(16, "0");
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

  // Two single-line headers. Takeout is not known to fold them; a following line that
  // starts with whitespace is ambiguous (a fold, or the message's first line), so stop.
  const lines: string[] = [];
  let cursor = fromEnd + 2;
  while (lines.length < 2) {
    const end = lineEnd(bytes, cursor, GMAIL_HEADERS_LIMIT);
    if (end < 0) {
      if (bytes.length - cursor > GMAIL_HEADERS_LIMIT)
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
    lines.push(line);
    cursor = end + 2;
  }
  if (cursor >= bytes.length) {
    if (final) throw new TakeoutMboxError("takeout_missing_separator", offset);
    return null;
  }
  if (bytes[cursor] === SP || bytes[cursor] === HT)
    throw new TakeoutMboxError("takeout_invalid_gmail_headers", offset);
  const thread = /^X-GM-THRID: ([0-9]{1,20})$/.exec(lines[0]!);
  const labels = /^X-Gmail-Labels: ?(.*)$/s.exec(lines[1]!);
  const threadId = thread ? toHex(thread[1]!) : null;
  if (!threadId || !labels) throw new TakeoutMboxError("takeout_invalid_gmail_headers", offset);
  return { messageId, threadId, fromDate, labels: labels[1]!, size: cursor };
}

/**
 * Splits a Takeout mbox stream. Push chunks in order, then call `end()` once. Each
 * returned entry's `raw` is a copy that stays valid after later pushes. An entry whose
 * stripped size exceeds `rawLimit` is reported as `oversize` without retaining its
 * bytes, so memory stays near one entry plus one chunk.
 */
export class TakeoutMboxSplitter {
  /** Backing store; the unread bytes are #store[#start, #end). It grows by doubling. */
  #store = new Uint8Array(0);
  #start = 0;
  #end = 0;
  /** Stream offset of the first unread byte. */
  #base = 0;
  #head: (Head & { offset: number }) | null = null;
  /** Bytes of the current entry discarded because it is oversize. */
  #dropped = 0;
  /** Where the next boundary search starts, relative to the unread bytes. */
  #scanFrom = 0;
  #ended = false;

  readonly #rawLimit: number;

  constructor(rawLimit = GMAIL_IMPORT_RAW_LIMIT) {
    this.#rawLimit = rawLimit;
  }

  push(chunk: Uint8Array): TakeoutItem[] {
    if (this.#ended) throw new Error("TakeoutMboxSplitter.push after end");
    if (chunk.length === 0) return [];
    const length = this.#end - this.#start;
    if (this.#end + chunk.length > this.#store.length) {
      const needed = length + chunk.length;
      if (needed <= this.#store.length / 2) this.#store.copyWithin(0, this.#start, this.#end);
      else {
        const next = new Uint8Array(Math.max(needed, this.#store.length * 2));
        next.set(this.#store.subarray(this.#start, this.#end));
        this.#store = next;
      }
      this.#start = 0;
      this.#end = length;
    }
    this.#store.set(chunk, this.#end);
    this.#end += chunk.length;
    return this.#drain(false);
  }

  end(): TakeoutItem[] {
    if (this.#ended) return [];
    this.#ended = true;
    return this.#drain(true);
  }

  get #bytes(): Uint8Array {
    return this.#store.subarray(this.#start, this.#end);
  }

  #drain(final: boolean): TakeoutItem[] {
    const items: TakeoutItem[] = [];
    for (;;) {
      if (!this.#head) {
        const bytes = this.#bytes;
        if (bytes.length === 0) return items;
        if (bytes.length < 5 && !final) return items;
        if (latin1.decode(bytes.subarray(0, 5)) !== "From ")
          throw new TakeoutMboxError(
            this.#base === 0 ? "takeout_invalid_start" : "takeout_invalid_from_line",
            this.#base,
          );
        const head = parseHead(bytes, this.#base, final);
        if (!head) return items;
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
        // two before the next possible boundary on.
        const keep = NEXT_FROM.length + FROM_LINE_LIMIT + THREAD_PREFIX.length + 2;
        if (this.#dropped + bytes.length > this.#rawLimit + keep) {
          const drop = Math.max(0, this.#scanFrom - 2);
          this.#dropped += drop;
          this.#consume(drop);
        }
        return items;
      }
      // At the end of the stream the entry ends at the last two bytes, Takeout's
      // separator, which must follow the message's own CRLF.
      const size = boundary >= 0 ? boundary : bytes.length - 2;
      if (boundary < 0 && !endsWithCrlfCrlf(bytes))
        throw new TakeoutMboxError("takeout_missing_separator", head.offset);
      const total = this.#dropped + size;
      if (this.#dropped > 0 || total > this.#rawLimit)
        items.push({
          kind: "oversize",
          offset: head.offset,
          messageId: head.messageId,
          size: total,
        });
      else
        items.push({
          kind: "entry",
          offset: head.offset,
          messageId: head.messageId,
          threadId: head.threadId,
          fromDate: head.fromDate,
          labels: head.labels,
          raw: bytes.slice(0, size),
        });
      this.#head = null;
      if (boundary < 0) {
        this.#consume(bytes.length);
        return items;
      }
      this.#consume(boundary + 2);
    }
  }

  /**
   * Returns the index of the separator CRLF before the next entry, -1 when the stream
   * ended and the current entry runs to its end, or null when more bytes are needed.
   * A boundary is a CRLF followed by a valid From_ line and `X-GM-THRID: `; body text
   * such as "From the team" is skipped. A boundary not preceded by the message's own
   * CRLF means a message without a final line break, which stops the run.
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
        if (candidate < 2 || bytes[candidate - 2] !== CR || bytes[candidate - 1] !== LF)
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

function endsWithCrlfCrlf(bytes: Uint8Array): boolean {
  const n = bytes.length;
  return (
    n >= 4 &&
    bytes[n - 4] === CR &&
    bytes[n - 3] === LF &&
    bytes[n - 2] === CR &&
    bytes[n - 1] === LF
  );
}
