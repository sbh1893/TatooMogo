/**
 * Reads question development documents (.docx, text only) into question drafts.
 * Pure and dependency-light so it runs in the admin browser (rule 7) and in the local check script.
 * The file never leaves the browser; only the parsed questions are sent to the server.
 *
 * Layout, repeated per criterion (anything before the first title is skipped):
 *   문항개발기준 NNN (분야-NN)
 *   [table: 과목 / 분야 / 영역 / 세부영역 / 항목 / 근거번호]
 *   평가목표 … / 유의사항 …
 *   예비문항 N | 지식수준: … | 예상 난이도: … | 문항형태: …
 *   문제 … / ① … ⑤ / 정답 ③ / 정답해설 … / 오답노트 ① … / ② … / 출제의도 … / 이의제기 예방검토 … / 근거번호 …
 */
import { strFromU8, unzipSync } from "fflate";
import { DIFFICULTIES, KNOWLEDGE_LEVELS } from "./question";

export const EXPECTED_CHOICES = 5;
const MARKS = "①②③④⑤⑥⑦⑧⑨⑩";
const markNo = (ch: string | undefined) => (ch ? MARKS.indexOf(ch) + 1 : 0); // 0 = not a mark

export type DocxErrorKind = "choices" | "answer_missing" | "answer_range" | "knowledge" | "difficulty" | "stem_missing" | "duplicate" | "label_order";
export const ERROR_TEXT: Record<DocxErrorKind, string> = {
  choices: `보기 수가 ${EXPECTED_CHOICES}개가 아님`,
  answer_missing: "정답 누락",
  answer_range: "정답이 보기 범위 밖",
  knowledge: "지식수준 값이 목록 밖",
  difficulty: "예상 난이도 값이 목록 밖",
  stem_missing: "문제(지문) 없음",
  duplicate: "같은 기준·문항 번호가 파일 안에 또 있음",
  label_order: "이름표 순서 어긋남",
};
/** Warnings: shown, but the admin may still register after reviewing the card. */
export const WARNINGS: DocxErrorKind[] = ["label_order"];

export type DocxItem = {
  pos: number; // 1-based order in the document
  criterionNo: string;
  itemNo: number;
  field: string;
  knowledgeLevel: string; // raw text; may be outside KNOWLEDGE_LEVELS (an error)
  difficulty: string;
  stem: string;
  choices: string[];
  answer: number | null; // 1-based
  correctExplanation: string; // 정답해설
  wrongNote: string; // 오답노트
  intent: string;
  objectionReview: string;
  basis: string;
  parseErrors: DocxErrorKind[]; // found while reading: label order, duplicates
};

export type DocxParse = { criteria: number; items: DocxItem[] };

// ------------------------------------------------------------------ docx → blocks

export function readDocxXml(bytes: Uint8Array): string {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (f) => f.name === "word/document.xml" });
  } catch {
    throw new Error("Word(.docx) 파일을 열 수 없습니다.");
  }
  const xml = files["word/document.xml"];
  if (!xml) throw new Error("Word(.docx) 파일이 아닙니다.");
  return strFromU8(xml);
}

export type Block = { kind: "p"; text: string } | { kind: "table"; rows: string[][] };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITIES[e] ?? m),
  );
const tidy = (s: string) =>
  s
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");

/** Body paragraphs and tables in order. Table cells keep their paragraphs joined by newlines; nested tables flatten into the cell. */
export function docxBlocks(xml: string): Block[] {
  const out: Block[] = [];
  const tok = /<w:tbl[ >]|<\/w:tbl>|<w:tr[ >]|<w:tc[ >]|<w:p\/>|<w:p[ >]|<\/w:p>|<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>/g;
  let depth = 0;
  let rows: string[][] = [];
  let para: string | null = null;
  const endPara = () => {
    if (para === null) return;
    const text = tidy(para);
    para = null;
    if (!text) return;
    if (depth === 0) return void out.push({ kind: "p", text });
    const row = rows.at(-1);
    if (row && row.length) row[row.length - 1] = row[row.length - 1] ? `${row[row.length - 1]}\n${text}` : text;
  };
  for (const m of xml.matchAll(tok)) {
    const t = m[0];
    if (t.startsWith("<w:tbl")) {
      endPara();
      if (depth++ === 0) rows = [];
    } else if (t === "</w:tbl>") {
      endPara();
      if (--depth === 0) out.push({ kind: "table", rows });
    } else if (t.startsWith("<w:tr")) {
      if (depth === 1) rows.push([]);
    } else if (t.startsWith("<w:tc")) {
      if (depth === 1) rows.at(-1)?.push("");
    } else if (t === "<w:p/>") {
      endPara();
    } else if (t.startsWith("<w:p")) {
      endPara();
      para = "";
    } else if (t === "</w:p>") {
      endPara();
    } else if (para !== null) {
      para += m[1] !== undefined ? decode(m[1]) : t === "<w:tab/>" ? " " : "\n";
    }
  }
  return out;
}

// ------------------------------------------------------------------ blocks → items

const TITLE = /^문항\s*개발\s*기준\s*(\d+)\s*(?:[(（](.*)[)）])?/;
const ITEM = /^예비\s*문항\s*(\d+)/;
const CRITERION_TEXT = /^(평가\s*목표|유의\s*사항)/;
const RULE_LINE = /^[-─━_=~·•*\s]{3,}$/;
const spaced = (word: string) => [...word].join("\\s*");

type Field = "header" | "stem" | "choices" | "answer" | "correct" | "wrong" | "intent" | "objection" | "basis";
const ORDER: Field[] = ["header", "stem", "choices", "answer", "correct", "wrong", "intent", "objection", "basis"];
// Longest first: "정답해설" must not be read as "정답".
const LABELS: [Field, RegExp][] = (
  [
    ["objection", "이의제기예방검토"],
    ["correct", "정답해설"],
    ["wrong", "오답노트"],
    ["intent", "출제의도"],
    ["basis", "근거번호"],
    ["answer", "정답"],
    ["stem", "문제"],
  ] as [Field, string][]
).map(([f, w]) => [f, new RegExp(`^[\\[【〈<(]?\\s*${spaced(w)}(\\s*[\\]】〉>)])?(\\s*[:：.])?\\s*`)]);

/** A label at the start of a paragraph, and the text after it. "문제가 …" is not a label: a label ends at a space, colon or non-Hangul. */
function label(text: string): { field: Field; rest: string } | null {
  for (const [field, re] of LABELS) {
    const m = re.exec(text);
    if (!m) continue;
    const rest = text.slice(m[0].length);
    const separated = m[0].length > 0 && /[\s:：.\]】〉>)]$/.test(m[0]);
    if (separated || rest === "" || !/^[가-힣]/.test(rest)) return { field, rest };
  }
  return null;
}

const norm = (s: string) => s.replace(/\s+/g, "");
const headerValue = (header: string, key: string) => norm(new RegExp(`${spaced(key)}\\s*[:：]?\\s*([^|｜]*)`).exec(header)?.[1] ?? "");

/** Criterion table → label → value. Accepts label/value pairs in a row, or a header row followed by a value row. */
function tableValues(rows: string[][]) {
  const known = new Set(["과목", "분야", "영역", "세부영역", "항목", "근거번호"]);
  const out: Record<string, string> = {};
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r].map((c) => c.trim());
    const filled = cells.filter(Boolean);
    if (filled.length > 1 && filled.every((c) => known.has(norm(c))) && rows[r + 1]) {
      cells.forEach((c, i) => c && (out[norm(c)] ??= (rows[r + 1][i] ?? "").trim()));
      r++;
      continue;
    }
    cells.forEach((c, i) => known.has(norm(c)) && cells[i + 1] !== undefined && (out[norm(c)] ??= cells[i + 1]));
  }
  return out;
}

/** Parses the whole document body. Never throws on odd content; problems are recorded per question. */
export function parseDocxItems(xmlOrBlocks: string | Block[]): DocxParse {
  const blocks = typeof xmlOrBlocks === "string" ? docxBlocks(xmlOrBlocks) : xmlOrBlocks;
  const items: DocxItem[] = [];
  let criteria = 0;
  let crit: { no: string; titleField: string; table: Record<string, string> | null } | null = null;
  let cur: (DocxItem & { at: Field; seen: Set<Field>; header: string; answerText: string }) | null = null;

  const close = () => {
    if (!cur) return;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- parser state, not part of the item
    const { at: _a, seen: _s, header, answerText, ...item } = cur;
    item.knowledgeLevel = headerValue(header, "지식수준");
    item.difficulty = headerValue(header, "예상난이도");
    const n = /[①-⑩]|\d+/.exec(answerText)?.[0];
    item.answer = n ? markNo(n) || Number(n) : null;
    for (const k of ["stem", "correctExplanation", "wrongNote", "intent", "objectionReview", "basis"] as const) item[k] = item[k].trim();
    if (!item.basis) item.basis = crit?.table?.["근거번호"] ?? "";
    items.push(item);
    cur = null;
  };
  const append = (field: Field, text: string) => {
    if (!cur || !text) return;
    const key = (
      { stem: "stem", correct: "correctExplanation", wrong: "wrongNote", intent: "intent", objection: "objectionReview", basis: "basis" } as const
    )[field as "stem"];
    if (field === "header") cur.header += ` ${text}`;
    else if (field === "answer") cur.answerText += ` ${text}`;
    else if (field === "choices") cur.choices[cur.choices.length - 1] = `${cur.choices.at(-1)} ${text}`.trim();
    else if (key) cur[key] = cur[key] ? `${cur[key]}\n${text}` : text;
  };
  /** "① a ② b" on one line: split only before the next expected mark, so "⑤ ①과 ③" stays one choice. */
  const addChoices = (text: string) => {
    if (!cur) return;
    let rest = text;
    while (rest) {
      const body = rest.slice(1).trim();
      const next = MARKS[cur.choices.length + 1];
      const cut = next ? body.search(new RegExp(`\\s${next}`)) : -1;
      cur.choices.push((cut >= 0 ? body.slice(0, cut) : body).trim());
      rest = cut >= 0 ? body.slice(cut).trim() : "";
    }
    cur.at = "choices";
  };

  for (const b of blocks) {
    if (b.kind === "table") {
      if (crit && !crit.table && !cur) crit.table = tableValues(b.rows);
      continue;
    }
    const text = b.text;
    if (RULE_LINE.test(text)) continue;
    const title = TITLE.exec(text);
    if (title) {
      close();
      criteria++;
      crit = { no: title[1], titleField: (title[2] ?? "").replace(/\s*[-–]\s*\d+\s*$/, "").trim(), table: null };
      continue;
    }
    if (!crit) continue; // overview before the first criterion
    const head = ITEM.exec(text);
    if (head) {
      close();
      cur = {
        pos: items.length + 1,
        criterionNo: crit.no,
        itemNo: Number(head[1]),
        field: (crit.table?.["분야"] || crit.titleField).trim(),
        knowledgeLevel: "",
        difficulty: "",
        stem: "",
        choices: [],
        answer: null,
        correctExplanation: "",
        wrongNote: "",
        intent: "",
        objectionReview: "",
        basis: "",
        parseErrors: [],
        at: "header",
        seen: new Set(["header"]),
        header: text.slice(head[0].length),
        answerText: "",
      };
      continue;
    }
    if (CRITERION_TEXT.test(text)) {
      close();
      continue;
    }
    if (!cur) continue;
    const l = label(text);
    if (l && !cur.seen.has(l.field)) {
      if (ORDER.indexOf(l.field) < ORDER.indexOf(cur.at) && !cur.parseErrors.includes("label_order")) cur.parseErrors.push("label_order");
      cur.seen.add(l.field);
      cur.at = l.field;
      if (l.field === "stem" && markNo(l.rest[0])) addChoices(l.rest);
      else append(l.field, l.rest);
      continue;
    }
    // Choices after 정답 (none seen yet) or before 문제 are out of order but still choices.
    const late = cur.at === "answer" && cur.choices.length === 0;
    if ((cur.at === "stem" || cur.at === "choices" || cur.at === "header" || late) && markNo(text[0])) {
      if ((cur.at === "header" || late) && !cur.parseErrors.includes("label_order")) cur.parseErrors.push("label_order");
      addChoices(text);
      continue;
    }
    append(cur.at, text);
  }
  close();

  const seenKeys = new Map<string, DocxItem>();
  for (const it of items) {
    const k = `${it.criterionNo}-${it.itemNo}`;
    const first = seenKeys.get(k);
    if (first) {
      it.parseErrors.push("duplicate");
      if (!first.parseErrors.includes("duplicate")) first.parseErrors.push("duplicate");
    } else seenKeys.set(k, it);
  }
  return { criteria, items };
}

// ------------------------------------------------------------------ checks shared by the screen and the script

/** Errors of an item as it is now (the review screen recomputes after edits). */
export function itemErrors(it: DocxItem): DocxErrorKind[] {
  const e: DocxErrorKind[] = [];
  if (!it.stem.trim()) e.push("stem_missing");
  if (it.choices.length !== EXPECTED_CHOICES) e.push("choices");
  if (it.answer === null) e.push("answer_missing");
  else if (it.answer < 1 || it.answer > it.choices.length) e.push("answer_range");
  if (!(KNOWLEDGE_LEVELS as readonly string[]).includes(it.knowledgeLevel)) e.push("knowledge");
  if (!(DIFFICULTIES as readonly string[]).includes(it.difficulty)) e.push("difficulty");
  return [...e, ...it.parseErrors];
}
export const blocking = (errors: DocxErrorKind[]) => errors.filter((e) => !WARNINGS.includes(e));

/** What the examinee sees after submitting: 정답해설, a blank line, then 오답노트 one choice per line. */
export function composeExplanation(correct: string, wrongNote: string) {
  const note = wrongNote.replace(/\s*\/\s*(?=[①-⑩])/g, "\n").trim();
  return [correct.trim(), note].filter(Boolean).join("\n\n");
}

export const itemKey = (it: { criterionNo: string; itemNo: number }) => `${it.criterionNo}-${it.itemNo}`;

/** Request body item for POST /api/admin/docx/import. */
export function toImportItem(it: DocxItem, subjectId: number) {
  return {
    subjectId,
    stem: it.stem,
    explanation: composeExplanation(it.correctExplanation, it.wrongNote),
    fixedChoices: false,
    groupKey: null,
    choices: it.choices.map((body, k) => ({ body, isCorrect: k + 1 === it.answer })),
    meta: {
      criterionNo: it.criterionNo,
      itemNo: it.itemNo,
      field: it.field,
      knowledgeLevel: it.knowledgeLevel || null,
      difficulty: it.difficulty || null,
      intent: it.intent,
      objectionReview: it.objectionReview,
      basis: it.basis,
    },
  };
}
