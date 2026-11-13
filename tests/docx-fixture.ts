// Builds fake question development documents (.docx) for tests. Content is meaningless on purpose:
// real question files are confidential and never enter this repository.
import { strToU8, zipSync } from "fflate";

export type FakeItem = {
  itemNo: number;
  header?: string; // overrides "| 지식수준: … | 예상 난이도: …"
  knowledge?: string;
  difficulty?: string;
  stem: string;
  choices: string[];
  answer?: string; // "③", "3"; undefined = no 정답 line
  correct?: string;
  wrong?: string;
  intent?: string;
  objection?: string;
  basis?: string;
  labelOnOwnLine?: boolean; // "문제" then the text in the next paragraph
  swapAnswerAndChoices?: boolean; // 정답 before the choices (label order error)
};
export type FakeCriterion = { no: string; field: string; items: FakeItem[]; headerTable?: boolean };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Word often splits one line into several runs; do the same.
const p = (text: string) => {
  const half = Math.ceil(text.length / 2);
  return `<w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:t xml:space="preserve">${esc(text.slice(0, half))}</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>${esc(text.slice(half))}</w:t></w:r></w:p>`;
};
const cell = (t: string) => `<w:tc><w:tcPr><w:tcW w:w="1000" w:type="dxa"/></w:tcPr>${p(t)}</w:tc>`;
const row = (cells: string[]) => `<w:tr>${cells.map(cell).join("")}</w:tr>`;
const table = (rows: string[][]) => `<w:tbl><w:tblPr/>${rows.map(row).join("")}</w:tbl>`;
const rule = `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6"/></w:pBdr></w:pPr></w:p>`;

function item(it: FakeItem) {
  const out = [p(`예비문항 ${it.itemNo} ${it.header ?? `| 지식수준: ${it.knowledge ?? "암기형"} | 예상 난이도: ${it.difficulty ?? "중"} | 문항형태: 가짜형태`}`)];
  out.push(...(it.labelOnOwnLine ? [p("문제"), p(it.stem)] : [p(`문제 ${it.stem}`)]));
  const marks = "①②③④⑤⑥⑦⑧";
  const choiceLines = it.choices.map((c, i) => p(`${marks[i]} ${c}`));
  const answer = it.answer === undefined ? [] : it.labelOnOwnLine ? [p("정답"), p(it.answer)] : [p(`정답 ${it.answer}`)];
  out.push(...(it.swapAnswerAndChoices ? [...answer, ...choiceLines] : [...choiceLines, ...answer]));
  out.push(p(`정답해설 ${it.correct ?? "가짜 정답해설"}`));
  out.push(p(`오답노트 ${it.wrong ?? "① 가짜 오답 하나 / ② 가짜 오답 둘"}`));
  out.push(p(`출제의도 ${it.intent ?? "가짜 출제의도"}`));
  out.push(p(`이의제기 예방검토 ${it.objection ?? "가짜 예방검토"}`));
  out.push(p(`근거번호 ${it.basis ?? "가짜-근거-1"}`));
  return out.join("");
}

export function fakeDocumentXml(criteria: FakeCriterion[]) {
  const body = [
    p("가짜 문항개발 결과 보고"),
    table([
      ["구분", "문항개발기준 수", "문항 수"],
      ["합계", String(criteria.length), String(criteria.reduce((n, c) => n + c.items.length, 0))],
    ]),
    p("이 문서는 테스트용 가짜 문서입니다."),
    ...criteria.map((c) =>
      [
        p(`문항개발기준 ${c.no} (${c.field}-01)`),
        c.headerTable
          ? table([
              ["과목", "분야", "영역", "세부영역", "항목", "근거번호"],
              ["가짜과목", c.field, "가짜영역", "가짜세부", "가짜항목", "표-근거"],
            ])
          : table([
              ["과목", "가짜과목", "분야", c.field],
              ["영역", "가짜영역", "세부영역", "가짜세부"],
              ["항목", "가짜항목", "근거번호", "표-근거"],
            ]),
        p("평가목표 가짜 평가목표"),
        p("유의사항 가짜 유의사항"),
        ...c.items.map(item),
        rule,
      ].join(""),
    ),
  ].join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`;
}

export function fakeDocx(criteria: FakeCriterion[]) {
  return zipSync({
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    "word/document.xml": strToU8(fakeDocumentXml(criteria)),
  });
}

const five = (n: number) => [1, 2, 3, 4, 5].map((k) => `가짜 보기 ${n}-${k}`);

/** The committed fixture (tests/fixtures/fake-items.docx): 3 good questions and 1 broken one, in two fields. */
export const FIXTURE: FakeCriterion[] = [
  {
    no: "001",
    field: "가짜분야가",
    items: [
      { itemNo: 1, stem: "가짜 문제 1", choices: five(1), answer: "③", knowledge: "암기형", difficulty: "하" },
      { itemNo: 2, stem: "가짜 문제 2", choices: five(2), answer: "5", knowledge: "해석형", difficulty: "중상", labelOnOwnLine: true },
    ],
  },
  {
    no: "002",
    field: "가짜분야나",
    headerTable: true,
    items: [
      { itemNo: 1, stem: "가짜 문제 3", choices: five(3), answer: "①", knowledge: "문제해결형", difficulty: "상" },
      { itemNo: 2, stem: "가짜 문제 4", choices: five(4).slice(0, 4), answer: "②", knowledge: "암기형", difficulty: "최상" },
    ],
  },
];
