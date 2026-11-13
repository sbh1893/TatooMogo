import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api, errorMessage } from "@/lib/api";
import "./cbt.css";
import { LegalLinks } from "./LegalPage";
import type { ExamInfo } from "./types";

const fmt = (t: number | null) => (t ? new Date(t).toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" }) : "");

/** Entry: exam code → exam info → examinee number and name → start (or continue). */
export function HomePage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [code, setCode] = useState(params.get("code") ?? "");
  const [info, setInfo] = useState<ExamInfo | null>(null);
  const [no, setNo] = useState("");
  const [name, setName] = useState("");
  const [agree, setAgree] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const lookUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      setInfo(await api<ExamInfo>(`/api/exam/info?code=${encodeURIComponent(code.trim())}`));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!info) return;
    setError(null);
    setBusy(true);
    try {
      const r = await api<{ status: "in_progress" | "submitted" }>("/api/exam/enter", {
        method: "POST",
        body: { code: info.code, examineeNo: no.trim(), name: name.trim() },
      });
      navigate(r.status === "submitted" ? "/result" : "/exam");
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="cbt">
      <div className="topbar">
        <div className="brand">
          타투모고
        </div>
      </div>
      <div className="start">
        <div className="card">
          {!info ? (
            <form onSubmit={lookUp}>
              <h1>모의고사 입장</h1>
              <p className="lead">안내받은 시험 코드를 입력해 주세요.</p>
              {error && <div className="err">{error}</div>}
              <div className="form-row">
                <label>
                  시험 코드
                  <input
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                    maxLength={6}
                    autoComplete="off"
                    autoCapitalize="characters"
                    placeholder="예: K7M4QX"
                    required
                  />
                </label>
              </div>
              <button className="btn btn-primary btn-block" disabled={busy}>
                {busy ? "확인 중…" : "다음"}
              </button>
            </form>
          ) : (
            <form onSubmit={start}>
              <h1>{info.title}</h1>
              <p className="lead">실제 시험장의 컴퓨터 기반 시험(CBT) 화면과 같은 흐름으로 응시합니다.</p>
              {info.notice && (
                <div className="notice" style={{ whiteSpace: "pre-line" }}>
                  {info.notice}
                </div>
              )}
              {!info.open && (
                <div className="err">
                  지금은 새로 입장할 수 없는 시간입니다.
                  {info.opensAt && info.serverNow < info.opensAt ? ` (${fmt(info.opensAt)}부터 응시할 수 있습니다)` : ""} 이미 응시를 시작했다면 같은
                  수험번호와 이름으로 이어서 볼 수 있습니다.
                </div>
              )}
              {error && <div className="err">{error}</div>}
              <div className="form-row">
                <label>
                  수험자 성명
                  <input value={name} onChange={(e) => setName(e.target.value)} maxLength={12} autoComplete="off" placeholder="홍길동" required />
                </label>
                <label>
                  수험번호
                  <input
                    value={no}
                    onChange={(e) => setNo(e.target.value)}
                    maxLength={16}
                    autoComplete="off"
                    pattern="[0-9A-Za-z\-]{1,16}"
                    title="영문·숫자 16자 이하"
                    required
                  />
                </label>
              </div>
              <table className="info">
                <thead>
                  <tr>
                    <th>과목</th>
                    <th>문항</th>
                  </tr>
                </thead>
                <tbody>
                  {info.subjects.map((s) => (
                    <tr key={s.name}>
                      <td>{s.name}</td>
                      <td>{s.count}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th>합계 · 제한 시간</th>
                    <th>
                      {info.total}문항 · {info.timeLimitMin}분
                    </th>
                  </tr>
                </tfoot>
              </table>
              <p style={{ fontSize: 13, color: "var(--sub)", margin: "-6px 0 14px", lineHeight: 1.6 }}>
                합격 기준: 과목별 {info.passSubjectPct}% 이상 &amp; 과목 평균 {info.passAvgPct}% 이상
                {info.closesAt ? ` · ${fmt(info.closesAt)}에 시험이 닫힙니다` : ""}
                <br />
                같은 수험번호와 이름으로 다시 입장하면 이어서 응시합니다. 다른 기기에서 입장하면 먼저 쓰던 기기는 멈춥니다.
                <br />
                단축키: <b>1~5</b> 보기 선택 · <b>←/→</b> 이전/다음 문제
              </p>
              <label className="agree">
                <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} required />
                <span>
                  시험 진행과 성적 처리를 위해 이름과 수험번호를 저장하는 데 동의합니다. (
                  <a href="/privacy" target="_blank" rel="noreferrer">
                    개인정보 처리방침
                  </a>
                  )
                </span>
              </label>
              <button className="btn btn-primary btn-block" disabled={busy || !agree}>
                {busy ? "입장 중…" : "시험 시작"}
              </button>
              <p style={{ textAlign: "center", marginTop: 12 }}>
                <button type="button" className="btn btn-ghost" onClick={() => setInfo(null)}>
                  다른 시험 코드 입력
                </button>
              </p>
            </form>
          )}
        </div>
        <LegalLinks />
      </div>
    </div>
  );
}
