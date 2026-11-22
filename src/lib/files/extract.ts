import { inflateRawSync, inflateSync } from "node:zlib";

/**
 * Text extraction for uploaded files, with no dependencies beyond Node's zlib.
 * Supported: TXT, MD, CSV (as is), DOCX (paragraph text), XLSX (each sheet as CSV),
 * PDF (text operators in unencrypted, Flate-compressed or uncompressed content streams).
 *
 * It is deliberately conservative: sizes are capped before and after decompression,
 * the type must match the file's leading bytes, and anything it can't read is
 * reported in `notes` instead of being guessed. Nothing here executes file content.
 */

export const FILE_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxTextChars: 200_000,
  maxZipEntries: 2_000,
  maxEntryBytes: 25 * 1024 * 1024,
  maxTotalUnzipped: 60 * 1024 * 1024,
  maxSheets: 10,
  maxPdfStreams: 2_000,
};

export type FileKind = "txt" | "md" | "csv" | "docx" | "xlsx" | "pdf";
export const FILE_KINDS: Record<FileKind, string> = { txt: "Plain text", md: "Markdown", csv: "CSV", docx: "Word (.docx)", xlsx: "Excel (.xlsx)", pdf: "PDF" };

export class FileError extends Error {}

export interface Extracted {
  kind: FileKind;
  text: string;
  truncated: boolean;
  notes: string[];
}

export function kindFromName(name: string): FileKind | null {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext === "txt" || ext === "text") return "txt";
  if (ext === "md" || ext === "markdown") return "md";
  if (ext === "csv") return "csv";
  if (ext === "docx") return "docx";
  if (ext === "xlsx") return "xlsx";
  if (ext === "pdf") return "pdf";
  return null;
}

export function extractText(name: string, bytes: Buffer): Extracted {
  const kind = kindFromName(name);
  if (!kind) throw new FileError(`Unsupported file type. Supported: ${Object.values(FILE_KINDS).join(", ")}. Legacy .doc and .xls files must be saved as .docx or .xlsx first.`);
  if (bytes.length === 0) throw new FileError("The file is empty.");
  if (bytes.length > FILE_LIMITS.maxBytes) throw new FileError(`The file is larger than ${FILE_LIMITS.maxBytes / 1024 / 1024} MB.`);
  const zip = bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const pdf = bytes.subarray(0, 5).toString("latin1") === "%PDF-";
  const notes: string[] = [];
  let text: string;
  if (kind === "docx" || kind === "xlsx") {
    if (!zip) throw new FileError(`This doesn't look like a real ${FILE_KINDS[kind]} file.`);
    const entries = readZip(bytes);
    text = kind === "docx" ? docxText(entries, notes) : xlsxText(entries, notes);
  } else if (kind === "pdf") {
    if (!pdf) throw new FileError("This doesn't look like a real PDF file.");
    text = pdfText(bytes, notes);
  } else {
    if (zip || pdf) throw new FileError("This is a binary file, not plain text. Use its real extension.");
    text = plainText(bytes);
  }
  text = text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
  if (!text) notes.push(kind === "pdf" ? "No text found. Scanned PDFs are images and need OCR, which isn't supported." : "No text found.");
  const truncated = text.length > FILE_LIMITS.maxTextChars;
  if (truncated) {
    text = text.slice(0, FILE_LIMITS.maxTextChars);
    notes.push(`Only the first ${FILE_LIMITS.maxTextChars.toLocaleString("en")} characters were kept.`);
  }
  return { kind, text, truncated, notes };
}

// ---------------------------------------------------------------- plain text

function plainText(bytes: Buffer): string {
  const sample = bytes.subarray(0, 8192);
  let nul = 0;
  for (const b of sample) if (b === 0) nul++;
  if (nul > 0) throw new FileError("This file contains binary data, not plain text (UTF-16 text files must be saved as UTF-8).");
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^﻿/, "");
}

// ---------------------------------------------------------------- zip

/** Reads a zip's central directory and returns a lazy reader per entry. ZIP64 and encrypted entries are refused. */
export function readZip(buf: Buffer): Map<string, () => Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new FileError("The file is damaged (no zip directory).");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new FileError("ZIP64 files aren't supported.");
  if (count > FILE_LIMITS.maxZipEntries) throw new FileError("The file has too many parts to read safely.");
  if (cdOffset + cdSize > buf.length) throw new FileError("The file is damaged (zip directory out of range).");
  const entries = new Map<string, () => Buffer>();
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new FileError("The file is damaged (bad zip entry).");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 1) throw new FileError("Password-protected files aren't supported.");
    if (size > FILE_LIMITS.maxEntryBytes) throw new FileError("A part of this file is too large to read safely.");
    total += size;
    if (total > FILE_LIMITS.maxTotalUnzipped) throw new FileError("This file expands to too much data to read safely.");
    entries.set(name, () => {
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new FileError("The file is damaged (bad local header).");
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + compressed);
      if (data.length !== compressed) throw new FileError("The file is damaged (truncated part).");
      if (method === 0) return Buffer.from(data);
      if (method === 8) {
        try {
          return inflateRawSync(data, { maxOutputLength: Math.max(size, 1) });
        } catch {
          throw new FileError("The file is damaged (a part couldn't be decompressed).");
        }
      }
      throw new FileError(`Unsupported compression in this file (method ${method}).`);
    });
  }
  return entries;
}

// ---------------------------------------------------------------- xml helpers

export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k === "amp") return "&";
    if (k === "lt") return "<";
    if (k === "gt") return ">";
    if (k === "quot") return '"';
    if (k === "apos") return "'";
    const code = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

const entryText = (entries: Map<string, () => Buffer>, name: string) => entries.get(name)?.().toString("utf8") ?? null;

// ---------------------------------------------------------------- docx

function docxText(entries: Map<string, () => Buffer>, notes: string[]): string {
  const xml = entryText(entries, "word/document.xml");
  if (xml === null) throw new FileError("This .docx has no document body.");
  const paragraphs = xml.split(/<\/w:p>/).map((p) =>
    decodeXml(
      p
        .replace(/<w:tab\/>/g, "\t")
        .replace(/<w:(br|cr)\b[^>]*\/>/g, "\n")
        .match(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>|\t|\n/g)
        ?.map((t) => t.replace(/<[^>]+>/g, ""))
        .join("") ?? "",
    ),
  );
  if ([...entries.keys()].some((k) => k.startsWith("word/media/"))) notes.push("Images in the document were skipped.");
  if (entries.has("word/footnotes.xml")) notes.push("Footnotes, headers and comments are not included.");
  return paragraphs.join("\n");
}

// ---------------------------------------------------------------- xlsx

const colIndex = (ref: string) => {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? "A";
  let n = 0;
  for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
};
const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

function xlsxText(entries: Map<string, () => Buffer>, notes: string[]): string {
  const shared = (entryText(entries, "xl/sharedStrings.xml") ?? "")
    .split(/<\/si>/)
    .slice(0, -1)
    .map((si) => decodeXml((si.match(/<t(?:\s[^>]*)?>[^<]*<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join("")));
  const workbook = entryText(entries, "xl/workbook.xml");
  if (workbook === null) throw new FileError("This .xlsx has no workbook.");
  const rels = entryText(entries, "xl/_rels/workbook.xml.rels") ?? "";
  const targets = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [m[0].match(/\bId="([^"]+)"/)?.[1] ?? "", m[0].match(/\bTarget="([^"]+)"/)?.[1] ?? ""]));
  const sheets = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({ name: decodeXml(m[0].match(/\bname="([^"]*)"/)?.[1] ?? "Sheet"), rid: m[0].match(/\br:id="([^"]+)"/)?.[1] ?? "" }));
  if (sheets.length > FILE_LIMITS.maxSheets) notes.push(`Only the first ${FILE_LIMITS.maxSheets} of ${sheets.length} sheets were read.`);
  let sawFormulaOnly = false;
  const out: string[] = [];
  for (const sheet of sheets.slice(0, FILE_LIMITS.maxSheets)) {
    const target = (targets.get(sheet.rid) ?? "").replace(/^\/?xl\//, "").replace(/^\//, "");
    const xml = entryText(entries, `xl/${target}`);
    if (xml === null) continue;
    const rows: string[] = [];
    for (const row of xml.match(/<row\b[\s\S]*?<\/row>/g) ?? []) {
      const cells: string[] = [];
      for (const c of row.match(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g) ?? []) {
        const open = c.match(/^<c\b[^>]*>/)![0];
        const ref = open.match(/\br="([A-Z]+\d+)"/)?.[1];
        const type = open.match(/\bt="([^"]+)"/)?.[1];
        const v = c.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        let value = "";
        if (type === "s" && v !== undefined) value = shared[Number(v)] ?? "";
        else if (type === "inlineStr") value = decodeXml((c.match(/<t(?:\s[^>]*)?>[^<]*<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join(""));
        else if (type === "b") value = v === "1" ? "TRUE" : "FALSE";
        else if (v) value = decodeXml(v);
        if (!value && /<f[\s>]/.test(c) && !v) sawFormulaOnly = true;
        const i = ref ? colIndex(ref) : cells.length;
        while (cells.length < i) cells.push("");
        cells[i] = csvCell(value);
      }
      rows.push(cells.join(","));
    }
    out.push(`## Sheet: ${sheet.name}\n${rows.join("\n")}`);
  }
  notes.push("Dates appear as spreadsheet serial numbers and formatting is not kept.");
  if (sawFormulaOnly) notes.push("Some formulas had no saved value and appear empty.");
  return out.join("\n\n");
}

// ---------------------------------------------------------------- pdf

function pdfString(s: string): string {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3}|\r?\n)/g, (_m, e: string) => {
    if (e === "n") return "\n";
    if (e === "r") return "\r";
    if (e === "t") return "\t";
    if (e === "b" || e === "f") return "";
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8));
    if (/^\r?\n$/.test(e)) return "";
    return e;
  });
}

function hexString(h: string): string {
  const clean = h.replace(/\s+/g, "");
  const bytes = Buffer.from(clean.length % 2 ? `${clean}0` : clean, "hex");
  // UTF-16BE with BOM, otherwise single-byte.
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return bytes.subarray(2).swap16().toString("utf16le");
  return bytes.toString("latin1");
}

/** Text from content-stream operators: Tj, ', ", and TJ arrays; Td, TD, T-star and ET start new lines. */
function contentText(content: string): string {
  const out: string[] = [];
  const re = /\((?:\\[\s\S]|[^\\)])*\)|<[0-9A-Fa-f\s]*>|\[|\]|T[Jj*dD]|'|"|ET|BT/g;
  let inArray = false;
  let line = "";
  for (const m of content.matchAll(re)) {
    const t = m[0];
    if (t === "[") inArray = true;
    else if (t === "]") inArray = false;
    else if (t.startsWith("(")) line += pdfString(t.slice(1, -1));
    else if (t.startsWith("<")) line += hexString(t.slice(1, -1));
    else if (t === "T*" || t === "Td" || t === "TD" || t === "'" || t === '"' || t === "ET") {
      if (!inArray && line) (out.push(line), (line = ""));
    }
  }
  if (line) out.push(line);
  return out.join("\n");
}

/** ASCII base-85 (PDF filter ASCII85Decode). Returns null on malformed input. */
export function ascii85(input: Buffer): Buffer | null {
  const s = input.toString("latin1").replace(/^\s*<~/, "").replace(/~>[\s\S]*$/, "").replace(/\s+/g, "");
  const out: number[] = [];
  let group: number[] = [];
  for (const ch of s) {
    if (ch === "z" && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const c = ch.charCodeAt(0) - 33;
    if (c < 0 || c > 84) return null;
    group.push(c);
    if (group.length === 5) {
      const v = group.reduce((a, d) => a * 85 + d, 0);
      if (v > 0xffffffff) return null;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      group = [];
    }
    if (out.length > FILE_LIMITS.maxEntryBytes) return null;
  }
  if (group.length === 1) return null;
  if (group.length) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    const v = group.reduce((a, d) => a * 85 + d, 0);
    out.push(...[(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].slice(0, n - 1));
  }
  return Buffer.from(out);
}

function pdfText(buf: Buffer, notes: string[]): string {
  const raw = buf.toString("latin1");
  if (/\/Encrypt\b/.test(raw)) throw new FileError("Encrypted or password-protected PDFs aren't supported.");
  const parts: string[] = [];
  let streams = 0;
  let unreadable = 0;
  const re = /<<((?:[^<>]|<<(?:[^<>]|<<[^<>]*>>)*>>|<[^<>]*>)*)>>\s*stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) && streams < FILE_LIMITS.maxPdfStreams) {
    const dict = m[1];
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    re.lastIndex = end;
    streams++;
    if (/\/Subtype\s*\/(Image|XML)|\/Type\s*\/(XObject|XRef|Metadata|EmbeddedFile)|\/Length1|\/FontFile/.test(dict)) continue;
    let data: Buffer | null = buf.subarray(start, end);
    const filters = [...(dict.match(/\/Filter\s*(\[[^\]]*\]|\/\w+)/)?.[1] ?? "").matchAll(/\/(\w+)/g)].map((f) => f[1]);
    for (const f of filters) {
      if (!data) break;
      if (f === "FlateDecode" || f === "Fl") {
        try {
          data = inflateSync(data, { maxOutputLength: FILE_LIMITS.maxEntryBytes });
        } catch {
          data = null;
        }
      } else if (f === "ASCII85Decode" || f === "A85") data = ascii85(data);
      else data = null;
    }
    if (!data) {
      unreadable++;
      continue;
    }
    const s = data.toString("latin1");
    if (!/\bBT\b/.test(s)) continue;
    const t = contentText(s);
    if (t.trim()) parts.push(t);
  }
  let text = parts.join("\n\n");
  // Text drawn with embedded (CID) fonts decodes to control characters; don't pass that off as text.
  const printable = text.replace(/[^\x20-\x7e -￿\n\t]/g, "").length;
  if (text && printable / text.length < 0.85) {
    notes.push("This PDF uses font encodings the basic reader can't decode; export it as text or DOCX for reliable results.");
    text = text.replace(/[^\x20-\x7e -￿\n\t]/g, "");
  }
  if (unreadable) notes.push(`${unreadable} part(s) use compression the basic reader doesn't support and were skipped.`);
  notes.push("PDF reading is basic: layout, tables and reading order may not be preserved.");
  return text;
}
