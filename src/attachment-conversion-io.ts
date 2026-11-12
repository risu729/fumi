export const CONVERSION_LIMITS = {
  sourceBytes: 2 * 1024 * 1024,
  outputBytes: 256 * 1024,
  outputCharacters: 100_000,
  entries: 8,
  expandedBytes: 4 * 1024 * 1024,
  ratio: 40,
};
export class ConversionBlocked extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
export const digest = async (bytes: Uint8Array | ArrayBuffer) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");

export async function readVerified(
  bucket: R2Bucket,
  key: string,
  sha256: string,
  maximum: number,
  expectedSize?: number,
): Promise<Uint8Array> {
  const object = await bucket.get(key);
  if (!object) throw new ConversionBlocked("source_missing");
  if (object.size > maximum || (expectedSize !== undefined && object.size !== expectedSize)) {
    await object.body.cancel();
    throw new ConversionBlocked("source_size");
  }
  const bytes = new Uint8Array(object.size);
  let offset = 0;
  const reader = object.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Source unavailable")), 5000);
  });
  try {
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- Bound every stream read by size and a shared deadline.
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      if (part.value.length > bytes.length - offset) throw new ConversionBlocked("source_size");
      bytes.set(part.value, offset);
      offset += part.value.length;
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (offset !== bytes.length || (await digest(bytes)) !== sha256)
    throw new ConversionBlocked("source_changed");
  return bytes;
}

export async function saveConversionObject(bucket: R2Bucket, bytes: Uint8Array, role: string) {
  const sha256 = await digest(bytes);
  const key = `derived/attachment-v1/${role}/${sha256}`;
  await bucket.put(key, bytes, {
    sha256,
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/octet-stream" },
  });
  const stored = await bucket.head(key);
  if (
    !stored ||
    stored.size !== bytes.length ||
    !stored.checksums.sha256 ||
    digestHex(stored.checksums.sha256) !== sha256
  )
    throw new ConversionBlocked("derivative_conflict");
  return { key, sha256, size: bytes.length };
}
function digestHex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, "0")).join("");
}

export function conversionText(text: unknown, passwords: readonly string[] = []): Uint8Array {
  if (typeof text !== "string" || text.length > CONVERSION_LIMITS.outputCharacters)
    throw new ConversionBlocked("output_limit");
  const result = redactCandidates(text, passwords);
  const bytes = new TextEncoder().encode(result);
  if (bytes.length > CONVERSION_LIMITS.outputBytes) throw new ConversionBlocked("output_limit");
  if (!result.trim()) throw new ConversionBlocked("no_text");
  return bytes;
}

/** A marker absent from every candidate cannot recreate a password at replacement boundaries. */
export function redactCandidates(text: string, passwords: readonly string[]) {
  const candidates = passwords.filter(Boolean).toSorted((a, b) => b.length - a.length);
  let marker = "█";
  let next = 0xe000;
  while (candidates.some((password) => password.includes(marker)))
    marker = String.fromCharCode(next++);
  let result = text;
  for (const password of candidates) result = result.split(password).join(marker);
  return result;
}
