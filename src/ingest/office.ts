import { strFromU8, unzipSync } from "fflate";

/** Text past this is cut off; a spreadsheet's numbers rarely need more to be found. */
const MAX_CHARS = 1_000_000;
const MAX_SHEET_CHARS = 300_000;
const MAX_COLUMNS = 60;
/** A part that would unpack past this is not read (guards against zip bombs). */
const MAX_PART_BYTES = 50 * 1024 * 1024;

const MIME: Record<string, OfficeKind> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-word.document.macroenabled.12": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.ms-powerpoint.presentation.macroenabled.12": "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel.sheet.macroenabled.12": "xlsx",
};
const EXT: Record<string, OfficeKind> = { docx: "docx", docm: "docx", pptx: "pptx", pptm: "pptx", xlsx: "xlsx", xlsm: "xlsx" };

export type OfficeKind = "docx" | "pptx" | "xlsx";

/** Which Office format a file name or MIME type names, if any. */
export function officeKind(nameOrMime: string): OfficeKind | undefined {
  const s = nameOrMime.trim().toLowerCase();
  return MIME[s.split(";")[0].trim()] ?? EXT[/\.([a-z]+)$/.exec(s)?.[1] ?? ""];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? entity;
    const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });

const tidy = (s: string, max = MAX_CHARS) =>
  s
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);

/** A package part's relationships: id → target path inside the zip. */
function relationships(parts: Record<string, Uint8Array>, relsPath: string, baseDir: string): Map<string, string> {
  const xml = parts[relsPath] ? strFromU8(parts[relsPath]) : "";
  const out = new Map<string, string>();
  for (const m of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /\bId="([^"]*)"/.exec(m[1])?.[1];
    const target = /\bTarget="([^"]*)"/.exec(m[1])?.[1];
    if (!id || !target) continue;
    // Targets are relative to the part's folder, or absolute from the package root.
    const resolved: string[] = [];
    for (const seg of (target.startsWith("/") ? target.slice(1) : `${baseDir}/${target}`).split("/")) {
      if (seg === "..") resolved.pop();
      else if (seg && seg !== ".") resolved.push(seg);
    }
    out.set(id, resolved.join("/"));
  }
  return out;
}

function docxText(parts: Record<string, Uint8Array>): string {
  const xml = strFromU8(parts["word/document.xml"] ?? new Uint8Array())
    // Paragraph properties hold tab-stop definitions (<w:tab w:val=…/>) that aren't text.
    .replace(/<w:pPr\b[\s\S]*?<\/w:pPr>/g, "");
  let out = "";
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>|<\/w:p>/g)) {
    if (m[1] !== undefined) out += decode(m[1]);
    else if (m[0].startsWith("<w:tab")) out += "\t";
    else out += "\n";
  }
  return tidy(out);
}

/** Text in a DrawingML part (slides): one line per paragraph. */
const drawingText = (xml: string) => {
  let out = "";
  for (const m of xml.matchAll(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>|<a:br\b[^>]*\/>|<\/a:p>/g)) out += m[1] !== undefined ? decode(m[1]) : "\n";
  return tidy(out);
};

function pptxText(parts: Record<string, Uint8Array>): string {
  // Slide order is the presentation's list of slide ids, not the file names.
  const rels = relationships(parts, "ppt/_rels/presentation.xml.rels", "ppt");
  const presentation = parts["ppt/presentation.xml"] ? strFromU8(parts["ppt/presentation.xml"]) : "";
  const listed = [...presentation.matchAll(/<p:sldId\b[^>]*\br:id="([^"]*)"/g)].map((m) => rels.get(m[1])).filter((p): p is string => !!p && !!parts[p]);
  const slideNo = (p: string) => Number(/slide(\d+)\.xml$/.exec(p)?.[1] ?? 0);
  const slides = listed.length ? listed : Object.keys(parts).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p)).sort((a, b) => slideNo(a) - slideNo(b));
  return tidy(
    slides
      .map((p) => drawingText(strFromU8(parts[p])))
      .filter(Boolean)
      .join("\n\n"),
  );
}

/** "AB12" → 27 (zero-based column of a cell reference). */
const columnOf = (ref: string) => {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/** The plain text of a rich or plain string item, without phonetic guides. */
const stringItem = (xml: string) =>
  decode(
    [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => m[1]).join(""),
  );

function xlsxText(parts: Record<string, Uint8Array>): string {
  const shared = parts["xl/sharedStrings.xml"] ? [...strFromU8(parts["xl/sharedStrings.xml"]).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => stringItem(m[1])) : [];
  const rels = relationships(parts, "xl/_rels/workbook.xml.rels", "xl");
  const workbook = parts["xl/workbook.xml"] ? strFromU8(parts["xl/workbook.xml"]) : "";
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*)\/?>/g)]
    .map((m) => ({ name: decode(/\bname="([^"]*)"/.exec(m[1])?.[1] ?? ""), path: rels.get(/\br:id="([^"]*)"/.exec(m[1])?.[1] ?? "") }))
    .filter((s): s is { name: string; path: string } => !!s.path && !!parts[s.path]);

  const out: string[] = [];
  let total = 0;
  for (const sheet of sheets) {
    if (total >= MAX_SHEET_CHARS) break;
    const lines: string[] = [];
    let size = 0;
    for (const row of strFromU8(parts[sheet.path]).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const col = columnOf(/\br="([A-Z]+)\d*"/.exec(c[1])?.[1] ?? "");
        const type = /\bt="([^"]*)"/.exec(c[1])?.[1];
        const v = /<v>([^<]*)<\/v>/.exec(c[2] ?? "")?.[1];
        let text = "";
        if (type === "s") text = shared[Number(v)] ?? "";
        else if (type === "inlineStr") text = stringItem(c[2] ?? "");
        else if (type === "b") text = v === "1" ? "TRUE" : v === "0" ? "FALSE" : "";
        else text = decode(v ?? "");
        const at = col >= 0 ? col : cells.length;
        if (at < MAX_COLUMNS) cells[at] = text.replace(/\s+/g, " ").trim();
      }
      const line = Array.from(cells, (c) => c ?? "").join("\t").replace(/\t+$/, "");
      if (!line) continue;
      lines.push(line);
      size += line.length + 1;
      if (total + size >= MAX_SHEET_CHARS) break;
    }
    if (!lines.length) continue;
    out.push(`${sheet.name}\n${lines.join("\n")}`);
    total += size;
  }
  return tidy(out.join("\n\n"), MAX_SHEET_CHARS);
}

const WANTED: Record<OfficeKind, (name: string) => boolean> = {
  docx: (n) => n === "word/document.xml",
  pptx: (n) => n === "ppt/presentation.xml" || n === "ppt/_rels/presentation.xml.rels" || /^ppt\/slides\/slide\d+\.xml$/.test(n),
  xlsx: (n) => n === "xl/workbook.xml" || n === "xl/_rels/workbook.xml.rels" || n === "xl/sharedStrings.xml" || /^xl\/worksheets\/[^/]+\.xml$/.test(n),
};

/**
 * The plain text of a Word (.docx), PowerPoint (.pptx) or Excel (.xlsx) file: paragraphs, slides in
 * presentation order, or each sheet's rows tab-separated. Undefined for any other kind of file, or one
 * that can't be opened.
 */
export function officeText(bytes: Uint8Array, nameOrMime: string): string | undefined {
  const kind = officeKind(nameOrMime);
  if (!kind) return undefined;
  let parts: Record<string, Uint8Array>;
  try {
    parts = unzipSync(bytes, { filter: (f) => WANTED[kind](f.name) && f.originalSize <= MAX_PART_BYTES });
  } catch {
    return undefined;
  }
  if (kind === "docx") return parts["word/document.xml"] ? docxText(parts) : undefined;
  if (kind === "pptx") return pptxText(parts);
  return xlsxText(parts);
}
