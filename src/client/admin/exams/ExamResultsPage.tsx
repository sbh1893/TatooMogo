import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import { api, errorMessage, type ExamResults } from "@/lib/api";
import { buildXlsx } from "@/lib/xlsx";
import { fmtTime } from "./common";

function download(bytes: Uint8Array, filename: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const minutes = (a: number, b: number) => Math.round((b - a) / 60_000);

function toSheets(r: ExamResults) {
  const subjects = r.examinees[0]?.subjects.map((s) => s.name) ?? [];
  return [
    {
      name: "수험자별 성적",
      rows: [
        ["수험번호", "이름", "평균(%)", "합격", "정답 수", ...subjects.map((s) => `${s}(%)`), "소요(분)", "제출 시각", "제출 방식"],
        ...r.examinees.map((e) => [
          e.no,
          e.name,
          e.avgPct,
          e.passed ? "합격" : "불합격",
          e.totalCorrect,
          ...e.subjects.map((s) => s.pct),
          minutes(e.startedAt, e.submittedAt),
          fmtTime(e.submittedAt),
          e.submitReason === "timeout" ? "시간 종료" : "직접 제출",
        ]),
      ],
    },
    {
      name: "문항별 정답률",
      rows: [["공통 문항 번호", "버전", "과목", "정답 수", "응답 수", "제출 인원", "정답률(%)"], ...r.questions.map((q) => [q.code, q.version, q.subject, q.correct, q.answered, r.submitted, q.rate])],
    },
  ];
}

export function ExamResultsPage() {
  const { id } = useParams();
  const [data, setData] = useState<ExamResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<ExamResults>(`/api/admin/exams/${id}/results`).then(setData, (e) => setError(errorMessage(e)));
  }, [id]);

  const exportXlsx = async () => {
    setBusy(true);
    try {
      // The server logs the download, then the file is made here (not in the Worker).
      const r = await api<ExamResults>(`/api/admin/exams/${id}/export`, { method: "POST" });
      download(buildXlsx(toSheets(r)), `성적_${r.exam.title}_${r.exam.code}.xlsx`.replace(/[\\/:*?"<>|]/g, "_"));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const passed = data?.examinees.filter((e) => e.passed).length ?? 0;
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link to={`/admin/exams/${id}`} className="text-sm text-slate-600 hover:underline">
          ← 시험 설정
        </Link>
        <h1 className="mr-auto text-xl font-bold">성적{data ? ` · ${data.exam.title}` : ""}</h1>
        <Button size="sm" onClick={exportXlsx} disabled={busy || !data?.submitted}>
          {busy ? "만드는 중…" : "엑셀 내려받기"}
        </Button>
      </div>
      {error && <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      {data && (
        <>
          <p className="text-sm text-slate-600">
            제출 {data.submitted}명 · 합격 {passed}명 · 기준: 과목별 {data.exam.passSubjectPct}% 이상, 평균 {data.exam.passAvgPct}% 이상 · 제출한 수험자만 집계합니다.
          </p>
          <h2 className="font-bold">수험자별 성적</h2>
          <div className="overflow-x-auto rounded-lg border bg-white">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="border-b bg-slate-50 text-left text-xs text-slate-600">
                <tr>
                  <th className="p-2">수험번호</th>
                  <th className="p-2">이름</th>
                  <th className="p-2 text-right">평균</th>
                  <th className="p-2">결과</th>
                  <th className="p-2">과목별</th>
                  <th className="p-2 text-right">소요</th>
                </tr>
              </thead>
              <tbody>
                {data.examinees.map((e) => (
                  <tr key={e.no} className="border-b last:border-0">
                    <td className="p-2 font-mono">{e.no}</td>
                    <td className="p-2">{e.name}</td>
                    <td className="p-2 text-right font-bold">{Math.round(e.avgPct * 10) / 10}</td>
                    <td className={`p-2 font-bold ${e.passed ? "text-emerald-700" : "text-red-700"}`}>{e.passed ? "합격" : "불합격"}</td>
                    <td className="p-2 text-xs text-slate-600">
                      {e.subjects.map((s) => (
                        <span key={s.name} className={`mr-2 whitespace-nowrap ${s.pct < data.exam.passSubjectPct ? "font-bold text-red-700" : ""}`}>
                          {s.name} {s.pct}%
                        </span>
                      ))}
                    </td>
                    <td className="p-2 text-right text-xs">{minutes(e.startedAt, e.submittedAt)}분</td>
                  </tr>
                ))}
                {data.examinees.length === 0 && (
                  <tr>
                    <td colSpan={6} className="p-6 text-center text-slate-500">
                      아직 제출한 수험자가 없습니다.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <h2 className="font-bold">공통 문항 번호별 정답률</h2>
          <div className="overflow-x-auto rounded-lg border bg-white">
            <table className="w-full min-w-[420px] text-sm">
              <thead className="border-b bg-slate-50 text-left text-xs text-slate-600">
                <tr>
                  <th className="p-2">공통 번호</th>
                  <th className="p-2">과목</th>
                  <th className="p-2">정답률</th>
                  <th className="p-2 text-right">정답/제출</th>
                </tr>
              </thead>
              <tbody>
                {data.questions.map((q) => (
                  <tr key={`${q.code}-${q.version}`} className="border-b last:border-0">
                    <td className="p-2 font-mono">
                      #{q.code}
                      {q.version > 1 && <span className="text-xs text-slate-500"> (v{q.version})</span>}
                    </td>
                    <td className="p-2 text-xs">{q.subject}</td>
                    <td className="p-2">
                      {q.rate === null ? (
                        "-"
                      ) : (
                        <div className="flex items-center gap-2">
                          <div className="h-2 w-24 rounded bg-slate-100">
                            <div className={`h-2 rounded ${q.rate < 40 ? "bg-red-500" : "bg-[#1f3a5f]"}`} style={{ width: `${q.rate}%` }} />
                          </div>
                          <span className="text-xs">{q.rate}%</span>
                        </div>
                      )}
                    </td>
                    <td className="p-2 text-right text-xs">
                      {q.correct}/{data.submitted}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
