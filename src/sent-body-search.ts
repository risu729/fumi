import { SENT_STATES, SENT_STATES_SQL } from "./mail-read.ts";
import type { MailPrincipal } from "./principal.ts";
import {
  BODY_SEARCH_CHARACTERS,
  chunks,
  InvalidSearchSource,
  sha256Hex,
  verifiedText,
} from "./search-text.ts";
import { truncateCodeUnits } from "./utf16.ts";

/**
 * Lexical index of the bodies of mail each principal sent through fumi
 * (docs/sent-body-search.md). Its tables are read only through statements that join
 * outbound_operations on the caller's principal; archive statements never read them.
 */
const VERSION = "sent-text-v1";
/** Operations indexed per scheduled run; each reads one input.json of at most 6 MiB. */
const SENT_BODY_BATCH = 5;
const INPUT_BYTES = 6 * 1024 * 1024;

interface Catalog {
  MAIL_CATALOG: D1Database;
  MAIL_ARCHIVE: R2Bucket;
}
interface Unindexed {
  operation_id: string;
  input_key: string;
  input_hash: string;
  state: string;
}

/** The searchable fields of a verified input.json, or null when it is not the expected JSON. */
function sentBody(json: string) {
  try {
    const value = JSON.parse(json) as {
      input?: { payload?: { text?: unknown; html?: unknown }; reply_message_id?: unknown };
      forward_message_id?: unknown;
    };
    const payload = value.input?.payload;
    if (typeof payload !== "object" || payload === null) return null;
    if (payload.text !== undefined && typeof payload.text !== "string") return null;
    return {
      text: payload.text,
      html: typeof payload.html === "string",
      composed:
        typeof value.forward_message_id === "string"
          ? "forward"
          : typeof value.input?.reply_message_id === "string"
            ? "reply"
            : "new",
    };
  } catch {
    return null;
  }
}

/**
 * The scheduled stage: index the plain-text bodies of up to five operations, newest
 * first, so a new send is searchable at the next run while older sends backfill. A
 * rejected operation is marked not_sent without reading R2; an input that can never be
 * read is marked unavailable and not read again. A D1 or R2 request failure leaves the
 * row for the next run.
 */
export async function indexSentBodies(ctx: Catalog) {
  const db = ctx.MAIL_CATALOG.withSession("first-primary");
  const rows = (
    await db
      .prepare(
        `SELECT operation_id,input_key,input_hash,state FROM outbound_operations
         WHERE body_search_json IS NULL AND state IN ('accepted','unknown','submitting','rejected')
         ORDER BY created_at DESC LIMIT ?`,
      )
      .bind(SENT_BODY_BATCH)
      .all<Unindexed>()
  ).results;
  const counts = { indexed: 0, unavailable: 0, skipped: 0, deferred: 0 };
  const mark = (row: Unindexed, status: "unavailable" | "not_sent") =>
    db
      .prepare(
        "UPDATE outbound_operations SET body_search_json=? WHERE operation_id=? AND input_hash=? AND body_search_json IS NULL",
      )
      .bind(JSON.stringify({ version: VERSION, status }), row.operation_id, row.input_hash)
      .run();
  for (const row of rows) {
    try {
      if (row.state === "rejected") {
        // oxlint-disable-next-line no-await-in-loop -- One small update per operation.
        await mark(row, "not_sent");
        counts.skipped++;
        continue;
      }
      let json: string | null;
      try {
        // oxlint-disable-next-line no-await-in-loop -- Hold at most one bounded input in memory.
        json = await verifiedText(ctx.MAIL_ARCHIVE, row.input_key, row.input_hash, INPUT_BYTES);
      } catch (error) {
        if (!(error instanceof InvalidSearchSource)) throw error;
        json = null;
      }
      const body = json === null ? null : sentBody(json);
      if (!body) {
        // oxlint-disable-next-line no-await-in-loop -- One small update per operation.
        await mark(row, "unavailable");
        counts.unavailable++;
        continue;
      }
      const omitted: string[] = [];
      const entries =
        body.text === undefined
          ? []
          : chunks(
              truncateCodeUnits(body.text, BODY_SEARCH_CHARACTERS),
              "body",
              // oxlint-disable-next-line no-await-in-loop -- See above.
              await sha256Hex(new TextEncoder().encode(body.text)),
            );
      if (body.text === undefined && body.html) omitted.push("html_only_body");
      if (body.text !== undefined && body.text.length > BODY_SEARCH_CHARACTERS)
        omitted.push("body_truncated");
      const coverage = JSON.stringify({
        version: VERSION,
        status: "ready",
        chunks: entries.length,
        omitted,
        composed: body.composed,
      });
      // Publish only while the operation is still unindexed with the input this run read.
      // D1 batches commit atomically, so a run that loses a race writes nothing.
      const guard =
        "EXISTS (SELECT 1 FROM outbound_operations WHERE operation_id=? AND input_hash=? AND body_search_json IS NULL)";
      const fence = [row.operation_id, row.input_hash];
      // oxlint-disable-next-line no-await-in-loop -- One bounded batch per operation.
      const results = await db.batch([
        db
          .prepare(`DELETE FROM sent_search_chunks WHERE operation_id=? AND ${guard}`)
          .bind(row.operation_id, ...fence),
        ...entries.map((entry) =>
          db
            .prepare(
              `INSERT INTO sent_search_chunks(operation_id,part,ordinal,text,sha256) SELECT ?,?,?,?,? WHERE ${guard}`,
            )
            .bind(row.operation_id, entry.part, entry.ordinal, entry.text, entry.sha256, ...fence),
        ),
        db
          .prepare(
            "UPDATE outbound_operations SET body_search_json=? WHERE operation_id=? AND input_hash=? AND body_search_json IS NULL",
          )
          .bind(coverage, ...fence),
      ]);
      if ((results.at(-1)?.meta.changes ?? 0) > 0) counts.indexed++;
    } catch {
      counts.deferred++;
    }
  }
  return counts;
}

export interface SentChunkRow {
  id: number;
  operation_id: string;
  part: string;
  ordinal: number;
  sha256: string;
  text: string;
  input_hash: string;
  excerpt: string;
  body_search_json: string;
}

/**
 * The caller's matching sent chunks below a chunk ID, newest chunk first. FTS5 walks
 * matches in descending rowid and stops after the limit; each match passes or fails the
 * principal, state and filter checks through primary-key lookups, so another principal's
 * chunk never reaches a result row, snippet() or an excerpt.
 */
export async function searchSentBodies(
  db: D1Database,
  principal: MailPrincipal,
  phrase: string,
  filters: { clauses: string[]; values: (string | number)[] },
  before: number,
  limit: number,
) {
  return (
    await db
      .prepare(
        `SELECT c.id,o.operation_id,c.part,c.ordinal,c.sha256,c.text,o.input_hash,
         snippet(sent_search_fts,0,'','','…',48) AS excerpt,o.body_search_json
         FROM sent_search_fts
         JOIN sent_search_chunks c ON c.id=sent_search_fts.rowid
         JOIN outbound_operations o ON o.operation_id=c.operation_id
         WHERE sent_search_fts MATCH ? AND sent_search_fts.rowid<? AND o.principal_id=?
         AND ${SENT_STATES_SQL} AND json_extract(o.body_search_json,'$.status')='ready'
         ${filters.clauses.length ? `AND ${filters.clauses.join(" AND ")}` : ""}
         ORDER BY sent_search_fts.rowid DESC LIMIT ?`,
      )
      .bind(phrase, before, principal.id, ...filters.values, limit)
      .all<SentChunkRow>()
  ).results;
}

/** Indexing coverage of the caller's own searchable operations only. */
export async function sentBodyCoverage(db: D1Database, principal: MailPrincipal) {
  const counts = await db
    .prepare(
      `SELECT
       COALESCE(SUM(json_extract(o.body_search_json,'$.status')='ready'),0) AS indexed,
       COALESCE(SUM(o.body_search_json IS NULL),0) AS pending,
       COALESCE(SUM(json_extract(o.body_search_json,'$.status')='unavailable'),0) AS unavailable,
       COALESCE(SUM(EXISTS(SELECT 1 FROM json_each(o.body_search_json,'$.omitted') WHERE value='html_only_body')),0) AS html_only
       FROM outbound_operations o WHERE o.principal_id=? AND ${SENT_STATES_SQL}`,
    )
    .bind(principal.id)
    .first<{ indexed: number; pending: number; unavailable: number; html_only: number }>();
  return {
    searched: true,
    principal: "this_principal_only",
    states: SENT_STATES,
    indexed: counts?.indexed ?? 0,
    pending: counts?.pending ?? 0,
    unavailable: counts?.unavailable ?? 0,
    html_only: counts?.html_only ?? 0,
  };
}
