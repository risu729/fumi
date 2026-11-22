// Incremental splitter for Google Takeout Gmail mbox files (ADR 0004).
//
// Each Takeout entry is:
//   From <decimal Gmail message id>@xxx <Www Mmm dd hh:mm:ss +zzzz yyyy>CRLF
//   X-GM-THRID: <decimal thread id>CRLF
//   X-Gmail-Labels: <comma-separated label names>CRLF
//   <the original message bytes>
//   CRLF (one separator added by Takeout)
// The splitter strips the From_ line, the two added headers and the separator, and
// returns the remaining bytes unchanged. Anything else stops with a fixed code.

import { GMAIL_IMPORT_RAW_LIMIT } from "./gmail-transport.ts";

export type TakeoutEntry = {
  kind: "entry";
  /** Byte offset of the entry's From_ line in the whole mbox stream. */
  offset: number;
  messageId: string;
  threadId: string;
  /** From_ date in milliseconds; second precision. */
  fromDate: number;
  /** X-Gmail-Labels value as stored, unfolded; may be localized or RFC 2047 encoded. */
  labels: string;
  raw: Uint8Array;
};

export type TakeoutOversize = {
  kind: "oversize";
  offset: number;
  messageId: string;
  /** Raw size after stripping, at least the limit when reported. */
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
// Longest accepted From_ line and the two Gmail header lines; labels can be long.
const FROM_LINE_LIMIT = 128;
const GMAIL_HEADERS_LIMIT = 64 * 1024;
const BOUNDARY = new TextEncoder().encode("\r\n\r\nFrom ");
const FROM_LINE =
  /^From ([0-9]{1,20})@xxx ([A-Z][a-z]{2} ([A-Z][a-z]{2}) ([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([+-])([0-9]{2})([0-9]{2}) ([0-9]{4}))$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const UINT64_MAX = (1n << 64n) - 1n;

/** Converts a decimal Gmail ID to the 16-digit hex form the Gmail API uses; null if over 64 bits. */
function toHex(decimal: string): string | null {
  const value = BigInt(decimal);
  return value > UINT64_MAX ? null : value.toString(16).padStart(16, "0");
}

function parseFromDate(match: RegExpExecArray): number {
  const month = MONTHS.indexOf(match[3]!);
  if (month < 0) return Number.NaN;
  const utc = Date.UTC(
    Number(match[11]),
    month,
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    Number(match[7]),
  );
  // Date.UTC rolls over out-of-range fields; reject them instead.
  const date = new Date(utc);
  if (
    date.getUTCDate() !== Number(match[4]) ||
    date.getUTCHours() !== Number(match[5]) ||
    date.getUTCMinutes() !== Number(match[6]) ||
    date.getUTCSeconds() !== Number(match[7]) ||
    Number(match[10]) > 59
  )
    return Number.NaN;
  const zone = (Number(match[9]) * 60 + Number(match[10])) * 60_000;
  return match[8] === "+" ? utc - zone : utc + zone;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  const last = haystack.length - needle.length;
  outer: for (let i = from; i <= last; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function lineEnd(bytes: Uint8Array, from: number, limit: number): number {
  for (let i = from; i < bytes.length - 1 && i - from <= limit; i++)
    if (bytes[i] === CR && bytes[i + 1] === LF) return i;
  return -1;
}

type Head = { messageId: string; threadId: string; fromDate: number; labels: string; size: number };

/**
 * Parses the From_ line and Gmail headers at `start`. Returns null when more bytes are
 * needed, so the caller can wait for the next chunk.
 */
function parseHead(bytes: Uint8Array, start: number, offset: number): Head | null {
  const fromEnd = lineEnd(bytes, start, FROM_LINE_LIMIT);
  if (fromEnd < 0) {
    if (bytes.length - start > FROM_LINE_LIMIT)
      throw new TakeoutMboxError("takeout_invalid_from_line", offset);
    return null;
  }
  const match = FROM_LINE.exec(latin1.decode(bytes.subarray(start, fromEnd)));
  if (!match) throw new TakeoutMboxError("takeout_invalid_from_line", offset);
  const fromDate = parseFromDate(match);
  if (!Number.isFinite(fromDate)) throw new TakeoutMboxError("takeout_invalid_from_line", offset);
  // Read unfolded header lines until both Gmail headers are seen.
  const headers: string[] = [];
  let cursor = fromEnd + 2;
  while (headers.length < 2) {
    let end = lineEnd(bytes, cursor, GMAIL_HEADERS_LIMIT);
    if (end < 0) {
      if (bytes.length - start > GMAIL_HEADERS_LIMIT)
        throw new TakeoutMboxError("takeout_header_limit", offset);
      return null;
    }
    // Folded continuation lines start with space or tab.
    while (end + 2 < bytes.length && (bytes[end + 2] === 32 || bytes[end + 2] === 9)) {
      const next = lineEnd(bytes, end + 2, GMAIL_HEADERS_LIMIT);
      if (next < 0) {
        if (bytes.length - start > GMAIL_HEADERS_LIMIT)
          throw new TakeoutMboxError("takeout_header_limit", offset);
        return null;
      }
      end = next;
    }
    if (end + 2 >= bytes.length) return null;
    let header: string;
    try {
      header = utf8.decode(bytes.subarray(cursor, end));
    } catch {
      throw new TakeoutMboxError("takeout_invalid_gmail_headers", offset);
    }
    headers.push(header.replace(/\r\n[ \t]/g, " "));
    cursor = end + 2;
  }
  const thread = /^X-GM-THRID: ([0-9]{1,20})$/.exec(headers[0]!);
  const labels = /^X-Gmail-Labels: ?(.*)$/s.exec(headers[1]!);
  if (!thread || !labels) throw new TakeoutMboxError("takeout_invalid_gmail_headers", offset);
  const messageId = toHex(match[1]!);
  const threadId = toHex(thread[1]!);
  if (!messageId) throw new TakeoutMboxError("takeout_invalid_from_line", offset);
  if (!threadId) throw new TakeoutMboxError("takeout_invalid_gmail_headers", offset);
  return {
    messageId,
    threadId,
    fromDate,
    labels: labels[1]!,
    size: cursor - start,
  };
}

/**
 * Splits a Takeout mbox stream. Push chunks in order, then call `end()`. Each returned
 * entry's `raw` is a copy that stays valid after later pushes. An entry whose stripped
 * size exceeds `rawLimit` is reported as `oversize` without retaining its bytes.
 */
export class TakeoutMboxSplitter {
  #buffer: Uint8Array = new Uint8Array(0);
  /** Stream offset of #buffer[0]. */
  #base = 0;
  #head: (Head & { offset: number }) | null = null;
  /** Bytes of the current entry discarded because it is oversize. */
  #dropped = 0;
  #started = false;
  /** Where the next boundary search starts in #buffer. */
  #scanFrom = 0;

  readonly #rawLimit: number;

  constructor(rawLimit = GMAIL_IMPORT_RAW_LIMIT) {
    this.#rawLimit = rawLimit;
  }

  push(chunk: Uint8Array): TakeoutItem[] {
    if (chunk.length === 0) return [];
    const next = new Uint8Array(this.#buffer.length + chunk.length);
    next.set(this.#buffer);
    next.set(chunk, this.#buffer.length);
    this.#buffer = next;
    return this.#drain(false);
  }

  end(): TakeoutItem[] {
    return this.#drain(true);
  }

  #drain(final: boolean): TakeoutItem[] {
    const items: TakeoutItem[] = [];
    for (;;) {
      if (!this.#head) {
        if (!this.#started) {
          if (this.#buffer.length === 0) return items;
          if (this.#buffer.length < 5 && !final) return items;
          if (latin1.decode(this.#buffer.subarray(0, 5)) !== "From ")
            throw new TakeoutMboxError("takeout_invalid_start", this.#base);
        }
        const head = parseHead(this.#buffer, 0, this.#base);
        if (!head) {
          if (final) throw new TakeoutMboxError("takeout_invalid_gmail_headers", this.#base);
          return items;
        }
        this.#started = true;
        this.#head = { ...head, offset: this.#base };
        this.#consume(head.size);
        this.#dropped = 0;
      }
      const head = this.#head;
      // A boundary is Takeout's separator CRLF after the message's own CRLF, followed by
      // a complete, valid From_ line. Body text such as "From the team" is skipped.
      let boundary = -1;
      for (;;) {
        const candidate = indexOf(this.#buffer, BOUNDARY, this.#scanFrom);
        if (candidate < 0) {
          this.#scanFrom = Math.max(0, this.#buffer.length - BOUNDARY.length + 1);
          break;
        }
        const end = lineEnd(this.#buffer, candidate + 4, FROM_LINE_LIMIT);
        if (end < 0 && this.#buffer.length - (candidate + 4) <= FROM_LINE_LIMIT && !final) {
          // The From_ line is not complete yet; look here again after the next chunk.
          this.#scanFrom = candidate;
          break;
        }
        if (end >= 0 && FROM_LINE.test(latin1.decode(this.#buffer.subarray(candidate + 4, end)))) {
          boundary = candidate;
          break;
        }
        this.#scanFrom = candidate + 1;
      }
      if (boundary >= 0 || final) {
        let size: number;
        if (boundary >= 0) size = boundary + 2;
        else {
          // The last entry ends with the message's CRLF and Takeout's separator CRLF.
          const length = this.#buffer.length;
          if (length < 2 || this.#buffer[length - 2] !== CR || this.#buffer[length - 1] !== LF)
            throw new TakeoutMboxError("takeout_missing_separator", head.offset);
          size = length - 2;
        }
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
            raw: this.#buffer.slice(0, size),
          });
        this.#head = null;
        if (boundary < 0) {
          this.#consume(this.#buffer.length);
          return items;
        }
        this.#consume(boundary + 4);
        this.#scanFrom = 0;
        continue;
      }
      // No boundary yet. An entry already over the limit keeps only the bytes from the
      // next possible boundary on.
      if (
        this.#dropped + this.#buffer.length >
        this.#rawLimit + BOUNDARY.length + FROM_LINE_LIMIT
      ) {
        const drop = this.#scanFrom;
        this.#dropped += drop;
        this.#consume(drop);
      }
      return items;
    }
  }

  #consume(count: number) {
    // A view, not a copy: the next push compacts the buffer.
    this.#buffer = this.#buffer.subarray(count);
    this.#base += count;
    this.#scanFrom = Math.max(0, this.#scanFrom - count);
  }
}
