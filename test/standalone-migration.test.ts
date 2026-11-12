import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  await applyD1Migrations(
    env.MAIL_CATALOG,
    env.TEST_MIGRATIONS.filter((m) => m.name < "0014"),
  );
});

describe("standalone ingress migration", () => {
  it("preserves sources, sparse cursors and both cascading routing tables", async () => {
    const db = env.MAIL_CATALOG;
    await db
      .prepare(`INSERT INTO archive_sources (
      rowid,source_kind,source_namespace,external_id,raw_key,receipt_key,received_at,
      receipt_snapshot,forward_status,raw_state,receipt_state,raw_size,raw_sha256,
      observed_pass,observed_revision,notify_events
    ) VALUES (7,'email_routing','ingress-v1','live','synthetic/live/raw.eml',
      'synthetic/live/receipt.json','2026-11-12T00:00:00.000Z','{}','forwarded',
      'present','valid',123,?,4,19,1)`)
      .bind("a".repeat(64))
      .run();
    await db
      .prepare(`INSERT INTO archive_sources (
      rowid,source_kind,source_namespace,external_id,raw_key,receipt_key,
      raw_state,receipt_state,observed_pass,observed_revision
    ) VALUES (400,'gmail','synthetic-account','imported','synthetic/import/raw.eml',
      'synthetic/import/receipt.json','missing','missing',5,20)`)
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
    await db
      .prepare("UPDATE archive_scan SET cursor='synthetic-cursor',revision=21,pass=6 WHERE id=1")
      .run();
    const tables = [
      "archive_sources",
      "routing_classifications",
      "routing_context",
      "archive_scan",
    ];
    const snapshots = await Promise.all(
      tables.map((table) => db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all()),
    );
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0014_"));
    if (!migration) throw new Error("Standalone migration fixture missing");
    await applyD1Migrations(db, [migration]);
    expect(
      await Promise.all(
        tables.map(
          async (table) =>
            (await db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all()).results,
        ),
      ),
    ).toEqual(snapshots.map((snapshot) => snapshot.results));
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect(
      (
        await db.prepare("PRAGMA index_list('archive_sources')").all<{ name: string }>()
      ).results.map((index) => index.name),
    ).toContain("archive_sources_raw_sha256");
    await db
      .prepare(`INSERT INTO archive_sources (
      source_kind,source_namespace,external_id,raw_key,receipt_key,receipt_snapshot,
      forward_status,raw_state,receipt_state,observed_pass,observed_revision
    ) VALUES ('email_routing','ingress-v1','standalone','synthetic/new/raw.eml',
      'synthetic/new/receipt.json','{}','skipped','present','valid',6,22)`)
      .run();
    expect(
      await db
        .prepare("SELECT rowid FROM archive_sources WHERE external_id='standalone'")
        .first("rowid"),
    ).toBe(401);
    // Gmail sources must never acquire live forwarding or notification evidence.
    await expect(
      db
        .prepare(
          "UPDATE archive_sources SET forward_status='skipped',receipt_snapshot='{}' WHERE source_kind='gmail'",
        )
        .run(),
    ).rejects.toThrow();
    await db.prepare("DELETE FROM archive_sources WHERE external_id='live'").run();
    expect((await db.prepare("SELECT * FROM routing_context").all()).results).toEqual([]);
    expect((await db.prepare("SELECT * FROM routing_classifications").all()).results).toEqual([]);
  });
});
