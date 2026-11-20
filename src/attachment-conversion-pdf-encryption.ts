/** Bounds for the dictionaries read at cross-reference offsets and `trailer` keywords. */
const LIMITS = { dictionaryChars: 65_536, offsets: 32, trailers: 32 };
const unescapeNames = (text: string) =>
  text.replace(/#([a-f0-9]{2})/gi, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
const mentionsEncrypt = (text: string) => /\/Encrypt\b/.test(unescapeNames(text));
const regular = (char: string | undefined) =>
  char !== undefined && !"\0\t\n\f\r ()<>[]{}/%".includes(char);
const space = (char: string | undefined) => char !== undefined && "\0\t\n\f\r ".includes(char);
// White-space only: a comment where a parser expects these tokens makes the PDF unreadable here.
const offsetPattern = /(?:startxref|\/Prev|\/XRefStm)[\0\t\n\f\r ]*(\d+|%)/g;
const objectPattern = /\d+[\0\t\n\f\r ]+\d+[\0\t\n\f\r ]+obj/y;

function nameEnd(text: string, index: number, limit: number) {
  while (index < limit && regular(text[index])) index++;
  return index;
}
/** Index after the comment, literal string or hex string at `index`; -1 if it is not closed
 * before `limit`. A comment closes at the end of its line or at `limit`. */
function skipOpaque(text: string, index: number, limit: number) {
  const char = text[index];
  if (char === "%") {
    while (index < limit && text[index] !== "\n" && text[index] !== "\r") index++;
    return index;
  }
  if (char === "(") {
    for (let depth = 0; index < limit; index++) {
      const inner = text[index];
      if (inner === "\\") index++;
      else if (inner === "(") depth++;
      else if (inner === ")" && --depth === 0) return index + 1;
    }
    return -1;
  }
  for (index++; index < limit; index++) if (text[index] === ">") return index + 1;
  return -1;
}
function skipSpaceAndComments(text: string, index: number, limit: number) {
  while (index < limit && (space(text[index]) || text[index] === "%"))
    index = space(text[index]) ? index + 1 : skipOpaque(text, index, limit);
  return index;
}
/** Whether the dictionary opening with `<<` at `start` holds an `/Encrypt` name at any depth;
 * undefined when it does not close within the bound. */
function dictionaryEncrypt(text: string, start: number) {
  const limit = Math.min(text.length, start + LIMITS.dictionaryChars);
  let found = false;
  for (let index = start, depth = 0; index < limit;) {
    const char = text[index];
    if (char === "<" && text[index + 1] === "<") {
      depth++;
      index += 2;
    } else if (char === ">" && text[index + 1] === ">") {
      index += 2;
      if (--depth === 0) return found;
    } else if (char === "%" || char === "(" || char === "<") {
      index = skipOpaque(text, index, limit);
      if (index < 0) return undefined;
    } else if (char === "/") {
      const end = nameEnd(text, index + 1, limit);
      found ||= unescapeNames(text.slice(index + 1, end)) === "Encrypt";
      index = end;
    } else index++;
  }
  return undefined;
}
/** An `/Encrypt` name outside comments, strings and stream data, such as a trailer or
 * cross-reference stream dictionary entry. Unterminated string or stream data falls back to
 * any mention in the remaining bytes. */
function lexicalEncrypt(text: string) {
  for (let index = 0; index < text.length;) {
    const char = text[index]!;
    if (char === "<" && text[index + 1] === "<") index += 2;
    else if (char === "%" || char === "(" || char === "<") {
      const next = skipOpaque(text, index, text.length);
      if (next < 0) return mentionsEncrypt(text.slice(index));
      index = next;
    } else if (char === "/") {
      const end = nameEnd(text, index + 1, text.length);
      if (unescapeNames(text.slice(index + 1, end)) === "Encrypt") return true;
      index = end;
    } else if (!regular(char)) index++;
    else {
      let end = nameEnd(text, index, text.length);
      if (text.slice(index, end) === "stream") {
        const close = text.indexOf("endstream", end);
        if (close < 0) return mentionsEncrypt(text.slice(end));
        end = close + "endstream".length;
      }
      index = end;
    }
  }
  return false;
}
/** Reads what a parser reads by position, wherever the lexical scan placed it: every
 * dictionary after a `trailer` keyword, and the classic or stream cross-reference section at
 * every `startxref`, `/Prev` and `/XRefStm` offset found anywhere in the bytes. Anything it
 * cannot read within its bounds counts as encrypted, because the caller saw a mention. */
function structuralEncrypt(text: string, unescaped: string) {
  if (!text.startsWith("%PDF-")) return true;
  const trailers: { at: number; dictionary: boolean }[] = [];
  for (const { index } of text.matchAll(/trailer/g)) {
    if (trailers.length === LIMITS.trailers) return true;
    const limit = Math.min(text.length, index + LIMITS.dictionaryChars);
    const at = skipSpaceAndComments(text, index + "trailer".length, limit);
    const dictionary = text.startsWith("<<", at);
    if (dictionary && dictionaryEncrypt(text, at) !== false) return true;
    trailers.push({ at: index, dictionary });
  }
  const offsets = new Set<number>();
  for (const source of [text, unescaped])
    for (const match of source.matchAll(offsetPattern)) {
      if (match[1] === "%") return true;
      offsets.add(Number(match[1]));
    }
  if (!offsets.size || offsets.size > LIMITS.offsets) return true;
  for (const offset of offsets) {
    if (!Number.isSafeInteger(offset) || offset >= text.length) return true;
    let at = offset;
    const limit = Math.min(text.length, offset + LIMITS.dictionaryChars);
    while (at < limit && space(text[at])) at++;
    if (text.startsWith("xref", at)) {
      if (!trailers.find((trailer) => trailer.at > at)?.dictionary) return true;
      continue;
    }
    objectPattern.lastIndex = at;
    if (!objectPattern.test(text)) return true;
    at = skipSpaceAndComments(
      text,
      objectPattern.lastIndex,
      Math.min(text.length, objectPattern.lastIndex + LIMITS.dictionaryChars),
    );
    if (!text.startsWith("<<", at) || dictionaryEncrypt(text, at) !== false) return true;
  }
  return false;
}
/** Routes a PDF to password decryption. Only bytes that mention an `/Encrypt` name can be
 * encrypted; such a PDF stays on the OCR path only when neither a lexical scan nor the
 * dictionaries a parser reads by position hold that entry. */
export function isEncryptedPdf(bytes: Uint8Array, mime: string) {
  if (mime !== "application/pdf") return false;
  const text = new TextDecoder("latin1").decode(bytes);
  const unescaped = unescapeNames(text);
  if (!/\/Encrypt\b/.test(unescaped)) return false;
  return lexicalEncrypt(text) || structuralEncrypt(text, unescaped);
}
