import { describe, expect, it } from "vitest";
import { classifyForwardError } from "../src/forward-failure.ts";
import { canonicalReceipt, parseReceipt, type ArchiveReceipt } from "../src/receipt-schema.ts";

const timeoutError = Object.assign(new Error("private diagnostic"), { name: "TimeoutError" });

describe("bounded forward failure classification", () => {
  it.each<[string, unknown, ReturnType<typeof classifyForwardError>]>([
    [
      "a reply code paired with its enhanced status",
      new Error("550 5.7.1 private@example.invalid rejected <private-id@example.invalid>"),
      { code: "rejected_permanent", smtpStatus: "5.7.1" },
    ],
    [
      "a multiline reply inside provider text",
      new Error("could not forward: 550-5.7.1 [203.0.113.7] synthetic policy text"),
      { code: "rejected_permanent", smtpStatus: "5.7.1" },
    ],
    [
      "a temporary reply",
      new Error("421 4.7.0 Try again later"),
      { code: "rejected_temporary", smtpStatus: "4.7.0" },
    ],
    [
      "a reply code at the start without an enhanced status",
      new Error("552 Requested mail action aborted"),
      { code: "rejected_permanent" },
    ],
    [
      "an enhanced status without a reply code",
      new Error("delivery deferred: 4.2.2 mailbox full"),
      { code: "rejected_temporary", smtpStatus: "4.2.2" },
    ],
    [
      "a three-digit enhanced status detail",
      new Error("550 5.7.100 synthetic"),
      { code: "rejected_permanent", smtpStatus: "5.7.100" },
    ],
    [
      // A success class cannot explain a rejection, and the same shape is a version number.
      "a success-class enhanced status without a rejection class",
      new Error("2.0.0 synthetic"),
      { code: "forward_failed" },
    ],
    [
      "a version number with a success class",
      new Error("runtime 2.1.3 failed"),
      { code: "forward_failed" },
    ],
    ["a TimeoutError", timeoutError, { code: "timeout" }],
    ["timed-out text", new Error("Forward request timed out"), { code: "timeout" }],
    ["timeout text", new Error("upstream timeout"), { code: "timeout" }],
    [
      "a thrown SMTP string",
      "550 5.1.1 synthetic",
      { code: "rejected_permanent", smtpStatus: "5.1.1" },
    ],
    ["opaque text", new Error("private SMTP diagnostic"), { code: "forward_failed" }],
    [
      "a code inside an address",
      new Error("user550@example.invalid failed"),
      { code: "forward_failed" },
    ],
    ["a mid-text bare number", new Error("Error 500 - internal"), { code: "forward_failed" }],
    ["a version number", new Error("runtime 15.7.1 failed"), { code: "forward_failed" }],
    ["an IPv4 address", new Error("peer [4.5.6.7] closed"), { code: "forward_failed" }],
    ["a non-error value", { message: "550 5.7.1" }, { code: "forward_failed" }],
    ["undefined", undefined, { code: "forward_failed" }],
  ])("classifies %s", (_name, error, expected) => {
    expect(classifyForwardError(error)).toEqual(expected);
  });

  it("inspects only a bounded prefix of the error text", () => {
    expect(classifyForwardError(new Error(`${"x ".repeat(1024)}550 5.7.1`))).toEqual({
      code: "forward_failed",
    });
  });

  it("prefers an SMTP class over timeout words", () => {
    expect(classifyForwardError(new Error("421 4.4.2 connection timed out"))).toEqual({
      code: "rejected_temporary",
      smtpStatus: "4.4.2",
    });
  });

  it("never reads a throwing message getter", () => {
    const error = new Error("synthetic");
    Object.defineProperty(error, "message", {
      get() {
        throw new Error("550 5.7.1");
      },
    });
    expect(classifyForwardError(error)).toEqual({ code: "forward_failed" });
  });
});

const base = {
  ingestId: "00000000-0000-4000-8000-000000000001",
  receivedAt: "2026-11-08T00:00:00.000Z",
  envelope: { from: "sender@example.invalid", to: "recipient@example.invalid" },
  reportedRawSize: 10,
  archive: { status: "failed", code: "read_failed" },
} as const;

describe("receipt v3 forward failure reasons", () => {
  it("parses v3 classified failures and keeps their canonical fields", () => {
    const v3 = {
      schemaVersion: 3,
      ...base,
      forward: { status: "failed", code: "rejected_permanent", smtpStatus: "5.7.1" },
    } as const;
    expect(parseReceipt(v3)).toEqual(v3);
    expect(JSON.parse(canonicalReceipt(v3))).toEqual(v3);
    const noStatus = { ...v3, forward: { status: "failed", code: "timeout" } } as const;
    expect(parseReceipt(noStatus)).toEqual(noStatus);
    expect(canonicalReceipt(noStatus)).not.toContain("smtpStatus");
  });

  it.each([
    ["v3 success", { schemaVersion: 3, forward: { status: "forwarded" } }],
    ["v3 skipped", { schemaVersion: 3, forward: { status: "skipped", reason: "archive_only" } }],
    [
      "v3 legacy target code",
      { schemaVersion: 3, forward: { status: "failed", code: "invalid_target" } },
    ],
    [
      "v1 new code",
      { schemaVersion: 1, forward: { status: "failed", code: "rejected_permanent" } },
    ],
    [
      "v1 SMTP status",
      {
        schemaVersion: 1,
        forward: { status: "failed", code: "forward_failed", smtpStatus: "5.7.1" },
      },
    ],
    [
      "a success-class status",
      {
        schemaVersion: 3,
        forward: { status: "failed", code: "forward_failed", smtpStatus: "2.0.0" },
      },
    ],
    [
      "free text in the status",
      {
        schemaVersion: 3,
        forward: { status: "failed", code: "timeout", smtpStatus: "5.7.1 text" },
      },
    ],
    [
      "an extra field",
      { schemaVersion: 3, forward: { status: "failed", code: "timeout", detail: "text" } },
    ],
  ])("rejects %s", (_name, override) => {
    expect(parseReceipt({ ...base, ...override })).toBeNull();
  });

  it("keeps v1 canonical snapshots byte-identical", () => {
    const v1: ArchiveReceipt = {
      schemaVersion: 1,
      ...base,
      forward: { status: "failed", code: "forward_failed" },
    };
    expect(canonicalReceipt(v1)).toBe(
      '{"schemaVersion":1,"ingestId":"00000000-0000-4000-8000-000000000001","receivedAt":"2026-11-08T00:00:00.000Z","envelope":{"from":"sender@example.invalid","to":"recipient@example.invalid"},"reportedRawSize":10,"archive":{"status":"failed","code":"read_failed"},"forward":{"status":"failed","code":"forward_failed"}}',
    );
  });
});
