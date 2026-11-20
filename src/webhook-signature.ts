/** Standard Webhooks signing shared by every fumi outbound webhook sender
 * (https://www.standardwebhooks.com/). Senders keep their own URL policy, storage
 * and retry rules; this module only turns a secret, an id and exact body bytes into
 * the three signature headers. */

/** A `whsec_` secret: canonical base64 of 24 to 64 random bytes. */
export function decodeSigningSecret(secret: string): Uint8Array<ArrayBuffer> {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new Error("Invalid signing secret");
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(atob(secret.slice(6)), (character) => character.charCodeAt(0));
  } catch {
    throw new Error("Invalid signing secret");
  }
  if (
    bytes.length < 24 ||
    bytes.length > 64 ||
    btoa(String.fromCharCode(...bytes)) !== secret.slice(6)
  )
    throw new Error("Invalid signing secret");
  return bytes;
}

export function validSigningSecret(secret: unknown): secret is string {
  if (typeof secret !== "string") return false;
  try {
    decodeSigningSecret(secret);
    return true;
  } catch {
    return false;
  }
}

/** Returns `Content-Type`, `webhook-id`, `webhook-timestamp` and `webhook-signature`
 * for one exact body. The receiver must verify against these bytes, unchanged. */
export async function standardWebhookHeaders(
  secret: string,
  id: string,
  body: string,
  now: number,
): Promise<Headers> {
  const timestamp = String(Math.floor(now / 1000));
  const key = await crypto.subtle.importKey(
    "raw",
    decodeSigningSecret(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)),
  );
  return new Headers({
    "Content-Type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${btoa(String.fromCharCode(...signature))}`,
  });
}
