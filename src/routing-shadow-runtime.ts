import * as v from "valibot";
import { compileShadowRouter, ROUTING_LIMITS } from "./routing.ts";
import type { RoutingMetadata, ShadowDecision } from "./routing.ts";

export const ROUTING_CONFIG_KEY = "config/routing-shadow-v1.json";
export const SHADOW_REPAIR_LIMIT = 5;
const CONFIG_BYTES = 256 * 1024;
const configArtifactSchema = v.strictObject({
  schemaVersion: v.literal(1),
  configJson: v.pipe(v.string(), v.maxLength(ROUTING_LIMITS.configBytes)),
  // These are administrator attestations after channel verification, not proof
  // that a self-asserted origin authenticates the owner. Only admin R2 writes may
  // provision this fixed key; mail and model outputs cannot update it.
  manifests: v.pipe(
    v.array(
      v.strictObject({
        json: v.pipe(v.string(), v.maxLength(ROUTING_LIMITS.manifestBytes)),
        authenticatedOrigin: v.pipe(v.string(), v.maxLength(256)),
      }),
    ),
    v.maxLength(ROUTING_LIMITS.plugins),
  ),
});
const mailboxSchema = v.strictObject({
  name: v.optional(v.string()),
  address: v.string(),
});
const extractionMetadataSchema = v.object({
  subject: v.nullable(v.string()),
  from: v.nullable(mailboxSchema),
  to: v.pipe(v.array(mailboxSchema), v.maxLength(32)),
});

interface ShadowSource {
  raw_key: string;
  raw_sha256: string;
  catalog_sha256: string | null;
  updated_at: number;
  metadata_json: string;
  attachment_count: number;
  source_kind: string;
  notify_events: number;
}

export interface ShadowRepairResult {
  status: "disabled" | "invalid_config" | "unavailable" | "complete" | "partial";
  examined: number;
  written: number;
  blocked: number;
  failed: number;
}

async function configBytes(object: R2ObjectBody): Promise<string> {
  if (object.size > CONFIG_BYTES) {
    await object.body.cancel();
    throw new Error("Invalid shadow configuration");
  }
  const bytes = new Uint8Array(object.size);
  const reader = object.body.getReader();
  let offset = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Shadow configuration unavailable")), 5000);
  });
  try {
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- A shared deadline and exact byte cap bound reads.
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      if (chunk.value.byteLength > bytes.byteLength - offset)
        throw new Error("Invalid shadow configuration");
      bytes.set(chunk.value, offset);
      offset += chunk.value.byteLength;
    }
    if (offset !== object.size) throw new Error("Invalid shadow configuration");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await Promise.race([reader.cancel().catch(() => undefined), Promise.resolve()]);
    reader.releaseLock();
  }
}

function metadata(source: ShadowSource): RoutingMetadata | null {
  const json = source.metadata_json;
  if (json.length > 32 * 1024 || new TextEncoder().encode(json).byteLength > 32 * 1024) return null;
  try {
    const parsed = v.safeParse(extractionMetadataSchema, JSON.parse(json) as unknown);
    if (
      !parsed.success ||
      !Number.isInteger(source.attachment_count) ||
      source.attachment_count < 0 ||
      source.attachment_count > 32
    )
      return null;
    const value = parsed.output;
    return {
      subject: value.subject ?? "",
      from: value.from?.address ?? "",
      to: value.to.map((address) => address.address).join(","),
      hasAttachments: source.attachment_count > 0,
    };
  } catch {
    return null;
  }
}

const columns = `e.raw_key,e.raw_sha256,s.raw_sha256 AS catalog_sha256,e.updated_at,e.metadata_json,
  e.attachment_count,s.source_kind,s.notify_events`;
const pending = `FROM mail_extractions e JOIN archive_sources s ON s.raw_key=e.raw_key
  LEFT JOIN routing_shadow_decisions d ON d.raw_key=e.raw_key AND d.configuration_sha256=?
  WHERE e.extractor_version='mime-v1' AND e.status='complete' AND s.raw_state='present'
  AND (d.raw_key IS NULL OR d.source_sha256!=e.raw_sha256 OR d.extraction_updated_at!=e.updated_at
    OR d.catalog_sha256 IS NOT s.raw_sha256
    OR d.source_kind!=s.source_kind OR d.notify_events!=s.notify_events)`;

/** Scheduled, bounded shadow-only replay. The fixed R2 artifact is administrator-owned. */
export async function repairRoutingShadow(env: {
  MAIL_ARCHIVE: R2Bucket;
  MAIL_CATALOG: D1Database;
}): Promise<ShadowRepairResult> {
  const result: ShadowRepairResult = {
    status: "complete",
    examined: 0,
    written: 0,
    blocked: 0,
    failed: 0,
  };
  let object: R2ObjectBody | null;
  try {
    object = await env.MAIL_ARCHIVE.get(ROUTING_CONFIG_KEY);
  } catch {
    return { ...result, status: "unavailable" };
  }
  if (!object) return { ...result, status: "disabled" };
  let router;
  try {
    const artifact = v.parse(
      configArtifactSchema,
      JSON.parse(await configBytes(object)) as unknown,
    );
    router = await compileShadowRouter(artifact.configJson, artifact.manifests);
  } catch {
    return { ...result, status: "invalid_config" };
  }
  const hash = router.configurationSha256;
  const db = env.MAIL_CATALOG.withSession("first-primary");
  try {
    const checkpoint = await db
      .prepare("SELECT cursor FROM routing_shadow_scan WHERE configuration_sha256=?")
      .bind(hash)
      .first<{ cursor: string }>();
    const cursor = checkpoint?.cursor ?? "";
    const first = await db
      .prepare(`SELECT ${columns} ${pending} AND e.raw_key>? ORDER BY e.raw_key LIMIT ?`)
      .bind(hash, cursor, SHADOW_REPAIR_LIMIT)
      .all<ShadowSource>();
    const rows = first.results;
    if (rows.length < SHADOW_REPAIR_LIMIT && cursor) {
      const wrap = await db
        .prepare(`SELECT ${columns} ${pending} AND e.raw_key<=? ORDER BY e.raw_key LIMIT ?`)
        .bind(hash, cursor, SHADOW_REPAIR_LIMIT - rows.length)
        .all<ShadowSource>();
      rows.push(...wrap.results);
    }
    for (const source of rows) {
      result.examined++;
      try {
        const provenance =
          source.source_kind === "email_routing" && source.notify_events === 1
            ? "live"
            : "historical";
        let decision: ShadowDecision | undefined;
        let failure: "invalid_metadata" | "evaluation_error" | "source_changed" | null = null;
        if (source.raw_sha256 !== source.catalog_sha256) failure = "source_changed";
        else {
          const input = metadata(source);
          if (!input && provenance === "live") failure = "invalid_metadata";
          else {
            decision = router.evaluate(input, provenance);
            if (decision.status === "evaluation_error" || decision.status === "invalid_metadata")
              failure = decision.status;
          }
        }
        const now = Date.now();
        // Fence against a source/extraction/provenance update between read and write.
        // The row is replayable after any newer extractor update or provenance change.
        // oxlint-disable-next-line no-await-in-loop -- Small sequential batch limits work and checkpoints each row.
        const write = await db
          .prepare(`INSERT INTO routing_shadow_decisions (
          raw_key,configuration_sha256,source_sha256,catalog_sha256,extraction_updated_at,source_kind,notify_events,
          state,failure_code,decision_json,updated_at)
          SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (
            SELECT 1 FROM mail_extractions e JOIN archive_sources s ON s.raw_key=e.raw_key
            WHERE e.raw_key=? AND e.extractor_version='mime-v1' AND e.status='complete'
            AND e.raw_sha256=? AND e.updated_at=? AND s.source_kind=? AND s.notify_events=?
            AND s.raw_state='present' AND s.raw_sha256 IS ?)
          ON CONFLICT(raw_key,configuration_sha256) DO UPDATE SET
            source_sha256=excluded.source_sha256,catalog_sha256=excluded.catalog_sha256,extraction_updated_at=excluded.extraction_updated_at,
            source_kind=excluded.source_kind,notify_events=excluded.notify_events,state=excluded.state,
            failure_code=excluded.failure_code,decision_json=excluded.decision_json,updated_at=excluded.updated_at`)
          .bind(
            source.raw_key,
            hash,
            source.raw_sha256,
            source.catalog_sha256,
            source.updated_at,
            source.source_kind,
            source.notify_events,
            failure ? "blocked" : "complete",
            failure,
            decision ? JSON.stringify(decision) : null,
            now,
            source.raw_key,
            source.raw_sha256,
            source.updated_at,
            source.source_kind,
            source.notify_events,
            source.catalog_sha256,
          )
          .run();
        if (write.meta.changes) {
          result.written++;
          if (failure) result.blocked++;
        }
      } catch {
        result.failed++;
      }
      // Advance even after an individual failure so a poison row cannot starve
      // later candidates. Uncommitted work remains eligible after the cursor wraps.
      // oxlint-disable-next-line no-await-in-loop -- Per-row fairness checkpoint for the bounded repair batch.
      await db
        .prepare(`INSERT INTO routing_shadow_scan(configuration_sha256,cursor,updated_at)
        VALUES (?,?,?) ON CONFLICT(configuration_sha256) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at`)
        .bind(hash, source.raw_key, Date.now())
        .run();
    }
    if (result.failed) result.status = "partial";
    return result;
  } catch {
    return { ...result, status: "unavailable" };
  }
}
