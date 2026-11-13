import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { api, errorMessage, type ExamListItem } from "@/lib/api";
import { ExamStatusBadge, fmtTime } from "./common";

export function ExamListPage() {
  const [items, setItems] = useState<ExamListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ items: ExamListItem[] }>("/api/admin/exams").then((r) => setItems(r.items), (e) => setError(errorMessage(e)));
  }, []);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">시험</h1>
        <Button asChild>
          <Link to="/admin/exams/new">시험 개설</Link>
        </Button>
      </div>
      {error && <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      <ul className="divide-y rounded-lg border bg-white">
        {items?.map((e) => (
          <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3 text-sm">
            <Link to={`/admin/exams/${e.id}`} className="font-medium hover:underline">
              {e.title}
            </Link>
            <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs tracking-widest">{e.code}</span>
            <span className="text-xs text-slate-500">
              문항 {e.questionCount} · {e.timeLimitMin}분 · 응시 {e.attemptCount}명
              {e.opensAt || e.closesAt ? ` · ${fmtTime(e.opensAt) || "처음부터"} ~ ${fmtTime(e.closesAt) || "끝없음"}` : ""}
            </span>
            <span className="ml-auto">
              <ExamStatusBadge status={e.status} />
            </span>
          </li>
        ))}
        {items?.length === 0 && <li className="p-6 text-center text-sm text-slate-500">아직 개설한 시험이 없습니다.</li>}
      </ul>
    </section>
  );
}
