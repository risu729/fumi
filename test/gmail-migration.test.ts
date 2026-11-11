import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  await applyD1Migrations(
    env.MAIL_CATALOG,
    env.TEST_MIGRATIONS.filter((m) => m.name < "0008"),
  );
});

describe("Gmail catalog migration on existing sources", () => {
  it("preserves sparse cursor rowids, every source field, notifications and scan state", async () => {
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='gmail_messages'",
      ).first(),
    ).toBeNull();
    await env.MAIL_CATALOG.prepare(`INSERT INTO archive_sources (
      rowid,source_kind,source_namespace,external_id,raw_key,receipt_key,received_at,
      receipt_snapshot,forward_status,raw_state,receipt_state,raw_size,raw_sha256,
      observed_pass,observed_revision,notify_events
    ) VALUES (7,'email_routing','ingress-v1','synthetic-live','synthetic/live/raw.eml',
      'synthetic/live/receipt.json','2026-11-11T00:00:00.000Z',?,'forwarded',
      'present','valid',123,?,4,19,1)`)
      .bind(JSON.stringify({ synthetic: "immutable receipt evidence" }), "a".repeat(64))
      .run();
    await env.MAIL_CATALOG.prepare(`INSERT INTO archive_sources (
      rowid,source_kind,source_namespace,external_id,raw_key,receipt_key,received_at,
      receipt_snapshot,forward_status,raw_state,receipt_state,raw_size,raw_sha256,
      observed_pass,observed_revision,notify_events
    ) VALUES (400,'email_routing','ingress-v1','synthetic-orphan','synthetic/orphan/raw.eml',
      'synthetic/orphan/receipt.json',NULL,NULL,NULL,'missing','missing',NULL,NULL,5,20,0)`).run();
    await env.MAIL_CATALOG.prepare(
      "UPDATE archive_scan SET cursor='synthetic-cursor',revision=21,pass=6 WHERE id=1",
    ).run();
    const before = (
      await env.MAIL_CATALOG.prepare("SELECT rowid,* FROM archive_sources ORDER BY rowid").all()
    ).results;
    const checkpoint = await env.MAIL_CATALOG.prepare("SELECT * FROM archive_scan").first();
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0008_"));
    if (!migration) throw new Error("Gmail migration fixture missing");
    await applyD1Migrations(env.MAIL_CATALOG, [migration]);
    expect(
      (await env.MAIL_CATALOG.prepare("SELECT rowid,* FROM archive_sources ORDER BY rowid").all())
        .results,
    ).toEqual(before);
    expect(await env.MAIL_CATALOG.prepare("SELECT * FROM archive_scan").first()).toEqual(
      checkpoint,
    );
    const indexes = await env.MAIL_CATALOG.prepare("PRAGMA index_list('archive_sources')").all<{
      name: string;
    }>();
    expect(indexes.results.map((i) => i.name)).toContain("archive_sources_raw_sha256");
    await env.MAIL_CATALOG.prepare(`INSERT INTO archive_sources
      (source_kind,source_namespace,external_id,raw_key,receipt_key,raw_state,receipt_state,observed_pass,observed_revision)
      VALUES ('email_routing','ingress-v1','synthetic-new','synthetic/new/raw.eml',
      'synthetic/new/receipt.json','present','missing',6,22)`).run();
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT rowid FROM archive_sources WHERE external_id='synthetic-new'",
      ).first("rowid"),
    ).toBe(401);
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT COUNT(*) AS n FROM archive_sources WHERE rowid<=400",
      ).first("n"),
    ).toBe(2);
    expect(
      await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS n FROM gmail_messages").first("n"),
    ).toBe(0);
  });
});
