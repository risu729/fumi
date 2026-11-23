import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PROCESSING_REPAIR_LIMIT, repairProcessing } from "../src/processing-jobs.ts";
import { repairMailIdentity } from "../src/mail-identity.ts";
import { closeScan, FULL_SCAN_INTERVAL, openScan, requestFullScan } from "../src/scan-schedule.ts";

const t0 = Date.parse("2026-11-23T00:00:00.000Z");

async function catalogSource() {
  const id = crypto.randomUUID();
  const key = `ingest/2026-11-23/${id}/raw.eml`;
  // No R2 object: identity records it as blocked without reading any bytes.
  await env.MAIL_CATALOG.prepare(
    `INSERT INTO archive_sources(source_kind,source_namespace,external_id,raw_key,receipt_key,raw_state,receipt_state,raw_sha256,observed_pass,observed_revision)
    VALUES('email_routing','ingress-v1',?,?,?,'present','missing',?,0,0)`,
  )
    .bind(id, key, `${key}.receipt`, "a".repeat(64))
    .run();
  return key;
}

async function scanState(name: string) {
  return env.MAIL_CATALOG.prepare(
    "SELECT next_full_at,scanned_rowid,fingerprint FROM catalog_scans WHERE name=?",
  )
    .bind(name)
    .first();
}

beforeAll(async () => {
  await applyD1Migrations(env.MAIL_CATALOG, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await env.MAIL_CATALOG.exec(
    "DELETE FROM catalog_scans; DELETE FROM mail_identity; DELETE FROM processing_jobs; DELETE FROM archive_sources;",
  );
});

describe("scheduled scan cadence", () => {
  it("runs a full pass when due, and otherwise reads only sources added since", async () => {
    const empty = await openScan(env.MAIL_CATALOG, "processing_ledger", "v1", t0);
    expect(empty).toEqual({ full: true, after: 0, through: 0, due: null });
    await catalogSource();
    const first = await openScan(env.MAIL_CATALOG, "processing_ledger", "v1", t0);
    expect(first.full).toBe(true);
    await closeScan(env.MAIL_CATALOG, "processing_ledger", "v1", first, t0);
    expect(await scanState("processing_ledger")).toEqual({
      next_full_at: t0 + FULL_SCAN_INTERVAL,
      scanned_rowid: first.through,
      fingerprint: "v1",
    });
    await catalogSource();
    const next = await openScan(env.MAIL_CATALOG, "processing_ledger", "v1", t0 + 1);
    expect(next).toEqual({
      full: false,
      after: first.through,
      through: first.through + 1,
      due: t0 + FULL_SCAN_INTERVAL,
    });
    await closeScan(env.MAIL_CATALOG, "processing_ledger", "v1", next, t0 + 1);
    // An incremental pass moves the mark but keeps the full pass schedule.
    expect(await scanState("processing_ledger")).toMatchObject({
      next_full_at: t0 + FULL_SCAN_INTERVAL,
      scanned_rowid: first.through + 1,
    });
    expect(
      (await openScan(env.MAIL_CATALOG, "processing_ledger", "v1", t0 + FULL_SCAN_INTERVAL)).full,
    ).toBe(true);
    // A new version of the derived rows needs every source again.
    expect((await openScan(env.MAIL_CATALOG, "processing_ledger", "v2", t0 + 1)).full).toBe(true);
    // A rebuilt table with fewer rows than the mark cannot hide sources.
    await env.MAIL_CATALOG.prepare("UPDATE catalog_scans SET scanned_rowid=1000").run();
    expect((await openScan(env.MAIL_CATALOG, "processing_ledger", "v1", t0 + 1)).full).toBe(true);
  });

  it("finds new sources without a ledger row every run and old ones at the full pass", async () => {
    const workflow = { createBatch: vi.fn().mockRejectedValue(new Error("offline")), get: vi.fn() };
    const old = await catalogSource();
    expect(await repairProcessing(env.MAIL_CATALOG, workflow, t0, true)).toMatchObject({
      discovered: 1,
    });
    await env.MAIL_CATALOG.prepare("DELETE FROM processing_jobs WHERE raw_key=?").bind(old).run();
    expect(await repairProcessing(env.MAIL_CATALOG, workflow, t0 + 1, true)).toMatchObject({
      discovered: 0,
    });
    const fresh = await catalogSource();
    expect(await repairProcessing(env.MAIL_CATALOG, workflow, t0 + 2, true)).toMatchObject({
      discovered: 1,
    });
    expect(
      await env.MAIL_CATALOG.prepare("SELECT raw_key FROM processing_jobs").all(),
    ).toMatchObject({ results: [{ raw_key: fresh }] });
    expect(
      await repairProcessing(env.MAIL_CATALOG, workflow, t0 + FULL_SCAN_INTERVAL, true),
    ).toMatchObject({ discovered: 1 });
    // An operator repair always reads every source.
    await env.MAIL_CATALOG.prepare("DELETE FROM processing_jobs WHERE raw_key=?").bind(old).run();
    expect(await repairProcessing(env.MAIL_CATALOG, workflow, t0 + 3)).toMatchObject({
      discovered: 1,
    });
  });

  it("keeps the ledger window open while a run hits its limit", async () => {
    const workflow = { createBatch: vi.fn().mockRejectedValue(new Error("offline")), get: vi.fn() };
    for (let index = 0; index <= PROCESSING_REPAIR_LIMIT; index++)
      // oxlint-disable-next-line no-await-in-loop -- Synthetic rows in rowid order.
      await catalogSource();
    expect(await repairProcessing(env.MAIL_CATALOG, workflow, t0, true)).toMatchObject({
      discovered: PROCESSING_REPAIR_LIMIT,
    });
    expect(await scanState("processing_ledger")).toBeNull();
    expect(await repairProcessing(env.MAIL_CATALOG, workflow, t0 + 1, true)).toMatchObject({
      discovered: 1,
    });
    expect(await scanState("processing_ledger")).toMatchObject({
      next_full_at: t0 + 1 + FULL_SCAN_INTERVAL,
    });
  });

  it("keeps the identity window open after a deferred read", async () => {
    const key = await catalogSource();
    const failing = {
      MAIL_CATALOG: env.MAIL_CATALOG,
      MAIL_ARCHIVE: {
        get: async () => {
          throw new Error("synthetic outage");
        },
      } as unknown as R2Bucket,
    };
    expect(await repairMailIdentity(failing, 10, new Date(t0), true)).toMatchObject({
      deferred: 1,
    });
    expect(await scanState("mail_identity")).toBeNull();
    expect(await repairMailIdentity(env, 10, new Date(t0 + 1), true)).toMatchObject({
      blocked: 1,
    });
    expect(
      await env.MAIL_CATALOG.prepare("SELECT raw_key FROM mail_identity").first("raw_key"),
    ).toBe(key);
    expect(await scanState("mail_identity")).not.toBeNull();
  });

  it("ignores a late cheap pass that would move the mark backwards or across versions", async () => {
    await catalogSource();
    const full = await openScan(env.MAIL_CATALOG, "mail_identity", "v1", t0);
    await closeScan(env.MAIL_CATALOG, "mail_identity", "v1", full, t0);
    await catalogSource();
    await catalogSource();
    const cheap = await openScan(env.MAIL_CATALOG, "mail_identity", "v1", t0 + 1);
    await closeScan(env.MAIL_CATALOG, "mail_identity", "v1", cheap, t0 + 1);
    await closeScan(
      env.MAIL_CATALOG,
      "mail_identity",
      "v1",
      { full: false, after: full.through, through: full.through + 1 },
      t0 + 2,
    );
    await closeScan(
      env.MAIL_CATALOG,
      "mail_identity",
      "v0",
      { full: false, after: 0, through: cheap.through + 5 },
      t0 + 3,
    );
    expect(await scanState("mail_identity")).toMatchObject({
      scanned_rowid: cheap.through,
      fingerprint: "v1",
    });
  });

  it("keeps a full pass requested while another full pass runs", async () => {
    const first = await openScan(env.MAIL_CATALOG, "routing_dispatch", "1", t0);
    await closeScan(env.MAIL_CATALOG, "routing_dispatch", "1", first, t0);
    const running = await openScan(
      env.MAIL_CATALOG,
      "routing_dispatch",
      "1",
      t0 + FULL_SCAN_INTERVAL,
    );
    expect(running.full).toBe(true);
    await requestFullScan(env.MAIL_CATALOG, "routing_dispatch");
    await closeScan(env.MAIL_CATALOG, "routing_dispatch", "1", running, t0 + FULL_SCAN_INTERVAL);
    expect(await scanState("routing_dispatch")).toMatchObject({ next_full_at: -1 });
    // A pass that started because of a request does not cancel a later one either.
    const requested = await openScan(env.MAIL_CATALOG, "routing_dispatch", "1", t0 + 1);
    await requestFullScan(env.MAIL_CATALOG, "routing_dispatch");
    await closeScan(env.MAIL_CATALOG, "routing_dispatch", "1", requested, t0 + 1);
    expect(await scanState("routing_dispatch")).toMatchObject({ next_full_at: -2 });
    expect(
      (await openScan(env.MAIL_CATALOG, "routing_dispatch", "1", t0 + FULL_SCAN_INTERVAL + 1)).full,
    ).toBe(true);
  });

  it("keeps a full identity pass due until it comes back below its limit", async () => {
    const older = await catalogSource();
    await catalogSource();
    const run = (limit: number, now: number) => repairMailIdentity(env, limit, new Date(now), true);
    expect(await run(1, t0)).toMatchObject({ blocked: 1, more: true });
    expect(await scanState("mail_identity")).toBeNull();
    expect(await run(1, t0 + 1)).toMatchObject({ blocked: 1, more: true });
    expect(await run(1, t0 + 2)).toMatchObject({ blocked: 0, more: false });
    expect(await scanState("mail_identity")).toMatchObject({
      next_full_at: t0 + 2 + FULL_SCAN_INTERVAL,
    });
    await env.MAIL_CATALOG.prepare("DELETE FROM mail_identity WHERE raw_key=?").bind(older).run();
    expect(await run(10, t0 + 3)).toMatchObject({ blocked: 0 });
    await catalogSource();
    expect(await run(10, t0 + 4)).toMatchObject({ blocked: 1, more: false });
    expect(await run(10, t0 + 2 + FULL_SCAN_INTERVAL)).toMatchObject({ blocked: 1 });
    expect(
      (
        await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS count FROM mail_identity").first<{
          count: number;
        }>()
      )?.count,
    ).toBe(3);
  });
});
