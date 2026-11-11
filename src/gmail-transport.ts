import { gmailId } from "./gmail-provenance.ts";

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_IMPORT_RAW_LIMIT = 25 * 1024 * 1024;
export interface GmailTransport {
  list(parameters: {
    q: string;
    includeSpamTrash: boolean;
    maxResults: number;
    pageToken?: string;
  }): Promise<unknown>;
  getRaw(id: string): Promise<unknown>;
}
export class GmailImportError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

// The raw field can be 35 MiB of base64. Decode it incrementally rather than
// retaining JSON text, parsed base64, a binary string and MIME at the same time.
async function readRawJson(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<unknown> {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const bytes = new Uint8Array(GMAIL_IMPORT_RAW_LIMIT);
  let metadata = "";
  let prefix = "";
  let carry = "";
  let found = false;
  let finished = false;
  let size = 0;
  let encodedSize = 0;
  function decodePart(text: string, final: boolean) {
    carry += text;
    if (!/^[A-Za-z0-9_-]*={0,2}$/.test(carry)) throw new GmailImportError("gmail_invalid_response");
    encodedSize += text.length;
    if (encodedSize > Math.ceil((GMAIL_IMPORT_RAW_LIMIT * 4) / 3) + 2)
      throw new GmailImportError("gmail_response_too_large");
    const count = final ? carry.length : Math.floor(carry.length / 4) * 4;
    if (count === 0) return;
    const binary = atob(carry.slice(0, count).replace(/-/g, "+").replace(/_/g, "/"));
    if (binary.length > bytes.length - size) throw new GmailImportError("gmail_response_too_large");
    for (let index = 0; index < binary.length; index++) bytes[size++] = binary.charCodeAt(index);
    carry = carry.slice(count);
  }
  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- Decode one bounded stream chunk at a time.
    const chunk = await reader.read();
    let text = chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
    if (!found) {
      prefix += text;
      const match = /"raw"\s*:\s*"/.exec(prefix);
      if (match) {
        metadata = `${prefix.slice(0, match.index)}"raw":""`;
        text = prefix.slice(match.index + match[0].length);
        prefix = "";
        found = true;
      } else {
        if (prefix.length > 32 * 1024 || chunk.done)
          throw new GmailImportError("gmail_invalid_response");
        continue;
      }
    }
    if (!finished) {
      const end = text.indexOf('"');
      const raw = end < 0 ? text : text.slice(0, end);
      // Avoid a large temporary atob string even if the response arrives in one chunk.
      for (let offset = 0; offset < raw.length; offset += 64 * 1024)
        decodePart(raw.slice(offset, offset + 64 * 1024), false);
      if (end >= 0) {
        decodePart("", true);
        finished = true;
        metadata += text.slice(end + 1);
      }
    } else metadata += text;
    if (metadata.length > 32 * 1024) throw new GmailImportError("gmail_response_too_large");
    if (chunk.done) break;
  }
  if (!found || !finished || carry) throw new GmailImportError("gmail_invalid_response");
  const rawKeys = [...metadata.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)].filter(
    (match) => JSON.parse(`"${match[1]}"`) === "raw",
  );
  if (rawKeys.length !== 1) throw new GmailImportError("gmail_invalid_response");
  const result = JSON.parse(metadata) as Record<string, unknown>;
  if (result["raw"] !== "") throw new GmailImportError("gmail_invalid_response");
  delete result["raw"];
  return { ...result, rawBytes: bytes.subarray(0, size) };
}

// Credentials and transport are trusted operator configuration, never mail input.
// This client has only GET methods, a fixed Google host, and no redirect following.
export function createReadonlyGmailTransport(config: {
  scopes: readonly string[];
  expectedAccountHash: string;
  accessToken: () => Promise<string>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): GmailTransport {
  if (config.scopes.length !== 1 || config.scopes[0] !== GMAIL_READONLY_SCOPE)
    throw new GmailImportError("readonly_scope_required");
  if (!/^[a-f0-9]{64}$/.test(config.expectedAccountHash))
    throw new GmailImportError("gmail_expected_account_required");
  const request = config.fetch ?? fetch;
  const sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let gate = Promise.resolve();
  let nextRequest = 0;
  function paced() {
    const turn = gate.then(async () => {
      await sleep(Math.max(0, nextRequest - Date.now()));
      nextRequest = Date.now() + 250;
      return undefined;
    });
    gate = turn.catch(() => undefined);
    return turn;
  }
  async function get(url: URL, limit: number, token: string): Promise<unknown> {
    for (let attempt = 0; attempt < 4; attempt++) {
      // oxlint-disable-next-line no-await-in-loop -- Serialize and pace all requests, including retries.
      await paced();
      let response: Response;
      try {
        // oxlint-disable-next-line no-await-in-loop -- Each retry has its own short deadline and token refresh.
        response = await request(url, {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
        });
      } catch {
        if (attempt === 3) throw new GmailImportError("gmail_unavailable");
        // oxlint-disable-next-line no-await-in-loop -- Transient transport failures retry with bounded backoff.
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!response.ok) {
        const retry = response.status === 429 || response.status >= 500;
        const delayHeader = response.headers.get("Retry-After");
        const delay = delayHeader === null ? 1000 * 2 ** attempt : Number(delayHeader) * 1000;
        // Do not echo provider response prose or private account details.
        // oxlint-disable-next-line no-await-in-loop -- Release failed response streams before retrying.
        await response.body?.cancel();
        if (!retry || attempt === 3) throw new GmailImportError(`gmail_http_${response.status}`);
        if (!Number.isFinite(delay) || delay > 30_000)
          throw new GmailImportError("gmail_retry_later");
        // oxlint-disable-next-line no-await-in-loop -- Bounded exponential retry respecting Retry-After.
        await sleep(Math.max(1000, delay));
        continue;
      }
      const reader = response.body?.getReader();
      if (!reader) throw new GmailImportError("gmail_invalid_response");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        // oxlint-disable-next-line no-await-in-loop -- Await bounded raw decoding before closing its response stream.
        if (url.searchParams.get("format") === "raw") return await readRawJson(reader);
        while (true) {
          // oxlint-disable-next-line no-await-in-loop -- Bounded streaming prevents unbounded JSON allocation.
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > limit) throw new GmailImportError("gmail_response_too_large");
          chunks.push(chunk.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return JSON.parse(
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
        );
      } catch (error) {
        if (error instanceof GmailImportError) throw error;
        throw new GmailImportError("gmail_invalid_response");
      } finally {
        // oxlint-disable-next-line no-await-in-loop -- Always release a bounded response before the next request.
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
    throw new GmailImportError("gmail_unavailable");
  }
  let verifiedToken: string | null = null;
  async function authorized(url: URL, limit: number): Promise<unknown> {
    let token: string;
    try {
      token = await config.accessToken();
    } catch {
      throw new GmailImportError("gmail_credentials_unavailable");
    }
    if (!token || token.length > 8192 || /[\r\n]/.test(token))
      throw new GmailImportError("gmail_credentials_unavailable");
    if (token !== verifiedToken) {
      const profile = await get(
        new URL("https://gmail.googleapis.com/gmail/v1/users/me/profile"),
        8192,
        token,
      );
      const address =
        profile && typeof profile === "object" && "emailAddress" in profile
          ? profile.emailAddress
          : null;
      if (typeof address !== "string" || address.length > 320)
        throw new GmailImportError("gmail_account_mismatch");
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(address.trim().toLowerCase()),
      );
      const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(
        "",
      );
      if (hash !== config.expectedAccountHash) throw new GmailImportError("gmail_account_mismatch");
      verifiedToken = token;
    }
    return get(url, limit, token);
  }
  return {
    list(parameters) {
      const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
      for (const [key, value] of Object.entries(parameters))
        url.searchParams.set(key, String(value));
      return authorized(url, 32 * 1024);
    },
    getRaw(id) {
      if (!gmailId(id)) throw new GmailImportError("gmail_invalid_id");
      const url = new URL(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`,
      );
      url.searchParams.set("format", "raw");
      url.searchParams.set("fields", "id,threadId,internalDate,labelIds,raw");
      return authorized(url, Math.ceil((GMAIL_IMPORT_RAW_LIMIT * 4) / 3) + 32 * 1024);
    },
  };
}
