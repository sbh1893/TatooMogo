// Shared by the admin screen (pre-submit check) and the server (authoritative check).

export const MIN_CHOICES = 2;
export const MAX_CHOICES = 8;
const MAX_TEXT = 5000;

export type ChoiceInput = {
  body: string;
  imageKey?: string | null;
  isCorrect: boolean;
};

export type QuestionInput = {
  subjectId: number;
  stem: string;
  stemImageKey?: string | null;
  explanation: string;
  fixedChoices: boolean;
  groupKey?: string | null;
  choices: ChoiceInput[];
};

// Admin-only metadata from the question development documents (Word import). Never sent to examinees.
export const KNOWLEDGE_LEVELS = ["암기형", "해석형", "문제해결형"] as const;
export const DIFFICULTIES = ["하", "중", "중상", "상"] as const;
export type KnowledgeLevel = (typeof KNOWLEDGE_LEVELS)[number];
export type Difficulty = (typeof DIFFICULTIES)[number];

export type QuestionMeta = {
  criterionNo: string; // 문항개발기준 번호, as written ("012")
  itemNo: number; // 예비문항 번호 within the criterion
  field: string; // 분야
  knowledgeLevel: KnowledgeLevel | null;
  difficulty: Difficulty | null;
  intent: string; // 출제의도
  objectionReview: string; // 이의제기 예방검토
  basis: string; // 근거번호
};

/** "archived": deleted by an admin but kept because attempts used it (rule 8). */
export type QuestionStatus = "review" | "active" | "disabled" | "archived";

type Result = { ok: true; value: QuestionInput } | { ok: false; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const optKey = (v: unknown) => {
  const s = str(v);
  return s === "" ? null : s;
};

export function validateQuestionInput(raw: unknown): Result {
  const errors: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ["요청 형식이 올바르지 않습니다."] };

  const subjectId = Number(raw.subjectId);
  if (!Number.isInteger(subjectId) || subjectId <= 0) errors.push("과목을 선택해 주세요.");

  const stem = str(raw.stem);
  const stemImageKey = optKey(raw.stemImageKey);
  if (!stem && !stemImageKey) errors.push("지문을 입력해 주세요.");
  if (stem.length > MAX_TEXT) errors.push(`지문은 ${MAX_TEXT}자 이하로 입력해 주세요.`);

  const explanation = str(raw.explanation);
  if (explanation.length > MAX_TEXT) errors.push(`해설은 ${MAX_TEXT}자 이하로 입력해 주세요.`);

  const groupKey = optKey(raw.groupKey);
  if (groupKey && groupKey.length > 50) errors.push("묶음 키는 50자 이하로 입력해 주세요.");

  const rawChoices = Array.isArray(raw.choices) ? raw.choices : [];
  if (rawChoices.length < MIN_CHOICES || rawChoices.length > MAX_CHOICES) {
    errors.push(`보기는 ${MIN_CHOICES}~${MAX_CHOICES}개여야 합니다.`);
  }
  const choices: ChoiceInput[] = rawChoices.map((c, i) => {
    const o = isObj(c) ? c : {};
    const body = str(o.body);
    const imageKey = optKey(o.imageKey);
    if (!body && !imageKey) errors.push(`${i + 1}번 보기 내용을 입력해 주세요.`);
    if (body.length > MAX_TEXT) errors.push(`${i + 1}번 보기는 ${MAX_TEXT}자 이하로 입력해 주세요.`);
    return { body, imageKey, isCorrect: o.isCorrect === true };
  });
  const correctCount = choices.filter((c) => c.isCorrect).length;
  if (rawChoices.length > 0 && correctCount !== 1) errors.push("정답 보기를 하나만 골라 주세요.");

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      subjectId,
      stem,
      stemImageKey,
      explanation,
      fixedChoices: raw.fixedChoices === true,
      groupKey,
      choices,
    },
  };
}

/** Server-side check of the Word import metadata. Values outside the lists become null on the screen first. */
export function validateQuestionMeta(raw: unknown): { ok: true; value: QuestionMeta } | { ok: false; errors: string[] } {
  if (!isObj(raw)) return { ok: false, errors: ["메타데이터 형식이 올바르지 않습니다."] };
  const errors: string[] = [];
  const criterionNo = str(raw.criterionNo);
  const itemNo = Number(raw.itemNo);
  const field = str(raw.field);
  if (!/^\d{1,10}$/.test(criterionNo)) errors.push("문항개발기준 번호가 없습니다.");
  if (!Number.isInteger(itemNo) || itemNo <= 0) errors.push("예비문항 번호가 없습니다.");
  if (!field || field.length > 50) errors.push("분야는 1~50자여야 합니다.");
  const pick = <T extends string>(v: unknown, list: readonly T[], label: string) => {
    const s = str(v);
    if (s && !list.includes(s as T)) errors.push(`${label} 값이 목록에 없습니다: ${s}`);
    return s ? (s as T) : null;
  };
  const knowledgeLevel = pick(raw.knowledgeLevel, KNOWLEDGE_LEVELS, "지식수준");
  const difficulty = pick(raw.difficulty, DIFFICULTIES, "예상 난이도");
  const text = (v: unknown, label: string) => {
    const s = str(v);
    if (s.length > MAX_TEXT) errors.push(`${label}은(는) ${MAX_TEXT}자 이하여야 합니다.`);
    return s;
  };
  const value = {
    criterionNo,
    itemNo,
    field,
    knowledgeLevel,
    difficulty,
    intent: text(raw.intent, "출제의도"),
    objectionReview: text(raw.objectionReview, "이의제기 예방검토"),
    basis: text(raw.basis, "근거번호"),
  };
  return errors.length ? { ok: false, errors } : { ok: true, value };
}
