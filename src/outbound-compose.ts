import { readVerified } from "./attachment-conversion-io.ts";
import { MIME_LIMITS } from "./mime-extraction.ts";
import { truncateCodeUnits } from "./utf16.ts";

/**
 * Gmail-style reply quoting and forward blocks, composed from the archived parent.
 * The parent's headers and body are untrusted text: they are escaped into HTML and
 * never choose recipients, senders, headers or tools.
 */

export interface ComposedPart {
  text?: string;
  html?: string;
}

export interface ParentAttachment {
  index: number;
  key: string;
  sha256: string;
  size: number;
  filename: string | null;
  mimeType: string;
}

export interface ParentMail {
  subject: string;
  from: string | null;
  to: string[];
  cc: string[];
  date: string | null;
  text: string;
  attachments: ParentAttachment[];
}

export class ComposeError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const encoder = new TextEncoder();
const digestPattern = /^[a-f0-9]{64}$/;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const QUOTE_STYLE =
  "margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex";
export const FORWARD_SEPARATOR = "---------- Forwarded message ---------";
export const QUOTE_TRUNCATED = "[Quoted text truncated by fumi]";

/** Cut to at most `limit` UTF-8 bytes on a code point boundary. */
export function truncateBytes(value: string, limit: number): string {
  let result = "";
  let size = 0;
  for (const character of value) {
    size += encoder.encode(character).byteLength;
    if (size > limit) break;
    result += character;
  }
  return result;
}

/** Header values are single-line display text in the composed body. */
function line(value: unknown): string {
  if (typeof value !== "string") return "";
  return controlFree(value, " ").replace(/ {2,}/g, " ").trim();
}

/** Replace C0 controls and DEL; header text in a composed body stays on one line. */
export function controlFree(value: string, replacement: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? replacement : character;
  }).join("");
}

function mailbox(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const entry = value as { name?: unknown; address?: unknown; group?: unknown };
  if (Array.isArray(entry.group)) return entry.group.flatMap(mailbox);
  const name = line(entry.name).replace(/"/g, "");
  const address = line(entry.address);
  if (!address) return name ? [name] : [];
  return [name ? `${name} <${address}>` : `<${address}>`];
}

function mailboxes(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap(mailbox) : mailbox(value);
}

/** RFC 5322 obsolete zone names (section 4.3), in minutes east of UTC. */
const NAMED_ZONES: Record<string, number> = {
  UT: 0,
  GMT: 0,
  EST: -300,
  EDT: -240,
  CST: -360,
  CDT: -300,
  MST: -420,
  MDT: -360,
  PST: -480,
  PDT: -420,
};

function zoneOffset(raw: string): number | null {
  // Strip a trailing comment such as "(JST)" without a backtracking regex.
  let end = raw.trimEnd();
  if (end.endsWith(")")) {
    const open = end.lastIndexOf("(");
    if (open !== -1) end = end.slice(0, open).trimEnd();
  }
  const token = end.slice(end.lastIndexOf(" ") + 1);
  const numeric = /^([+-])(\d{2}):?(\d{2})$/.exec(token);
  if (numeric)
    return (numeric[1] === "-" ? -1 : 1) * (Number(numeric[2]) * 60 + Number(numeric[3]));
  return NAMED_ZONES[token.toUpperCase()] ?? null;
}

/**
 * Gmail's "Tue, Nov 17, 2026 at 11:13 PM", in the Date header's own zone. Without a
 * numeric or RFC 5322 named zone the time is shown in UTC and labeled as such.
 */
export function formatMailDate(raw: string | null): string | null {
  if (!raw) return null;
  const time = Date.parse(raw);
  if (!Number.isFinite(time)) return null;
  const offset = zoneOffset(raw);
  const local = new Date(time + (offset ?? 0) * 60_000);
  const hours = local.getUTCHours();
  const minutes = String(local.getUTCMinutes()).padStart(2, "0");
  return `${DAYS[local.getUTCDay()]}, ${MONTHS[local.getUTCMonth()]} ${local.getUTCDate()}, ${local.getUTCFullYear()} at ${hours % 12 || 12}:${minutes} ${hours < 12 ? "AM" : "PM"}${offset === null ? " UTC" : ""}`;
}

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const SKIPPED_ELEMENTS = new Set(["head", "style", "script", "title"]);
const BREAK_ELEMENTS = new Set([
  "br",
  "/p",
  "/div",
  "/tr",
  "/li",
  "/h1",
  "/h2",
  "/h3",
  "/h4",
  "/h5",
  "/h6",
  "/blockquote",
  "/table",
  "/pre",
]);

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] !== "#") return entities[name.toLowerCase()] ?? match;
    const code =
      name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
      ? String.fromCodePoint(code)
      : match;
  });
}

/**
 * Minimal HTML-to-text for HTML-only parents. A single scan keeps text outside
 * tags, comments and head/style/script/title elements. The result is plain text
 * that is only ever quoted as text or escaped into HTML, never trusted as markup.
 */
export function htmlToText(html: string): string {
  // ASCII-only lowercasing keeps indices aligned with the original string.
  const lower = html.replace(/[A-Z]/g, (character) => character.toLowerCase());
  const output: string[] = [];
  let position = 0;
  while (position < html.length) {
    const open = html.indexOf("<", position);
    if (open === -1) {
      output.push(html.slice(position));
      break;
    }
    output.push(html.slice(position, open));
    // A "<" that cannot start markup is text, as in "a < b".
    if (!/[a-z/!?]/.test(lower[open + 1] ?? "")) {
      output.push("<");
      position = open + 1;
      continue;
    }
    if (lower.startsWith("<!--", open)) {
      const close = lower.indexOf("-->", open + 4);
      position = close === -1 ? html.length : close + 3;
      continue;
    }
    const close = html.indexOf(">", open + 1);
    if (close === -1) break;
    const name = /^\/?[a-z0-9]+/.exec(lower.slice(open + 1, close))?.[0] ?? "";
    position = close + 1;
    if (SKIPPED_ELEMENTS.has(name)) {
      const end = lower.indexOf(`</${name}`, position);
      const after = end === -1 ? -1 : html.indexOf(">", end);
      position = after === -1 ? html.length : after + 1;
    } else if (BREAK_ELEMENTS.has(name)) {
      output.push("\n");
    }
  }
  // Line-wise trimming stays linear on long whitespace runs.
  return decodeEntities(output.join(""))
    .split("\n")
    .map((entry) => {
      let end = entry.length;
      while (end > 0 && (entry[end - 1] === " " || entry[end - 1] === "\t")) end--;
      return entry.slice(0, end);
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function htmlLines(value: string): string {
  return escapeHtml(value).replace(/\n/g, "<br>\n");
}

/** CRLF/CR to LF and no trailing newlines; a loop, since /\n+$/ backtracks quadratically. */
function normalizeNewlines(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n");
  let end = normalized.length;
  while (end > 0 && normalized.charCodeAt(end - 1) === 10) end--;
  return normalized.slice(0, end);
}

/** Plain-text quote: "> line", ">>" for already quoted lines and ">" for blank lines. */
export function quoteLines(value: string): string {
  return normalizeNewlines(value)
    .split("\n")
    .map((entry) => (entry === "" ? ">" : entry.startsWith(">") ? `>${entry}` : `> ${entry}`))
    .join("\n");
}

/** Insert before </body> when the author sent a full document; otherwise append. */
function appendHtml(html: string, fragment: string): string {
  const end = html.toLowerCase().lastIndexOf("</body");
  return end === -1 ? html + fragment : html.slice(0, end) + fragment + html.slice(end);
}

function bytes(part: ComposedPart): number {
  return encoder.encode((part.text ?? "") + (part.html ?? "")).byteLength;
}

export async function loadParent(
  db: Pick<D1Database, "prepare">,
  bucket: R2Bucket,
  rawKey: string,
  includeBody = true,
): Promise<ParentMail> {
  const row = await db
    .prepare(
      "SELECT metadata_json, attachments_json, body_json_key FROM mail_extractions WHERE raw_key = ? AND extractor_version = 'mime-v1' AND status = 'complete'",
    )
    .bind(rawKey)
    .first<{ metadata_json: string; attachments_json: string; body_json_key: string }>();
  if (!row) throw new ComposeError("original_unavailable");
  // Extraction derivatives are content-addressed: the key ends with the SHA-256.
  const digest = row.body_json_key.slice(row.body_json_key.lastIndexOf("/") + 1);
  if (includeBody && !digestPattern.test(digest)) throw new ComposeError("original_unavailable");
  let body: { text?: unknown; html?: unknown } = {};
  if (includeBody) {
    try {
      const content = await readVerified(
        bucket,
        row.body_json_key,
        digest,
        MIME_LIMITS.bodyJsonBytes,
      );
      body = JSON.parse(new TextDecoder().decode(content)) as { text?: unknown; html?: unknown };
    } catch {
      throw new ComposeError("original_unavailable");
    }
  }
  const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
  const rawDate = Array.isArray(metadata["threadHeaders"])
    ? (metadata["threadHeaders"] as { name?: unknown; value?: unknown }[]).find(
        (header) => header.name === "date" && typeof header.value === "string",
      )?.value
    : undefined;
  const date = typeof rawDate === "string" ? rawDate : metadata["date"];
  return {
    subject: line(metadata["subject"]),
    from: mailbox(metadata["from"])[0] ?? null,
    to: mailboxes(metadata["to"]),
    cc: mailboxes(metadata["cc"]),
    date: formatMailDate(typeof date === "string" ? date : null),
    text:
      typeof body.text === "string"
        ? body.text
        : typeof body.html === "string"
          ? htmlToText(body.html)
          : "",
    attachments: JSON.parse(row.attachments_json) as ParentAttachment[],
  };
}

/**
 * Like Gmail's prefilled subject: an empty subject, or the parent's own subject,
 * gets the prefix. A subject the caller changed is sent as written.
 */
function prefixed(subject: string, parent: ParentMail, prefix: string, existing: RegExp) {
  if (subject.trim() && subject.trim() !== parent.subject) return subject;
  const base = truncateBytes(parent.subject, 998);
  if (existing.test(base)) return base;
  const result = `${prefix} ${base}`;
  return encoder.encode(result).byteLength > 998 ? base : result;
}

export function replySubject(subject: string, parent: ParentMail): string {
  return prefixed(subject, parent, "Re:", /^re\s*:/i);
}

export function forwardSubject(subject: string, parent: ParentMail): string {
  return prefixed(subject, parent, "Fwd:", /^fwd?\s*:/i);
}

function attribution(parent: ParentMail): string {
  const who = parent.from ?? "<unknown sender>";
  return parent.date ? `On ${parent.date} ${who} wrote:` : `${who} wrote:`;
}

function quotedReply(author: ComposedPart, parent: ParentMail, source: string): ComposedPart {
  const header = attribution(parent);
  return {
    ...(author.text === undefined
      ? {}
      : {
          text: `${normalizeNewlines(author.text)}\n\n${header}\n\n${quoteLines(source)}\n`,
        }),
    ...(author.html === undefined
      ? {}
      : {
          html: appendHtml(
            author.html,
            `<br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">${escapeHtml(header)}<br></div><blockquote class="gmail_quote" style="${QUOTE_STYLE}">${htmlLines(normalizeNewlines(source))}</blockquote></div>`,
          ),
        }),
  };
}

/**
 * Append a Gmail-style quote. The author's own text is never shortened: when the
 * total would exceed the body limit, the quoted original is cut at the largest
 * prefix that fits and marked as truncated.
 */
export function composeReply(
  author: ComposedPart,
  parent: ParentMail,
  limit: number,
): ComposedPart {
  // Nothing to quote: Gmail's attribution over an empty quote adds nothing.
  if (!parent.text.trim()) return author;
  const source = truncateCodeUnits(parent.text, limit);
  const full = quotedReply(author, parent, source);
  if (source.length === parent.text.length && bytes(full) <= limit) return full;
  const cut = (length: number) =>
    quotedReply(author, parent, `${truncateCodeUnits(source, length)}\n${QUOTE_TRUNCATED}`);
  if (bytes(cut(0)) > limit) throw new ComposeError("invalid_body");
  let low = 0;
  let high = source.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bytes(cut(middle)) <= limit) low = middle;
    else high = middle - 1;
  }
  return cut(low);
}

/** Gmail-style forward block. A forward is never shortened; oversize is an error. */
export function composeForward(
  author: ComposedPart,
  parent: ParentMail,
  limit: number,
): ComposedPart {
  const fields = [
    ["From", parent.from],
    ["Date", parent.date],
    ["Subject", parent.subject],
    ["To", parent.to.join(", ")],
    ["Cc", parent.cc.join(", ")],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
  const header = [FORWARD_SEPARATOR, ...fields.map(([name, value]) => `${name}: ${value}`)];
  const source = normalizeNewlines(parent.text);
  const authorText = author.text ? `${normalizeNewlines(author.text)}\n\n` : "";
  // Like reply quoting, the block joins each part the author wrote; a forward
  // without a note is plain text.
  const composed: ComposedPart = {
    ...(author.text !== undefined || !author.html
      ? { text: `${authorText}${header.join("\n")}\n\n${source}\n` }
      : {}),
    ...(author.html
      ? {
          html: appendHtml(
            author.html,
            `<br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">${header.map(escapeHtml).join("<br>")}<br></div><br><br>${htmlLines(source)}</div>`,
          ),
        }
      : {}),
  };
  if (bytes(composed) > limit) throw new ComposeError("forward_too_large");
  return composed;
}
