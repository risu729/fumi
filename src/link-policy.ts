/**
 * Hard limits for fetching a link from mail. They run in code on every URL that
 * would be fetched, including each redirect `Location`, whatever a model chose.
 * No function here resolves names, contacts a host or logs anything.
 */
import { normalizeLinkUrl } from "./link-extraction.ts";

export type LinkPolicyRefusal = "blocked_action_url" | "blocked_destination" | "pending_login";
export type LinkPolicyResult = { ok: true; url: URL } | { ok: false; outcome: LinkPolicyRefusal };

/** Longest URL, in UTF-16 code units, that is ever requested, including redirects. */
export const LINK_REQUEST_URL_LENGTH = 8192;

/**
 * Stems matched against the compacted path and query (see `compactPathAndQuery`).
 * Each is a substring of the action words it covers:
 * `unsub` unsubscribe; `optout` opt-out, opt_out, optout; `confirm` confirm,
 * confirmation; `verif` verify, verification, verified; `activat` activate,
 * activation; `accept` accept, accepted, acceptance; `declin` decline, declined;
 * `reset` reset.
 */
export const ACTION_STEMS = [
  "unsub",
  "optout",
  "confirm",
  "verif",
  "activat",
  "accept",
  "declin",
  "reset",
] as const;
/** Login stems. A match means the link needs a login, so it is `pending_login`. */
export const LOGIN_STEMS = ["login", "logon"] as const;

const maxDecodeRounds = 4;
const utf8 = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

/** Decode every `%XX` as a byte, leaving malformed escapes literal, then read the
 * bytes as UTF-8 with replacement characters. */
function percentDecode(value: string): string {
  if (!value.includes("%")) return value;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let index = 0; index < value.length; index++) {
    const character = value[index] ?? "";
    if (character === "%" && /^[0-9A-Fa-f]{2}$/u.test(value.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(value.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      const code = value.codePointAt(index) ?? 0;
      if (code > 0xffff) index++;
      for (const byte of encoder.encode(String.fromCodePoint(code))) bytes.push(byte);
    }
  }
  return utf8.decode(new Uint8Array(bytes));
}

/**
 * The form the action rule matches against: the URL's path and query, with `+`
 * read as a space, percent-decoded up to four times (until it stops changing),
 * NFKC-normalized (so full-width letters become ASCII), lowercased, and with every
 * character other than `a-z` and `0-9` removed. Separators, encoded or not, can
 * therefore not split a word: `un-subscribe`, `un%2Dsubscribe`, `Un%252Dsubscribe`,
 * `ｕｎｓｕｂｓｃｒｉｂｅ` and `un%00subscribe` all compact to `unsubscribe`.
 */
export function compactPathAndQuery(url: URL): string {
  let value = `${url.pathname}${url.search}`.replaceAll("+", " ");
  for (let round = 0; round < maxDecodeRounds; round++) {
    const decoded = percentDecode(value);
    if (decoded === value) break;
    value = decoded;
  }
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "");
}

/** `blocked_action_url`, `pending_login` or null for a URL's path and query. Action
 * stems win over login stems, so a password-reset login link is refused. */
export function actionRefusal(url: URL): "blocked_action_url" | "pending_login" | null {
  const compact = compactPathAndQuery(url);
  if (ACTION_STEMS.some((stem) => compact.includes(stem))) return "blocked_action_url";
  if (LOGIN_STEMS.some((stem) => compact.includes(stem))) return "pending_login";
  return null;
}

function ipv4Value(hostname: string): number | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

// IPv4 ranges that are not globally reachable or are special-purpose
// (IANA IPv4 Special-Purpose Address Registry, plus multicast and reserved).
const blockedIpv4: [number, number][] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT shared address space
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, including cloud metadata addresses
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // deprecated 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, including 255.255.255.255 broadcast
].map(([address, prefix]) => [ipv4Value(address as string) ?? 0, prefix as number]);

export function isBlockedIpv4(hostname: string): boolean {
  const value = ipv4Value(hostname);
  if (value === null) return false;
  return blockedIpv4.some(
    ([network, prefix]) =>
      Math.floor(value / 2 ** (32 - prefix)) === Math.floor(network / 2 ** (32 - prefix)),
  );
}

/** Parse the bracketed IPv6 host that the URL parser serializes into eight
 * 16-bit groups, or null. */
function ipv6Groups(hostname: string): number[] | null {
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return null;
  let body = hostname.slice(1, -1);
  // The URL parser never serializes a dotted tail, but accept one defensively.
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/u.exec(body);
  if (dotted) {
    const value = ipv4Value(dotted[2] ?? "");
    if (value === null) return null;
    body = `${dotted[1]}${Math.floor(value / 65536).toString(16)}:${(value % 65536).toString(16)}`;
  }
  const halves = body.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":"));
  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/iu.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
}

/**
 * Only global unicast `2000::/3` is allowed, minus its special-purpose blocks.
 * Everything else is refused, including `::`, `::1`, IPv4-mapped `::ffff:0:0/96`
 * (whatever IPv4 address it embeds), IPv4-compatible `::/96`, NAT64 `64:ff9b::/96`,
 * discard `100::/64`, ULA `fc00::/7`, link-local `fe80::/10`, site-local
 * `fec0::/10` and multicast `ff00::/8`.
 */
export function isBlockedIpv6(hostname: string): boolean {
  const groups = ipv6Groups(hostname);
  if (!groups) return hostname.startsWith("[");
  const [first = 0, second = 0] = groups;
  if (first < 0x2000 || first > 0x3fff) return true;
  if (first === 0x2001 && second < 0x0200) return true; // 2001::/23 IETF protocol assignments, incl. Teredo
  if (first === 0x2001 && second === 0x0db8) return true; // 2001:db8::/32 documentation
  if (first === 0x2002) return true; // 2002::/16 6to4, embeds an IPv4 address
  if (first === 0x3fff && second < 0x1000) return true; // 3fff::/20 documentation
  return false;
}

// Names that resolve only on a local machine or private network, or are reserved.
const blockedSuffixes = [
  "localhost",
  "local",
  "localdomain",
  "internal",
  "intranet",
  "private",
  "corp",
  "home",
  "lan",
  "arpa", // includes home.arpa and reverse-lookup names
  "test",
  "invalid",
  "onion",
  "alt",
];
// Four dotted or dashed numbers between dots, dashes or the ends of the name, as
// used by wildcard DNS services that resolve `10.0.0.1.example`, `10-0-0-1.example`
// or `app-10-0-0-1.example` to the embedded address.
const embeddedIpv4 = /(?:^|[.-])(?:\d{1,3}[.-]){3}\d{1,3}(?:[.-]|$)/u;

/** Hostname rule only. The URL parser has already canonicalized IPv4 in decimal,
 * octal, hexadecimal and short forms, mapped full-width characters and applied IDNA. */
export function isBlockedHostname(hostname: string): boolean {
  if (hostname.startsWith("[")) return isBlockedIpv6(hostname);
  // Trailing dots are trimmed with a loop: `/\.+$/` backtracks quadratically on a
  // long run of dots that is followed by another character.
  let end = hostname.length;
  while (end > 0 && hostname[end - 1] === ".") end--;
  const name = hostname.slice(0, end);
  if (ipv4Value(name) !== null) return isBlockedIpv4(name);
  if (!name.includes(".")) return true; // single label, for example `metadata`
  if (!/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/u.test(name)) return true;
  if (/^[0-9.]+$/u.test(name)) return true; // numeric but not a canonical IPv4
  if (embeddedIpv4.test(name)) return true;
  return blockedSuffixes.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

/**
 * Check one URL against every hard limit and return the URL to request: http or
 * https only, no userinfo or fragment, the scheme's default port, a public
 * destination, and no action word in the path or query. Use it for the chosen
 * candidate and again for each redirect `Location`.
 */
export function checkLinkUrl(value: string | URL): LinkPolicyResult {
  const href = typeof value === "string" ? value : value.href;
  // Redirect targets such as signed storage URLs can be longer than a mail candidate.
  if (href.length > LINK_REQUEST_URL_LENGTH) return { ok: false, outcome: "blocked_destination" };
  const url = normalizeLinkUrl(href);
  if (!url || url.href.length > LINK_REQUEST_URL_LENGTH)
    return { ok: false, outcome: "blocked_destination" };
  if (url.port !== "" || isBlockedHostname(url.hostname))
    return { ok: false, outcome: "blocked_destination" };
  const action = actionRefusal(url);
  if (action) return { ok: false, outcome: action };
  return { ok: true, url };
}
