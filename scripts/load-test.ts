/**
 * Load check: N examinees enter, save every answer and submit at the same time.
 * Prints requests, latency and the D1 queries / rows read / rows written each request made
 * (the dev server reports these in X-D1-Meter; ENVIRONMENT=development only).
 *
 *   npm run dev                       (another terminal; local DB migrated + seeded)
 *   npm run load-test                 (30 examinees, a new exam from active bank questions)
 *   npm run load-test -- --n 50 --questions 40 --base http://localhost:5173
 *
 * Numbers come from local D1 (SQLite); production D1 counts the same way but may differ a little.
 */
const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const BASE = arg("base", "http://localhost:5173").replace(/\/$/, "");
const N = Number(arg("n", "30"));
const QUESTIONS = Number(arg("questions", "20"));
const ORIGIN = { Origin: BASE };

type Stat = { ms: number[]; q: number; read: number; write: number; errors: number };
const stats = new Map<string, Stat>();

async function req(label: string, path: string, init: RequestInit = {}, meter = true) {
  const headers = new Headers(init.headers);
  if (init.method && init.method !== "GET") for (const [k, v] of Object.entries(ORIGIN)) headers.set(k, v);
  if (init.body) headers.set("Content-Type", "application/json");
  if (meter) headers.set("X-D1-Meter", "1");
  const t = performance.now();
  const res = await fetch(BASE + path, { ...init, headers });
  const ms = performance.now() - t;
  const s = stats.get(label) ?? { ms: [], q: 0, read: 0, write: 0, errors: 0 };
  s.ms.push(ms);
  const m = res.headers.get("X-D1-Meter");
  if (m) {
    const [q, r, w] = m.split(",").map(Number);
    s.q += q;
    s.read += r;
    s.write += w;
  }
  if (!res.ok) s.errors++;
  if (meter) stats.set(label, s);
  return res;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.url}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function makeExam() {
  const bank = await json<{ items: { id: number }[] }>(await req("", "/api/admin/questions?status=active&size=500", {}, false));
  if (bank.items.length < 1) throw new Error("사용 중인 문항이 없습니다. npm run db:seed:local 을 먼저 실행하세요.");
  const ids = bank.items.slice(0, QUESTIONS).map((q) => q.id);
  const exam = await json<{ id: number; code: string }>(
    await req("", "/api/admin/exams", { method: "POST", body: JSON.stringify({ title: `부하 점검 ${new Date().toISOString()}`, timeLimitMin: 60, passSubjectPct: 40, passAvgPct: 60 }) }, false),
  );
  await json(await req("", `/api/admin/exams/${exam.id}/questions`, { method: "PUT", body: JSON.stringify({ items: ids.map((questionId) => ({ questionId })) }) }, false));
  await json(await req("", `/api/admin/exams/${exam.id}/open`, { method: "POST" }, false));
  return { ...exam, count: ids.length };
}

async function examinee(code: string, i: number) {
  await json(await req("info", `/api/exam/info?code=${code}`));
  const enter = await req("enter", "/api/exam/enter", { method: "POST", body: JSON.stringify({ code, examineeNo: `LOAD${String(i).padStart(4, "0")}`, name: `부하${i}` }) });
  await json(enter);
  const Cookie = enter.headers.get("set-cookie")!.split(";")[0];
  const paper = await json<{ questions: { no: number; choices: unknown[] }[] }>(await req("paper", "/api/exam/paper", { headers: { Cookie } }));
  for (const q of paper.questions) {
    const choice = 1 + Math.floor(Math.random() * q.choices.length);
    await json(await req("answers (save)", "/api/exam/answers", { method: "PUT", headers: { Cookie }, body: JSON.stringify({ no: q.no, choice }) }));
  }
  await json(await req("submit", "/api/exam/submit", { method: "POST", headers: { Cookie } }));
  await json(await req("result", "/api/exam/result", { headers: { Cookie } }));
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))];
const r1 = (x: number) => Math.round(x * 10) / 10;

async function main() {
  const exam = await makeExam();
  console.log(`시험 ${exam.code} (${exam.count}문항), 수험자 ${N}명 동시 시작 → ${BASE}\n`);
  const t = performance.now();
  const results = await Promise.allSettled(Array.from({ length: N }, (_, i) => examinee(exam.code, i + 1)));
  const secs = (performance.now() - t) / 1000;
  const failed = results.filter((r) => r.status === "rejected");

  const rows = [...stats].map(([label, s]) => ({
    요청: label,
    횟수: s.ms.length,
    오류: s.errors,
    "평균 ms": r1(s.ms.reduce((a, b) => a + b, 0) / s.ms.length),
    "p95 ms": r1(pct(s.ms, 95)),
    "쿼리/회": r1(s.q / s.ms.length),
    "읽은 행/회": r1(s.read / s.ms.length),
    "쓴 행/회": r1(s.write / s.ms.length),
  }));
  console.table(rows);
  const total = [...stats.values()].reduce((a, s) => ({ n: a.n + s.ms.length, read: a.read + s.read, write: a.write + s.write }), { n: 0, read: 0, write: 0 });
  const save = stats.get("answers (save)");
  console.log(`\n걸린 시간 ${r1(secs)}초 · 실패한 수험자 ${failed.length}명`);
  for (const f of failed.slice(0, 3)) console.log("  ", (f as PromiseRejectedResult).reason?.message);
  console.log(`합계: 요청 ${total.n}건 · D1 읽은 행 ${total.read} · 쓴 행 ${total.write}`);
  if (save) console.log(`답안 저장 1회: 읽은 행 ${r1(save.read / save.ms.length)} (ANALYSIS 5-3 추정 5행 이하) · 쓴 행 ${r1(save.write / save.ms.length)}`);
  console.log(
    `\n무료 한도 대비(이 시험 1회, ${N}명): Workers 요청 ${total.n} / 100,000(하루) = ${r1((100 * total.n) / 100_000)}% · ` +
      `D1 읽기 ${total.read} / 5,000,000 = ${r1((100 * total.read) / 5_000_000)}% · D1 쓰기 ${total.write} / 100,000 = ${r1((100 * total.write) / 100_000)}%`,
  );
  console.log("  (화면 파일은 Static Assets라 요청 수에 들어가지 않습니다. 관리자 요청과 그림 요청은 위 숫자에 없습니다.)");
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
