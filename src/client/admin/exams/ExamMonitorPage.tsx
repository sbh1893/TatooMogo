import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import { api, errorMessage, type ExamMonitor } from "@/lib/api";
import { ExamStatusBadge, fmtTime } from "./common";

const ago = (now: number, t: number) => {
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `${s}초 전` : s < 3600 ? `${Math.floor(s / 60)}분 전` : fmtTime(t);
};

/** Live status of one exam, refreshed by hand (each refresh is one request). */
export function ExamMonitorPage() {
  const { id } = useParams();
  const [data, setData] = useState<ExamMonitor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      api<ExamMonitor>(`/api/admin/exams/${id}/attempts`).then(
        (d) => {
          setData(d);
          setError(null);
        },
        (e) => setError(errorMessage(e)),
      ),
    [id],
  );
  useEffect(() => {
    load();
  }, [load]);
  const refresh = () => {
    setBusy(true);
    load().finally(() => setBusy(false));
  };

  const now = data?.serverNow ?? 0;
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link to={`/admin/exams/${id}`} className="text-sm text-slate-600 hover:underline">
          ← 시험 설정
        </Link>
        <h1 className="mr-auto text-xl font-bold">응시 현황{data ? ` · ${data.exam.title}` : ""}</h1>
        {data && <ExamStatusBadge status={data.exam.status} />}
        <Button size="sm" variant="outline" onClick={refresh} disabled={busy}>
          {busy ? "불러오는 중…" : "새로고침"}
        </Button>
      </div>
      {error && <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      {data && (
        <>
          <div className="grid grid-cols-3 gap-2 text-center">
            {[
              ["응시 중", data.inProgress],
              ["제출 완료", data.submitted],
              ["전체 문항", data.exam.total],
            ].map(([label, n]) => (
              <div key={label} className="rounded-lg border bg-white p-3">
                <div className="text-2xl font-bold">{n}</div>
                <div className="text-xs text-slate-500">{label}</div>
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-500">서버 시각 {fmtTime(now)} 기준 · 화면은 자동으로 바뀌지 않습니다. 새로고침을 눌러 주세요.</p>
          <div className="overflow-x-auto rounded-lg border bg-white">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b bg-slate-50 text-left text-xs text-slate-600">
                <tr>
                  <th className="p-2">수험번호</th>
                  <th className="p-2">이름</th>
                  <th className="p-2">진행률</th>
                  <th className="p-2">상태</th>
                  <th className="p-2">마지막 활동</th>
                  <th className="p-2 text-right">기기 전환</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((a) => {
                  const pct = data.exam.total ? Math.round((100 * a.answered) / data.exam.total) : 0;
                  const status =
                    a.submittedAt !== null
                      ? a.submitReason === "timeout"
                        ? "시간 종료 제출"
                        : "제출"
                      : now > a.deadlineAt
                        ? "시간 종료(처리 대기)"
                        : `응시 중 · ${Math.ceil((a.deadlineAt - now) / 60_000)}분 남음`;
                  return (
                    <tr key={a.no} className="border-b last:border-0">
                      <td className="p-2 font-mono">{a.no}</td>
                      <td className="p-2">{a.name}</td>
                      <td className="p-2">
                        <div className="flex items-center gap-2">
                          <div className="h-2 w-24 rounded bg-slate-100">
                            <div className="h-2 rounded bg-[#1f3a5f]" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-xs text-slate-600">
                            {a.answered}/{data.exam.total}
                          </span>
                        </div>
                      </td>
                      <td className="p-2 text-xs">{status}</td>
                      <td className="p-2 text-xs text-slate-600">{a.lastActiveAt ? ago(now, a.lastActiveAt) : "-"}</td>
                      <td className={`p-2 text-right ${a.deviceSwitches > 0 ? "font-bold text-amber-700" : ""}`}>{a.deviceSwitches}</td>
                    </tr>
                  );
                })}
                {data.items.length === 0 && (
                  <tr>
                    <td colSpan={6} className="p-6 text-center text-slate-500">
                      아직 입장한 수험자가 없습니다.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
