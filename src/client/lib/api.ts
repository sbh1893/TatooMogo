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

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : "알 수 없는 오류가 발생했습니다.");

// Response shapes of /api/admin (kept next to the fetcher; the server is the source of truth).
export type Subject = { id: number; name: string; sortOrder: number };
export type QuestionStatus = "review" | "active" | "disabled";
export type QuestionListItem = {
  id: number;
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
