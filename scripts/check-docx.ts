// Local check of a question development document: parses it like the admin screen does and prints
// counts only — never question text. Usage: npm run check-docx -- <path/to/file.docx>
import { readFileSync } from "node:fs";
import { ERROR_TEXT, itemErrors, parseDocxItems, readDocxXml } from "../src/shared/docx-items";
import { DIFFICULTIES, KNOWLEDGE_LEVELS } from "../src/shared/question";

const path = process.argv[2];
if (!path) {
  console.error("사용법: npm run check-docx -- <파일 경로>");
  process.exit(1);
}
const { criteria, items } = parseDocxItems(readDocxXml(new Uint8Array(readFileSync(path))));

const tally = (values: string[]) => {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return m;
};
const show = (title: string, m: Map<string, number>, order?: readonly string[]) => {
  console.log(`\n[${title}]`);
  const keys = order ? [...order, ...[...m.keys()].filter((k) => !order.includes(k))] : [...m.keys()].sort();
  for (const k of keys) if (m.get(k)) console.log(`  ${k}: ${m.get(k)}`);
};
const inList = (v: string, list: readonly string[]) => (list.includes(v) ? v : v ? "(목록 밖)" : "(없음)");

console.log(`기준 수: ${criteria}`);
console.log(`문항 수: ${items.length}`);
show("분야별 문항 수", tally(items.map((i) => i.field || "(분야 없음)")));
show("정답 번호 분포", tally(items.map((i) => (i.answer === null ? "(없음)" : String(i.answer)))), ["1", "2", "3", "4", "5"]);
show("보기 수 분포", tally(items.map((i) => `${i.choices.length}개`)));
show("지식수준", tally(items.map((i) => inList(i.knowledgeLevel, KNOWLEDGE_LEVELS))), KNOWLEDGE_LEVELS);
show("예상 난이도", tally(items.map((i) => inList(i.difficulty, DIFFICULTIES))), DIFFICULTIES);

const bad = items.map((i) => ({ i, e: itemErrors(i) })).filter((x) => x.e.length);
console.log(`\n[형식 오류] ${bad.length}문항`);
for (const { i, e } of bad) console.log(`  #${i.pos} (기준 ${i.criterionNo}-${i.itemNo}): ${e.map((k) => ERROR_TEXT[k]).join(", ")}`);
show("오류 종류별", tally(bad.flatMap((x) => x.e.map((k) => ERROR_TEXT[k]))));
