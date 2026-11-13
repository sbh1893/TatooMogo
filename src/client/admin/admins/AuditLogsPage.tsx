import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, errorMessage, type AuditLog } from "@/lib/api";
import { fmtTime } from "../exams/common";

const ACTIONS: Record<string, string> = {
  login: "로그인",
  "subject.create": "과목 추가",
  "subject.update": "과목 수정",
  "question.create": "문항 추가",
  "question.update": "문항 수정",
  "question.version": "문항 새 버전",
  "question.disable": "문항 사용 중지",
  "question.enable": "문항 재사용",
  "question.import": "PDF 문항 등록",
  "source.upload": "문제지 업로드",
  "exam.create": "시험 개설",
  "exam.update": "시험 설정 수정",
  "exam.questions": "시험 문항 구성",
  "exam.open": "시험 열기",
  "exam.close": "시험 닫기",
  "exam.export": "성적 내려받기",
  "admin.create": "관리자 추가",
  "admin.update": "관리자 변경",
};

type Page = { items: AuditLog[]; total: number; page: number; pageSize: number };

/** Access and change log (super admin). */
export function AuditLogsPage() {
  const [action, setAction] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = new URLSearchParams({ page: String(page), ...(action ? { action } : {}) });
    api<Page>(`/api/admin/audit-logs?${q}`).then(setData, (e) => setError(errorMessage(e)));
  }, [action, page]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-bold">접속 기록</h1>
        <select
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
            setPage(1);
          }}
          className="h-9 rounded-md border bg-white px-2 text-sm"
          aria-label="종류"
        >
          <option value="">전체</option>
          {Object.entries(ACTIONS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      <ul className="divide-y rounded-lg border bg-white text-sm">
        {data?.items.map((l) => (
          <li key={l.id} className="flex flex-wrap gap-x-3 gap-y-0.5 p-3">
            <span className="w-36 shrink-0 text-xs text-slate-500">{fmtTime(l.createdAt)}</span>
            <span className="font-medium">{ACTIONS[l.action] ?? l.action}</span>
            <span className="text-slate-700">{l.adminEmail}</span>
            {l.targetType && (
              <span className="text-xs text-slate-500">
                {l.targetType} {l.targetId}
              </span>
            )}
            {l.detail != null && <span className="max-w-full truncate text-xs text-slate-500">{JSON.stringify(l.detail)}</span>}
            <span className="ml-auto font-mono text-xs text-slate-400">{l.ip}</span>
          </li>
        ))}
        {data?.items.length === 0 && <li className="p-6 text-center text-slate-500">기록이 없습니다.</li>}
      </ul>
      {data && (
        <div className="flex items-center justify-center gap-2 text-sm">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            이전
          </Button>
          <span>
            {page} / {pages} (전체 {data.total}건)
          </span>
          <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            다음
          </Button>
        </div>
      )}
    </section>
  );
}
