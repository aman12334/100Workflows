import { isIP } from "node:net";

/**
 * Which URLs and network addresses the web-fetch tool may reach.
 *
 * Two layers, both required:
 *  1. checkUrl(): the URL itself (scheme, credentials, port, obviously local names, literal IPs).
 *  2. isPublicAddress(): every address a hostname resolves to, checked again at
 *     connection time (see http-fetch.ts), so DNS rebinding can't swap in a
 *     private address after the check.
 * Redirect targets go through both layers again.
 */

export const ALLOWED_PORTS = new Set([80, 443]);
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".private", ".test", ".invalid", ".example"];
const LOCAL_NAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback", "metadata", "metadata.google.internal"]);

export class UrlRejected extends Error {}

/** A URL that passed the syntactic checks, normalised (no fragment). */
/** `ports` is replaceable only so tests can reach a local test server; production allows 80 and 443. */
export function checkUrl(raw: string, ports: ReadonlySet<number> = ALLOWED_PORTS): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UrlRejected("not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UrlRejected(`only http and https URLs can be fetched, not ${url.protocol.replace(":", "")}`);
  if (url.username || url.password) throw new UrlRejected("URLs with embedded credentials are not allowed");
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!ports.has(port)) throw new UrlRejected(`port ${port} is not allowed; only 80 and 443`);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) throw new UrlRejected("the URL has no host");
  if (LOCAL_NAMES.has(host) || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) throw new UrlRejected(`"${host}" is a local or reserved name`);
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new UrlRejected(`${host} is a private, loopback or reserved address`);
  } else if (!host.includes(".")) {
    throw new UrlRejected(`"${host}" is not a public hostname`);
  } else if (/^[0-9.]+$/.test(host) || /^0x/i.test(host)) {
    throw new UrlRejected(`"${host}" looks like an encoded IP address`);
  }
  url.hash = "";
  return url;
}

function v4Parts(ip: string): number[] | null {
  const parts = ip.split(".").map(Number);
  return parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255) ? parts : null;
}

function publicV4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127) return false; // "this" network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF protocol assignments, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** Expands an IPv6 address to 8 groups of 16 bits; null if it isn't one. */
function v6Groups(ip: string): number[] | null {
  let addr = ip.toLowerCase().split("%")[0];
  const v4 = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const p = v4Parts(v4[1]);
    if (!p) return null;
    addr = addr.slice(0, -v4[1].length) + `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const [head, tail] = addr.split("::");
  if (addr.split("::").length > 2) return null;
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail ? tail.split(":") : [];
  const fill = addr.includes("::") ? 8 - h.length - t.length : 0;
  const groups = [...h, ...Array(fill).fill("0"), ...t].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** True only for globally routable unicast addresses. Anything unparseable is treated as not public. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const p = v4Parts(ip);
    return p !== null && publicV4(p);
  }
  if (family !== 6) return false;
  const g = v6Groups(ip);
  if (!g) return false;
  if (g.every((x) => x === 0)) return false; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible: judge the embedded IPv4 address.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return publicV4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
  }
  if (g[0] === 0x64 && g[1] === 0xff9b) return publicV4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]); // NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((g[0] & 0xff00) === 0xff00) return false; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x2002) return false; // 6to4 can embed private IPv4
  if (g[0] === 0x2001 && g[1] === 0) return false; // Teredo
  return (g[0] & 0xe000) === 0x2000; // global unicast 2000::/3
}
