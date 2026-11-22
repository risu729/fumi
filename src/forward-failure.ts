import type { FORWARD_ERROR_CODES } from "./receipt-schema.ts";

export interface ForwardErrorReason {
  code: (typeof FORWARD_ERROR_CODES)[number];
  smtpStatus?: string;
}

/** Only this prefix of the error text is inspected. Nothing from it is kept but the codes. */
const INSPECTED_CHARACTERS = 512;
// A 4xx/5xx reply code followed by an enhanced status of the same class: "550 5.7.1" or "550-5.7.1".
const PAIRED_REPLY = /(?<![\w.])([45])[0-5]\d[ -](\1\.\d{1,3}\.\d{1,3})(?!\w|\.\d)/;
// A reply code alone counts only at the very start, where a raw SMTP reply begins.
const LEADING_REPLY = /^([45])[0-5]\d(?=[ -])/;
const ENHANCED_STATUS = /(?<![\w.])([245])\.\d{1,3}\.\d{1,3}(?!\w|\.\d)/;
// "timeout", "timed out", "time-out"; a fixed word, never kept.
const TIMEOUT_TEXT = /\btimed?[ -]?out\b/i;

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

const replyClass = (digit: string) => (digit === "5" ? "rejected_permanent" : "rejected_temporary");

/**
 * Map a `message.forward()` rejection to a fixed code and, when present, its RFC 3463
 * enhanced status code. Workers types promise only a rejected Promise, so anything that
 * does not match the strict patterns stays `forward_failed`. Callers must never store or
 * log the error itself: it can carry addresses, headers or provider text.
 */
export function classifyForwardError(error: unknown): ForwardErrorReason {
  const { name, message } = errorText(error);
  const text = message.slice(0, INSPECTED_CHARACTERS);
  const paired = PAIRED_REPLY.exec(text);
  if (paired) return { code: replyClass(paired[1]!), smtpStatus: paired[2]! };
  const leading = LEADING_REPLY.exec(text);
  const enhanced = ENHANCED_STATUS.exec(text);
  if (leading) {
    return {
      code: replyClass(leading[1]!),
      ...(enhanced?.[1] === leading[1] ? { smtpStatus: enhanced![0] } : {}),
    };
  }
  if (enhanced) {
    const digit = enhanced[1]!;
    return {
      code: digit === "2" ? "forward_failed" : replyClass(digit),
      smtpStatus: enhanced[0],
    };
  }
  if (name === "TimeoutError" || TIMEOUT_TEXT.test(text)) return { code: "timeout" };
  return { code: "forward_failed" };
}
