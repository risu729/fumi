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
type Forward = { status: "forwarded" } | { status: "failed"; code: string; smtpStatus?: string };
/** A live ingress row with a retained receipt and, optionally, a current extraction. */
async function ingress(
  id: string,
  receivedAt: string,
  forward: Forward,
  messageId: string | null,
  extraction: "current" | "stale" | "none" = messageId === null ? "none" : "current",
) {
  const rawKey = `synthetic/forward/${id}`;
  const schemaVersion =
    forward.status === "failed" &&
    forward.code !== "forward_failed" &&
    forward.code !== "invalid_target"
      ? 3
      : 1;
  const snapshot = JSON.stringify({
    schemaVersion,
    ingestId: id,
    receivedAt,
    envelope: { from: "synthetic@example.invalid", to: "archive@example.invalid" },
    reportedRawSize: 100,
    archive: { status: "stored", key: rawKey, size: 100, sha256: "a".repeat(64) },
    forward,
  });
  await env.MAIL_CATALOG.prepare(`INSERT INTO archive_sources(source_kind,source_namespace,external_id,raw_key,receipt_key,
    received_at,receipt_snapshot,forward_status,raw_state,receipt_state,raw_size,raw_sha256,observed_pass,observed_revision)
    VALUES('email_routing','ingress-v1',?,?,?,?,?,?,'present','valid',100,?,0,0)`)
    .bind(id, rawKey, `${rawKey}.receipt`, receivedAt, snapshot, forward.status, "a".repeat(64))
    .run();
  if (extraction !== "none")
    await env.MAIL_CATALOG.prepare(`INSERT INTO mail_extractions(raw_key,extractor_version,raw_sha256,raw_size,instance_id,status,metadata_json,attachments_json,body_json_key,manifest_key,updated_at)
      VALUES(?,'mime-v1',?,100,?,'complete',?,'[]','synthetic/body','synthetic/manifest',0)`)
      .bind(
        rawKey,
        (extraction === "current" ? "a" : "b").repeat(64),
        rawKey,
        JSON.stringify({ subject: "Synthetic", messageId }),
      )
      .run();
}
function forwardFailures(result: Awaited<ReturnType<typeof getMailHealth>>) {
  const section = result.sections.forward_failures;
  expect(section.status).toBe("observed");
  if (section.status !== "observed") throw new Error("Missing synthetic evidence");
  return section;
}
beforeAll(async () => applyD1Migrations(env.MAIL_CATALOG, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.MAIL_CATALOG.exec(
    "DELETE FROM gmail_import_items; DELETE FROM gmail_imports; DELETE FROM processing_jobs; DELETE FROM mail_extractions; DELETE FROM archive_sources; UPDATE archive_scan SET cursor=NULL,revision=0,pass=0 WHERE id=1;",
  );
});

describe("bounded read-only archival health evidence", () => {
  it("counts v2 skipped forwarding separately from failures and unknown snapshots", async () => {
    await source(
      "standalone",
      "missing",
      JSON.stringify({
        ...JSON.parse(failedReceipt("standalone")),
        schemaVersion: 2,
        forward: { status: "skipped", reason: "archive_only" },
      }),
    );
    await env.MAIL_CATALOG.prepare(
      "UPDATE archive_sources SET forward_status='skipped' WHERE external_id='standalone'",
    ).run();
    const result = await getMailHealth(env, reader, now);
    expect(counts(result.sections.catalog)).toMatchObject({
      known_ingress_snapshots: 1,
      receipt_forward_skipped: 1,
      receipt_forward_failures: 0,
      receipt_archive_failures: 1,
      ingress_snapshot_unknown: 0,
      missing: 1,
    });
    expect(result.archive_completeness).toBe("unknown");
  });
  it("counts v3 classified forward failures as known failures", async () => {
    await source(
      "classified",
      "present",
      JSON.stringify({
        ...JSON.parse(failedReceipt("classified")),
        schemaVersion: 3,
        forward: { status: "failed", code: "rejected_permanent", smtpStatus: "5.7.1" },
      }),
    );
    await source(
      "v3-forwarded",
      "present",
      JSON.stringify({
        ...JSON.parse(failedReceipt("v3-forwarded")),
        schemaVersion: 3,
        forward: { status: "forwarded" },
      }),
    );
    await env.MAIL_CATALOG.prepare(
      "UPDATE archive_sources SET forward_status='forwarded' WHERE external_id='v3-forwarded'",
    ).run();
    const result = await getMailHealth(env, reader, now);
    expect(counts(result.sections.catalog)).toMatchObject({
      known_ingress_snapshots: 1,
      receipt_forward_failures: 1,
      ingress_snapshot_unknown: 1,
    });
  });
  it("lists failed forwards newest first with codes and retry recovery by Message-ID", async () => {
    const at = (time: string) => `2026-11-21T${time}:00.000Z`;
    // A legacy failure that a later retry with the same Message-ID forwarded.
    await ingress(
      "legacy",
      at("00:00"),
      { status: "failed", code: "forward_failed" },
      "<a@example.invalid>",
    );
    await ingress("retry", at("00:05"), { status: "forwarded" }, "<a@example.invalid>");
    // Every attempt of one Message-ID failed.
    await Promise.all(
      ["01:00", "01:05", "01:10"].map((time, index) =>
        ingress(
          `rejected-${index}`,
          at(time),
          { status: "failed", code: "rejected_permanent", smtpStatus: "5.7.1" },
          "<b@example.invalid>",
        ),
      ),
    );
    // A forwarded copy received before the failure is not a recovery.
    await ingress("earlier", at("01:59"), { status: "forwarded" }, "<c@example.invalid>");
    await ingress(
      "after-copy",
      at("02:00"),
      { status: "failed", code: "timeout" },
      "<c@example.invalid>",
    );
    // A later failed attempt is not a recovery either; no or stale extraction is unknown.
    await ingress(
      "no-extraction",
      at("03:00"),
      { status: "failed", code: "rejected_temporary", smtpStatus: "4.7.0" },
      null,
    );
    await ingress(
      "stale",
      at("04:00"),
      { status: "failed", code: "invalid_target" },
      "<d@example.invalid>",
      "stale",
    );
    await ingress("stale-retry", at("04:05"), { status: "forwarded" }, "<d@example.invalid>");
    const result = await getMailHealth(env, reader, now);
    const section = forwardFailures(result);
    expect(section.counts).toEqual({
      receipt_forward_failures: 7,
      receipt_forward_failures_recovered: 1,
      receipt_forward_failures_unrecovered: 4,
      receipt_forward_failures_recovery_unknown: 2,
    });
    expect(section.failed_forwards).toEqual([
      {
        id: "mail_stale",
        received_at: at("04:00"),
        code: "invalid_target",
        smtp_status: null,
        recovery: "unknown",
        recovered_by: null,
      },
      {
        id: "mail_no-extraction",
        received_at: at("03:00"),
        code: "rejected_temporary",
        smtp_status: "4.7.0",
        recovery: "unknown",
        recovered_by: null,
      },
      {
        id: "mail_after-copy",
        received_at: at("02:00"),
        code: "timeout",
        smtp_status: null,
        recovery: "unrecovered",
        recovered_by: null,
      },
      ...[2, 1, 0].map((index) => ({
        id: `mail_rejected-${index}`,
        received_at: at(["01:00", "01:05", "01:10"][index]!),
        code: "rejected_permanent",
        smtp_status: "5.7.1",
        recovery: "unrecovered",
        recovered_by: null,
      })),
      {
        id: "mail_legacy",
        received_at: at("00:00"),
        code: "forward_failed",
        smtp_status: null,
        recovery: "recovered",
        recovered_by: "mail_retry",
      },
    ]);
    expect(section.failed_forwards_truncated).toBe(false);
    expect(counts(result.sections.catalog)["receipt_forward_failures"]).toBe(7);
    const text = JSON.stringify(result);
    for (const secret of ["@example.invalid", "synthetic/forward/", "Synthetic"])
      expect(text).not.toContain(secret);
  });
  it("caps the failed forward list and reports zero failures as an empty observation", async () => {
    let result = await getMailHealth(env, reader, now);
    expect(forwardFailures(result)).toMatchObject({
      counts: { receipt_forward_failures: 0, receipt_forward_failures_unrecovered: 0 },
      failed_forwards: [],
      failed_forwards_truncated: false,
    });
    await Promise.all(
      Array.from({ length: 21 }, (_, index) => index.toString().padStart(2, "0")).map((index) =>
        ingress(
          `capped-${index}`,
          `2026-11-21T00:${index}:00.000Z`,
          { status: "failed", code: "forward_failed" },
          `<capped-${index}@example.invalid>`,
        ),
      ),
    );
    result = await getMailHealth(env, reader, now);
    const section = forwardFailures(result);
    expect(section.counts).toMatchObject({
      receipt_forward_failures: 21,
      receipt_forward_failures_unrecovered: 21,
    });
    expect(section.failed_forwards).toHaveLength(20);
    expect(section.failed_forwards[0]?.id).toBe("mail_capped-20");
    expect(section.failed_forwards.at(-1)?.id).toBe("mail_capped-01");
    expect(section.failed_forwards_truncated).toBe(true);
  });
  it("makes the failed forward list unknown when a row breaks the closed output shape", async () => {
    await ingress(
      "bad id",
      "2026-11-21T00:00:00.000Z",
      { status: "failed", code: "forward_failed" },
      null,
    );
    const result = await getMailHealth(env, reader, now);
    expect(result.sections.forward_failures).toEqual({
      status: "unknown",
      reason: "invalid_catalog_evidence",
    });
    expect(JSON.stringify(result)).not.toContain("bad id");
  });
  it("makes the failed forward list unknown when a v3 snapshot has an invalid SMTP status", async () => {
    await ingress(
      "bad-status",
      "2026-11-21T00:00:00.000Z",
      { status: "failed", code: "rejected_permanent", smtpStatus: "2.0.0" },
      null,
    );
    const result = await getMailHealth(env, reader, now);
    expect(counts(result.sections.catalog)["receipt_forward_failures"]).toBe(1);
    expect(result.sections.forward_failures).toEqual({
      status: "unknown",
      reason: "invalid_catalog_evidence",
    });
    expect(JSON.stringify(result)).not.toContain("2.0.0");
  });
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
    expect(result.sections.forward_failures).toEqual({
      status: "unknown",
      reason: "schema_missing",
    });
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
