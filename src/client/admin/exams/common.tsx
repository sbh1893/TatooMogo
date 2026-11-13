import type { ExamStatus } from "@/lib/api";

const LABEL: Record<ExamStatus, [string, string]> = {
  draft: ["준비 중", "bg-slate-100 text-slate-700"],
  open: ["열림", "bg-emerald-100 text-emerald-900"],
  closed: ["닫힘", "bg-slate-300 text-slate-800"],
};

export function ExamStatusBadge({ status }: { status: ExamStatus }) {
  const [text, cls] = LABEL[status];
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${cls}`}>{text}</span>;
}

export const fmtTime = (t: number | null) => (t ? new Date(t).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" }) : "");

/** epoch ms ⇄ <input type="datetime-local"> value (local time). */
export const toLocalInput = (t: number | null) => {
  if (!t) return "";
  const d = new Date(t);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
export const fromLocalInput = (v: string) => (v ? new Date(v).getTime() : null);
