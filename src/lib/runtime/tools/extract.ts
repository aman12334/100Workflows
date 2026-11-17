/**
 * Readable text and metadata from an HTML page, without a DOM library.
 *
 * Deliberately simple: drop everything that is not visible prose (scripts,
 * styles, templates, forms, navigation chrome, hidden elements), keep headings
 * as markdown-style lines, and decode the common entities. The result is
 * untrusted text for a prompt, never HTML to render.
 */

export interface ExtractedPage {
  title: string;
  description: string | null;
  publisher: string | null;
  published: string | null;
  headings: string[];
  text: string;
}

const DROP_BLOCKS = /<(script|style|noscript|template|svg|iframe|object|embed|canvas|form|select|button|head)\b[\s\S]*?<\/\1\s*>/gi;
const HIDDEN = /<([a-z][a-z0-9]*)\b[^>]*\s(hidden|aria-hidden\s*=\s*["']true["']|style\s*=\s*["'][^"']*display\s*:\s*none[^"']*["'])[^>]*>[\s\S]*?<\/\1\s*>/gi;
const COMMENTS = /<!--[\s\S]*?-->/g;
const BLOCK_TAGS = /<\/?(p|div|section|article|main|header|footer|li|ul|ol|tr|table|br|hr|blockquote|pre|dd|dt|figcaption|h[1-6])\b[^>]*>/gi;

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", euro: "€", pound: "£" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    }
    return NAMED[code.toLowerCase()] ?? m;
  });
}

const clean = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

function meta(html: string, names: string[]): string | null {
  for (const name of names) {
    const re = new RegExp(`<meta\\b[^>]*(?:name|property|itemprop)\\s*=\\s*["']${name}["'][^>]*>`, "i");
    const tag = html.match(re)?.[0];
    const content = tag?.match(/content\s*=\s*["']([^"']*)["']/i)?.[1];
    if (content?.trim()) return clean(content).slice(0, 300);
  }
  return null;
}

export function extractPage(html: string, contentType = "text/html"): ExtractedPage {
  if (!/html|xml/i.test(contentType)) {
    const text = html.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    return { title: text.split("\n")[0].slice(0, 200), description: null, publisher: null, published: null, headings: [], text };
  }
  const title = clean(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "") || meta(html, ["og:title", "twitter:title"]) || "";
  const description = meta(html, ["description", "og:description"]);
  const publisher = meta(html, ["og:site_name", "publisher", "application-name"]);
  const published =
    meta(html, ["article:published_time", "datePublished", "date", "pubdate", "dc.date", "article:modified_time", "dateModified"]) ??
    html.match(/<time\b[^>]*datetime\s*=\s*["']([^"']+)["']/i)?.[1] ??
    null;

  let body = html.replace(COMMENTS, " ").replace(DROP_BLOCKS, " ");
  for (let i = 0; i < 3; i++) body = body.replace(HIDDEN, " ");
  const main = body.match(/<(main|article)\b[^>]*>([\s\S]*)<\/\1\s*>/i)?.[2];
  if (main && clean(main).length > 400) body = main;
  else body = body.replace(/<(nav|aside)\b[\s\S]*?<\/\1\s*>/gi, " ");

  const headings = [...body.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)].map((m) => `${"#".repeat(Number(m[1]))} ${clean(m[2])}`).filter((h) => h.length > 2).slice(0, 60);
  const text = decodeEntities(
    body
      .replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `\n${"#".repeat(Number(n))} `)
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(BLOCK_TAGS, "\n")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { title, description, publisher, published: published ? published.slice(0, 40) : null, headings, text };
}
