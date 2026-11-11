import { eventStatement } from "./event-store.ts";
import { OutboundError, reconcileOutboundReceipts, withOutboundErrors } from "./outbound.ts";
import type { OutboundContext } from "./outbound.ts";

interface DeliveryEvent {
  event_id: string;
  provider_message_id: string;
  sender: string;
  recipient: string;
  state: string;
  event_timestamp: number;
  operation_id: string | null;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new OutboundError("invalid_provider_event");
  return value as Record<string, unknown>;
}

function field(value: unknown, max = 1024): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > max ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new OutboundError("invalid_provider_event");
  return value;
}

function normalize(value: unknown): DeliveryEvent {
  const envelope = object(value);
  const source = object(envelope["source"]);
  const payload = object(envelope["payload"]);
  const metadata = object(envelope["metadata"]);
  const delivery = object(payload["delivery"]);
  const state = field(delivery["status"], 32);
  if (
    !["delivered", "deferred", "bounced", "failed", "rejected", "complained"].includes(state) ||
    envelope["type"] !== `cf.email.sending.message.${state}` ||
    source["type"] !== "email.sending" ||
    metadata["eventSchemaVersion"] !== 1 ||
    payload["terminal"] !== (state !== "deferred")
  )
    throw new OutboundError("invalid_provider_event");
  field(source["zoneId"]);
  field(metadata["accountId"]);
  field(metadata["eventSubscriptionId"]);
  const sender = field(payload["sender"], 254);
  const recipient = field(payload["recipient"], 254);
  if (
    !/^[^\s<>@]+@[^\s<>@]+$/.test(sender) ||
    !/^[^\s<>@]+@[^\s<>@]+$/.test(recipient) ||
    sender.split("@")[1]?.toLowerCase() !== field(source["domain"], 253).toLowerCase()
  )
    throw new OutboundError("invalid_provider_event");
  const timestampText = field(metadata["eventTimestamp"], 40);
  const timestamp = Date.parse(timestampText);
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(timestampText) ||
    !Number.isFinite(timestamp)
  )
    throw new OutboundError("invalid_provider_event");
  const eventId = field(payload["eventId"], 160);
  if (!/^[A-Za-z0-9_-]+$/.test(eventId)) throw new OutboundError("invalid_provider_event");
  return {
    event_id: eventId,
    provider_message_id: field(payload["messageId"]),
    sender,
    recipient,
    state,
    event_timestamp: timestamp,
    operation_id: null,
  };
}

/** Only invoke with a trusted provider Queue event. HTTP/MCP input is not a receipt. */
async function applyProviderEventImpl(ctx: OutboundContext, value: unknown) {
  const event = normalize(value);
  const session = ctx.MAIL_CATALOG.withSession("first-primary");
  await session
    .prepare(`INSERT OR IGNORE INTO outbound_provider_events
    (event_id,provider_message_id,sender,recipient,state,event_timestamp,received_at)
    VALUES (?,?,?,?,?,?,?)`)
    .bind(
      event.event_id,
      event.provider_message_id,
      event.sender,
      event.recipient,
      event.state,
      event.event_timestamp,
      Date.now(),
    )
    .run();
  const saved = await session
    .prepare("SELECT * FROM outbound_provider_events WHERE event_id = ?")
    .bind(event.event_id)
    .first<DeliveryEvent>();
  if (
    !saved ||
    ["provider_message_id", "sender", "recipient", "state", "event_timestamp"].some(
      (key) => saved[key as keyof DeliveryEvent] !== event[key as keyof DeliveryEvent],
    )
  )
    throw new OutboundError("provider_event_conflict");
  await reconcileProviderEvents(ctx, event.provider_message_id);
  return { event_id: event.event_id, retained: true };
}

/** Retry projection after receipt persistence; this never calls the sending API. */
async function reconcileProviderEventsImpl(ctx: OutboundContext, providerId?: string) {
  await reconcileOutboundReceipts(ctx);
  const session = ctx.MAIL_CATALOG.withSession("first-primary");
  const rows = await session
    .prepare(`SELECT e.* FROM outbound_provider_events e
    WHERE e.operation_id IS NULL ${providerId ? "AND e.provider_message_id = ?" : ""}
    AND EXISTS (SELECT 1 FROM outbound_operations o JOIN outbound_recipients r ON r.operation_id = o.operation_id
      WHERE o.provider_message_id = e.provider_message_id AND lower(o.from_address) = lower(e.sender)
      AND lower(r.address) = lower(e.recipient))
    ORDER BY e.event_timestamp,e.event_id LIMIT 100`)
    .bind(...(providerId ? [providerId] : []))
    .all<DeliveryEvent>();
  for (const event of rows.results) {
    // oxlint-disable-next-line no-await-in-loop -- Each event projects transactionally in provider order.
    const operation = await session
      .prepare(
        "SELECT operation_id,principal_id FROM outbound_operations WHERE provider_message_id = ?",
      )
      .bind(event.provider_message_id)
      .first<{ operation_id: string; principal_id: string }>();
    if (!operation) continue;
    const op = operation.operation_id;
    const deliveryGuard =
      "EXISTS (SELECT 1 FROM outbound_recipients WHERE operation_id = ? AND event_id = ?)";
    // Every terminal delivery fact outranks a deferred fact regardless of arrival
    // order. Terminal facts stay settled; a later complaint can follow delivery.
    // oxlint-disable-next-line no-await-in-loop -- Batch is one atomic projection and event publication.
    await session.batch([
      session
        .prepare(`UPDATE outbound_recipients SET state = ?, event_timestamp = ?, event_id = ?
        WHERE operation_id = ? AND lower(address) = lower(?) AND (
          (state = 'pending') OR
          (state = 'deferred' AND (? != 'deferred' OR event_timestamp < ? OR (event_timestamp = ? AND coalesce(event_id,'') < ?))) OR
          (state = 'delivered' AND ? = 'complained'))`)
        .bind(
          event.state,
          event.event_timestamp,
          event.event_id,
          op,
          event.recipient,
          event.state,
          event.event_timestamp,
          event.event_timestamp,
          event.event_id,
          event.state,
        ),
      session
        .prepare(
          "UPDATE outbound_operations SET state = 'accepted', failure_code = NULL, updated_at = ? WHERE operation_id = ? AND state IN ('submitting','unknown')",
        )
        .bind(Date.now(), op),
      eventStatement(session, {
        id: `send:${op}:accepted`,
        name: "email.send_status_changed",
        data: { operationId: op, status: "accepted" },
        principalId: operation.principal_id,
        occurredAt: new Date(event.event_timestamp).toISOString(),
      }),
      eventStatement(
        session,
        {
          id: `delivery:${event.event_id}`,
          name: "email.delivery_status_changed",
          data: { operationId: op, status: event.state },
          principalId: operation.principal_id,
          occurredAt: new Date(event.event_timestamp).toISOString(),
        },
        { sql: deliveryGuard, bindings: [op, event.event_id] },
      ),
      session
        .prepare(
          "UPDATE outbound_provider_events SET operation_id = ? WHERE event_id = ? AND EXISTS (SELECT 1 FROM outbound_recipients WHERE operation_id = ? AND lower(address) = lower(?))",
        )
        .bind(op, event.event_id, op, event.recipient),
    ]);
  }
  return { processed: rows.results.length };
}

export const applyProviderEvent = withOutboundErrors(applyProviderEventImpl);
export const reconcileProviderEvents = withOutboundErrors(reconcileProviderEventsImpl);
