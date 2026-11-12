import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getMailHealth } from "../src/mail-health.ts";
import type { MailPrincipal } from "../src/principal.ts";

const reader: MailPrincipal = { id: "synthetic-reader", scopes: ["mail:read"], fromAddresses: [] };
const now = Date.parse("2026-11-12T00:00:00.000Z");
type Section = Awaited<ReturnType<typeof getMailHealth>>["sections"]["catalog"];
function counts(section: Section) {
  expect(section.status).toBe("observed");
  if (section.status !== "observed") throw new Error("Missing synthetic evidence");
  return section.counts;
}
async function source(
  id: string,
  rawState = "present",
  snapshot: string | null = null,
  receiptState = snapshot ? "valid" : "missing",
  kind = "email_routing",
) {
  const rawKey = `synthetic/health/${id}`;
  await env.MAIL_CATALOG.prepare(`INSERT INTO archive_sources(source_kind,source_namespace,external_id,raw_key,receipt_key,
    received_at,receipt_snapshot,forward_status,raw_state,receipt_state,raw_size,raw_sha256,observed_pass,observed_revision)
    VALUES(?,?,?,?,?,'2026-11-12T00:00:00.000Z',?,?,?,?,100,?,0,0)`)
    .bind(
      kind,
      kind === "gmail" ? "synthetic-account" : "ingress-v1",
      id,
      rawKey,
      `${rawKey}.receipt`,
      snapshot,
      snapshot ? "failed" : null,
      rawState,
      receiptState,
      "a".repeat(64),
    )
    .run();
  return rawKey;
}
const failedReceipt = (id: string) =>
  JSON.stringify({
    schemaVersion: 1,
    ingestId: id,
    receivedAt: "2026-11-12T00:00:00.000Z",
    envelope: { from: "synthetic@example.invalid", to: "archive@example.invalid" },
    reportedRawSize: 100,
    archive: { status: "failed", code: "capture_timeout" },
    forward: { status: "failed", code: "forward_failed" },
  });
beforeAll(async () => applyD1Migrations(env.MAIL_CATALOG, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.MAIL_CATALOG.exec(
    "DELETE FROM gmail_import_items; DELETE FROM gmail_imports; DELETE FROM processing_jobs; DELETE FROM mail_extractions; DELETE FROM archive_sources; UPDATE archive_scan SET cursor=NULL,revision=0,pass=0 WHERE id=1;",
  );
});

describe("bounded read-only archival health evidence", () => {
  it("requires mail:read before inspecting catalog state", async () => {
    const prepare = vi.fn();
    await expect(
      getMailHealth({ MAIL_CATALOG: { prepare } }, { ...reader, scopes: [] }, now),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(prepare).not.toHaveBeenCalled();
  });
  it("never interprets an empty catalog or zero failures as a complete archive", async () => {
    const result = await getMailHealth(env, reader, now);
    expect(counts(result.sections.catalog)).toMatchObject({
      stored: 0,
      missing: 0,
      unknown: 0,
      receipt_archive_failures: 0,
      receipt_forward_failures: 0,
    });
    expect(result.archive_completeness).toBe("unknown");
    expect(result.coverage).toMatchObject({
      r2_live_objects_verified: false,
      unseen_ingress_count: null,
      mailbox_total: null,
      zero_failures_proves_complete: false,
    });
    expect(counts(result.sections.archive_scan)["completed_listing_passes"]).toBe(0);
  });
  it("distinguishes observed originals, retained ingress failures and unknown malformed receipt evidence", async () => {
    await source("stored");
    await source("failed", "missing", failedReceipt("failed"), "missing");
    await source("malformed", "invalid", "{", "invalid");
    const result = await getMailHealth(env, reader, now);
    expect(counts(result.sections.catalog)).toMatchObject({
      stored: 1,
      missing: 1,
      unknown: 1,
      known_ingress_snapshots: 1,
      receipt_archive_failures: 1,
      receipt_forward_failures: 1,
      ingress_snapshot_unknown: 2,
      current_receipt_missing: 2,
      current_receipt_invalid: 1,
    });
    expect(JSON.stringify(result)).not.toContain("synthetic@example.invalid");
    expect(JSON.stringify(result)).not.toContain("synthetic/health/");
  });
  it("reports current MIME coverage separately from pipeline job outcomes", async () => {
    const current = await source("complete"),
      blocked = await source("blocked"),
      stale = await source("stale");
    await source("pending");
    await env.MAIL_CATALOG.batch(
      [current, stale].map((rawKey, index) =>
        env.MAIL_CATALOG.prepare(`INSERT INTO mail_extractions(raw_key,extractor_version,raw_sha256,raw_size,instance_id,status,metadata_json,attachments_json,body_json_key,manifest_key,updated_at)
      VALUES(?,'mime-v1',?,100,?,'complete','{}','[]','synthetic/body','synthetic/manifest',0)`).bind(
          rawKey,
          (index ? "b" : "a").repeat(64),
          rawKey,
        ),
      ),
    );
    await env.MAIL_CATALOG.prepare(
      "INSERT INTO mail_extractions(raw_key,extractor_version,instance_id,status,failure_code,updated_at) VALUES(?,'mime-v1',?,'blocked','invalid_mime',0)",
    )
      .bind(blocked, blocked)
      .run();
    await env.MAIL_CATALOG.batch(
      ["pending", "running", "complete", "failed"].map((state, index) =>
        env.MAIL_CATALOG.prepare(`INSERT INTO processing_jobs(raw_key,pipeline_version,instance_id,state,created_at,updated_at,next_check_at,completed_at)
      VALUES(?,'mime-v1',?,?,0,0,0,?)`).bind(
          `synthetic/job/${index}`,
          `synthetic-instance-${index}`,
          state,
          state === "complete" ? 0 : null,
        ),
      ),
    );
    const result = await getMailHealth(env, reader, now);
    expect(counts(result.sections.mime)).toEqual({
      current_complete: 1,
      blocked: 1,
      pending: 1,
      unknown: 1,
    });
    expect(counts(result.sections.processing)).toEqual({
      pending: 1,
      running: 1,
      complete: 1,
      failed: 1,
    });
  });
  it("distinguishes completed import scopes, checkpoints and overlapping durable memberships", async () => {
    const first = await source("gmail-one", "present", null, "valid", "gmail"),
      second = await source("gmail-two", "missing", null, "valid", "gmail");
    await env.MAIL_CATALOG.prepare(`INSERT INTO gmail_imports(import_id,account_namespace,scope_json,complete,imported_count,pending_json,lease_until)
      VALUES('completed','synthetic-account','{}',1,2,NULL,0),('pending','synthetic-account','{}',0,0,'["synthetic-id"]',?)`)
      .bind(now + 1000)
      .run();
    await env.MAIL_CATALOG.prepare(
      "INSERT INTO gmail_import_items(import_id,message_id,raw_key) VALUES('completed','one',?),('completed','two',?),('pending','one',?)",
    )
      .bind(first, second, first)
      .run();
    const result = await getMailHealth(env, reader, now);
    expect(counts(result.sections.gmail_imports)).toEqual({
      completed_scopes: 1,
      pending_scopes: 1,
      checkpointed_memberships: 2,
      staged_pages: 1,
      active_leases: 1,
    });
    expect(counts(result.sections.gmail_memberships)).toEqual({
      recorded_memberships: 3,
      catalog_original_present: 2,
      original_missing_or_unknown: 1,
    });
    expect(counts(result.sections.catalog)["gmail_sources"]).toBe(2);
    expect(result.coverage.mailbox_total).toBeNull();
  });
  it("caps rows and makes older out-of-window failures explicit rather than reporting complete", async () => {
    await env.MAIL_CATALOG.prepare(`WITH RECURSIVE fixture(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM fixture WHERE n<1001)
      INSERT INTO archive_sources(source_kind,source_namespace,external_id,raw_key,receipt_key,raw_state,receipt_state,observed_pass,observed_revision)
      SELECT 'email_routing','ingress-v1','bounded-'||n,'synthetic/bounded/'||n,'synthetic/bounded/'||n||'.receipt',CASE WHEN n=1 THEN 'missing' ELSE 'present' END,'missing',0,0 FROM fixture ORDER BY n`).run();
    const result = await getMailHealth(env, reader, now);
    expect(result.sections.catalog).toMatchObject({
      window: { records: 1000, limit: 1000, truncated: true },
    });
    expect(counts(result.sections.catalog)).toMatchObject({ stored: 1000, missing: 0 });
    expect(result.status).toBe("partial_observations");
    expect(result.archive_completeness).toBe("unknown");
  });
  it("treats missing optional schema as unknown and issues only fixed read queries", async () => {
    const statements: string[] = [];
    const prepare = (sql: string) => {
      statements.push(sql);
      if (sql.startsWith("SELECT name FROM sqlite_master"))
        return {
          bind: () => ({
            all: async () => ({ results: [{ name: "archive_sources" }, { name: "archive_scan" }] }),
          }),
        } as unknown as D1PreparedStatement;
      return env.MAIL_CATALOG.prepare(sql);
    };
    const result = await getMailHealth({ MAIL_CATALOG: { prepare } }, reader, now);
    expect(result.sections.mime).toEqual({ status: "unknown", reason: "schema_missing" });
    expect(result.sections.processing).toEqual({ status: "unknown", reason: "schema_missing" });
    expect(result.sections.gmail_imports).toEqual({ status: "unknown", reason: "schema_missing" });
    expect(result.status).toBe("partial_observations");
    expect(statements).toHaveLength(3);
    expect(statements.every((sql) => /^(SELECT|WITH)\b/.test(sql))).toBe(true);
  });
  it("returns unknown after one whole-call deadline without exposing database errors", async () => {
    const prepare = vi.fn(
      () =>
        ({
          bind: () => ({ all: () => new Promise(() => undefined) }),
        }) as unknown as D1PreparedStatement,
    );
    vi.useFakeTimers();
    try {
      const pending = getMailHealth({ MAIL_CATALOG: { prepare } }, reader, now);
      await vi.advanceTimersByTimeAsync(5001);
      const result = await pending;
      expect(Object.values(result.sections).every((section) => section.status === "unknown")).toBe(
        true,
      );
      expect(result.archive_completeness).toBe("unknown");
      expect(prepare).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
