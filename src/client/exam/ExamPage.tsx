import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, ApiError, errorMessage } from "@/lib/api";
import "./cbt.css";
import type { Paper, PaperQuestion } from "./types";

type Modal = { kind: "submit" } | { kind: "timeup" } | { kind: "info"; title: string; body: string } | null;
const SIZES = [
  [15, "작게"],
  [17, "보통"],
  [20, "크게"],
] as const;
const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
};

export function ExamPage() {
  const navigate = useNavigate();
  const [paper, setPaper] = useState<Paper | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<number, number | null>>({});
  const [unsaved, setUnsaved] = useState<Record<number, number | null>>({}); // saves that failed, latest value per question
  const [saving, setSaving] = useState(0);
  const [cur, setCur] = useState(0);
  const [lay, setLay] = useState<1 | 2>(1);
  const [fs, setFs] = useState(17);
  const [omrOpen, setOmrOpen] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [now, setNow] = useState(() => Date.now());
  const [online, setOnline] = useState(() => navigator.onLine);
  const [offset, setOffset] = useState(0); // server clock − this device's clock
  const queue = useRef(Promise.resolve()); // saves go out one at a time, in click order
  const finished = useRef(false);

  // An error that means "this attempt is over here": another device took over, or it was submitted.
  const handleGone = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) setFatal(e.message);
      else if (e instanceof ApiError && e.status === 409) {
        finished.current = true;
        setModal(e.code === "timeout" ? { kind: "timeup" } : null);
        if (e.code !== "timeout") navigate("/result", { replace: true });
      } else return false;
      return true;
    },
    [navigate],
  );

  useEffect(() => {
    api<Paper>("/api/exam/paper").then(
      (p) => {
        setOffset(p.serverNow - Date.now());
        setPaper(p);
        setAnswers(Object.fromEntries(p.answers.map((a) => [a.no, a.choice])));
      },
      (e) => handleGone(e) || setFatal(errorMessage(e)),
    );
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    addEventListener("online", on);
    addEventListener("offline", off);
    return () => {
      clearInterval(tick);
      removeEventListener("online", on);
      removeEventListener("offline", off);
    };
  }, [handleGone]);

  const send = useCallback(
    (no: number, choice: number | null) => {
      setSaving((n) => n + 1);
      queue.current = queue.current.then(() =>
        api<{ serverNow: number }>("/api/exam/answers", { method: "PUT", body: { no, choice } }).then(
          (r) => {
            setOffset(r.serverNow - Date.now());
            setUnsaved((u) => {
              if (!(no in u) || u[no] !== choice) return u;
              const rest = { ...u };
              delete rest[no];
              return rest;
            });
          },
          (e) => {
            if (!handleGone(e)) setUnsaved((u) => ({ ...u, [no]: choice }));
          },
        ).finally(() => setSaving((n) => n - 1)),
      );
      return queue.current;
    },
    [handleGone],
  );

  const mark = useCallback(
    (no: number, choice: number) => {
      if (finished.current) return;
      const next = answers[no] === choice ? null : choice; // the same choice again clears it
      setAnswers((a) => ({ ...a, [no]: next }));
      void send(no, next);
    },
    [answers, send],
  );
  const retry = () => Object.entries(unsaved).forEach(([no, c]) => void send(Number(no), c));

  const submit = async () => {
    setModal(null);
    await queue.current;
    try {
      await api("/api/exam/submit", { method: "POST" });
      finished.current = true;
      navigate("/result", { replace: true });
    } catch (e) {
      if (!handleGone(e)) setModal({ kind: "info", title: "제출하지 못했습니다", body: `${errorMessage(e)} 잠시 후 다시 눌러 주세요.` });
    }
  };

  const left = paper ? paper.deadlineAt - (now + offset) : Infinity;
  // Time is up on the server clock: send what is queued, then let the server close it.
  useEffect(() => {
    if (left > 0 || finished.current || !paper) return;
    finished.current = true;
    void queue.current
      .then(() => api("/api/exam/submit", { method: "POST" }))
      .catch(() => {})
      .then(() => setModal({ kind: "timeup" }));
  }, [left, paper]);

  const n = paper?.questions.length ?? 0;
  const go = useCallback(
    (i: number) => {
      const k = Math.max(0, Math.min(n - 1, i));
      setCur(lay === 2 ? k - (k % 2) : k);
    },
    [n, lay],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!paper || modal || (e.target as HTMLElement).tagName === "INPUT") return;
      const q = paper.questions[cur];
      const k = Number(e.key);
      if (Number.isInteger(k) && k >= 1 && k <= q.choices.length) mark(q.no, k);
      if (e.key === "ArrowRight") go(cur + lay);
      if (e.key === "ArrowLeft") go(cur - lay);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [paper, modal, cur, lay, mark, go]);

  const omrList = useRef<HTMLDivElement>(null);
  useEffect(() => {
    omrList.current?.querySelector(".orow.cur")?.scrollIntoView({ block: "nearest" });
  }, [cur]);

  if (fatal)
    return (
      <div className="cbt">
        <div className="start">
          <div className="card">
            <div className="err">{fatal}</div>
            <Link className="btn btn-primary" to="/">
              처음 화면으로
            </Link>
          </div>
        </div>
      </div>
    );
  if (!paper)
    return (
      <div className="cbt">
        <p style={{ padding: 24 }}>문제지를 불러오는 중…</p>
      </div>
    );

  const unanswered = paper.questions.filter((q) => answers[q.no] == null).map((q) => q.no);
  const shown = lay === 2 ? [cur - (cur % 2), cur - (cur % 2) + 1].filter((i) => i < n) : [cur];
  const firstUnanswered = () => {
    for (let k = 1; k <= n; k++) {
      const i = (cur + k) % n;
      if (answers[paper.questions[i].no] == null) return i;
    }
    return -1;
  };

  const question = (q: PaperQuestion) => (
    <div className="q" key={q.no}>
      <span className="subject-tag">{q.subjectName}</span>
      <div className="stem">
        <span className="n">{q.no}.</span>
        <span className="t">
          {q.stem}
          {q.stemImage && <img src={q.stemImage} alt={`${q.no}번 지문 그림`} />}
        </span>
      </div>
      <ul className="choices" role="radiogroup" aria-label={`${q.no}번 보기`}>
        {q.choices.map((c) => (
          <li
            key={c.no}
            role="radio"
            aria-checked={answers[q.no] === c.no}
            tabIndex={0}
            className={answers[q.no] === c.no ? "sel" : ""}
            onClick={() => mark(q.no, c.no)}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), mark(q.no, c.no))}
          >
            <span className="c">{c.no}</span>
            <span>
              {c.text}
              {c.image && <img src={c.image} alt={`${c.no}번 보기 그림`} />}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <div className="cbt" style={{ "--fs": `${fs}px` } as React.CSSProperties}>
      <section className="exam">
        <div className="topbar">
          <div className="brand">{paper.exam.title}</div>
          <div className="spacer" />
          <div className="chip">
            수험번호 <b>{paper.examinee.no}</b>
          </div>
          <div className="chip">
            성명 <b>{paper.examinee.name}</b>
          </div>
          <div className="chip">
            문제지 <b>{paper.paperCode}</b>
          </div>
          <div className="chip">남은 시간</div>
          <div className={`timer ${left <= 60_000 ? "warn" : ""}`} role="timer" aria-live="off">
            {mmss(left)}
          </div>
        </div>
        <div className="toolbar">
          <div className="grp">
            <span className="lbl">글자크기</span>
            {SIZES.map(([px, label]) => (
              <button key={px} className={`tbtn ${fs === px ? "on" : ""}`} onClick={() => setFs(px)}>
                {label}
              </button>
            ))}
          </div>
          <div className="grp layout-grp">
            <span className="lbl">화면배치</span>
            {([1, 2] as const).map((l) => (
              <button
                key={l}
                className={`tbtn ${lay === l ? "on" : ""}`}
                onClick={() => {
                  setLay(l);
                  if (l === 2) setCur(cur - (cur % 2));
                }}
              >
                {l}단
              </button>
            ))}
          </div>
          <div className="stat">
            {!online ? (
              <b style={{ color: "var(--bad)" }}>오프라인 · </b>
            ) : saving > 0 ? (
              <span>저장 중 · </span>
            ) : null}
            전체 <b>{n}</b> · 안 푼 문제 <b style={{ color: "var(--bad)" }}>{unanswered.length}</b>
          </div>
        </div>
        {Object.keys(unsaved).length > 0 && (
          <div className="savebar" role="alert">
            답 {Object.keys(unsaved).length}개가 저장되지 않았습니다.
            <button className="btn btn-ghost" style={{ padding: "4px 10px" }} onClick={retry}>
              다시 저장
            </button>
          </div>
        )}

        <div className="main">
          <div className={`qpane ${lay === 2 ? "two" : ""}`}>
            {shown.map((i) => question(paper.questions[i]))}
            {lay === 2 && shown.length === 1 && <div className="q" />}
            <div className="navrow" style={lay === 2 ? { gridColumn: "1/-1" } : undefined}>
              <button className="btn btn-ghost" disabled={cur < lay} onClick={() => go(cur - lay)}>
                ◀ 이전
              </button>
              <span className="pos">
                {cur + 1} / {n}
              </span>
              {cur + lay >= n ? (
                <button className="btn btn-accent" onClick={() => setModal({ kind: "submit" })}>
                  답안 제출
                </button>
              ) : (
                <button className="btn btn-primary" onClick={() => go(cur + lay)}>
                  다음 ▶
                </button>
              )}
            </div>
          </div>

          <aside className={`omr ${omrOpen ? "open" : ""}`} aria-label="답안 표기란">
            <h3>
              <span>답안 표기란</span>
              <span style={{ color: "var(--sub)", fontWeight: 500 }}>
                {n - unanswered.length}/{n}
              </span>
            </h3>
            <div className="list" ref={omrList}>
              {paper.questions.map((q, i) => (
                <div key={q.no} className={`orow ${shown.includes(i) ? "cur" : ""}`}>
                  <span
                    className="no"
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      go(i);
                      setOmrOpen(false);
                    }}
                    onKeyDown={(e) => e.key === "Enter" && go(i)}
                  >
                    {q.no}
                  </span>
                  {q.choices.map((c) => (
                    <button
                      key={c.no}
                      className={`bub ${answers[q.no] === c.no ? "on" : ""}`}
                      aria-label={`${q.no}번 ${c.no}`}
                      aria-pressed={answers[q.no] === c.no}
                      onClick={() => {
                        mark(q.no, c.no);
                        if (!shown.includes(i)) go(i);
                      }}
                    >
                      {c.no}
                    </button>
                  ))}
                </div>
              ))}
            </div>
            <div className="foot">
              <button
                className="btn btn-ghost"
                onClick={() => {
                  const i = firstUnanswered();
                  if (i < 0) return setModal({ kind: "info", title: "모든 문제에 답했습니다", body: "안 푼 문제가 없습니다. 답안을 제출할 수 있어요." });
                  go(i);
                  setOmrOpen(false);
                }}
              >
                안 푼 문제로 이동
              </button>
              <button className="btn btn-accent" onClick={() => setModal({ kind: "submit" })}>
                답안 제출
              </button>
            </div>
          </aside>
          <button className="omr-toggle" onClick={() => setOmrOpen(!omrOpen)} aria-expanded={omrOpen}>
            📝 답안 표기란
          </button>
        </div>
      </section>

      {modal && (
        <div className="modal-bg" role="dialog" aria-modal="true">
          <div className="modal">
            {modal.kind === "submit" && (
              <>
                <h3>답안을 제출하시겠습니까?</h3>
                <p>
                  {unanswered.length ? (
                    <>
                      아직 풀지 않은 문제가 <b style={{ color: "var(--bad)" }}>{unanswered.length}개</b> 있습니다. 제출하면 수정할 수 없습니다.
                    </>
                  ) : (
                    "제출 후에는 답안을 수정할 수 없습니다."
                  )}
                </p>
                {unanswered.length > 0 && (
                  <div className="unans">
                    {unanswered.map((no) => (
                      <button
                        key={no}
                        onClick={() => {
                          setModal(null);
                          go(no - 1);
                        }}
                      >
                        {no}번
                      </button>
                    ))}
                  </div>
                )}
                <div className="acts">
                  <button className="btn btn-ghost" onClick={() => setModal(null)}>
                    {unanswered.length ? "계속 풀기" : "취소"}
                  </button>
                  <button className="btn btn-accent" onClick={submit}>
                    제출
                  </button>
                </div>
              </>
            )}
            {modal.kind === "timeup" && (
              <>
                <h3>시험 시간 종료</h3>
                <p>제한 시간이 끝나 답안이 자동으로 제출되었습니다.</p>
                <div className="acts">
                  <button className="btn btn-primary" onClick={() => navigate("/result", { replace: true })}>
                    결과 보기
                  </button>
                </div>
              </>
            )}
            {modal.kind === "info" && (
              <>
                <h3>{modal.title}</h3>
                <p>{modal.body}</p>
                <div className="acts">
                  <button className="btn btn-primary" onClick={() => setModal(null)}>
                    확인
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
