import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  await applyD1Migrations(
    env.MAIL_CATALOG,
    env.TEST_MIGRATIONS.filter((m) => m.name < "0026"),
  );
});

const indexes = async (db: D1Database) =>
  (
    await db
      .prepare(
        "SELECT name,sql FROM sqlite_schema WHERE type='index' AND tbl_name='archive_sources' AND sql IS NOT NULL ORDER BY name",
      )
      .all<{ name: string; sql: string }>()
  ).results;

describe("mailbox export source migration", () => {
  it("keeps sources, sparse rowids, indexes and both cascading routing tables", async () => {
    const db = env.MAIL_CATALOG;
    await db
      .prepare(`INSERT INTO archive_sources (
      rowid,source_kind,source_namespace,external_id,raw_key,receipt_key,received_at,
      receipt_snapshot,forward_status,raw_state,receipt_state,raw_size,raw_sha256,
      observed_pass,observed_revision,notify_events
    ) VALUES (9,'email_routing','ingress-v1','live','synthetic/live/raw.eml',
      'synthetic/live/receipt.json','2026-11-12T00:00:00.000Z','{}','skipped',
      'present','valid',123,?,4,19,1)`)
      .bind("a".repeat(64))
      .run();
    await db
      .prepare(`INSERT INTO archive_sources (
      rowid,source_kind,source_namespace,external_id,raw_key,receipt_key,received_at,
      raw_state,receipt_state,raw_size,raw_sha256,observed_pass,observed_revision
    ) VALUES (512,'gmail','synthetic-account','imported','synthetic/import/raw.eml',
      'synthetic/import/receipt.json','2026-11-13T00:00:00.000Z','present','valid',45,?,5,20)`)
      .bind("c".repeat(64))
      .run();
    await db
      .prepare(`INSERT INTO routing_classifications VALUES (
      'synthetic/live/raw.eml',?,?, 'synthetic/manifest','held',3,'synthetic-lease',42,43,
      '{"synthetic":"result"}','synthetic_failure',44)`)
      .bind("b".repeat(64), "a".repeat(64))
      .run();
    await db
      .prepare(`INSERT INTO routing_context VALUES (
      'synthetic/live/raw.eml',?,2,'synthetic-thread','case','waiting',1,1,45)`)
      .bind("a".repeat(64))
      .run();
    const tables = ["archive_sources", "routing_classifications", "routing_context"];
    const snapshot = async () =>
      Promise.all(
        tables.map(
          async (table) =>
            (await db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all()).results,
        ),
      );
    const before = await snapshot();
    const indexesBefore = await indexes(db);
    expect(indexesBefore.map((index) => index.name)).toEqual([
      "archive_sources_external_id",
      "archive_sources_raw_sha256",
      "archive_sources_search_kind_order",
      "archive_sources_search_order",
    ]);
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0026_"));
    if (!migration) throw new Error("Mailbox export migration fixture missing");
    await applyD1Migrations(db, [migration]);

    expect(await snapshot()).toEqual(before);
    // Same names and the same expressions, so INDEXED BY in src/mail-read.ts still applies.
    const normalize = (sql: string) => sql.replace(/\s+/g, " ").replace(/\( /g, "(");
    expect((await indexes(db)).map((index) => ({ ...index, sql: normalize(index.sql) }))).toEqual(
      indexesBefore.map((index) => ({ ...index, sql: normalize(index.sql) })),
    );
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect(
      (
        await db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name LIKE 'mailbox_export_%' OR name LIKE 'archive_sources_mailbox%'",
          )
          .all()
      ).results,
    ).toEqual([]);

    await db
      .prepare(`INSERT INTO archive_sources (
      source_kind,source_namespace,external_id,raw_key,receipt_key,received_at,
      raw_state,receipt_state,raw_size,raw_sha256,observed_pass,observed_revision
    ) VALUES ('mailbox_export','outlook-synthetic','pst-item','synthetic/pst/raw.eml',
      'synthetic/pst/receipt.json','2026-01-02T03:04:05.678Z','present','valid',67,?,6,21)`)
      .bind("d".repeat(64))
      .run();
    expect(
      await db
        .prepare("SELECT rowid FROM archive_sources WHERE external_id='pst-item'")
        .first("rowid"),
    ).toBe(513);
    // A mailbox export never acquires forwarding or notification evidence.
    for (const change of ["forward_status='skipped',receipt_snapshot='{}'", "notify_events=1"])
      // oxlint-disable-next-line no-await-in-loop -- Each refused update is checked alone.
      await expect(
        db.prepare(`UPDATE archive_sources SET ${change} WHERE source_kind='mailbox_export'`).run(),
      ).rejects.toThrow();
    await expect(
      db.prepare("UPDATE archive_sources SET source_kind='other' WHERE rowid=513").run(),
    ).rejects.toThrow();

    await db.prepare("DELETE FROM archive_sources WHERE external_id='live'").run();
    expect((await db.prepare("SELECT * FROM routing_context").all()).results).toEqual([]);
    expect((await db.prepare("SELECT * FROM routing_classifications").all()).results).toEqual([]);
  });
});
