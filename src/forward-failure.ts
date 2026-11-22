import type { FORWARD_ERROR_CODES } from "./receipt-schema.ts";

export interface ForwardErrorReason {
  code: (typeof FORWARD_ERROR_CODES)[number];
  smtpStatus?: string;
}

/** Only this prefix of the error text is inspected. Nothing from it is kept but the codes. */
const INSPECTED_CHARACTERS = 512;
// The only SMTP form that classifies: a 4xx/5xx reply code followed by an enhanced status
// of the same class, "550 5.7.1" or "550-5.7.1". Neither may sit inside an address, path,
// hostname or version number. A reply code alone ("404 Not Found", "500 Internal Server
// Error") and an enhanced status alone ("runtime 4.1.3 failed") are too often HTTP codes,
// ports or version numbers, so they stay unclassified and keep receipt v1.
const PAIRED_REPLY = /(?<![\w.@/-])([45])[0-5]\d[ -](\1\.\d{1,3}\.\d{1,3})(?![\w@]|[.:/-]\w)/;
// "timeout", "timed out", "time-out"; a fixed word, never kept.
const TIMEOUT_TEXT = /\btimed?[ -]?out\b/gi;
// Characters that end the token around a timeout word.
const TOKEN_BOUNDARY = /[\s<>()[\]{},;"'`]/;
// A token holding an address, a URL or path, or a hostname label is not a timeout report.
const ADDRESS_LIKE_TOKEN = /[@/]|\.[a-z]/i;

function errorText(error: unknown): { name: string; message: string } {
  try {
    if (typeof error === "string") return { name: "", message: error };
    if (error instanceof Error) {
      const name = typeof error.name === "string" ? error.name : "";
      const message = typeof error.message === "string" ? error.message : "";
      return { name, message };
    }
  } catch {
    /* A hostile getter leaves the error unclassified. */
  }
  return { name: "", message: "" };
}

/** True for a timeout word that is not part of an address, URL or hostname. */
function mentionsTimeout(text: string): boolean {
  for (const match of text.matchAll(TIMEOUT_TEXT)) {
    let start = match.index;
    while (start > 0 && !TOKEN_BOUNDARY.test(text[start - 1]!)) start -= 1;
    let end = match.index + match[0].length;
    while (end < text.length && !TOKEN_BOUNDARY.test(text[end]!)) end += 1;
    // Sentence punctuation after the word does not make it a hostname.
    const token = text.slice(start, end).replace(/[.:!?]+$/, "");
    if (!ADDRESS_LIKE_TOKEN.test(token)) return true;
  }
  return false;
}

/**
 * Map a `message.forward()` rejection to a fixed code and, for a paired SMTP reply, its
 * RFC 3463 enhanced status code. Workers types promise only a rejected Promise, so
 * anything that does not match the strict patterns stays `forward_failed`. Callers must
 * never store or log the error itself: it can carry addresses, headers or provider text.
 */
export function classifyForwardError(error: unknown): ForwardErrorReason {
  const { name, message } = errorText(error);
  const text = message.slice(0, INSPECTED_CHARACTERS);
  const paired = PAIRED_REPLY.exec(text);
  if (paired) {
    return {
      code: paired[1] === "5" ? "rejected_permanent" : "rejected_temporary",
      smtpStatus: paired[2]!,
    };
  }
  if (name === "TimeoutError" || mentionsTimeout(text)) return { code: "timeout" };
  return { code: "forward_failed" };
}
