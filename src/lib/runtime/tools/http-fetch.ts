import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import zlib from "node:zlib";
import { ALLOWED_PORTS, checkUrl, isPublicAddress, UrlRejected } from "./url-guard";

/**
 * Read-only HTTP GET for public web pages, with SSRF protection.
 *
 *  - URLs and every redirect target pass checkUrl().
 *  - The hostname is resolved by our own lookup, which rejects the connection
 *    unless every resolved address is public; the socket connects to the
 *    address that was checked, so DNS rebinding can't redirect it afterwards.
 *  - At most MAX_REDIRECTS redirects, a hard byte limit (compressed and
 *    decompressed), a total time limit, and only text-like content types.
 *  - No cookies, no credentials, no request body, GET only.
 */

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  bytes: number;
  redirects: number;
}

export interface FetchOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}

/** What the web-fetch tool calls. Tests replace it; production uses safeFetch. */
export type PageTransport = (url: string, options: FetchOptions) => Promise<FetchedPage>;

export class FetchFailed extends Error {
  constructor(
    message: string,
    /** Whether trying again might succeed (timeouts, 5xx, connection resets). */
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export const MAX_REDIRECTS = 3;
export const DEFAULT_MAX_BYTES = 2_000_000;
export const DEFAULT_TIMEOUT_MS = 15_000;
const TEXT_TYPES = /^(text\/html|text\/plain|application\/xhtml\+xml|application\/xml|text\/xml|application\/json|text\/markdown)\b/i;
const USER_AGENT = "100Workflows/1.0 (+local research tool; read-only)";

/** Resolves a hostname and refuses to connect unless every address is public. Exported for tests. */
export function guardedLookup(isAllowed: (ip: string) => boolean = isPublicAddress, resolver: typeof dnsLookup = dnsLookup): LookupFunction {
  return (hostname, options, callback) => {
    resolver(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err, "", 0);
      const list = (Array.isArray(addresses) ? addresses : [{ address: addresses as unknown as string, family: 4 }]) as LookupAddress[];
      if (!list.length) return callback(new UrlRejected(`${hostname} did not resolve`), "", 0);
      const blocked = list.find((a) => !isAllowed(a.address));
      if (blocked) return callback(new UrlRejected(`${hostname} resolves to ${blocked.address}, a private or reserved address`), "", 0);
      if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
      callback(null, list[0].address, list[0].family);
    });
  };
}

interface Transport {
  lookup: LookupFunction;
  /** Ports that may be contacted. Production: 80 and 443. */
  ports?: ReadonlySet<number>;
}

function requestOnce(url: URL, opts: Required<Pick<FetchOptions, "maxBytes">> & { signal: AbortSignal }, t: Transport) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: "GET",
        lookup: t.lookup,
        signal: opts.signal,
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1", "accept-encoding": "gzip, deflate, br" },
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, headers: res.headers, body: Buffer.alloc(0) });
        }
        const declared = Number(res.headers["content-length"] ?? 0);
        if (declared > opts.maxBytes) {
          res.destroy();
          return reject(new FetchFailed(`the page is ${declared} bytes, over the ${opts.maxBytes}-byte limit`, false));
        }
        const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
        const stream =
          encoding === "gzip" ? res.pipe(zlib.createGunzip()) : encoding === "deflate" ? res.pipe(zlib.createInflate()) : encoding === "br" ? res.pipe(zlib.createBrotliDecompress()) : res;
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > opts.maxBytes) {
            res.destroy();
            stream.destroy();
            reject(new FetchFailed(`the page is over the ${opts.maxBytes}-byte limit`, false));
            return;
          }
          chunks.push(chunk);
        });
        stream.on("end", () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }));
        stream.on("error", (e: Error) => reject(new FetchFailed(`could not read the response: ${e.message}`, true)));
      },
    );
    req.on("error", (e: Error & { code?: string }) => {
      if (e instanceof UrlRejected) return reject(e);
      if (e.name === "AbortError") return reject(e);
      reject(new FetchFailed(`connection failed (${e.code ?? e.message})`, true));
    });
    req.end();
  });
}

/** Creates the production transport. `lookup` is replaceable only so tests can point at a local server. */
export function createSafeFetch(transport: Transport = { lookup: guardedLookup() }): PageTransport {
  return async (raw, options) => {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const ports = transport.ports ?? ALLOWED_PORTS;
    let url = checkUrl(raw, ports);
    for (let redirects = 0; ; redirects++) {
      let res;
      try {
        res = await requestOnce(url, { maxBytes, signal }, transport);
      } catch (err) {
        if (timeout.aborted) throw new FetchFailed(`timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`, true);
        throw err;
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.location;
        if (!location) throw new FetchFailed(`redirect (${res.status}) without a location`, false);
        if (redirects >= MAX_REDIRECTS) throw new FetchFailed(`more than ${MAX_REDIRECTS} redirects`, false);
        url = checkUrl(new URL(location, url).toString(), ports); // every hop is checked again
        continue;
      }
      if (res.status >= 400) throw new FetchFailed(`the server answered ${res.status}`, res.status >= 500 || res.status === 429);
      const contentType = String(res.headers["content-type"] ?? "");
      if (!TEXT_TYPES.test(contentType)) throw new FetchFailed(`unsupported content type "${contentType.split(";")[0] || "unknown"}" (only web pages and text can be read)`, false);
      return { url: raw, finalUrl: url.toString(), status: res.status, contentType, body: res.body.toString("utf8"), bytes: res.body.length, redirects };
    }
  };
}

export const safeFetch: PageTransport = createSafeFetch();
