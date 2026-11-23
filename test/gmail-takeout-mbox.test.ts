import { describe, expect, it } from "vitest";
import {
  TakeoutMboxError,
  TakeoutMboxSplitter,
  type TakeoutEntry,
  type TakeoutItem,
} from "../src/gmail-takeout-mbox.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Synthetic = { id: string; thread?: string; date?: string; labels?: string; message: string };

const entry = ({
  id,
  thread = id,
  date = "Tue Jul 08 09:44:28 +0000 2025",
  labels = "Inbox",
  message,
}: Synthetic) =>
  `From ${id}@xxx ${date}\r\nX-GM-THRID: ${thread}\r\nX-Gmail-Labels: ${labels}\r\n${message}\r\n`;

const message = (subject: string, body: string) =>
  `Message-ID: <${subject}@example.invalid>\r\nSubject: ${subject}\r\n\r\n${body}\r\n`;

const split = (mbox: string | Uint8Array, chunk = Number.POSITIVE_INFINITY, limit?: number) => {
  const bytes = typeof mbox === "string" ? encoder.encode(mbox) : mbox;
  const splitter = new TakeoutMboxSplitter(limit);
  const items: TakeoutItem[] = [];
  for (let i = 0; i < bytes.length; i += Math.min(chunk, bytes.length))
    items.push(...splitter.push(bytes.subarray(i, Math.min(bytes.length, i + chunk))));
  items.push(...splitter.end());
  return items;
};

const failure = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (error instanceof TakeoutMboxError) return { code: error.code, offset: error.offset };
    throw error;
  }
  throw new Error("expected a TakeoutMboxError");
};

const first = message("first", "Hello.");
const second = message("second", "From the team: thanks.\r\n\r\nFrom here on, reply above.");
const third = message("third", "");
const mbox =
  entry({ id: "1837071459230217940", message: first }) +
  entry({
    id: "1837071459230217941",
    thread: "1837071459230217940",
    date: "Wed Jan 01 00:00:00 +0900 2025",
    labels: "Archived,Unread,=?UTF-8?B?44Op44OZ44Or?=",
    message: second,
  }) +
  entry({ id: "18446744073709551615", labels: "", message: third });

describe("Takeout mbox splitter", () => {
  it("strips the From_ line, Gmail headers and separator and keeps the message bytes", () => {
    const items = split(mbox) as TakeoutEntry[];
    expect(items.map((item) => item.kind)).toEqual(["entry", "entry", "entry"]);
    expect(items.map((item) => decoder.decode(item.raw))).toEqual([first, second, third]);
    expect(items[0]).toMatchObject({
      offset: 0,
      messageId: "197e96c24a6cf6d4",
      threadId: "197e96c24a6cf6d4",
      fromDate: Date.parse("2025-07-08T09:44:28Z"),
      labels: "Inbox",
    });
    expect(items[1]).toMatchObject({
      offset: entry({ id: "1837071459230217940", message: first }).length,
      messageId: "197e96c24a6cf6d5",
      threadId: "197e96c24a6cf6d4",
      fromDate: Date.parse("2024-12-31T15:00:00Z"),
      labels: "Archived,Unread,=?UTF-8?B?44Op44OZ44Or?=",
    });
    expect(items[2]).toMatchObject({ messageId: "ffffffffffffffff", labels: "" });
  });

  it("reports where each entry ends and resumes from a checkpoint", () => {
    const items = split(mbox);
    expect(items.map((item) => item.end)).toEqual([
      items[1]!.offset,
      items[2]!.offset,
      encoder.encode(mbox).length,
    ]);
    const resumed = new TakeoutMboxSplitter(undefined, items[1]!.offset);
    const rest = [
      ...resumed.push(encoder.encode(mbox).subarray(items[1]!.offset)),
      ...resumed.end(),
    ];
    expect(rest).toEqual(items.slice(1));
  });

  it("does not pad message IDs, like the Gmail API", () => {
    expect(split(entry({ id: "255", message: first }))[0]).toMatchObject({ messageId: "ff" });
  });

  it("returns the same entries for every chunk size", () => {
    const whole = split(mbox);
    for (const size of [1, 2, 3, 5, 7, 9, 13, 64, 127])
      expect(split(mbox, size), `chunk ${size}`).toEqual(whole);
  });

  it("keeps a body line that looks like a From_ line but is not one", () => {
    const body = message(
      "quoted",
      "From 123@xxx yesterday\r\n\r\nFrom 1@xxx Tue Jul 08 09:44:28 +0000\r\n\r\n" +
        "From 5@xxx Tue Jul 08 09:44:28 +0000 2025\r\nSubject: quoted mbox\r\n",
    );
    const items = split(entry({ id: "1", message: body }), 4) as TakeoutEntry[];
    expect(items).toHaveLength(1);
    expect(decoder.decode(items[0]!.raw)).toBe(body);
  });

  it("returns a copy that later pushes do not change", () => {
    const splitter = new TakeoutMboxSplitter();
    const bytes = encoder.encode(mbox);
    const items = splitter.push(bytes);
    const raw = (items[0] as TakeoutEntry).raw;
    const before = decoder.decode(raw);
    bytes.fill(0);
    splitter.push(encoder.encode("x"));
    expect(decoder.decode(raw)).toBe(before);
  });

  it("returns nothing for an empty stream", () => {
    expect(split("")).toEqual([]);
  });

  it("reports an entry over the raw limit without its bytes and continues", () => {
    const big = message("big", "x".repeat(2000));
    const small = message("small", "ok");
    const text = entry({ id: "10", message: big }) + entry({ id: "11", message: small });
    for (const size of [1, 17, 300, 100_000]) {
      const items = split(text, size, 1000);
      expect(items, `chunk ${size}`).toHaveLength(2);
      expect(items[0]).toEqual({
        kind: "oversize",
        offset: 0,
        messageId: "a",
        size: encoder.encode(big).length,
        end: entry({ id: "10", message: big }).length,
      });
      expect(items[1]).toMatchObject({
        kind: "entry",
        offset: entry({ id: "10", message: big }).length,
        messageId: "b",
      });
      expect(decoder.decode((items[1] as TakeoutEntry).raw)).toBe(small);
    }
  });

  it("accepts an entry exactly at the raw limit", () => {
    const body = message("edge", "y".repeat(100));
    const items = split(entry({ id: "12", message: body }), 7, encoder.encode(body).length);
    expect(items[0]?.kind).toBe("entry");
  });

  it("stops at a stream that does not start with a From_ line", () => {
    expect(failure(() => split(`X${mbox}`))).toEqual({ code: "takeout_invalid_start", offset: 0 });
  });

  it("stops at an invalid From_ line with its offset", () => {
    for (const date of [
      "Tue Jul 08 09:44:28 2025",
      "Tue Foo 08 09:44:28 +0000 2025",
      "Tue Feb 30 09:44:28 +0000 2025",
      "Mon Jul 08 09:44:28 +0000 2025",
      "Tue Jul 08 24:00:00 +0000 2025",
      "Tue Jul 08 09:44:28 +9900 2025",
      "Thu Jan 01 00:00:00 +0000 0070",
    ])
      expect(
        failure(() => split(entry({ id: "1", date, message: first }))),
        date,
      ).toEqual({
        code: "takeout_invalid_from_line",
        offset: 0,
      });
    expect(failure(() => split(entry({ id: "18446744073709551616", message: first })))).toEqual({
      code: "takeout_invalid_from_line",
      offset: 0,
    });
    expect(failure(() => split("From 1@xxx Tue Jul"))).toEqual({
      code: "takeout_invalid_from_line",
      offset: 0,
    });
  });

  it("applies a negative zone offset", () => {
    const items = split(entry({ id: "1", date: "Sun Jan 01 00:00:00 -0130 2006", message: first }));
    expect(items[0]).toMatchObject({ fromDate: Date.parse("2006-01-01T01:30:00Z") });
  });

  it("stops when the Gmail headers are missing or malformed", () => {
    const missing = `From 1@xxx Tue Jul 08 09:44:28 +0000 2025\r\n${first}\r\n`;
    expect(failure(() => split(missing))).toEqual({
      code: "takeout_invalid_gmail_headers",
      offset: 0,
    });
    const bad = entry({ id: "1", thread: "abc", message: first });
    expect(failure(() => split(bad))).toEqual({ code: "takeout_invalid_gmail_headers", offset: 0 });
    const invalidUtf8 = new Uint8Array([
      ...encoder.encode(
        "From 1@xxx Tue Jul 08 09:44:28 +0000 2025\r\nX-GM-THRID: 1\r\nX-Gmail-Labels: ",
      ),
      0xff,
      ...encoder.encode(`\r\n${first}\r\n`),
    ]);
    expect(failure(() => split(invalidUtf8))).toEqual({
      code: "takeout_invalid_gmail_headers",
      offset: 0,
    });
  });

  it("stops when a line after the labels starts with whitespace", () => {
    // A folded label line and a message whose first line starts with a space look the same.
    for (const size of [1, 64, 10_000])
      expect(
        failure(() => split(entry({ id: "1", message: ` leading\r\n${first}` }), size)),
      ).toEqual({
        code: "takeout_invalid_gmail_headers",
        offset: 0,
      });
  });

  it("stops at a later entry with invalid Gmail headers, at that entry's offset", () => {
    const head = entry({ id: "1", message: first });
    const text = `${head}From 2@xxx Tue Jul 08 09:44:28 +0000 2025\r\nX-GM-THRID: 2\r\nSubject: x\r\n\r\nbody\r\n\r\n`;
    for (const size of [5, 10_000])
      expect(failure(() => split(text, size))).toEqual({
        code: "takeout_invalid_gmail_headers",
        offset: head.length,
      });
  });

  it("returns entries split before an error and throws it on the next call", () => {
    const head = entry({ id: "1", message: first });
    const bad = `From 2@xxx Tue Jul 08 09:44:28 +0000 2025\r\nX-GM-THRID: 2\r\nSubject: x\r\n\r\nbody\r\n\r\n`;
    const splitter = new TakeoutMboxSplitter();
    const items = splitter.push(encoder.encode(head + bad));
    expect(items.map((item) => item.offset)).toEqual([0]);
    expect(decoder.decode((items[0] as TakeoutEntry).raw)).toBe(first);
    const error = failure(() => splitter.end());
    expect(error).toEqual({ code: "takeout_invalid_gmail_headers", offset: head.length });
    expect(failure(() => splitter.push(encoder.encode(mbox)))).toEqual(error);
  });

  it("stops when a message has no final line break before the next entry", () => {
    const head = entry({ id: "1", message: first });
    const text = `${head.slice(0, -2)}${entry({ id: "2", message: second })}`;
    for (const size of [3, 10_000])
      expect(failure(() => split(text, size))).toEqual({
        code: "takeout_missing_separator",
        offset: head.length - 2,
      });
  });

  it("stops at a stream cut off inside the last entry", () => {
    const whole = entry({ id: "1", message: first });
    const headers =
      "From 1@xxx Tue Jul 08 09:44:28 +0000 2025\r\nX-GM-THRID: 1\r\nX-Gmail-Labels: Inbox\r\n";
    for (const cut of [
      whole.slice(0, -2),
      whole.slice(0, -3),
      `${headers}Subject: x\r\n\r\nline1\r\n`,
      headers,
    ])
      expect(failure(() => split(cut))).toEqual({ code: "takeout_missing_separator", offset: 0 });
    expect(failure(() => split(headers.slice(0, -2)))).toEqual({
      code: "takeout_invalid_gmail_headers",
      offset: 0,
    });
  });

  it("stops at Gmail headers over the header limit", () => {
    const labels = "L".repeat(64 * 1024 + 10);
    const text = entry({ id: "1", labels, message: first });
    expect(failure(() => split(text, 4096))).toEqual({ code: "takeout_header_limit", offset: 0 });
  });

  it("ends once and refuses later pushes", () => {
    const splitter = new TakeoutMboxSplitter();
    splitter.push(encoder.encode(mbox));
    expect(splitter.end()).toHaveLength(1);
    expect(splitter.end()).toEqual([]);
    expect(() => splitter.push(encoder.encode("x"))).toThrow();
  });

  it("throws the first error again on every later call", () => {
    const splitter = new TakeoutMboxSplitter();
    splitter.push(encoder.encode(entry({ id: "1", message: first }).slice(0, -2)));
    const error = failure(() => splitter.end());
    expect(error.code).toBe("takeout_missing_separator");
    expect(failure(() => splitter.end())).toEqual(error);
    expect(failure(() => splitter.push(encoder.encode(mbox)))).toEqual(error);
  });
});
