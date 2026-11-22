import { describe, expect, it } from "vitest";
import {
  checkLinkUrl,
  compactPathAndQuery,
  isBlockedHostname,
  LINK_REQUEST_URL_LENGTH,
  isBlockedIpv4,
  isBlockedIpv6,
} from "../src/link-policy.ts";
import { workerDomain, workerZone } from "../worker-domain.ts";

const outcome = (url: string) => {
  const result = checkLinkUrl(url);
  return result.ok ? result.url.href : result.outcome;
};

describe("action URL rule", () => {
  it.each([
    "https://files.example.com/unsubscribe?id=1",
    "https://files.example.com/list/UnSubscribe",
    "https://files.example.com/u?action=unsub",
    "https://files.example.com/opt-out",
    "https://files.example.com/opt_out",
    "https://files.example.com/x?Opt+Out=1",
    "https://files.example.com/confirm-email",
    "https://files.example.com/account/confirmation/abc",
    "https://files.example.com/verify?token=x",
    "https://files.example.com/email-verification",
    "https://files.example.com/activate",
    "https://files.example.com/invite/accept",
    "https://files.example.com/invite/decline",
    "https://files.example.com/declined",
    "https://files.example.com/password/reset?t=1",
  ])("refuses %s", (url) => {
    expect(outcome(url)).toBe("blocked_action_url");
  });

  it.each([
    ["separator", "https://files.example.com/un-subscribe"],
    ["dot", "https://files.example.com/un.subscribe"],
    ["percent-encoded letter", "https://files.example.com/%75nsubscribe"],
    ["percent-encoded separator", "https://files.example.com/un%2Dsubscribe"],
    ["double encoding", "https://files.example.com/un%252Dsubscribe"],
    ["triple encoding", "https://files.example.com/%2525%37%35nsubscribe"],
    ["encoded slash", "https://files.example.com/opt%2Fout"],
    ["NUL byte", "https://files.example.com/un%00subscribe"],
    ["overlong UTF-8", "https://files.example.com/un%C0%AEsubscribe"],
    ["soft hyphen", "https://files.example.com/un%C2%ADsubscribe"],
    ["full-width letters", "https://files.example.com/ｕｎｓｕｂｓｃｒｉｂｅ"],
    ["encoded full-width letters", "https://files.example.com/%EF%BD%95nsubscribe"],
    ["mixed case", "https://files.example.com/VeRiFy"],
    ["query key", "https://files.example.com/file.pdf?reset"],
    ["query value", "https://files.example.com/file.pdf?a=b&mode=ac%63ept"],
    ["path parameter", "https://files.example.com/file;action=confirm"],
    ["dot segments", "https://files.example.com/x/../activate"],
    ["plus as space", "https://files.example.com/x?a=de+cline"],
  ])("refuses an action hidden by %s", (_, url) => {
    expect(outcome(url)).toBe("blocked_action_url");
  });

  it("compacts path and query only, not the host or fragment", () => {
    expect(
      compactPathAndQuery(new URL("https://unsubscribe.example.com/a%2Db?C=%2564#reset")),
    ).toBe("abcd");
    expect(outcome("https://reset.example.com/files/report.pdf#confirm")).toBe(
      "https://reset.example.com/files/report.pdf",
    );
  });

  it("marks login links pending without refusing them as actions", () => {
    expect(outcome("https://files.example.com/login?next=/doc.pdf")).toBe("pending_login");
    expect(outcome("https://files.example.com/Log-In")).toBe("pending_login");
    expect(outcome("https://files.example.com/logon.aspx")).toBe("pending_login");
    // Action words win over login words.
    expect(outcome("https://files.example.com/login/reset")).toBe("blocked_action_url");
  });

  it("allows ordinary download URLs", () => {
    expect(outcome("https://files.example.com/receipts/2026-11.pdf?sig=AbC123")).toBe(
      "https://files.example.com/receipts/2026-11.pdf?sig=AbC123",
    );
  });
});

describe("destination rule", () => {
  it.each([
    "http://127.0.0.1/a",
    "http://127.1/a",
    "http://2130706433/a",
    "http://0x7f000001/a",
    "http://0x7f.0.0.1/a",
    "http://0177.0.0.1/a",
    "http://017700000001/a",
    "http://127.0.0.1./a",
    "http://0.0.0.0/a",
    "http://10.1.2.3/a",
    "http://172.16.0.1/a",
    "http://172.31.255.255/a",
    "http://192.168.1.1/a",
    "http://169.254.169.254/latest/meta-data",
    "http://100.64.0.1/a",
    "http://100.127.255.255/a",
    "http://192.0.0.8/a",
    "http://198.18.0.1/a",
    "http://224.0.0.1/a",
    "http://239.255.255.250/a",
    "http://255.255.255.255/a",
    "http://[::1]/a",
    "http://[::]/a",
    "http://[0:0:0:0:0:0:0:1]/a",
    "http://[::ffff:127.0.0.1]/a",
    "http://[::ffff:7f00:1]/a",
    "http://[::ffff:8.8.8.8]/a",
    "http://[::127.0.0.1]/a",
    "http://[64:ff9b::a00:1]/a",
    "http://[fc00::1]/a",
    "http://[fd12:3456::1]/a",
    "http://[fe80::1]/a",
    "http://[febf::1]/a",
    "http://[fec0::1]/a",
    "http://[ff02::1]/a",
    "http://[2001:db8::1]/a",
    "http://[2001::1]/a",
    "http://[2002:7f00:1::]/a",
    "http://localhost/a",
    "http://LOCALHOST./a",
    "http://ｌｏｃａｌｈｏｓｔ/a",
    "http://app.localhost/a",
    "http://printer.local/a",
    "http://metadata.google.internal/a",
    "http://router.lan/a",
    "http://nas.home.arpa/a",
    "http://1.0.0.127.in-addr.arpa/a",
    "http://example.test/a",
    "http://example.invalid/a",
    "http://metadata/a",
    "http://intranet./a",
    "http://10.0.0.1.nip.example/a",
    "http://10-0-0-1.sslip.example/a",
    "http://app-10-0-0-1.nip.example/a",
    "http://app-169-254-169-254-x.nip.example/a",
    "http://customer-10.0.0.1.nip.example/a",
    "http://192.31.196.1/a",
    "http://192.52.193.1/a",
    "http://192.175.48.1/a",
    "https://takuk.me/a",
    "https://fumi.takuk.me/mcp",
    "https://FUMI.TAKUK.ME./mcp",
    "https://files.takuk.me/a.pdf",
    "https://a.b.takuk.me/a.pdf",
    "https://workers.dev/a",
    "https://fumi.example.workers.dev/a",
    "https://WORKERS.DEV./a",
    "https://files.example.com:8443/a",
    "http://files.example.com:443/a",
    "ftp://files.example.com/a",
    "file:///etc/passwd",
    "data:text/plain,x",
    "javascript:alert(1)",
    "not a url",
  ])("refuses %s", (url) => {
    expect(outcome(url)).toBe("blocked_destination");
  });

  it.each([
    "https://files.example.com/a",
    "http://files.example.com:80/a",
    "https://files.example.com:443/a",
    "https://files.example.com./a",
    "https://8.8.8.8/a",
    "https://[2606:4700::1111]/a",
    "https://xn--r8jz45g.example/a",
    "https://cdn-1.files.example.com/a",
    "https://v1-2-3.files.example.com/a",
    "https://files-2026-11-22-1.example.com/a",
    "https://nottakuk.me/a",
    "https://takuk.me.example.com/a",
    "https://myworkers.dev/a",
    "https://workers.dev.example.com/a",
  ])("allows %s", (url) => {
    expect(checkLinkUrl(url).ok).toBe(true);
  });

  it("strips userinfo and fragments from the URL to request", () => {
    expect(outcome("https://user:secret@files.example.com/a#part")).toBe(
      "https://files.example.com/a",
    );
  });

  it("caps the length of any URL to request", () => {
    const base = "https://files.example.com/";
    expect(checkLinkUrl(`${base}${"a".repeat(LINK_REQUEST_URL_LENGTH - base.length)}`).ok).toBe(
      true,
    );
    expect(outcome(`${base}${"a".repeat(LINK_REQUEST_URL_LENGTH - base.length + 1)}`)).toBe(
      "blocked_destination",
    );
  });

  it("classifies range edges exactly", () => {
    expect(isBlockedIpv4("172.15.255.255")).toBe(false);
    expect(isBlockedIpv4("172.32.0.0")).toBe(false);
    expect(isBlockedIpv4("100.63.255.255")).toBe(false);
    expect(isBlockedIpv4("100.128.0.0")).toBe(false);
    expect(isBlockedIpv4("223.255.255.255")).toBe(false);
    expect(isBlockedIpv4("192.31.195.255")).toBe(false);
    expect(isBlockedIpv4("192.31.197.0")).toBe(false);
    expect(isBlockedIpv4("192.52.192.255")).toBe(false);
    expect(isBlockedIpv4("192.52.194.0")).toBe(false);
    expect(isBlockedIpv4("192.175.47.255")).toBe(false);
    expect(isBlockedIpv4("192.175.49.0")).toBe(false);
    expect(isBlockedIpv6("[1fff:ffff::1]")).toBe(true);
    expect(isBlockedIpv6("[2001:200::1]")).toBe(false);
    expect(isBlockedIpv6("[3fff:1000::1]")).toBe(false);
    expect(isBlockedIpv6("[4000::1]")).toBe(true);
    expect(isBlockedIpv6("[not:an:address]")).toBe(true);
    expect(isBlockedHostname("files.example.com")).toBe(false);
  });

  it("refuses the Worker's configured domain and every name in its zone", () => {
    expect(isBlockedHostname(workerDomain)).toBe(true);
    expect(isBlockedHostname(workerZone)).toBe(true);
    expect(isBlockedHostname(`any.${workerZone}`)).toBe(true);
    expect(isBlockedHostname(`not${workerZone}`)).toBe(false);
  });

  it("ignores any number of trailing dots in a hostname", () => {
    expect(isBlockedHostname("files.example.com.")).toBe(false);
    expect(isBlockedHostname("files.example.com...")).toBe(false);
    expect(isBlockedHostname("10.0.0.1..")).toBe(true);
    expect(isBlockedHostname("localhost..")).toBe(true);
    expect(isBlockedHostname("...")).toBe(true);
    expect(isBlockedHostname("...files.example.com")).toBe(true);
  });
});
