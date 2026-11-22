/**
 * Fetch one file from a link in mail under the hard limits of `link-policy.ts`.
 * Nothing in production calls this yet; see docs/link-downloads.md.
 *
 * URLs can carry access tokens. This module never logs, and its errors and
 * outcome codes never contain a URL, header or body.
 */
import { checkLinkUrl } from "./link-policy.ts";

export const LINK_FETCH_LIMITS = {
  /** Response body cap. Equal to the decoded MIME part cap for attachments. */
  maxBytes: 4 * 1024 * 1024,
  /** Deadline for the whole redirect chain, including reading the body. */
  timeoutMs: 30_000,
  /** Redirects followed after the first request. */
  maxRedirects: 5,
} as const;

export type LinkFetchLimits = { -readonly [Key in keyof typeof LINK_FETCH_LIMITS]: number };

export type LinkFetchOutcome =
  | "pending_login"
  | "pending_html"
  | "blocked_action_url"
  | "blocked_destination"
  | "too_large"
  | "timeout"
  | "redirect_limit"
  | "network_error"
  | `http_${number}`;

export interface LinkFileProvenance {
  /** The URL that returned the file, after redirects, without userinfo or fragment. */
  finalUrl: string;
  /** Number of redirects followed. */
  redirects: number;
  /** When the final response headers arrived, ISO 8601 in UTC. */
  fetchedAt: string;
  status: number;
  size: number;
  /** Media type essence from `Content-Type`, or null when absent or malformed. */
  mimeType: string | null;
  sha256: string;
}

export type LinkFetchResult =
  | { ok: true; bytes: Uint8Array; provenance: LinkFileProvenance }
  | { ok: false; outcome: LinkFetchOutcome };

export interface LinkFetchOptions {
  /** Defaults to the global `fetch`. Tests inject a local mock. */
  fetch?: typeof fetch;
  now?: () => number;
  limits?: Partial<LinkFetchLimits>;
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const pageTypes = new Set(["text/html", "application/xhtml+xml"]);
const mediaTypePattern = /^[!#$%&'*+.^_`|~0-9a-z-]{1,127}\/[!#$%&'*+.^_`|~0-9a-z-]{1,127}$/u;

class Timeout extends Error {}

/** Lowercased `type/subtype` of a Content-Type value, or null. */
export function mediaTypeEssence(value: string | null): string | null {
  if (value === null) return null;
  const essence = (value.split(";", 1)[0] ?? "").trim().toLowerCase();
  return mediaTypePattern.test(essence) ? essence : null;
}

/** True when the first bytes look like an HTML document whatever its declared type.
 * NUL characters and leading replacement characters are removed first, so UTF-16
 * HTML, with or without a byte order mark, is recognized too. */
function looksLikeHtml(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false })
    .decode(bytes.subarray(0, 512))
    .replaceAll("\u0000", "")
    .replace(/^[\s\ufeff\ufffd]+/u, "")
    .slice(0, 16)
    .toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(new Timeout());
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

/** Read at most `maxBytes`, stopping at the deadline. Null means the cap was exceeded. */
async function readCapped(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  deadline: Promise<never>,
): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- One bounded stream, read in order.
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) return null;
      chunks.push(chunk.value);
    }
  } finally {
    await Promise.race([reader.cancel().catch(() => undefined), Promise.resolve()]);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function follow(
  start: string,
  send: typeof fetch,
  now: () => number,
  limits: LinkFetchLimits,
  signal: AbortSignal,
  deadline: Promise<never>,
): Promise<LinkFetchResult> {
  let checked = checkLinkUrl(start);
  for (let redirects = 0; ; redirects++) {
    if (!checked.ok) return { ok: false, outcome: checked.outcome };
    const url = checked.url;
    // GET with no body, cookies or credentials. `redirect: "manual"` returns a 3xx
    // without contacting its Location; workerd rejects `redirect: "error"`.
    // oxlint-disable-next-line no-await-in-loop -- Each hop depends on the previous response.
    const response = await Promise.race([
      send(url.href, { method: "GET", headers: new Headers(), redirect: "manual", signal }),
      deadline,
    ]);
    if (redirectStatuses.has(response.status) && response.headers.has("Location")) {
      const location = response.headers.get("Location") ?? "";
      // oxlint-disable-next-line no-await-in-loop -- Release the hop before the next one.
      await discard(response);
      if (redirects >= limits.maxRedirects) return { ok: false, outcome: "redirect_limit" };
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        return { ok: false, outcome: "blocked_destination" };
      }
      checked = checkLinkUrl(next);
      continue;
    }
    if (response.status === 401 || response.headers.has("WWW-Authenticate")) {
      // oxlint-disable-next-line no-await-in-loop -- Terminal response.
      await discard(response);
      return { ok: false, outcome: "pending_login" };
    }
    if (response.status !== 200) {
      // oxlint-disable-next-line no-await-in-loop -- Terminal response.
      await discard(response);
      return { ok: false, outcome: `http_${response.status}` };
    }
    const fetchedAt = new Date(now()).toISOString();
    const mimeType = mediaTypeEssence(response.headers.get("Content-Type"));
    if (mimeType !== null && pageTypes.has(mimeType)) {
      // oxlint-disable-next-line no-await-in-loop -- Terminal response.
      await discard(response);
      return { ok: false, outcome: "pending_html" };
    }
    const declared = Number(response.headers.get("Content-Length") ?? "");
    if (Number.isFinite(declared) && declared > limits.maxBytes) {
      // oxlint-disable-next-line no-await-in-loop -- Terminal response.
      await discard(response);
      return { ok: false, outcome: "too_large" };
    }
    const bytes = response.body
      ? // oxlint-disable-next-line no-await-in-loop -- Terminal response.
        await readCapped(response.body, limits.maxBytes, deadline)
      : new Uint8Array(0);
    if (bytes === null) return { ok: false, outcome: "too_large" };
    if (looksLikeHtml(bytes)) return { ok: false, outcome: "pending_html" };
    // oxlint-disable-next-line no-await-in-loop -- Terminal response.
    const digest = hex(await crypto.subtle.digest("SHA-256", bytes));
    return {
      ok: true,
      bytes,
      provenance: {
        finalUrl: url.href,
        redirects,
        fetchedAt,
        status: response.status,
        size: bytes.byteLength,
        mimeType,
        sha256: digest,
      },
    };
  }
}

/**
 * Fetch `url` once under the link policy and return the file with its provenance,
 * or a fixed outcome code. Every redirect `Location` is checked with the same policy
 * before it is requested, so a refused hop is never contacted. Only a 200 response
 * that is not an HTML page is a file. A 401 or a `WWW-Authenticate` challenge is
 * `pending_login`; a redirect to a login path is `pending_login` from the policy.
 */
export async function fetchLinkFile(
  url: string,
  options: LinkFetchOptions = {},
): Promise<LinkFetchResult> {
  const limits: LinkFetchLimits = { ...LINK_FETCH_LIMITS, ...options.limits };
  const signal = AbortSignal.timeout(limits.timeoutMs);
  const deadline = aborted(signal);
  // A rejection that nobody awaits must not surface as an unhandled rejection.
  deadline.catch(() => undefined);
  try {
    return await follow(
      url,
      options.fetch ?? fetch,
      options.now ?? Date.now,
      limits,
      signal,
      deadline,
    );
  } catch (error) {
    if (error instanceof Timeout || signal.aborted) return { ok: false, outcome: "timeout" };
    // The cause can contain the URL, so it is not kept.
    return { ok: false, outcome: "network_error" };
  }
}
