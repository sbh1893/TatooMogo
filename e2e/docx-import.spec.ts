import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * Word import: upload the fake fixture → review screen (format errors shown) → map fields → register
 * → find the questions with the bank's 분야 filter. Re-runs are fine: the duplicate choice is "새 버전".
 * Needs the local DB migrated (npm run db:migrate:local) and the dev admin bypass.
 */
const FIXTURE = fileURLToPath(new URL("../tests/fixtures/fake-items.docx", import.meta.url));

test("Word 파일: 검수 → 등록 → 문제은행 분야 필터", async ({ page }) => {
  await page.goto("/admin/import");
  await page.getByRole("link", { name: "Word 파일" }).click();
  await page.getByLabel("Word 파일").setInputFiles(FIXTURE);

  await expect(page.getByText(/기준 2개 · 문항 4개 · 형식 오류 1개/)).toBeVisible();
  const cards = page.getByTestId("docx-item");
  await expect(cards).toHaveCount(4);
  const broken = cards.filter({ hasText: "기준 002-2" });
  await expect(broken.getByText("보기 수가 5개가 아님")).toBeVisible();
  await expect(broken.getByText("예상 난이도 값이 목록 밖")).toBeVisible();
  await expect(broken.getByRole("checkbox", { name: "검수 완료" })).toBeDisabled();

  // Map both fields to the first existing subject (or keep a saved mapping).
  for (const f of ["가짜분야가", "가짜분야나"]) {
    const sel = page.getByLabel(`${f} 과목`);
    if (!(await sel.inputValue())) await sel.selectOption({ index: 1 });
  }
  await page.getByLabel(/새 버전으로 등록/).check();
  await page.getByRole("button", { name: "오류 없는 문항 모두 검수 완료" }).click();
  await page.getByRole("button", { name: "검수 완료 3문항 등록" }).click();
  await expect(page.getByText(/등록 \d+문항 · 새 버전 \d+문항 · 건너뜀 0문항/)).toBeVisible();
  await expect(cards).toHaveCount(1); // only the broken one is left

  await page.goto("/admin/questions");
  await page.getByLabel("분야").selectOption("가짜분야가");
  await expect(page).toHaveURL(/field=/);
  const table = page.locator("table");
  await expect(table.getByText("가짜 문제 1")).toBeVisible();
  await expect(table.getByText("가짜 문제 2")).toBeVisible();
  await expect(table.getByText("가짜 문제 3")).toHaveCount(0);
  await page.getByLabel("예상 난이도").selectOption("중상");
  await expect(table.getByText("가짜 문제 1")).toHaveCount(0);
  await expect(table.getByText("가짜 문제 2")).toBeVisible();
});
