/** Review-screen operations on split drafts (pure, unit-tested in tests/draft-ops.test.ts). */
import type { QuestionInput } from "./question";
import { joinWrapped, type Box, type Draft, type ImageRef } from "./split-rules";

export type ReviewDraft = Draft & { id: string; subjectId: number | null; explanation: string; reviewed: boolean };

let seq = 0;
const newId = () => `d${Date.now().toString(36)}${(seq++).toString(36)}`;

const sameName = (a: string, b: string) => a.replace(/[\s·・.]/g, "") === b.replace(/[\s·・.]/g, "");

/** Wraps splitter output for review; the subject heading ("위생·감염관리") is matched to a subject by name. */
export function toReview(drafts: Draft[], subjects: { id: number; name: string }[]): ReviewDraft[] {
  return drafts.map((d) => ({
    ...d,
    id: newId(),
    subjectId: (d.subject ? subjects.find((s) => sameName(s.name, d.subject!))?.id : null) ?? null,
    explanation: "",
    reviewed: false,
  }));
}

export function blankDraft(no: number, page: number): ReviewDraft {
  return {
    id: newId(),
    no,
    subject: null,
    subjectId: null,
    stem: "",
    stemImages: [],
    choices: Array.from({ length: 5 }, () => ({ text: "" })),
    fixedChoices: false,
    groupKey: null,
    groupIntro: null,
    groupImages: [],
    answer: null,
    page,
    box: { x: 0, y: 0, w: 0, h: 0 },
    explanation: "",
    reviewed: false,
  };
}

const unionBox = (a: Box, b: Box): Box => {
  if (!a.w && !a.h) return b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/** Joins question i with the one after it (the splitter cut one question in two). */
export function mergeWithNext(list: ReviewDraft[], i: number): ReviewDraft[] {
  const a = list[i];
  const b = list[i + 1];
  if (!a || !b) return list;
  const merged: ReviewDraft = {
    ...a,
    stem: a.choices.length ? a.stem : joinWrapped(a.stem, b.stem),
    choices: a.choices.length ? [...a.choices.slice(0, -1), ...mergeLast(a, b)] : b.choices,
    stemImages: [...a.stemImages, ...b.stemImages],
    groupImages: [...a.groupImages, ...b.groupImages],
    box: a.page === b.page ? unionBox(a.box, b.box) : a.box,
    answer: a.answer ?? b.answer,
    reviewed: false,
  };
  return [...list.slice(0, i), merged, ...list.slice(i + 2)];
}
/** b's stem text continues a's last choice; b's choices follow. */
function mergeLast(a: ReviewDraft, b: ReviewDraft) {
  const last = a.choices.at(-1)!;
  return [{ ...last, text: joinWrapped(last.text, b.stem) }, ...b.choices];
}

/**
 * Splits question i at a cursor (the splitter missed a question start). `field` is "stem" or a
 * choice index; text after `pos` in that field, and every later choice, becomes the next question.
 */
export function splitAt(list: ReviewDraft[], i: number, field: "stem" | number, pos: number): ReviewDraft[] {
  const a = list[i];
  if (!a) return list;
  const text = field === "stem" ? a.stem : (a.choices[field]?.text ?? "");
  const head = text.slice(0, pos).trim();
  const tail = text.slice(pos).trim().replace(/^(\d{1,3})\s*[.)]\s*/, "");
  const cut = field === "stem" ? 0 : field + 1;
  const first: ReviewDraft =
    field === "stem"
      ? { ...a, stem: head, choices: [], reviewed: false }
      : { ...a, choices: a.choices.slice(0, cut).map((c, k) => (k === field ? { ...c, text: head } : c)), reviewed: false };
  const second: ReviewDraft = {
    ...blankDraft(a.no + 1, a.page),
    subject: a.subject,
    subjectId: a.subjectId,
    stem: tail,
    choices: a.choices.slice(cut),
  };
  return [...list.slice(0, i), first, second, ...list.slice(i + 1)];
}

/** The one picture a stem can carry: group picture and stem pictures together, as one crop. */
export function stemPicture(d: ReviewDraft): ImageRef | null | "pages" {
  const refs = [...d.groupImages, ...d.stemImages];
  if (refs.length === 0) return null;
  if (refs.length === 1) return refs[0];
  if (refs.some((r) => r.page !== refs[0].page)) return "pages";
  return { page: refs[0].page, box: refs.map((r) => r.box).reduce(unionBox) };
}

/**
 * Turns a reviewed draft into the bulk API item. `keyOf` gives the uploaded R2 key of a picture.
 * Returns problems (in Korean) instead when it can't be registered yet.
 */
export function toBulkItem(
  d: ReviewDraft,
  keyOf: (ref: ImageRef) => string | undefined,
): { ok: true; item: QuestionInput & { sourceNo: number } } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!d.subjectId) errors.push("과목을 정해 주세요.");
  if (!d.answer || d.answer > d.choices.length) errors.push("정답을 정해 주세요.");
  const pic = stemPicture(d);
  if (pic === "pages") errors.push("지문 그림이 여러 쪽에 걸쳐 있습니다. 한 영역으로 다시 잘라 주세요.");
  if (errors.length) return { ok: false, errors };
  const stem = d.groupIntro ? `${d.groupIntro}\n\n${d.stem}` : d.stem;
  return {
    ok: true,
    item: {
      sourceNo: d.no,
      subjectId: d.subjectId!,
      stem,
      stemImageKey: pic && pic !== "pages" ? (keyOf(pic) ?? null) : null,
      explanation: d.explanation,
      fixedChoices: d.fixedChoices,
      groupKey: d.groupKey,
      choices: d.choices.map((c, k) => ({ body: c.text, imageKey: c.image ? (keyOf(c.image) ?? null) : null, isCorrect: k + 1 === d.answer })),
    },
  };
}

export const refKey = (r: ImageRef) => `${r.page}:${[r.box.x, r.box.y, r.box.w, r.box.h].map((v) => Math.round(v)).join(",")}`;
