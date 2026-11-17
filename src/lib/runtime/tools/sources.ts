/**
 * Evidence retrieved by tools. A Source is the only thing a research workflow
 * may cite, and it records how much of it was actually read:
 *
 *   via "page"           the runtime fetched the page and extracted its text
 *   via "search_result"  only the search API's title, URL and cited passages
 *                        are known; the page itself was not read
 */

export interface Source {
  id: string;
  url: string;
  title: string;
  publisher: string | null;
  published: string | null;
  via: "page" | "search_result";
  /** Passages the search API cited from this page (search results only). */
  excerpts: string[];
  /** Readable text of the page, when it was fetched. Kept in memory for the run; only a short excerpt is stored. */
  text: string;
  retrievedAt: string;
}

export interface UnavailableSource {
  url: string;
  reason: string;
}

/** What a stored result keeps about each source (no full page text). */
export interface StoredSource {
  id: string;
  url: string;
  title: string;
  publisher: string | null;
  published: string | null;
  via: Source["via"];
  retrieved_at: string;
  excerpt: string;
}

export const SOURCE_PROMPT_CHARS = 8_000;
export const SOURCES_PROMPT_TOTAL = 48_000;
export const PAGE_TEXT_LIMIT = 60_000;

/** The text a citation may be checked against: the page text if read, plus any cited passages. */
export function sourceText(s: Source): string {
  return [s.text, ...s.excerpts].filter(Boolean).join("\n");
}

const attr = (s: string) => s.replace(/["<>&\n]/g, " ").slice(0, 300);

/** Stops retrieved text from closing or opening the tags it is wrapped in. */
export function fenceUntrusted(text: string): string {
  return text.replace(/<\/?\s*(sources?|unavailable_sources|user_input|upstream|draft|task|previous_attempt_feedback)\b/gi, (m) => m.replace("<", "&lt;"));
}

/** The <sources> block producers see. Text is cut per source and in total; cuts are marked. */
export function sourcesForPrompt(sources: Source[], unavailable: UnavailableSource[]): string {
  let budget = SOURCES_PROMPT_TOTAL;
  const blocks = sources.map((s) => {
    const kind = s.via === "page" ? "page, read in full" : "search result, page not read";
    const head = `<source id="${s.id}" kind="${kind}" url="${attr(s.url)}" title="${attr(s.title)}"${s.publisher ? ` publisher="${attr(s.publisher)}"` : ""}${s.published ? ` published="${attr(s.published)}"` : ""}>`;
    const parts: string[] = [];
    if (s.excerpts.length) parts.push(`Passages cited by the search engine:\n${s.excerpts.map((e) => `- "${e}"`).join("\n")}`);
    if (s.text) {
      const room = Math.max(0, Math.min(SOURCE_PROMPT_CHARS, budget));
      const cut = s.text.slice(0, room);
      budget -= cut.length;
      parts.push(cut.length < s.text.length ? `${cut}\n…[page text truncated]` : cut);
    }
    return `${head}\n${fenceUntrusted(parts.join("\n\n") || "(no text)")}\n</source>`;
  });
  const missing = unavailable.length
    ? `\n\n<unavailable_sources>\n${unavailable.map((u) => `- ${attr(u.url)}: ${attr(u.reason)}`).join("\n")}\n</unavailable_sources>`
    : "";
  return `<sources>\n${blocks.join("\n\n")}\n</sources>${missing}`;
}

export function storedSources(sources: Source[]): StoredSource[] {
  return sources.map((s) => ({
    id: s.id,
    url: s.url,
    title: s.title,
    publisher: s.publisher,
    published: s.published,
    via: s.via,
    retrieved_at: s.retrievedAt,
    excerpt: (s.excerpts[0] ?? s.text).replace(/\s+/g, " ").slice(0, 300),
  }));
}

const mdEscape = (t: string) => t.replace(/[\\`*_[\]<>|#~]/g, "\\$&");
/** Only http(s) URLs become links; parentheses and spaces are encoded so they can't break out of the link. */
const mdUrl = (u: string) => (/^https?:\/\//i.test(u) ? u.replace(/[()\s<>]/g, (c) => encodeURIComponent(c)) : "");

export function renderSources(sources: Source[], unavailable: UnavailableSource[]): string {
  const lines = sources.map((s) => {
    const url = mdUrl(s.url);
    const title = mdEscape(s.title || s.url);
    const meta = [s.via === "page" ? "read in full" : "search result only, page not read", s.publisher, s.published ? `published ${s.published}` : null, `retrieved ${s.retrievedAt.slice(0, 10)}`]
      .filter(Boolean)
      .map((m) => mdEscape(String(m)))
      .join(" · ");
    return `- **${s.id}** ${url ? `[${title}](${url})` : title} · ${meta}`;
  });
  const parts = [`## Sources\n\n${lines.join("\n") || "_None._"}`];
  if (unavailable.length) parts.push(`## Could not be accessed\n\n${unavailable.map((u) => `- ${mdEscape(u.url)}: ${mdEscape(u.reason)}`).join("\n")}`);
  return parts.join("\n\n");
}
