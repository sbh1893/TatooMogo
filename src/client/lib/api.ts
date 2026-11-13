export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** JSON fetch against our own API. Throws ApiError with the server's Korean message. */
export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? "GET",
    headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data as { error?: { code: string; message: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? "network", err?.message ?? `요청에 실패했습니다. (${res.status})`);
  }
  return data as T;
}

/** Uploads a PNG/JPEG for a stem or choice; returns its R2 key ("media/….png"). */
export async function uploadMedia(blob: Blob, name = "image.png"): Promise<string> {
  const form = new FormData();
  form.set("file", new File([blob], name, { type: blob.type || "image/png" }));
  const res = await fetch("/api/admin/media", { method: "POST", body: form, credentials: "same-origin" });
  const data = (await res.json().catch(() => null)) as { key?: string; error?: { message: string } } | null;
  if (!res.ok || !data?.key) throw new Error(data?.error?.message ?? "그림을 올리지 못했습니다.");
  return data.key;
}

/** Admin URL of an uploaded picture. */
export const mediaUrl = (key: string) => `/api/admin/${key}`;

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : "알 수 없는 오류가 발생했습니다.");

// Response shapes of /api/admin (kept next to the fetcher; the server is the source of truth).
export type Subject = { id: number; name: string; sortOrder: number };
export type QuestionStatus = "review" | "active" | "disabled";
export type QuestionListItem = {
  id: number;
  groupKey: string | null;
  code: number;
  version: number;
  subjectId: number;
  subjectName: string;
  stemPreview: string;
  status: QuestionStatus;
  updatedAt: number;
  used: boolean;
};
export type QuestionDetail = {
  id: number;
  code: number;
  version: number;
  isLatest: boolean;
  subjectId: number;
  stem: string;
  stemImageKey: string | null;
  explanation: string;
  fixedChoices: boolean;
  groupKey: string | null;
  status: QuestionStatus;
  used: boolean;
  choices: { id: number; ord: number; body: string; imageKey: string | null; isCorrect: boolean }[];
  versions: { id: number; version: number; status: QuestionStatus; createdAt: number }[];
};
export type SaveResult = { id: number; code: number; version: number; newVersion: boolean };

export type SourceFile = {
  id: number;
  filename: string;
  roundLabel: string | null;
  sizeBytes: number;
  kind: "text" | "scan" | null;
  status: "uploaded" | "reviewing" | "done" | "failed";
  createdAt: number;
};

export type ExamSettings = {
  title: string;
  timeLimitMin: number;
  opensAt: number | null;
  closesAt: number | null;
  passSubjectPct: number;
  passAvgPct: number;
  shuffleQuestions: boolean;
  shuffleWithinSubject: boolean;
  shuffleChoices: boolean;
  revealExplanations: boolean;
  notice: string;
};
export type ExamStatus = "draft" | "open" | "closed";
export type ExamListItem = {
  id: number;
  title: string;
  code: string;
  status: ExamStatus;
  opensAt: number | null;
  closesAt: number | null;
  timeLimitMin: number;
  questionCount: number;
  attemptCount: number;
};
export type ExamQuestion = {
  eqId: number;
  questionId: number;
  code: number;
  version: number;
  subjectId: number;
  subjectName: string;
  stemPreview: string;
  groupKey: string | null;
  points: number;
};
export type ExamDetail = ExamSettings & { id: number; code: string; status: ExamStatus; locked: boolean; attemptCount: number; questions: ExamQuestion[] };
