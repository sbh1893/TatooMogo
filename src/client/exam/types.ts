// Response shapes of /api/exam (the server is the source of truth).

export type ExamInfo = {
  title: string;
  code: string;
  timeLimitMin: number;
  passSubjectPct: number;
  passAvgPct: number;
  notice: string;
  opensAt: number | null;
  closesAt: number | null;
  open: boolean;
  serverNow: number;
  subjects: { name: string; count: number }[];
  total: number;
};

export type PaperChoice = { no: number; text: string; image: string | null };
export type PaperQuestion = { no: number; subjectName: string; stem: string; stemImage: string | null; choices: PaperChoice[] };
export type Paper = {
  exam: { title: string; subjects: string[] };
  examinee: { no: string; name: string };
  paperCode: string;
  serverNow: number;
  deadlineAt: number;
  questions: PaperQuestion[];
  answers: { no: number; choice: number }[];
};

export type Result = {
  exam: { title: string; passSubjectPct: number; passAvgPct: number };
  examinee: { no: string; name: string };
  paperCode: string;
  submitReason: "manual" | "timeout" | "admin" | null;
  durationSec: number;
  totalCorrect: number;
  total: number;
  avgPct: number;
  passed: boolean;
  subjects: { name: string; correct: number; total: number; pct: number; failed: boolean }[];
  review:
    | {
        no: number;
        code: number;
        subjectName: string;
        stem: string;
        stemImage: string | null;
        choices: PaperChoice[];
        correctNo: number;
        pickedNo: number | null;
        explanation: string;
      }[]
    | null;
};

export const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"];
