/**
 * PDF exam paper → draft questions. Every splitting rule lives in this file
 * (docs/ANALYSIS.md 2주차 `rules.ts`), so a new paper layout means editing only here.
 *
 * Input is plain page data (see pdf-extract.ts): text items and image boxes in PDF points,
 * top-left origin, `y` of a text item = its baseline.
 */

export type Box = { x: number; y: number; w: number; h: number };
export type TextItem = { str: string; x: number; y: number; w: number; h: number };
export type PageData = { page: number; width: number; height: number; items: TextItem[]; images: Box[]; vrules: Box[] };

/** An image region on a page; `key` is set once the cropped PNG is uploaded to R2. */
export type ImageRef = { page: number; box: Box; key?: string };
export type DraftChoice = { text: string; image?: ImageRef };
export type Draft = {
  no: number;
  subject: string | null;
  stem: string;
  stemImages: ImageRef[];
  choices: DraftChoice[];
  fixedChoices: boolean;
  groupKey: string | null;
  /** Shared passage / image of a group ("※ [6~7] …"); only on the group's first question. */
  groupIntro: string | null;
  groupImages: ImageRef[];
  answer: number | null; // 1-based, from the answer key
  page: number;
  box: Box; // area on `page` for highlighting
};

// ---------------------------------------------------------------- patterns

const CHOICE_MARKS = "①②③④⑤⑥⑦⑧⑨⑩";
export const RE_SUBJECT = /^제\s*(\d+)\s*과목\s+(.+?)(?:\s*\(\s*\d+\s*[~∼-]\s*\d+\s*\))?\s*$/;
export const RE_GROUP = /^※\s*\[\s*(\d+)\s*[~∼-]\s*(\d+)\s*\]\s*(.*)$/;
export const RE_QUESTION = /^(\d{1,3})\s*[.)]\s*(.*)$/;
const RE_PAGE_NO = /^[-–]?\s*\d{1,3}\s*[-–]?$/;
/** A choice that points at other choices ("①~④ 모두") — shuffling would break it. */
const RE_REFERS_TO_CHOICES = /[①-⑩]\s*[~∼,·]\s*[①-⑩]/;
/** Header / footer bands, as a fraction of page height. */
const MARGIN_TOP = 0.05;
const MARGIN_BOTTOM = 0.96;

// ---------------------------------------------------------------- lines

type Line = { page: number; x: number; y: number; h: number; right: number; text: string; items: TextItem[] };
type Block = { kind: "line"; line: Line } | { kind: "image"; page: number; box: Box };

const isHangul = (ch: string | undefined) => !!ch && /[가-힣]/.test(ch);

/**
 * How a line that wrapped is joined back onto the text before it.
 * - "char" (글자 단위): the paper wraps between any two syllables (Korean default, CSS word-break: normal),
 *   so a Hangul–Hangul break is taken as mid-word and joined without a space.
 *   ponytail: a break that fell on a real space between two Hangul words loses that space; the reviewer fixes it.
 * - "word" (어절 단위): the paper only wraps at spaces (word-break: keep-all), so every break is a space.
 */
export type JoinMode = "char" | "word";
export type SplitOptions = { join?: JoinMode };
export const DEFAULT_JOIN: JoinMode = "char";

export function joinWrapped(a: string, b: string, mode: JoinMode = DEFAULT_JOIN) {
  if (!a) return b;
  if (!b) return a;
  // "것" (a bound noun) is always written after a space in Korean.
  const glue = mode === "char" && isHangul(a.at(-1)) && isHangul(b[0]) && b[0] !== "것";
  return glue ? a + b : `${a} ${b}`;
}

function toLines(page: number, items: TextItem[]): Line[] {
  const sorted = [...items].sort((p, q) => p.y - q.y || p.x - q.x);
  const lines: Line[] = [];
  for (const it of sorted) {
    const last = lines.at(-1);
    if (last && Math.abs(last.y - it.y) < Math.max(2, it.h * 0.4)) last.items.push(it);
    else lines.push({ page, x: 0, y: it.y, h: it.h, right: 0, text: "", items: [it] });
  }
  for (const l of lines) {
    l.items.sort((p, q) => p.x - q.x);
    let text = "";
    let end = -Infinity;
    for (const it of l.items) {
      const gap = it.x - end;
      text += text && gap > it.h * 0.15 ? ` ${it.str.trim()}` : it.str.trim();
      end = it.x + it.w;
    }
    l.x = l.items[0].x;
    l.right = end;
    l.h = Math.max(...l.items.map((i) => i.h));
    l.text = text.replace(/\s+/g, " ").trim();
  }
  return lines;
}

/**
 * Reading order of one page: the full-width band above the columns, then the left column,
 * then the right column. Columns come from a vertical rule near the middle when the paper
 * has one, otherwise from where lines start.
 */
export function pageBlocks(p: PageData): Block[] {
  const items = p.items.filter((i) => i.y > p.height * MARGIN_TOP && i.y < p.height * MARGIN_BOTTOM && !RE_PAGE_NO.test(i.str.trim()));
  const mid = p.width / 2;
  const rules = p.vrules.filter((r) => Math.abs(r.x + r.w / 2 - mid) < p.width * 0.1);

  let splitX: number | null = null;
  let colTop = 0;
  if (rules.length) {
    splitX = rules.reduce((s, r) => s + r.x + r.w / 2, 0) / rules.length;
    colTop = Math.min(...rules.map((r) => r.y));
  } else {
    // Two columns: plenty of text starts right of the middle and almost nothing runs across it.
    const right = items.filter((i) => i.x > mid - p.width * 0.02).length;
    const across = items.filter((i) => i.x < mid - 5 && i.x + i.w > mid + 5).length;
    if (items.length && right / items.length > 0.2 && across / items.length < 0.05) splitX = mid;
  }

  const imgBlocks = (filter: (b: Box) => boolean): Block[] =>
    p.images.filter(filter).map((box) => ({ kind: "image" as const, page: p.page, box }));
  const ordered = (its: TextItem[], imgs: Block[]): Block[] =>
    [...toLines(p.page, its).map((line) => ({ kind: "line" as const, line })), ...imgs].sort(
      (a, b) => (a.kind === "line" ? a.line.y - a.line.h : a.box.y) - (b.kind === "line" ? b.line.y - b.line.h : b.box.y),
    );

  if (splitX === null) return ordered(items, imgBlocks(() => true));
  const sx = splitX;
  const inBand = (y: number) => y < colTop;
  const isLeft = (x: number) => x < sx;
  return [
    ...ordered(items.filter((i) => inBand(i.y)), imgBlocks((b) => inBand(b.y + b.h / 2))),
    ...ordered(
      items.filter((i) => !inBand(i.y) && isLeft(i.x)),
      imgBlocks((b) => !inBand(b.y + b.h / 2) && isLeft(b.x + b.w / 2)),
    ),
    ...ordered(
      items.filter((i) => !inBand(i.y) && !isLeft(i.x)),
      imgBlocks((b) => !inBand(b.y + b.h / 2) && !isLeft(b.x + b.w / 2)),
    ),
  ];
}

// ---------------------------------------------------------------- questions

const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
const lineBox = (l: Line): Box => ({ x: l.x, y: l.y - l.h, w: l.right - l.x, h: l.h * 1.3 });

export function splitPages(pages: PageData[], opts: SplitOptions = {}): Draft[] {
  const join = (a: string, b: string) => joinWrapped(a, b, opts.join ?? DEFAULT_JOIN);
  const drafts: Draft[] = [];
  let subject: string | null = null;
  let cur: Draft | null = null;
  let curMarks: { x: number; y: number }[] = []; // where each choice marker of `cur` sits
  let curImages: ImageRef[] = [];
  let group: { key: string; from: number; to: number; intro: string; images: ImageRef[] } | null = null;
  let inIntro = false; // collecting a group's shared passage
  let expectedNo: number | null = null;

  const finish = () => {
    if (cur) {
      // An image is a choice's picture when that choice's marker sits on the same row, left of it
      // (picture choices are laid out "① [img]  ② [img]"). Otherwise it belongs to the stem.
      for (const ref of curImages) {
        const { box } = ref;
        let best = -1;
        cur.choices.forEach((c, i) => {
          const m = curMarks[i];
          if (c.image || !m || m.x > box.x + 5 || m.y < box.y - 5 || m.y > box.y + box.h + 10) return;
          if (best < 0 || m.x > curMarks[best].x) best = i;
        });
        if (best >= 0) cur.choices[best].image = ref;
        else cur.stemImages.push(ref);
      }
      cur.fixedChoices = cur.choices.some((c) => RE_REFERS_TO_CHOICES.test(c.text));
      drafts.push(cur);
    }
    cur = null;
    curMarks = [];
    curImages = [];
  };

  /** Appends text to the stem or, once choices started, to the last choice — splitting at expected markers. */
  const addText = (q: Draft, line: Line) => {
    let rest = line.text;
    while (rest) {
      const next = CHOICE_MARKS[q.choices.length];
      const at = next ? rest.indexOf(next) : -1;
      const head = (at === -1 ? rest : rest.slice(0, at)).trim();
      if (head) {
        const last = q.choices.at(-1);
        if (last) last.text = join(last.text, head);
        else q.stem = join(q.stem, head);
      }
      if (at === -1) break;
      // Estimate where the marker sits, for attaching image choices.
      const before = line.items.find((it) => it.str.includes(next));
      curMarks.push({ x: before ? before.x : line.x, y: line.y });
      q.choices.push({ text: "" });
      rest = rest.slice(at + next.length);
    }
    q.box = q.page === line.page ? union(q.box, lineBox(line)) : q.box;
  };

  for (const p of pages) {
    for (const b of pageBlocks(p)) {
      if (b.kind === "image") {
        const ref: ImageRef = { page: b.page, box: b.box };
        if (inIntro && group) group.images.push(ref);
        else if (cur) curImages.push(ref); // placed in finish(), once all choice markers are known
        continue;
      }

      const line = b.line;
      const subj = RE_SUBJECT.exec(line.text);
      if (subj) {
        finish();
        subject = subj[2].trim();
        inIntro = false;
        continue;
      }
      const grp = RE_GROUP.exec(line.text);
      if (grp) {
        finish();
        group = { key: `${grp[1]}-${grp[2]}`, from: Number(grp[1]), to: Number(grp[2]), intro: grp[3].trim(), images: [] };
        inIntro = true;
        continue;
      }
      const qm = RE_QUESTION.exec(line.text);
      // A number only starts a question when it is the next one expected ("121℃ …" in a stem is not).
      if (qm && (expectedNo === null || Number(qm[1]) === expectedNo)) {
        finish();
        const no = Number(qm[1]);
        expectedNo = no + 1;
        inIntro = false;
        const g = group && no >= group.from && no <= group.to ? group : null;
        const first = !!g && no === g.from;
        cur = {
          no,
          subject,
          stem: "",
          stemImages: [],
          choices: [],
          fixedChoices: false,
          groupKey: g?.key ?? null,
          groupIntro: first ? g.intro : null,
          groupImages: first ? g.images : [],
          answer: null,
          page: line.page,
          box: lineBox(line),
        };
        addText(cur, { ...line, text: qm[2] });
        continue;
      }
      if (inIntro && group) group.intro = join(group.intro, line.text);
      else if (cur) addText(cur, line);
      // Anything before the first question (cover, notices) is not part of any question.
    }
  }
  finish();
  return drafts;
}

// ---------------------------------------------------------------- answer key

/**
 * Parses a pasted answer key: "1-③, 2-①", "1③ 2①", "1 3, 2 1", "1. ③", "1:3".
 * Returns question number → 1-based choice. Later entries win.
 */
export function parseAnswerKey(text: string): Map<number, number> {
  const out = new Map<number, number>();
  const re = /(\d{1,3})\s*[-.:)=]?\s*([①-⑩]|\d{1,2})(?!\d)/g;
  for (const m of text.matchAll(re)) {
    const v = CHOICE_MARKS.includes(m[2]) ? CHOICE_MARKS.indexOf(m[2]) + 1 : Number(m[2]);
    if (v >= 1 && v <= 10) out.set(Number(m[1]), v);
  }
  return out;
}

export function applyAnswerKey(drafts: Draft[], key: Map<number, number>) {
  return drafts.map((d) => (key.has(d.no) ? { ...d, answer: key.get(d.no)! } : d));
}
