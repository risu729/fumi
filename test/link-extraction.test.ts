import { describe, expect, it } from "vitest";
import {
  decodeAttributeValue,
  extractLinkCandidates,
  LINK_EXTRACTION_LIMITS,
} from "../src/link-extraction.ts";

const urls = (text: string | null, html: string | null = null) =>
  extractLinkCandidates({ text, html }).candidates.map((candidate) => candidate.url);

describe("link extraction from text", () => {
  it("finds http and https URLs and trims prose punctuation", () => {
    expect(
      urls(
        "Download: https://files.example.com/a.pdf. Or (see https://files.example.com/b_(1).zip), " +
          'also "HTTP://Files.Example.com/c?x=1&y=2"! Finally <https://files.example.com/d>.',
      ),
    ).toEqual([
      "https://files.example.com/a.pdf",
      "https://files.example.com/b_(1).zip",
      "http://files.example.com/c?x=1&y=2",
      "https://files.example.com/d",
    ]);
  });

  it("stops at non-ASCII text written directly after a URL", () => {
    expect(urls("こちらhttps://files.example.com/receipt.pdfからダウンロードしてください")).toEqual(
      ["https://files.example.com/receipt.pdf"],
    );
  });

  it("ignores other schemes, lookalike schemes and bare hosts", () => {
    expect(
      urls(
        "ftp://files.example.com/a javascript:alert(1) xhttps://files.example.com/b " +
          "www.example.com/c mailto:someone@example.com",
      ),
    ).toEqual([]);
  });

  it("removes userinfo and fragments and deduplicates", () => {
    const result = extractLinkCandidates({
      text: "https://user:pass@files.example.com/a#one https://files.example.com/a#two",
      html: '<a href="https://files.example.com/a">a</a>',
    });
    expect(result.candidates).toEqual([
      { index: 0, url: "https://files.example.com/a", sources: ["text", "html"] },
    ]);
  });
});

describe("link extraction from HTML", () => {
  it("decodes entities in href values", () => {
    expect(
      urls(
        null,
        '<a href="https://files.example.com/get?a=1&amp;b=2&#38;c=3&#x26;d=4">x</a>' +
          "<a href='https&#58;&sol;&sol;files.example.com/&#x65;'>y</a>",
      ),
    ).toEqual(["https://files.example.com/get?a=1&b=2&c=3&d=4", "https://files.example.com/e"]);
  });

  it("keeps legacy references literal before = or alphanumerics, as HTML does", () => {
    expect(decodeAttributeValue("?a=1&amp=2&ampx&amp/&quot;")).toBe('?a=1&amp=2&ampx&/"');
    expect(decodeAttributeValue("&unknown;&#0;&#x110000;")).toBe("&unknown;\ufffd\ufffd");
  });

  it("handles unquoted, spaced, uppercase and duplicate attributes", () => {
    expect(
      urls(
        null,
        "<A HREF=https://files.example.com/1>1</A>" +
          '<a\nclass="x" href = "https://files.example.com/2" href="https://files.example.com/dup">2</a>' +
          '<area shape=rect href="  https://files.example.com/3\n ">' +
          '<a title="href=https://files.example.com/not-an-attribute">t</a>',
      ),
    ).toEqual([
      "https://files.example.com/1",
      "https://files.example.com/2",
      "https://files.example.com/3",
    ]);
  });

  it("removes tabs and newlines inside href like the URL parser", () => {
    expect(urls(null, '<a href="https://files.exa\tmple.com/a\nb">x</a>')).toEqual([
      "https://files.example.com/ab",
    ]);
  });

  it("ignores comments, raw-text elements, forms, buttons and non-link elements", () => {
    expect(
      urls(
        null,
        '<!-- <a href="https://files.example.com/comment"> -->' +
          "<script>var s = '<a href=\"https://files.example.com/script\">';</script>" +
          '<style>a[href="https://files.example.com/style"]{}</style>' +
          '<textarea><a href="https://files.example.com/textarea"></textarea>' +
          '<form action="https://files.example.com/form"><button formaction="https://files.example.com/button">b</button></form>' +
          '<link href="https://files.example.com/link"><base href="https://files.example.com/">' +
          '<img src="https://files.example.com/img"><a href="/relative">r</a><a href="//files.example.com/p">p</a>' +
          "<a href=\"javascript:location='https://files.example.com/js'\">j</a>" +
          '<a href="https://files.example.com/real">ok</a>',
      ),
    ).toEqual(["https://files.example.com/real"]);
  });

  it("survives unterminated markup", () => {
    expect(urls(null, '<a href="https://files.example.com/a">a</a><a href="https://files')).toEqual(
      ["https://files.example.com/a"],
    );
    expect(urls(null, "<!-- never closed <a href=https://files.example.com/x>")).toEqual([]);
    expect(urls(null, "<script>never closed <a href=https://files.example.com/x>")).toEqual([]);
  });
});

describe("link extraction limits", () => {
  it("caps the number of candidates and reports truncation", () => {
    const text = Array.from(
      { length: LINK_EXTRACTION_LIMITS.candidates + 5 },
      (_, index) => `https://files.example.com/${index}`,
    ).join(" ");
    const result = extractLinkCandidates({ text, html: null });
    expect(result.candidates).toHaveLength(LINK_EXTRACTION_LIMITS.candidates);
    expect(result.candidates.at(-1)?.index).toBe(LINK_EXTRACTION_LIMITS.candidates - 1);
    expect(result.truncated).toBe(true);
  });

  it("drops URLs longer than the length cap", () => {
    const long = `https://files.example.com/${"a".repeat(LINK_EXTRACTION_LIMITS.urlLength)}`;
    const huge = `https://files.example.com/${"b".repeat(LINK_EXTRACTION_LIMITS.urlLength * 5)}`;
    const result = extractLinkCandidates({
      text: `${long} ${huge} https://files.example.com/ok`,
      html: null,
    });
    expect(result.candidates.map((candidate) => candidate.url)).toEqual([
      "https://files.example.com/ok",
    ]);
    expect(result.tooLong).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("scans a large body in bounded time", () => {
    const html = `${"<a href=x ".repeat(50_000)}<p>${"&amp;".repeat(100_000)}`;
    const started = Date.now();
    expect(extractLinkCandidates({ text: "h".repeat(1_000_000), html }).candidates).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("trims a long run of closing brackets in linear time", () => {
    // Each trimmed bracket used to recount the whole URL, so this took minutes.
    const text = `https://files.example.com/a${")".repeat(100_000)}${"]".repeat(100_000)}.`;
    const started = Date.now();
    expect(extractLinkCandidates({ text, html: null }).candidates).toEqual([
      { index: 0, url: "https://files.example.com/a", sources: ["text"] },
    ]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
