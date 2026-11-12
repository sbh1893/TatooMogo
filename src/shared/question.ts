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

export type QuestionStatus = "review" | "active" | "disabled";

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
