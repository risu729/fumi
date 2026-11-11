export const EVENT_NAMES = [
  "email.received",
  "email.ready",
  "email.processing_failed",
  "email.send_status_changed",
  "email.delivery_status_changed",
] as const;
export type EventName = (typeof EVENT_NAMES)[number];
export type EventData =
  | { ingestId: string; status?: string }
  | { operationId: string; status: string };
export interface MailEvent {
  id: string;
  name: EventName;
  data: EventData;
  occurredAt: string;
  principalId?: string;
}
export const SEND_STATES = ["prepared", "submitting", "accepted", "rejected", "unknown"] as const;
export const DELIVERY_STATES = [
  "pending",
  "deferred",
  "delivered",
  "bounced",
  "rejected",
  "suppressed",
  "failed",
  "complained",
] as const;
export function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/.test(value);
}
export function eventScope(name: EventName): string {
  return name === "email.send_status_changed" || name === "email.delivery_status_changed"
    ? "mail:send"
    : "mail:read";
}
export function validEventData(name: EventName, value: unknown): value is EventData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  if (name === "email.send_status_changed" || name === "email.delivery_status_changed") {
    const states: readonly string[] =
      name === "email.send_status_changed" ? SEND_STATES : DELIVERY_STATES;
    return (
      Object.keys(data).length === 2 &&
      validId(data["operationId"]) &&
      typeof data["status"] === "string" &&
      states.includes(data["status"])
    );
  }
  return Object.keys(data).length === 1 && validId(data["ingestId"]);
}
/** Call in the lifecycle batch. Sequence allocation and event visibility commit atomically;
 * no asynchronous publication flag can leave a pending event behind a replay cursor. */
export function eventStatement(
  db: D1DatabaseSession,
  event: MailEvent,
  guard?: { sql: string; bindings: (string | number | null | ArrayBuffer)[] },
): D1PreparedStatement {
  if (
    !validId(event.id) ||
    !EVENT_NAMES.includes(event.name) ||
    !validEventData(event.name, event.data) ||
    !Number.isFinite(Date.parse(event.occurredAt)) ||
    (eventScope(event.name) === "mail:send" && !event.principalId)
  ) {
    throw new Error("Invalid mail event");
  }
  return db
    .prepare(`INSERT OR IGNORE INTO mail_events
    (event_id,name,principal_id,data_json,occurred_at) SELECT ?,?,?,?,? WHERE ${guard?.sql ?? "1"}`)
    .bind(
      event.id,
      event.name,
      event.principalId ?? null,
      JSON.stringify(event.data),
      new Date(event.occurredAt).toISOString(),
      ...(guard?.bindings ?? []),
    );
}
export interface Subscription {
  id: string;
  principal_id: string;
  name: EventName;
  arguments_json: string;
  callback_url: string;
  signing_secret: string;
  previous_signing_secret: string | null;
  previous_secret_until: number;
  expires_at: number;
  start_sequence: number;
  cursor: number;
  state: "active" | "stopped";
  revision: number;
  attempts: number;
  next_attempt_at: number;
  lease_until: number;
  lease_token: string | null;
}
export interface StoredEvent {
  sequence: number;
  event_id: string;
  name: EventName;
  data_json: string;
  occurred_at: string;
}
export function cursorFor(id: string, sequence: number): string {
  return `${id}:${sequence}`;
}
