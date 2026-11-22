import { describe, expect, it } from "vitest";
import { fetchLinkFile, LINK_FETCH_LIMITS, mediaTypeEssence } from "../src/link-fetch.ts";

type Handler = (request: Request) => Response | Promise<Response>;

/** A local fetch mock. It builds a real Request so workerd validates every option,
 * records each request and never contacts a network. */
function mockFetch(routes: Record<string, Handler>) {
  const requests: Request[] = [];
  const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    const handler = routes[request.url];
    if (!handler) throw new Error("unexpected request");
    return handler(request);
  }) as typeof fetch;
  return { send, requests };
}

const file =
  (body: BodyInit, type = "application/pdf", status = 200) =>
  () =>
    new Response(body, { status, headers: { "Content-Type": type } });
const redirect =
  (location: string, status = 302) =>
  () =>
    new Response("moved", { status, headers: { Location: location } });

async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

describe("link fetch", () => {
  it("returns the file with provenance and sends a plain GET", async () => {
    const body = new TextEncoder().encode("%PDF-1.7 synthetic");
    const { send, requests } = mockFetch({
      "https://files.example.com/r.pdf": file(body, "Application/PDF; name=r.pdf"),
    });
    const result = await fetchLinkFile("https://user:pw@files.example.com/r.pdf#x", {
      fetch: send,
      now: () => Date.UTC(2026, 10, 22, 9, 20),
    });
    expect(result).toEqual({
      ok: true,
      bytes: body,
      provenance: {
        finalUrl: "https://files.example.com/r.pdf",
        redirects: 0,
        fetchedAt: "2026-11-22T09:20:00.000Z",
        status: 200,
        size: body.byteLength,
        mimeType: "application/pdf",
        sha256: await sha256(body),
      },
    });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.method).toBe("GET");
    expect(request?.redirect).toBe("manual");
    expect([...(request?.headers.keys() ?? [])]).toEqual([]);
  });

  it("refuses action and private URLs before any request", async () => {
    const { send, requests } = mockFetch({});
    expect(await fetchLinkFile("https://files.example.com/unsubscribe", { fetch: send })).toEqual({
      ok: false,
      outcome: "blocked_action_url",
    });
    expect(await fetchLinkFile("http://169.254.169.254/", { fetch: send })).toEqual({
      ok: false,
      outcome: "blocked_destination",
    });
    expect(await fetchLinkFile("https://files.example.com/login", { fetch: send })).toEqual({
      ok: false,
      outcome: "pending_login",
    });
    expect(requests).toEqual([]);
  });

  it("follows redirects, checking each hop", async () => {
    const body = new Uint8Array([1, 2, 3]);
    const { send, requests } = mockFetch({
      "https://short.example.com/x": redirect("https://cdn.example.com/a", 301),
      "https://cdn.example.com/a": redirect("/b?sig=1", 307),
      "https://cdn.example.com/b?sig=1": file(body, "application/zip"),
    });
    const result = await fetchLinkFile("https://short.example.com/x", { fetch: send });
    expect(result.ok && result.provenance).toMatchObject({
      finalUrl: "https://cdn.example.com/b?sig=1",
      redirects: 2,
      mimeType: "application/zip",
    });
    expect(requests.map((request) => request.url)).toEqual([
      "https://short.example.com/x",
      "https://cdn.example.com/a",
      "https://cdn.example.com/b?sig=1",
    ]);
  });

  it.each([
    ["http://127.0.0.1/file", "blocked_destination"],
    ["http://[::ffff:a00:1]/file", "blocked_destination"],
    ["https://files.example.com:8080/file", "blocked_destination"],
    ["ftp://files.example.com/file", "blocked_destination"],
    ["https://files.example.com/account/verify?t=1", "blocked_action_url"],
    ["https://files.example.com/sso/login?return=/file", "pending_login"],
  ])("never contacts a refused Location %s", async (location, expected) => {
    const { send, requests } = mockFetch({
      "https://files.example.com/start": redirect(location),
    });
    expect(await fetchLinkFile("https://files.example.com/start", { fetch: send })).toEqual({
      ok: false,
      outcome: expected,
    });
    expect(requests.map((request) => request.url)).toEqual(["https://files.example.com/start"]);
  });

  it("stops at the redirect cap without contacting the next Location", async () => {
    const routes: Record<string, Handler> = {};
    for (let hop = 0; hop <= LINK_FETCH_LIMITS.maxRedirects + 1; hop++)
      routes[`https://files.example.com/${hop}`] = redirect(`/${hop + 1}`);
    const { send, requests } = mockFetch(routes);
    expect(await fetchLinkFile("https://files.example.com/0", { fetch: send })).toEqual({
      ok: false,
      outcome: "redirect_limit",
    });
    expect(requests).toHaveLength(LINK_FETCH_LIMITS.maxRedirects + 1);
  });

  it("accepts exactly the redirect cap", async () => {
    const routes: Record<string, Handler> = { "https://files.example.com/2": file("ok") };
    for (let hop = 0; hop < 2; hop++)
      routes[`https://files.example.com/${hop}`] = redirect(`/${hop + 1}`);
    const { send } = mockFetch(routes);
    const result = await fetchLinkFile("https://files.example.com/0", {
      fetch: send,
      limits: { maxRedirects: 2 },
    });
    expect(result.ok && result.provenance.redirects).toBe(2);
  });

  it("refuses HTML pages, by type or by content", async () => {
    const { send } = mockFetch({
      "https://files.example.com/html": file(
        "<p>Click to download</p>",
        "text/html; charset=utf-8",
      ),
      "https://files.example.com/xhtml": file("<html/>", "application/xhtml+xml"),
      "https://files.example.com/sniffed": file(
        "\ufeff\n  <!DOCTYPE html><form></form>",
        "application/octet-stream",
      ),
      "https://files.example.com/untyped": () =>
        new Response(new TextEncoder().encode("<HTML><body>")),
      // A byte order mark and "<html>" in UTF-16LE.
      "https://files.example.com/utf16": () =>
        new Response(
          new Uint8Array([0xff, 0xfe, 0x3c, 0, 0x68, 0, 0x74, 0, 0x6d, 0, 0x6c, 0, 0x3e, 0]),
        ),
    });
    for (const path of ["html", "xhtml", "sniffed", "untyped", "utf16"])
      // oxlint-disable-next-line no-await-in-loop -- Sequential cases against one mock.
      expect(await fetchLinkFile(`https://files.example.com/${path}`, { fetch: send })).toEqual({
        ok: false,
        outcome: "pending_html",
      });
  });

  it.each([
    "<!-- page -->\n<!DOCTYPE html><html>",
    "<!DOCTYPE\nhtml>",
    "<!doctype  HTML>",
    "<html>",
    "<HEAD><title>Sign in</title>",
    "  <body onload=x>",
    "<script>location.href='/'</script>",
    "<iframe src=/>",
    "<TITLE>Download</TITLE>",
    "<div>",
    "<p>Click",
    "<a href=/f>",
    "<br>",
  ])("sniffs %j as an HTML page whatever its declared type", async (page) => {
    const { send } = mockFetch({
      "https://files.example.com/page": file(page, "application/octet-stream"),
    });
    expect(await fetchLinkFile("https://files.example.com/page", { fetch: send })).toEqual({
      ok: false,
      outcome: "pending_html",
    });
  });

  it.each([
    ["<?xml version='1.0'?><Invoice/>", "application/xml"],
    ["<abbr>", "text/plain"],
    ["<pre>", "text/plain"],
    ["%PDF-1.7 <html>", "application/pdf"],
  ])("keeps %j, which is not an HTML start", async (content, type) => {
    const { send } = mockFetch({ "https://files.example.com/f": file(content, type) });
    const result = await fetchLinkFile("https://files.example.com/f", { fetch: send });
    expect(result.ok && result.provenance.mimeType).toBe(type);
  });

  it("does not wait for a refused response body to cancel", async () => {
    const stuck = new ReadableStream<Uint8Array>({
      pull() {},
      cancel: () => new Promise<void>(() => undefined),
    });
    const { send } = mockFetch({
      "https://files.example.com/stuck": () => new Response(stuck, { status: 404 }),
    });
    expect(
      await fetchLinkFile("https://files.example.com/stuck", {
        fetch: send,
        limits: { timeoutMs: 50 },
      }),
    ).toEqual({ ok: false, outcome: "http_404" });
  });

  it("maps login challenges and HTTP errors to fixed outcomes", async () => {
    const { send } = mockFetch({
      "https://files.example.com/401": file("", "text/plain", 401),
      "https://files.example.com/challenge": () =>
        new Response(null, { status: 403, headers: { "WWW-Authenticate": "Basic" } }),
      "https://files.example.com/404": file("missing", "text/plain", 404),
      "https://files.example.com/204": () => new Response(null, { status: 204 }),
      "https://files.example.com/304": () => new Response(null, { status: 304 }),
      "https://files.example.com/no-location": () => new Response(null, { status: 302 }),
    });
    const outcomes = [];
    for (const path of ["401", "challenge", "404", "204", "304", "no-location"]) {
      // oxlint-disable-next-line no-await-in-loop -- Sequential cases against one mock.
      const result = await fetchLinkFile(`https://files.example.com/${path}`, { fetch: send });
      outcomes.push(result.ok ? "ok" : result.outcome);
    }
    expect(outcomes).toEqual([
      "pending_login",
      "pending_login",
      "http_404",
      "http_204",
      "http_304",
      "http_302",
    ]);
  });

  it("caps a streaming body without reading past the limit", async () => {
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { send } = mockFetch({
      "https://files.example.com/endless": () =>
        new Response(stream, { headers: { "Content-Type": "application/zip" } }),
    });
    expect(
      await fetchLinkFile("https://files.example.com/endless", {
        fetch: send,
        limits: { maxBytes: 10 * 1024 },
      }),
    ).toEqual({ ok: false, outcome: "too_large" });
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(20);
  });

  it("refuses a declared length over the cap before reading", async () => {
    const { send } = mockFetch({
      "https://files.example.com/big": () =>
        new Response("x".repeat(64), {
          headers: { "Content-Type": "application/zip", "Content-Length": "64" },
        }),
    });
    expect(
      await fetchLinkFile("https://files.example.com/big", {
        fetch: send,
        limits: { maxBytes: 63 },
      }),
    ).toEqual({ ok: false, outcome: "too_large" });
  });

  it("accepts a body of exactly the cap", async () => {
    const { send } = mockFetch({ "https://files.example.com/exact": file("x".repeat(64)) });
    const result = await fetchLinkFile("https://files.example.com/exact", {
      fetch: send,
      limits: { maxBytes: 64 },
    });
    expect(result.ok && result.provenance.size).toBe(64);
  });

  it("times out while waiting for headers", async () => {
    const send = ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      return new Promise<Response>((_, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), {
          once: true,
        });
      });
    }) as typeof fetch;
    expect(
      await fetchLinkFile("https://files.example.com/slow", {
        fetch: send,
        limits: { timeoutMs: 50 },
      }),
    ).toEqual({ ok: false, outcome: "timeout" });
  });

  it("times out while reading a stalled body", async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8));
      },
    });
    const { send } = mockFetch({
      "https://files.example.com/stalled": () =>
        new Response(stalled, { headers: { "Content-Type": "application/zip" } }),
    });
    expect(
      await fetchLinkFile("https://files.example.com/stalled", {
        fetch: send,
        limits: { timeoutMs: 50 },
      }),
    ).toEqual({ ok: false, outcome: "timeout" });
  });

  it("reports a network failure without its cause", async () => {
    const send = (() =>
      Promise.reject(new TypeError("https://files.example.com/secret?token=1"))) as typeof fetch;
    expect(
      await fetchLinkFile("https://files.example.com/secret?token=1", { fetch: send }),
    ).toEqual({
      ok: false,
      outcome: "network_error",
    });
  });

  it("parses media type essences strictly", () => {
    expect(mediaTypeEssence("Application/PDF ; q=1")).toBe("application/pdf");
    expect(mediaTypeEssence(null)).toBeNull();
    expect(mediaTypeEssence("pdf")).toBeNull();
    expect(mediaTypeEssence("text/html<script>")).toBeNull();
  });
});
