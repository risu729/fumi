import * as v from "valibot";
import { dispatchDigest } from "./plugin-offer.ts";
import { ROUTING_LIMITS, validateRoutingManifest } from "./routing.ts";

const publicationSchema = v.strictObject({
  json: v.pipe(v.string(), v.maxLength(ROUTING_LIMITS.manifestBytes)),
  sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});

/** Only the administrator-configured default capability is eligible; no URL lookup. */
export async function readRoutingOwnerManifest(binding: object | undefined): Promise<Response> {
  if (!binding)
    return Response.json({ error: { code: "owner_binding_unavailable" } }, { status: 503 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Owner manifest deadline")), 5000);
  });
  try {
    const manifest: unknown = Reflect.get(binding, "manifest");
    if (typeof manifest !== "function")
      return Response.json({ error: { code: "owner_binding_unavailable" } }, { status: 503 });
    const read = async () => {
      const result: unknown = await Reflect.apply(manifest, binding, []);
      const publication = v.parse(publicationSchema, result);
      validateRoutingManifest(publication.json);
      if ((await dispatchDigest(publication.json)) !== publication.sha256)
        throw new Error("Owner manifest integrity");
      return publication;
    };
    const publication = await Promise.race([read(), deadline]);
    return Response.json({
      ...publication,
      binding: { kind: "rpc", serviceRef: "default", name: "ROUTING_DISPATCH_RPC" },
    });
  } catch {
    return Response.json({ error: { code: "owner_manifest_unavailable" } }, { status: 502 });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
