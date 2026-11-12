import * as v from "valibot";
import { compileShadowRouter } from "./routing.ts";
import {
  adapterSchema,
  notificationAdapterSchema,
  dispatchDigest,
  readDispatchBytes,
} from "./plugin-offer.ts";

export const DISPATCH_CONFIG_KEY = "config/routing-dispatch-v1.json";
export const offerFieldSchema = v.picklist([
  "subject",
  "from",
  "to",
  "hasAttachments",
  "envelope",
  "text",
]);
export type OfferField = v.InferOutput<typeof offerFieldSchema>;
const id = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,63}$/));
const positive = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const grant = v.pipe(
  v.array(offerFieldSchema),
  v.maxLength(6),
  v.check((fields) => new Set(fields).size === fields.length),
);
const artifactSchema = v.strictObject({
  schemaVersion: v.literal(1),
  revision: positive,
  generation: positive,
  enabled: v.boolean(),
  routing: v.strictObject({
    configJson: v.pipe(v.string(), v.maxLength(64 * 1024)),
    manifests: v.pipe(
      v.array(
        v.strictObject({
          json: v.pipe(v.string(), v.maxLength(8192)),
          authenticatedOrigin: v.pipe(v.string(), v.maxLength(256)),
        }),
      ),
      v.maxLength(16),
    ),
  }),
  destination: v.strictObject({ id, adapter: notificationAdapterSchema, offerFields: grant }),
  owners: v.pipe(
    v.array(v.strictObject({ handlerRef: id, adapter: adapterSchema, offerFields: grant })),
    v.maxLength(16),
  ),
});
const adoptionProjection = v.object({
  adoptions: v.array(
    v.object({
      pluginId: id,
      enabled: v.boolean(),
      handlerRef: id,
      inputFields: v.array(v.picklist(["subject", "from", "to", "hasAttachments"])),
      offerInputFields: v.optional(v.array(offerFieldSchema)),
    }),
  ),
});

export async function loadDispatchConfiguration(bucket: R2Bucket) {
  const object = await bucket.get(DISPATCH_CONFIG_KEY);
  if (!object) return null;
  if (object.size > 256 * 1024) {
    await Promise.race([object.body.cancel().catch(() => undefined), Promise.resolve()]);
    throw new Error("Invalid dispatch configuration");
  }
  const json = await readDispatchBytes(object.body, 256 * 1024, 5000);
  const artifact = v.parse(artifactSchema, JSON.parse(json) as unknown);
  const router = await compileShadowRouter(artifact.routing.configJson, artifact.routing.manifests);
  const adoptions = v.parse(
    adoptionProjection,
    JSON.parse(artifact.routing.configJson) as unknown,
  ).adoptions;
  if (new Set(artifact.owners.map((owner) => owner.handlerRef)).size !== artifact.owners.length)
    throw new Error("Invalid dispatch configuration");
  const enabledRefs = adoptions
    .filter((adoption) => adoption.enabled)
    .map((adoption) => adoption.handlerRef);
  if (new Set(enabledRefs).size !== enabledRefs.length)
    throw new Error("Invalid dispatch configuration");
  for (const owner of artifact.owners) {
    const adoption = adoptions.find((item) => item.handlerRef === owner.handlerRef && item.enabled);
    const manifest = adoption
      ? artifact.routing.manifests
          .map(
            (entry) =>
              JSON.parse(entry.json) as {
                pluginId: string;
                offerInputFields?: OfferField[];
                inputFields: OfferField[];
              },
          )
          .find((entry) => entry.pluginId === adoption.pluginId)
      : undefined;
    if (
      !adoption ||
      !manifest ||
      owner.offerFields.some(
        (field) =>
          !(adoption.offerInputFields ?? adoption.inputFields).some(
            (allowed) => allowed === field,
          ) || !(manifest.offerInputFields ?? manifest.inputFields).includes(field),
      )
    )
      throw new Error("Invalid dispatch configuration");
  }
  const configurationSha256 = await dispatchDigest(JSON.stringify(artifact));
  const destinationSha256 = await dispatchDigest(JSON.stringify(artifact.destination));
  return { artifact, router, adoptions, configurationSha256, destinationSha256 };
}
export type DispatchConfiguration = NonNullable<
  Awaited<ReturnType<typeof loadDispatchConfiguration>>
>;
