import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Two examinees sit the same exam: they get different papers, each answers by reading the screen,
 * and the scores on their result pages match what they answered.
 * Needs: local DB migrated (npm run db:migrate:local) and .dev.vars with the dev admin bypass.
 */
const ORIGIN = { Origin: "http://localhost:5173" };
const run = Date.now().toString(36);

async function admin<T>(request: APIRequestContext, method: string, path: string, data?: unknown): Promise<T> {
  const res = await request.fetch(path, { method, data, headers: ORIGIN });
  expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

/** 8 questions: 4 in each of two subjects. The right answer's text is "정답 <n>". */
async function makeExam(request: APIRequestContext) {
  const { items: subjects } = await admin<{ items: { id: number; name: string }[] }>(request, "GET", "/api/admin/subjects");
  expect(subjects.length).toBeGreaterThanOrEqual(2);
  const ids: number[] = [];
  for (let n = 1; n <= 8; n++) {
    const q = await admin<{ id: number }>(request, "POST", "/api/admin/questions", {
      subjectId: subjects[n <= 4 ? 0 : 1].id,
      stem: `E2E ${run} 문항 ${n}`,
      explanation: `해설 ${n}`,
      fixedChoices: false,
      choices: [0, 1, 2, 3, 4].map((k) => ({ body: k === n % 5 ? `정답 ${n}` : `오답 ${n}-${k}`, isCorrect: k === n % 5 })),
    });
    ids.push(q.id);
  }
  const exam = await admin<{ id: number; code: string }>(request, "POST", "/api/admin/exams", {
    title: `E2E ${run}`,
    timeLimitMin: 30,
    passSubjectPct: 40,
    passAvgPct: 60,
  });
  await admin(request, "PUT", `/api/admin/exams/${exam.id}/questions`, { items: ids.map((questionId) => ({ questionId })) });
  await admin(request, "POST", `/api/admin/exams/${exam.id}/open`);
  return { code: exam.code, firstSubject: subjects[0].name };
}

async function enter(page: Page, code: string, no: string, name: string) {
  await page.goto(`/?code=${code}`);
  await page.getByRole("button", { name: "다음" }).click();
  await page.getByPlaceholder("홍길동").fill(name);
  await page.getByTitle("영문·숫자 16자 이하").fill(no);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "시험 시작" }).click();
  await expect(page).toHaveURL(/\/exam$/);
}

/** Goes through the paper; answers right when `answerRight(subject)` says so, else picks a wrong choice. */
async function sit(page: Page, answerRight: (subject: string) => boolean) {
  const order: string[] = [];
  for (let i = 0; i < 8; i++) {
    const q = page.locator(".qpane .q").first();
    const stem = (await q.locator(".stem .t").innerText()).trim();
    const subject = (await q.locator(".subject-tag").innerText()).trim();
    const choices = q.getByRole("radio");
    order.push(`${stem}|${(await choices.allInnerTexts()).join("/")}`);
    const pick = answerRight(subject) ? q.getByRole("radio").filter({ hasText: "정답" }) : q.getByRole("radio").filter({ hasText: "오답" }).first();
    const saved = page.waitForResponse((r) => r.url().endsWith("/api/exam/answers") && r.ok());
    await pick.click();
    await saved;
    if (i < 7) await page.getByRole("button", { name: "다음 ▶" }).click();
  }
  await page.locator(".navrow").getByRole("button", { name: "답안 제출" }).click();
  await page.locator(".modal").getByRole("button", { name: "제출" }).click();
  await expect(page).toHaveURL(/\/result$/);
  return order;
}

test("390px: 다음/답안 제출 stay clickable on long questions", async ({ browser, request }) => {
  const { items: subjects } = await admin<{ items: { id: number }[] }>(request, "GET", "/api/admin/subjects");
  const longStem = Array.from({ length: 30 }, (_, k) => `긴 지문 ${run} 줄 ${k + 1}`).join("\n");
  const ids: number[] = [];
  for (let n = 1; n <= 2; n++) {
    const q = await admin<{ id: number }>(request, "POST", "/api/admin/questions", {
      subjectId: subjects[0].id,
      stem: `${longStem}\n문항 ${n}`,
      fixedChoices: false,
      choices: [0, 1, 2, 3].map((k) => ({ body: `보기 ${k}`, isCorrect: k === 0 })),
    });
    ids.push(q.id);
  }
  const exam = await admin<{ id: number; code: string }>(request, "POST", "/api/admin/exams", { title: `E2E mobile ${run}`, timeLimitMin: 30, passSubjectPct: 40, passAvgPct: 60 });
  await admin(request, "PUT", `/api/admin/exams/${exam.id}/questions`, { items: ids.map((questionId) => ({ questionId })) });
  await admin(request, "POST", `/api/admin/exams/${exam.id}/open`);

  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  await enter(page, exam.code, `M${run}`.slice(0, 16), "모바일");
  // A plain click fails if anything (e.g. a floating button) sits on top of the target.
  const next = page.getByRole("button", { name: "다음 ▶" });
  await next.scrollIntoViewIfNeeded();
  await next.click({ timeout: 3000 });
  await expect(page.locator(".navrow .pos")).toHaveText("2 / 2");
  const submit = page.locator(".navrow").getByRole("button", { name: "답안 제출" });
  await submit.scrollIntoViewIfNeeded();
  await submit.click({ timeout: 3000 });
  await expect(page.locator(".modal")).toBeVisible();
  // The answer sheet still opens from the toolbar.
  await page.locator(".modal").getByRole("button", { name: "계속 풀기" }).click();
  await page.getByRole("button", { name: "📝 답안 표기란" }).click();
  await expect(page.locator(".omr.open")).toBeVisible();
});

test("exam delete stays disabled until the exam code is typed", async ({ page, request }) => {
  const exam = await admin<{ id: number; code: string }>(request, "POST", "/api/admin/exams", {
    title: `E2E 삭제 ${run}`,
    timeLimitMin: 30,
    passSubjectPct: 40,
    passAvgPct: 60,
  });
  await admin(request, "POST", `/api/admin/exams/${exam.id}/close`);
  await page.goto(`/admin/exams/${exam.id}`);
  const button = page.getByRole("button", { name: "시험 삭제" });
  await expect(button).toBeDisabled();
  const input = page.getByLabel(/시험 코드/);
  await input.fill("WRONG1");
  await expect(button).toBeDisabled();
  await input.fill(exam.code.toLowerCase()); // case does not matter
  await expect(button).toBeEnabled();
  page.once("dialog", (d) => d.accept());
  await button.click();
  await expect(page).toHaveURL(/\/admin\/exams$/);
  expect((await request.get(`/api/admin/exams/${exam.id}`)).status()).toBe(404);
});

test("two examinees get different papers and the scores match their answers", async ({ browser, request }) => {
  const { code, firstSubject } = await makeExam(request);
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await enter(a, code, `A${run}`.slice(0, 16), "응시자가");
  await enter(b, code, `B${run}`.slice(0, 16), "응시자나");

  const paperA = await sit(a, () => true); // all right → 100, pass
  const paperB = await sit(b, (s) => s === firstSubject); // first subject only → 100% and 0% → 50, fail (과락)
  expect(paperA.join("\n")).not.toBe(paperB.join("\n"));
  expect([...paperA].sort()).not.toEqual([]);

  await expect(a.locator(".stamp")).toHaveText("합격");
  await expect(a.locator(".big")).toContainText("100점");
  await expect(a.locator(".big")).toContainText("8/8 정답");

  await expect(b.locator(".stamp")).toHaveText("불합격");
  await expect(b.locator(".big")).toContainText("50점");
  await expect(b.locator(".big")).toContainText("4/8 정답");
  await expect(b.locator(".why")).toContainText("과락 과목");
});
