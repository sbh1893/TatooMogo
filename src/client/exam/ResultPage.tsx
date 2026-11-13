import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, ApiError, errorMessage } from "@/lib/api";
import "./cbt.css";
import { CIRCLED, type Result } from "./types";

const round = (x: number) => Math.round(x * 10) / 10;

export function ResultPage() {
  const navigate = useNavigate();
  const [r, setR] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "wrong">("all");

  useEffect(() => {
    api<Result>("/api/exam/result").then(setR, (e) => {
      if (e instanceof ApiError && e.status === 409) navigate("/exam", { replace: true }); // not submitted yet
      else setError(errorMessage(e));
    });
  }, [navigate]);

  if (error)
    return (
      <div className="cbt">
        <div className="start">
          <div className="card">
            <div className="err">{error}</div>
            <Link className="btn btn-primary" to="/">
              처음 화면으로
            </Link>
          </div>
        </div>
      </div>
    );
  if (!r)
    return (
      <div className="cbt">
        <p style={{ padding: 24 }}>결과를 불러오는 중…</p>
      </div>
    );

  const failedSubjects = r.subjects.filter((s) => s.failed);
  const review = r.review?.filter((q) => filter === "all" || q.pickedNo !== q.correctNo) ?? [];

  return (
    <div className="cbt">
      <div className="topbar">
        <div className="brand">
          {r.exam.title}
          <small>채점 결과</small>
        </div>
        <div className="spacer" />
        <div className="chip">
          {r.examinee.no} · {r.examinee.name} · 문제지 {r.paperCode}
        </div>
      </div>
      <div className="result">
        <div className="card">
          <div className="verdict">
            <div className={`stamp ${r.passed ? "pass" : "fail"}`}>{r.passed ? "합격" : "불합격"}</div>
            <div>
              <div className="big">
                {round(r.avgPct)}점{" "}
                <small>
                  ({r.totalCorrect}/{r.total} 정답 · 과목 평균)
                </small>
              </div>
              <div className="why">
                {failedSubjects.length > 0 && (
                  <>
                    과락 과목: <b style={{ color: "var(--bad)" }}>{failedSubjects.map((s) => s.name).join(", ")}</b> ({r.exam.passSubjectPct}% 미만)
                    <br />
                  </>
                )}
                {r.avgPct < r.exam.passAvgPct && (
                  <>
                    평균 {round(r.avgPct)}점으로 합격선 {r.exam.passAvgPct}점에 미달
                    <br />
                  </>
                )}
                {r.passed && (
                  <>
                    모든 과목 {r.exam.passSubjectPct}% 이상, 평균 {r.exam.passAvgPct}점 이상으로 합격 기준을 충족했습니다.
                    <br />
                  </>
                )}
                소요 시간 {Math.floor(r.durationSec / 60)}분 {r.durationSec % 60}초{r.submitReason === "timeout" ? " (시간 종료로 자동 제출)" : ""}
              </div>
            </div>
          </div>
          <div className="subjects">
            {r.subjects.map((s) => (
              <div className="subj" key={s.name}>
                <span>{s.name}</span>
                <div className="bar">
                  <i className={s.failed ? "low" : ""} style={{ width: `${s.pct}%` }} />
                  <span className="cut" style={{ left: `${r.exam.passSubjectPct}%` }} />
                </div>
                <span className="sc">
                  {s.correct}/{s.total} · {Math.round(s.pct)}%
                </span>
              </div>
            ))}
          </div>
          <div className="legend">
            <span />
            과락 기준선 {r.exam.passSubjectPct}%
          </div>
        </div>

        {r.review ? (
          <>
            <div className="section-title">
              <span>문항별 해설</span>
              <div className="filter">
                <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>
                  전체
                </button>
                <button className={filter === "wrong" ? "on" : ""} onClick={() => setFilter("wrong")}>
                  오답만
                </button>
              </div>
            </div>
            {review.map((q) => {
              const ok = q.pickedNo === q.correctNo;
              return (
                <div className="review" key={q.no}>
                  <div className="hd">
                    <b>{q.no}.</b>
                    <span className={`badge ${ok ? "o" : "x"}`}>{ok ? "정답" : q.pickedNo === null ? "미응답" : "오답"}</span>
                    <span className="subject-tag" style={{ margin: 0 }}>
                      {q.subjectName}
                    </span>
                    <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--sub)" }}>공통 문항 #{q.code}</span>
                  </div>
                  <div className="stem">{q.stem}</div>
                  {q.stemImage && <img src={q.stemImage} alt={`${q.no}번 지문 그림`} style={{ maxWidth: "100%" }} />}
                  <ol>
                    {q.choices.map((c) => (
                      <li key={c.no} className={c.no === q.correctNo ? "ans" : c.no === q.pickedNo ? "wrong" : ""}>
                        {CIRCLED[c.no - 1]} {c.text}
                        {c.image && <img src={c.image} alt={`${c.no}번 보기 그림`} style={{ maxHeight: 100, display: "block" }} />}
                        {c.no === q.correctNo ? " ✓" : ""}
                        {c.no === q.pickedNo && !ok ? " (내 답)" : ""}
                      </li>
                    ))}
                  </ol>
                  {q.explanation && <div className="exp">💡 {q.explanation}</div>}
                </div>
              );
            })}
            {review.length === 0 && (
              <div className="review" style={{ textAlign: "center", color: "var(--sub)" }}>
                틀린 문제가 없습니다 🎉
              </div>
            )}
          </>
        ) : (
          <p className="foot-note">이 시험은 정답과 해설을 공개하지 않습니다.</p>
        )}
        <p className="foot-note">TAT-Q 문신사 CBT 모의고사 · 모의고사 결과는 실제 시험 결과와 다를 수 있습니다.</p>
      </div>
    </div>
  );
}
