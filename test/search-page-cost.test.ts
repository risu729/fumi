import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { searchMail, type MailReadEnvironment, type SearchArgs } from "../src/mail-read.ts";
import type { MailPrincipal } from "../src/principal.ts";

const principal: MailPrincipal = {
  id: "synthetic-reader",
  scopes: ["mail:read"],
  fromAddresses: [],
};
const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);

/** One synthetic original: its catalog, extraction, Gmail and identity rows. */
interface Original {
  kind: "email_routing" | "gmail";
  namespace: string;
  id: string;
  receivedAt: string | null;
  from: string;
  subject: string;
  labels: string[];
  attachments: number;
  /**
   * The identity row: a complete row of this group, one for another SHA-256, a blocked
   * one, a complete identity-v1 row (not current, so the original stands alone), or none.
   */
  group?: string;
  identity?: "complete" | "stale" | "blocked" | "previous";
}

async function insertOriginals(originals: Original[]) {
  if (!originals.length) return;
  const rows = JSON.stringify(originals);
  await env.MAIL_CATALOG.batch([
    env.MAIL_CATALOG.prepare(
      `INSERT INTO archive_sources (source_kind,source_namespace,external_id,raw_key,receipt_key,received_at,raw_state,receipt_state,raw_size,raw_sha256,observed_pass,observed_revision)
       SELECT value->>'kind',value->>'namespace',value->>'id','synthetic/'||(value->>'id'),'synthetic/'||(value->>'id')||'.receipt',
       value->>'receivedAt','present','missing',1,?,0,0 FROM json_each(?) ORDER BY key`,
    ).bind(SHA, rows),
    env.MAIL_CATALOG.prepare(
      `INSERT INTO gmail_messages (raw_key,account_namespace,message_id,thread_id,internal_date,label_ids_json,imported_at)
       SELECT 'synthetic/'||(value->>'id'),value->>'namespace',value->>'id','t'||(value->>'id'),'0',value->'labels','2026-01-01T00:00:00.000Z'
       FROM json_each(?) WHERE value->>'kind'='gmail' ORDER BY key`,
    ).bind(rows),
    env.MAIL_CATALOG.prepare(
      `INSERT INTO mail_extractions (raw_key,extractor_version,raw_sha256,raw_size,instance_id,status,metadata_json,attachments_json,attachment_count,body_json_key,manifest_key,updated_at)
       SELECT 'synthetic/'||(value->>'id'),'mime-v1',?,1,value->>'id','complete',
       json_object('subject',value->>'subject','from',json_object('address',value->>'from'),'to',json_array(json_object('address','owner@example.invalid'))),
       '[]',value->>'attachments','synthetic/body/'||(value->>'id'),'synthetic/manifest/'||(value->>'id'),0
       FROM json_each(?) ORDER BY key`,
    ).bind(SHA, rows),
  ]);
}
/** Identity rows are written in their own order, as the scheduled backfill does. */
async function insertIdentities(originals: Original[]) {
  const rows = JSON.stringify(originals.filter((original) => original.identity));
  await env.MAIL_CATALOG.prepare(
    `INSERT INTO mail_identity (raw_key,identity_version,raw_sha256,status,failure_code,group_id,group_rule,indexed_at)
     SELECT 'synthetic/'||(value->>'id'),CASE value->>'identity' WHEN 'previous' THEN 'identity-v1' ELSE 'identity-v2' END,CASE value->>'identity' WHEN 'stale' THEN ? ELSE ? END,
     CASE value->>'identity' WHEN 'blocked' THEN 'blocked' ELSE 'complete' END,
     CASE value->>'identity' WHEN 'blocked' THEN 'source_missing' END,
     CASE value->>'identity' WHEN 'blocked' THEN NULL ELSE value->>'group' END,
     CASE value->>'identity' WHEN 'blocked' THEN NULL ELSE 'message_id_dkim' END,
     '2026-01-01T00:00:00.000Z' FROM json_each(?) ORDER BY key`,
  )
    .bind(OTHER_SHA, SHA, rows)
    .run();
}

/** A small deterministic generator, so a failing seed can be replayed. */
function generator(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    int: (below: number) => Math.floor(next() * below),
    pick: <T>(values: readonly T[]) => values[Math.floor(next() * values.length)]!,
  };
}
type Random = ReturnType<typeof generator>;
let serial = 0;
const BASE = Date.parse("2020-01-01T00:00:00.000Z");
const iso = (milliseconds: number) => new Date(milliseconds).toISOString();
const SENDERS = ["alpha@example.invalid", "beta@example.invalid", "gamma@example.invalid"];
const LABEL_SETS = [["INBOX"], ["INBOX", "Label_1"], ["SENT"], ["Label_1"], []];

/**
 * Messages with one to four copies each: a live capture and Gmail copies in several
 * accounts, a few seconds to a day apart in either direction, so a representative can be
 * newer or older than the other copies and copies of one group straddle page boundaries.
 * `start` is the newest message time; messages go back `step` apart.
 */
function archiveMessages(
  random: Random,
  count: number,
  options: { start: number; step: number; copyRate: number; spread: number; copies?: number },
) {
  const originals: Original[] = [];
  for (let message = 0; message < count; message++) {
    serial++;
    const time = options.start - message * options.step;
    const copies = random.next() < options.copyRate ? 2 + random.int((options.copies ?? 4) - 1) : 1;
    const group = `group-${serial.toString().padStart(8, "0")}`;
    const from = random.pick(SENDERS);
    const subject = random.pick(["Invoice", "Meeting", "Report"]);
    for (let copy = 0; copy < copies; copy++) {
      const live = copy === 0 && random.next() < 0.4;
      const noTime = random.next() < 0.02;
      // Some copies share the representative's time, so ties fall back to the external ID.
      const offset = random.next() < 0.2 ? 0 : Math.round((random.next() - 0.5) * options.spread);
      originals.push({
        kind: live ? "email_routing" : "gmail",
        namespace: live ? "ingress-v1" : `account-${copy}`,
        id: `00000000-0000-4000-8000-${(serial * 32 + copy).toString(16).padStart(12, "0")}`,
        receivedAt: noTime ? null : iso(time + offset),
        from,
        subject,
        labels: live ? [] : random.pick(LABEL_SETS),
        attachments: random.int(2),
        ...(copies > 1 || random.next() < 0.5
          ? {
              group,
              identity:
                random.next() < 0.1
                  ? random.pick(["stale", "blocked", "previous"] as const)
                  : "complete",
            }
          : {}),
      });
    }
  }
  return originals;
}

/**
 * The archive statement of searchMail before page cost was bounded: every page collapses
 * all matching originals up to the snapshot, then applies the cursor. The reference for
 * the equivalence tests; it selects only the fields the comparison needs.
 */
const OLD_JOINS = `LEFT JOIN mail_extractions e ON e.raw_key=s.raw_key AND e.extractor_version='mime-v1'
 LEFT JOIN gmail_messages g ON g.raw_key=s.raw_key AND s.source_kind='gmail'`;
function oldCollapsedSql(where: string, expand: boolean, after: string) {
  return `WITH matched AS (SELECT s.rowid AS source_row,s.raw_key,s.source_kind,s.received_at,s.external_id,
   CASE WHEN i.rowid<=? AND i.identity_version='identity-v2' AND i.status='complete' AND i.raw_sha256=s.raw_sha256 THEN i.group_id END AS copy_group_id
   FROM archive_sources s ${OLD_JOINS} LEFT JOIN mail_identity i ON i.raw_key=s.raw_key WHERE ${where}),
 ranked AS (SELECT source_row,copy_group_id,
   ROW_NUMBER() OVER (PARTITION BY COALESCE(copy_group_id,'raw:'||raw_key)
     ORDER BY CASE source_kind WHEN 'email_routing' THEN 0 ELSE 1 END,COALESCE(received_at,'~'),external_id) AS copy_rank,
   COUNT(*) OVER (PARTITION BY COALESCE(copy_group_id,'raw:'||raw_key)) AS copies FROM matched)
 SELECT s.external_id,s.received_at,r.copy_group_id,r.copies FROM ranked r JOIN archive_sources s ON s.rowid=r.source_row ${OLD_JOINS}
 WHERE ${expand ? "1" : "r.copy_rank=1"}${after ? ` AND ${after}` : ""} ORDER BY COALESCE(s.received_at,'') DESC,s.external_id DESC LIMIT ?`;
}
const gmailLabel = (label: string) =>
  `(s.source_kind='gmail' AND EXISTS(SELECT 1 FROM json_each(COALESCE(g.label_ids_json,'[]')) WHERE value='${label}'))`;
/** The filters these tests use, as searchMail writes them. */
const OLD_FILTERS: Record<string, { sql: string; values: string[] }> = {
  "": { sql: "", values: [] },
  "from:alpha": {
    sql: "(instr(LOWER(COALESCE(json_extract(e.metadata_json, '$.from'),'')),?)>0)",
    values: ["alpha"],
  },
  "subject:report": {
    sql: "(instr(LOWER(COALESCE(json_extract(e.metadata_json, '$.subject'),'')),?)>0)",
    values: ["report"],
  },
  "has:attachment": { sql: "COALESCE(e.attachment_count,0)>0", values: [] },
  "in:inbox": { sql: `(s.source_kind='email_routing' OR ${gmailLabel("INBOX")})`, values: [] },
  "in:sent": { sql: gmailLabel("SENT"), values: [] },
  "after:2020-01-01": { sql: "s.received_at >= ?", values: ["2020-01-01T00:00:00.000Z"] },
  "before:2019-12-30": { sql: "s.received_at < ?", values: ["2019-12-30T00:00:00.000Z"] },
};
interface OldRow {
  external_id: string;
  received_at: string | null;
  copy_group_id: string | null;
  copies: number;
}
interface Token {
  version: 2;
  snapshot: number;
  groups: number;
  sent: number;
  beforeTime: string;
  beforeId: string;
  query: string;
}
const decodeToken = (token: string) =>
  JSON.parse(
    new TextDecoder().decode(Uint8Array.from(atob(token), (character) => character.charCodeAt(0))),
  ) as Token;
const encodeToken = (token: Token) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(token))));
/** The archive rows the old statement returns for this search and cursor. */
async function oldArchivePage(
  args: SearchArgs,
  snapshots: { snapshot: number; groups: number },
  cursor: Token | null,
) {
  const filter = OLD_FILTERS[args.query ?? ""]!;
  const clauses = ["s.rowid<=?", ...(filter.sql ? [filter.sql] : [])];
  const values: (string | number)[] = [snapshots.groups, snapshots.snapshot, ...filter.values];
  const source = args.archive_source ?? "all";
  if (source !== "all") {
    clauses.push("s.source_kind=?");
    values.push(source);
  }
  for (const label of [...new Set(args.label_ids ?? [])].sort()) {
    clauses.push(
      "((s.source_kind='email_routing' AND ?='INBOX') OR (s.source_kind='gmail' AND EXISTS(SELECT 1 FROM json_each(COALESCE(g.label_ids_json,'[]')) WHERE value=?)))",
    );
    values.push(label, label);
  }
  const after = cursor
    ? "(COALESCE(s.received_at,'') < ? OR (COALESCE(s.received_at,'') = ? AND 'mail_'||s.external_id < ?))"
    : "";
  if (cursor) values.push(cursor.beforeTime, cursor.beforeTime, cursor.beforeId);
  return env.MAIL_CATALOG.prepare(
    oldCollapsedSql(clauses.join(" AND "), args.expand_copies ?? false, after),
  )
    .bind(...values, (args.max_results ?? 20) + 1)
    .all<OldRow>();
}

/** Counts the rows D1 reads and the statements it runs for one search page. */
function countingEnvironment() {
  const counter = { rowsRead: 0, statements: 0 };
  const targets = new WeakMap<object, D1PreparedStatement>();
  const record = (meta: D1Meta) => {
    counter.rowsRead += meta.rows_read;
    counter.statements++;
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        if (property === "all")
          return async () => {
            const result = await target.all();
            record(result.meta);
            return result;
          };
        if (property === "first")
          return async () => {
            const result = await target.all();
            record(result.meta);
            return result.results[0] ?? null;
          };
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    targets.set(proxy, statement);
    return proxy;
  };
  const database = env.MAIL_CATALOG;
  const counting = {
    prepare: (sql: string) => wrap(database.prepare(sql)),
    batch: async (statements: D1PreparedStatement[]) => {
      const results = await database.batch(
        statements.map((statement) => targets.get(statement) ?? statement),
      );
      for (const result of results) record(result.meta);
      return results;
    },
  } as unknown as D1Database;
  const environment: MailReadEnvironment = {
    MAIL_CATALOG: counting,
    MAIL_ARCHIVE: env.MAIL_ARCHIVE,
  };
  return { environment, counter };
}

async function clear() {
  serial = 0;
  await env.MAIL_CATALOG.exec(
    "DELETE FROM mail_identity; DELETE FROM gmail_messages; DELETE FROM mail_extractions; DELETE FROM archive_sources;",
  );
}
beforeAll(async () => applyD1Migrations(env.MAIL_CATALOG, env.TEST_MIGRATIONS));
beforeEach(clear);

/** The rows read by each page of a search, for at most `pages` pages. */
async function pageCosts(args: SearchArgs, pages: number) {
  const costs: number[] = [];
  let token: string | null = null;
  do {
    const { environment, counter } = countingEnvironment();
    // oxlint-disable-next-line no-await-in-loop -- Pages follow one another.
    const result = await searchMail(environment, principal, {
      ...args,
      ...(token ? { next_page_token: token } : {}),
    });
    costs.push(counter.rowsRead);
    token = result.next_page_token;
  } while (token && costs.length < pages);
  return costs;
}

const snapshotsNow = async () =>
  (await env.MAIL_CATALOG.prepare(
    `SELECT (SELECT COALESCE(MAX(rowid),0) FROM archive_sources) AS snapshot,
     (SELECT COALESCE(MAX(rowid),0) FROM mail_identity) AS groups`,
  ).first<{ snapshot: number; groups: number }>())!;
const oldSummary = (row: OldRow) => [
  `mail_${row.external_id}`,
  row.received_at,
  row.copy_group_id,
  row.copies,
];

/**
 * Pages through searchMail and checks every page against the old statement with the same
 * cursor: the same rows in the same order, the same copy fields and the same token.
 * `between` runs after each page, so the catalog can change during the traversal.
 * Returns every result of the traversal.
 */
async function expectSameTraversal(
  args: SearchArgs,
  between: (page: number) => Promise<void> = async () => {},
) {
  const limit = args.max_results ?? 20;
  let snapshots = await snapshotsNow();
  let cursor: Token | null = null;
  const seen: unknown[] = [];
  for (let page = 0; ; page++) {
    // oxlint-disable-next-line no-await-in-loop -- Pages follow one another.
    const result = await searchMail(env, principal, {
      ...args,
      ...(cursor ? { next_page_token: encodeToken(cursor) } : {}),
    });
    // oxlint-disable-next-line no-await-in-loop -- The reference reads the same catalog state.
    const old = (await oldArchivePage(args, snapshots, cursor)).results;
    const expected = old.slice(0, limit).map(oldSummary);
    expect(
      result.emails.map((mail) => [
        mail.id,
        "received_at" in mail ? mail.received_at : undefined,
        mail.group_id,
        mail.copies,
      ]),
      `page ${page} of ${JSON.stringify(args)}`,
    ).toEqual(expected);
    seen.push(...expected);
    if (old.length <= limit) {
      expect(result.next_page_token).toBeNull();
      return seen;
    }
    const last = old[limit - 1]!;
    const next = decodeToken(result.next_page_token!);
    expect(next).toMatchObject({
      version: 2,
      ...snapshots,
      beforeTime: last.received_at ?? "",
      beforeId: `mail_${last.external_id}`,
    });
    cursor = next;
    snapshots = { snapshot: next.snapshot, groups: next.groups };
    // oxlint-disable-next-line no-await-in-loop -- Changes land between pages.
    await between(page);
  }
}

describe("search page cost", () => {
  it("reads the same rows per page however large the older archive is", async () => {
    const costs = [];
    for (const older of [1500, 3000]) {
      // oxlint-disable-next-line no-await-in-loop -- One archive at a time.
      await clear();
      const recent = archiveMessages(generator(1), 600, {
        start: BASE,
        step: 3_600_000,
        copyRate: 0.15,
        spread: 120_000,
      });
      // Older mail that no page below reaches, from its own generator, so the recent
      // archive is identical at both sizes.
      const rest = archiveMessages(generator(2), older, {
        start: BASE - 700 * 3_600_000,
        step: 3_600_000,
        copyRate: 0.15,
        spread: 120_000,
      });
      // oxlint-disable-next-line no-await-in-loop -- One archive at a time.
      await insertOriginals([...rest, ...recent]);
      // oxlint-disable-next-line no-await-in-loop -- One archive at a time.
      await insertIdentities([...recent, ...rest]);
      const run = [];
      for (const args of [
        {},
        { expand_copies: true },
        { query: "from:alpha" },
        { query: "from:alpha", expand_copies: true },
        // Filters on source_kind, which SQLite could otherwise serve from the primary key.
        { query: "in:inbox" },
        { archive_source: "gmail" as const },
        { label_ids: ["INBOX"] },
      ]) {
        // oxlint-disable-next-line no-await-in-loop -- One search at a time.
        const pages = await pageCosts(args, 10);
        expect(pages).toHaveLength(10);
        run.push([pages[0], pages[9]]);
      }
      costs.push(run);
    }
    // Page 1 and page 10 of each search read exactly as many rows at both archive sizes.
    expect(costs[1]).toEqual(costs[0]);
    for (const page of costs[0]!.flat()) expect(page).toBeLessThan(3000);
  });

  it("reads no older Gmail-only import when archive_source keeps to live captures", async () => {
    const costs = [];
    for (const older of [1500, 3000]) {
      // oxlint-disable-next-line no-await-in-loop -- One archive at a time.
      await clear();
      const recent = archiveMessages(generator(1), 300, {
        start: BASE,
        step: 3_600_000,
        copyRate: 0.15,
        spread: 120_000,
      });
      // An older Gmail import below every live capture, as a Takeout import leaves it.
      const history = archiveMessages(generator(2), older, {
        start: BASE - 400 * 3_600_000,
        step: 3_600_000,
        copyRate: 0.15,
        spread: 120_000,
      }).map((original) =>
        original.kind === "gmail"
          ? original
          : { ...original, kind: "gmail" as const, namespace: "account-0", labels: ["INBOX"] },
      );
      // oxlint-disable-next-line no-await-in-loop -- One archive at a time.
      await insertOriginals([...history, ...recent]);
      // oxlint-disable-next-line no-await-in-loop -- One archive at a time.
      await insertIdentities([...recent, ...history]);
      // Every page, including the last, which finds no older live capture.
      // oxlint-disable-next-line no-await-in-loop -- One archive at a time.
      costs.push(await pageCosts({ archive_source: "email_routing" }, 100));
    }
    expect(costs[0]!.length).toBeGreaterThan(1);
    expect(costs[1]).toEqual(costs[0]);
  });

  it("returns the old pages for random archives, filters and page sizes", async () => {
    for (let seed = 1; seed <= 60; seed++) {
      // oxlint-disable-next-line no-await-in-loop -- One archive at a time.
      await clear();
      const random = generator(seed);
      const step = random.pick([1000, 60_000, 3_600_000]);
      const shape = {
        start: BASE + 2 * 86_400_000,
        step,
        copyRate: random.pick([0.2, 0.5, 0.9]),
        // Copies up to several messages apart, so groups straddle page boundaries. Many
        // scattered copies make a walk fall short and repeat with a larger window.
        spread: step * random.pick([0, 1, 6, 20]),
        copies: random.pick([4, 4, 16, 30]),
      };
      const originals = archiveMessages(random, 10 + random.int(50), shape);
      // Times rounded to two hours make ties across groups.
      if (random.next() < 0.3)
        for (const original of originals)
          if (original.receivedAt)
            original.receivedAt = iso(
              Math.floor(Date.parse(original.receivedAt) / 7_200_000) * 7_200_000,
            );
      // oxlint-disable-next-line no-await-in-loop -- One archive at a time.
      await insertOriginals(originals);
      // Identity rows land in another order than the originals, some only mid-traversal.
      const shuffled = [...originals];
      for (let index = shuffled.length - 1; index > 0; index--) {
        const other = random.int(index + 1);
        [shuffled[index], shuffled[other]] = [shuffled[other]!, shuffled[index]!];
      }
      const late = shuffled.splice(0, random.int(Math.ceil(shuffled.length / 4)));
      // oxlint-disable-next-line no-await-in-loop -- One archive at a time.
      await insertIdentities(shuffled);
      const args: SearchArgs = {
        query: random.pick(Object.keys(OLD_FILTERS)),
        max_results: 1 + random.int(6),
        expand_copies: random.next() < 0.3,
        ...(random.next() < 0.5
          ? { archive_source: random.pick(["all", "gmail", "email_routing"] as const) }
          : {}),
        ...(random.next() < 0.4
          ? { label_ids: random.pick([["INBOX"], ["Label_1"], ["INBOX", "Label_1"], ["SENT"]]) }
          : {}),
      };
      // oxlint-disable-next-line no-await-in-loop -- One archive at a time.
      await expectSameTraversal(args, async (page) => {
        if (page !== 0) return;
        // Changes after the first page: new originals and identity rows past the
        // snapshots, and a filter that starts or stops matching an existing original.
        const added = archiveMessages(random, 1 + random.int(5), shape);
        await insertOriginals(added);
        await insertIdentities([...late, ...added]);
        await env.MAIL_CATALOG.prepare(
          "UPDATE mail_extractions SET metadata_json=json_set(metadata_json,'$.from.address',?) WHERE raw_key=?",
        )
          .bind(random.pick(SENDERS), `synthetic/${random.pick(originals).id}`)
          .run();
      });
    }
  });

  it("collapses everything at once when larger walks still fall short", async () => {
    // Three groups of many Gmail copies with interleaved times: the newest originals are
    // all later copies, and each group's representative is its earliest copy.
    const originals: Original[] = [];
    for (let copy = 0; copy < 80; copy++)
      for (const [index, group] of ["group-a", "group-b", "group-c"].entries())
        originals.push({
          kind: "gmail",
          namespace: `account-${copy}`,
          id: `00000000-0000-4000-8000-${index}${copy.toString().padStart(11, "0")}`,
          receivedAt: iso(BASE + copy * 60_000 + index),
          from: "alpha@example.invalid",
          subject: "Invoice",
          labels: ["INBOX"],
          attachments: 0,
          group,
          identity: "complete",
        });
    await insertOriginals(originals);
    await insertIdentities(originals);
    const { environment, counter } = countingEnvironment();
    const page = await searchMail(environment, principal, {
      archive_source: "gmail",
      max_results: 1,
    });
    // The snapshots, two walks with their collapses, and the collapse of every original.
    expect(counter.statements).toBe(6);
    expect(page.emails.map((mail) => [mail.id, mail.copies])).toEqual([
      [`mail_${originals[2]!.id}`, 80],
    ]);
    expect(await expectSameTraversal({ archive_source: "gmail", max_results: 1 })).toHaveLength(3);
    expect(
      await expectSameTraversal({ archive_source: "gmail", max_results: 7, expand_copies: true }),
    ).toHaveLength(240);
  });
});
