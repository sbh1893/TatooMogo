// Local development seed: 4 subjects, the demo's 20 questions, and the dev admin as super_admin.
// Usage: npm run db:seed:local   (local D1 only — it wipes local data first)
import { existsSync, readFileSync } from "node:fs";
import { SEED_BANK, SEED_SUBJECTS } from "../src/db/seed-data";
import { q, runSqlFile } from "./d1";

function devEmail() {
  if (!existsSync(".dev.vars")) return "dev@example.com";
  const m = readFileSync(".dev.vars", "utf8").match(/^ADMIN_DEV_EMAIL\s*=\s*(.+)$/m);
  return (m?.[1] ?? "dev@example.com").trim().replace(/^["']|["']$/g, "").toLowerCase();
}

const now = Date.now();
const lines: string[] = [
  // Children first so foreign keys never block the wipe.
  "DELETE FROM answers;", "DELETE FROM attempts;", "DELETE FROM exam_questions;", "DELETE FROM exams;",
  "DELETE FROM choices;", "DELETE FROM questions;", "DELETE FROM source_files;", "DELETE FROM subjects;",
  "DELETE FROM audit_logs;", "DELETE FROM admins;",
  `INSERT INTO admins (id, email, role, status, created_at) VALUES (1, ${q(devEmail())}, 'super_admin', 'active', ${now});`,
];

SEED_SUBJECTS.forEach((s, i) => {
  lines.push(`INSERT INTO subjects (id, name, sort_order, created_at) VALUES (${i + 1}, ${q(s.name)}, ${i + 1}, ${now});`);
});

let choiceId = 1;
SEED_BANK.forEach((b, i) => {
  const id = i + 1;
  const subjectId = SEED_SUBJECTS.findIndex((s) => s.key === b.s) + 1;
  lines.push(
    `INSERT INTO questions (id, code, version, is_latest, subject_id, stem, explanation, fixed_choices, status, created_by, created_at, updated_at) ` +
      `VALUES (${id}, ${id}, 1, 1, ${subjectId}, ${q(b.q)}, ${q(b.e)}, 0, 'active', 1, ${now}, ${now});`,
  );
  b.c.forEach((body, ord) => {
    lines.push(
      `INSERT INTO choices (id, question_id, ord, body, is_correct) VALUES (${choiceId++}, ${id}, ${ord}, ${q(body)}, ${ord === b.a ? 1 : 0});`,
    );
  });
});

runSqlFile("seed", lines.join("\n"), "--local");
console.log(`\n시드 완료: 과목 ${SEED_SUBJECTS.length}개, 문항 ${SEED_BANK.length}개, 관리자 ${devEmail()} (super_admin)`);
