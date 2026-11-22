/**
 * Deterministic candidate URL extraction from the stored body derivative
 * (`derived/mime-v1/<sha256>/body-json/<sha256>`, `{ text, html }`).
 *
 * This module is pure: it parses strings only, never renders HTML, runs scripts,
 * resolves names or fetches anything. Its output is an indexed list so that a
 * later selection step can answer with indexes instead of URLs.
 */

export const LINK_EXTRACTION_LIMITS = {
  /** Distinct candidates kept per message. Later ones set `truncated`. */
  candidates: 64,
  /** Maximum length of a normalized candidate URL, in UTF-16 code units. */
  urlLength: 2048,
} as const;

/** The parsed body derivative, as stored by MIME extraction. */
export interface MailBody {
  text: string | null;
  html: string | null;
}

export type LinkSource = "text" | "html";

export interface LinkCandidate {
  /** Position in `candidates`; a selection step returns these, never a URL. */
  index: number;
  /** Absolute http(s) URL without userinfo or fragment. */
  url: string;
  /** Body parts the URL appeared in, in first-seen order. */
  sources: LinkSource[];
}

export interface LinkExtraction {
  candidates: LinkCandidate[];
  /** More distinct URLs existed than `LINK_EXTRACTION_LIMITS.candidates`. */
  truncated: boolean;
  /** URLs dropped because they were longer than `LINK_EXTRACTION_LIMITS.urlLength`. */
  tooLong: number;
}

/**
 * Parse and normalize one URL. Returns null for anything that is not an absolute
 * http or https URL. Userinfo and the fragment are removed: neither is sent to a
 * server by this feature, and dropping them makes equal targets deduplicate.
 */
export function normalizeLinkUrl(value: string): URL | null {
  let url: URL;
  try {
    // No base: relative and protocol-relative references are not candidates.
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.username = "";
  url.password = "";
  url.hash = "";
  return url;
}

// RFC 3986 unreserved, reserved and percent characters. Anything else, including
// whitespace, `<`, `>`, quotes and every non-ASCII character such as Japanese
// text written directly after a URL, ends the match.
const textUrlPattern = /(?<![A-Za-z0-9+.-])https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/giu;
const trailingPunctuation = new Set([".", ",", ":", ";", "!", "?", "'", '"', "*"]);

function count(value: string, character: string): number {
  let total = 0;
  for (const item of value) if (item === character) total++;
  return total;
}

/** Remove sentence punctuation and unbalanced closing brackets after a URL in prose.
 * Brackets are counted once and the counts updated as characters are removed, so
 * the work stays linear in the length of the match. */
function trimProseUrl(value: string): string {
  const openParens = count(value, "(");
  const openBrackets = count(value, "[");
  let closeParens = count(value, ")");
  let closeBrackets = count(value, "]");
  let end = value.length;
  while (end > 0) {
    const last = value[end - 1] ?? "";
    if (trailingPunctuation.has(last)) end--;
    else if (last === ")" && closeParens > openParens) {
      closeParens--;
      end--;
    } else if (last === "]" && closeBrackets > openBrackets) {
      closeBrackets--;
      end--;
    } else break;
  }
  return value.slice(0, end);
}

function* textUrls(text: string): Generator<string> {
  for (const match of text.matchAll(textUrlPattern)) yield trimProseUrl(match[0]);
}

// Named references decoded inside attribute values. Others stay literal; the URL
// policy is applied to exactly the string that would be fetched, so a reference
// left undecoded cannot hide an action word from it.
const namedReferences: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  sol: "/",
  colon: ":",
  period: ".",
  quest: "?",
  equals: "=",
  num: "#",
  percnt: "%",
  lpar: "(",
  rpar: ")",
  commat: "@",
  excl: "!",
  dollar: "$",
  plus: "+",
  comma: ",",
  semi: ";",
  lowbar: "_",
  Tab: "\t",
  NewLine: "\n",
};
// Legacy references that HTML also decodes without a semicolon (this subset only).
const legacyReferences = new Set(["amp", "lt", "gt", "quot"]);

function codePoint(value: number): string {
  if (value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return "\ufffd";
  return String.fromCodePoint(value);
}

/** Decode character references in an attribute value, following the HTML rules for
 * numeric references and the attribute-value legacy rule for named ones. */
export function decodeAttributeValue(value: string): string {
  return value.replace(
    /&(?:#([0-9]{1,8});?|#[xX]([0-9a-fA-F]{1,8});?|([A-Za-z][A-Za-z0-9]{0,31})(;?))/gu,
    (
      match,
      decimal: string | undefined,
      hexadecimal: string | undefined,
      name,
      semicolon,
      offset: number,
      whole: string,
    ) => {
      if (decimal !== undefined) return codePoint(Number.parseInt(decimal, 10));
      if (hexadecimal !== undefined) return codePoint(Number.parseInt(hexadecimal, 16));
      const replacement = namedReferences[name as string];
      if (replacement === undefined) return match;
      if (semicolon === ";") return replacement;
      if (!legacyReferences.has(name as string)) return match;
      // In an attribute, a legacy reference followed by `=` or an alphanumeric stays literal.
      const next = whole[offset + match.length] ?? "";
      return /[=A-Za-z0-9]/u.test(next) ? match : replacement;
    },
  );
}

/** HTML ASCII whitespace: tab, line feed, form feed, carriage return and space. */
function isSpace(character: string | undefined): boolean {
  return (
    character === " " ||
    character === "\t" ||
    character === "\n" ||
    character === "\f" ||
    character === "\r"
  );
}
// Elements whose content is not markup. Their text is skipped up to the matching end tag.
const rawTextElements = new Set([
  "script",
  "style",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "textarea",
  "title",
  "plaintext",
]);
// Only hyperlinks. Forms, buttons, `<base>`, `<link>` and resource URLs are ignored.
const linkElements = new Set(["a", "area"]);

/**
 * Yield the `href` of each `<a>` and `<area>` start tag. A small tokenizer that
 * follows the HTML tag and attribute syntax: comments and raw-text elements are
 * skipped, attribute values may be double-quoted, single-quoted or unquoted, and
 * the first of duplicate attributes wins.
 */
function* htmlHrefs(html: string): Generator<string> {
  const length = html.length;
  // ASCII-only lowering keeps every index equal to `html` (full Unicode lowering
  // can change the length, for example of U+0130).
  const lower = html.replace(/[A-Z]+/gu, (run) => run.toLowerCase());
  let position = 0;
  while (position < length) {
    const open = html.indexOf("<", position);
    if (open === -1) return;
    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open + 4);
      if (close === -1) return;
      position = close + 3;
      continue;
    }
    const first = html[open + 1] ?? "";
    if (first === "!" || first === "?" || first === "/") {
      // Doctype, bogus comment or end tag: nothing to extract.
      const close = html.indexOf(">", open + 2);
      if (close === -1) return;
      position = close + 1;
      continue;
    }
    if (!/[A-Za-z]/u.test(first)) {
      position = open + 1;
      continue;
    }
    let cursor = open + 1;
    while (
      cursor < length &&
      !isSpace(html[cursor]) &&
      html[cursor] !== "/" &&
      html[cursor] !== ">"
    )
      cursor++;
    const name = html.slice(open + 1, cursor).toLowerCase();
    let href: string | undefined;
    const seen = new Set<string>();
    // Attributes, until `>` or the end of input.
    while (cursor < length && html[cursor] !== ">") {
      const character = html[cursor] ?? "";
      if (isSpace(character) || character === "/") {
        cursor++;
        continue;
      }
      const nameStart = cursor;
      // An `=` that starts a name is part of it (HTML parse error recovery).
      cursor++;
      while (cursor < length) {
        const next = html[cursor] ?? "";
        if (isSpace(next) || next === "/" || next === ">" || next === "=") break;
        cursor++;
      }
      const attribute = html.slice(nameStart, cursor).toLowerCase();
      let rawValue = "";
      let afterName = cursor;
      while (afterName < length && isSpace(html[afterName])) afterName++;
      if (html[afterName] === "=") {
        cursor = afterName + 1;
        while (cursor < length && isSpace(html[cursor])) cursor++;
        const quote = html[cursor];
        if (quote === '"' || quote === "'") {
          const close = html.indexOf(quote, cursor + 1);
          const end = close === -1 ? length : close;
          rawValue = html.slice(cursor + 1, end);
          cursor = close === -1 ? length : close + 1;
        } else {
          const valueStart = cursor;
          while (cursor < length && !isSpace(html[cursor]) && html[cursor] !== ">") cursor++;
          rawValue = html.slice(valueStart, cursor);
        }
      }
      if (seen.has(attribute)) continue;
      seen.add(attribute);
      if (attribute === "href") href = rawValue;
    }
    // A tag cut off by the end of input is dropped, as in HTML.
    if (cursor >= length) return;
    position = cursor + 1;
    if (href !== undefined && linkElements.has(name)) yield decodeAttributeValue(href);
    if (rawTextElements.has(name)) {
      if (name === "plaintext") return;
      const close = lower.indexOf(`</${name}`, position);
      if (close === -1) return;
      position = close;
    }
  }
}

/**
 * Extract an indexed, deduplicated list of http(s) candidate URLs from text
 * bodies and HTML hyperlinks. Text URLs come first, then HTML ones, each in
 * document order. The result contains no other mail content.
 */
export function extractLinkCandidates(body: MailBody): LinkExtraction {
  const candidates: LinkCandidate[] = [];
  const byUrl = new Map<string, LinkCandidate>();
  let truncated = false;
  let tooLong = 0;
  const add = (raw: string, source: LinkSource) => {
    // Reject very long input before parsing; normalization can shorten it by
    // removing whitespace, userinfo and the fragment, so allow some slack.
    if (raw.length > LINK_EXTRACTION_LIMITS.urlLength * 4) {
      tooLong++;
      return;
    }
    const url = normalizeLinkUrl(raw);
    if (!url) return;
    const href = url.href;
    if (href.length > LINK_EXTRACTION_LIMITS.urlLength) {
      tooLong++;
      return;
    }
    const existing = byUrl.get(href);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      return;
    }
    if (candidates.length >= LINK_EXTRACTION_LIMITS.candidates) {
      truncated = true;
      return;
    }
    const candidate = { index: candidates.length, url: href, sources: [source] };
    candidates.push(candidate);
    byUrl.set(href, candidate);
  };
  if (body.text) for (const raw of textUrls(body.text)) add(raw, "text");
  if (body.html) for (const raw of htmlHrefs(body.html)) add(raw, "html");
  return { candidates, truncated, tooLong };
}
