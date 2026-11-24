import { pairBoundary } from "./utf16.ts";

/** Chunk length and overlap, in UTF-16 code units, of every lexical index. */
const CHUNK = 3500;
const OVERLAP = 200;
/** The most UTF-16 code units of one body that an index holds. */
export const BODY_SEARCH_CHARACTERS = 100_000;

export interface Chunk {
  part: string;
  ordinal: number;
  text: string;
  sha256: string;
  original_sha256?: string;
  representation?: string;
  source_part?: string;
}

// The stored object can never yield the recorded text: R2 answered, but the object
// is absent, over its bound, not the recorded digest, or not UTF-8. Reading it again
// returns the same answer; D1 and R2 request failures stay ordinary errors.
export class InvalidSearchSource extends Error {}
export class UnsupportedEncoding extends InvalidSearchSource {}

export const sha256Hex = async (bytes: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");

export async function verifiedText(bucket: R2Bucket, key: string, digest: string, maximum: number) {
  const object = await bucket.get(key);
  if (!object) throw new InvalidSearchSource("Search source unavailable");
  if (object.size > maximum) {
    await object.body.cancel();
    throw new InvalidSearchSource("Search source exceeds bound");
  }
  const bytes = await object.arrayBuffer();
  if ((await sha256Hex(bytes)) !== digest) throw new InvalidSearchSource("Search source changed");
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new UnsupportedEncoding("Unsupported text encoding");
  }
}

export function chunks(text: string, part: string, sha256: string): Chunk[] {
  const result: Chunk[] = [];
  for (let start = 0; start < text.length; start += CHUNK - OVERLAP) {
    // A boundary inside a surrogate pair moves back one unit: the start keeps the whole pair
    // and the end leaves it to the next chunk, so the overlap never drops below 199 units.
    const chunk = text.slice(pairBoundary(text, start), pairBoundary(text, start + CHUNK));
    result.push({ part, ordinal: result.length, text: chunk, sha256 });
    if (start + CHUNK >= text.length) break;
  }
  return result;
}
