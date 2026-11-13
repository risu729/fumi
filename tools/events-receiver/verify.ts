/** Standard Webhooks verification for the temporary MCP Events acceptance receiver.
 * The receiver records only event IDs, signature results and times. */

export interface SignatureResult {
  /** Number of `v1,` signatures presented in the header. */
  presented: number;
  /** Indices of configured secrets that produced a matching signature, ascending. */
  matchedKeys: number[];
  /** Whether at least one presented signature matched a configured secret. */
  valid: boolean;
}

export const TIMESTAMP_TOLERANCE_SECONDS = 300;
const MAX_SIGNATURES = 4;

export function decodeSecret(secret: string): Uint8Array<ArrayBuffer> {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new Error("Invalid signing secret");
  const bytes = Uint8Array.from(atob(secret.slice(6)), (character) => character.charCodeAt(0));
  if (bytes.length < 24 || bytes.length > 64) throw new Error("Invalid signing secret");
  return bytes;
}

export function parseSecrets(serialized: string | undefined): string[] {
  const parsed: unknown = JSON.parse(serialized ?? "[]");
  if (
    !Array.isArray(parsed) ||
    parsed.length < 1 ||
    parsed.length > 2 ||
    !parsed.every((secret): secret is string => typeof secret === "string")
  )
    throw new Error("Invalid signing secret configuration");
  for (const secret of parsed) decodeSecret(secret);
  return parsed;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

function decodeSignature(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Verify `webhook-signature` against every configured secret, so a rotation
 * delivery can be shown to carry one valid signature per key. */
export async function verifySignatures(
  secrets: readonly string[],
  id: string,
  timestamp: string,
  body: string,
  header: string,
  nowSeconds: number,
): Promise<SignatureResult> {
  const signatures = header
    .split(" ")
    .filter((part) => part.length > 0)
    .slice(0, MAX_SIGNATURES + 1);
  const presented = signatures.length;
  const invalid = { presented, matchedKeys: [], valid: false };
  if (
    presented === 0 ||
    presented > MAX_SIGNATURES ||
    !/^[0-9]{1,12}$/.test(timestamp) ||
    Math.abs(nowSeconds - Number(timestamp)) > TIMESTAMP_TOLERANCE_SECONDS
  )
    return invalid;
  const decoded = signatures.map((part) =>
    part.startsWith("v1,") ? decodeSignature(part.slice(3)) : null,
  );
  const content = new TextEncoder().encode(`${id}.${timestamp}.${body}`);
  const matchedKeys: number[] = [];
  for (const [index, secret] of secrets.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- At most two configured secrets.
    const key = await crypto.subtle.importKey(
      "raw",
      decodeSecret(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    // oxlint-disable-next-line no-await-in-loop -- At most two configured secrets.
    const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, content));
    if (decoded.some((signature) => signature !== null && equalBytes(signature, expected)))
      matchedKeys.push(index);
  }
  return { presented, matchedKeys, valid: matchedKeys.length > 0 };
}
