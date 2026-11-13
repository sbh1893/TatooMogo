/**
 * Measures the PDF splitter against a truth file.
 *   npm run split:measure                     (test paper A)
 *   npm run split:measure -- <pdf> <truth.json> [answers.txt] [--dump fixture.json]
 * --dump writes the extracted page data so unit tests can run without pdf.js.
 */
import fs from "node:fs";
import path from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { extractDocument, type PdfDoc } from "../src/shared/pdf-extract";
import { compareWithTruth, type Truth } from "../src/shared/split-score";
import { applyAnswerKey, parseAnswerKey, splitPages } from "../src/shared/split-rules";

const dir = "docs/samples/test";
const args = process.argv.slice(2);
const dumpAt = args.indexOf("--dump");
const dump = dumpAt >= 0 ? args.splice(dumpAt, 2)[1] : null;
const [pdf = `${dir}/TATQ_test_paper_A_text.pdf`, truthFile = `${dir}/TATQ_test_paper_A_truth.json`, answers = `${dir}/TATQ_test_paper_A_answers.txt`] =
  args;

const doc = (await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdf)), verbosity: 0 }).promise) as unknown as PdfDoc;
const pages = await extractDocument(pdfjs as never, doc);
if (dump) {
  fs.mkdirSync(path.dirname(dump), { recursive: true });
  fs.writeFileSync(dump, JSON.stringify(pages));
  console.log(`page data → ${dump}`);
}

let drafts = splitPages(pages);
if (answers && fs.existsSync(answers)) drafts = applyAnswerKey(drafts, parseAnswerKey(fs.readFileSync(answers, "utf8")));
const truth = JSON.parse(fs.readFileSync(truthFile, "utf8")) as Truth;
const r = compareWithTruth(drafts, truth);

console.log(`\n${path.basename(pdf)}: 분리된 문항 ${drafts.length}개 / 정답 ${truth.questions.length}개\n`);
console.log("| 항목 | 맞음 | 대상 | 정확도 |");
console.log("| --- | ---: | ---: | ---: |");
for (const row of r.rows) console.log(`| ${row.label} | ${row.ok} | ${row.total} | ${row.total ? ((100 * row.ok) / row.total).toFixed(1) : "-"}% |`);
console.log(`\n모든 항목이 맞은 문항: ${r.perfect} / ${truth.questions.length}`);
if (r.problems.length) {
  console.log("\n틀린 곳:");
  for (const p of r.problems) console.log(`- ${p}`);
}
