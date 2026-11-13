import { Link } from "react-router";
import "./cbt.css";

const PAGES = {
  privacy: {
    title: "개인정보 처리방침",
    // Headings only; the wording is the client's to decide (PLAN 법적 준비, ANALYSIS #22).
    sections: ["수집하는 항목: 이름, 수험번호, 응시 기록(답안·점수), 접속 IP", "수집·이용 목적", "보관 기간", "제3자 제공 및 처리 위탁", "이용자의 권리와 행사 방법", "개인정보 보호책임자 연락처", "시행일"],
  },
  terms: {
    title: "이용약관",
    sections: ["목적", "서비스 내용(모의고사 응시·채점)", "이용자의 의무", "문제 저작권", "책임의 한계", "약관 변경", "시행일"],
  },
} as const;

/** Placeholder until the client supplies the text. */
export function LegalPage({ kind }: { kind: keyof typeof PAGES }) {
  const p = PAGES[kind];
  return (
    <div className="cbt">
      <div className="topbar">
        <div className="brand">
          타투모고
        </div>
      </div>
      <div className="start">
        <div className="card">
          <h1>{p.title}</h1>
          <div className="notice">문구 준비 중입니다. 운영자가 확정한 내용으로 바뀔 예정입니다.</div>
          <ol style={{ lineHeight: 2, paddingLeft: 20 }}>
            {p.sections.map((s) => (
              <li key={s}>
                {s} <span style={{ color: "var(--sub)" }}>— (문구 확정 필요)</span>
              </li>
            ))}
          </ol>
          <p style={{ marginTop: 20 }}>
            <Link to="/">← 처음 화면으로</Link>
          </p>
        </div>
      </div>
    </div>
  );
}

export function LegalLinks() {
  return (
    <p className="foot-note">
      <Link to="/privacy">개인정보 처리방침</Link> · <Link to="/terms">이용약관</Link>
    </p>
  );
}
