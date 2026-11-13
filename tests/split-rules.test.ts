import { describe, expect, it } from "vitest";
import truth from "../docs/samples/test/TATQ_test_paper_A_truth.json";
import { applyAnswerKey, joinWrapped, parseAnswerKey, splitPages, type PageData, type TextItem } from "../src/shared/split-rules";
import { compareWithTruth, type Truth } from "../src/shared/split-score";
import paperA from "./fixtures/paper-A.pages.json";

const W = 595;
const H = 842;
/** One text line at (x, y); a fake page item. */
const t = (str: string, x: number, y: number): TextItem => ({ str, x, y, w: str.length * 9, h: 10 });
const page = (items: TextItem[], extra: Partial<PageData> = {}): PageData => ({ page: 1, width: W, height: H, items, images: [], vrules: [], ...extra });

describe("splitPages: layouts", () => {
  it("one column, multi-line stem, one choice per line", () => {
    const [q] = splitPages([
      page([
        t("1. 고압증기멸균기의 표준 멸균 조", 40, 100),
        t("건으로 옳은 것은?", 52, 114),
        t("① 100℃", 52, 130),
        t("② 121℃, 15~20분", 52, 144),
        t("③ 80℃", 52, 158),
      ]),
    ]);
    expect(q).toMatchObject({ no: 1, stem: "고압증기멸균기의 표준 멸균 조건으로 옳은 것은?" });
    expect(q.choices.map((c) => c.text)).toEqual(["100℃", "121℃, 15~20분", "80℃"]);
  });

  it("several short choices on one line, and a choice that wraps onto the next line", () => {
    const [a, b] = splitPages([
      page([
        t("1. 혈액 매개 감염병이 아닌 것은?", 40, 100),
        t("① B형간염", 52, 114),
        t("② C형간염", 120, 114),
        t("③ 결핵", 190, 114),
        t("2. 옳은 것은?", 40, 140),
        t("① 일회용 잉크캡에 덜어 쓰고 남은 것은 폐", 52, 154),
        t("기한다", 62, 168),
        t("② 재사용한다", 52, 182),
      ]),
    ]);
    expect(a.choices.map((c) => c.text)).toEqual(["B형간염", "C형간염", "결핵"]);
    expect(b.choices.map((c) => c.text)).toEqual(["일회용 잉크캡에 덜어 쓰고 남은 것은 폐기한다", "재사용한다"]);
  });

  it("two columns without a rule: left column first, then right; header, footer and subject lines dropped", () => {
    const drafts = splitPages([
      page([
        t("문신사 모의고사 1교시", 40, 20), // header band
        t("제1과목 위생 (1~2)", 40, 80),
        t("1. 왼쪽 첫 문항", 40, 100),
        t("① 가", 52, 114),
        t("② 나", 52, 128),
        t("2. 오른쪽 문항", 310, 100),
        t("① 다", 322, 114),
        t("② 라", 322, 128),
        t("- 1 -", 290, 830), // page number
      ]),
    ]);
    expect(drafts.map((d) => [d.no, d.subject, d.stem])).toEqual([
      [1, "위생", "왼쪽 첫 문항"],
      [2, "위생", "오른쪽 문항"],
    ]);
    expect(drafts[0].choices.map((c) => c.text)).toEqual(["가", "나"]);
  });

  it("a number at the start of a stem line is not a new question unless it is the next number", () => {
    const [q, ...rest] = splitPages([page([t("1. 다음 중 옳은 것은?", 40, 100), t("121℃에서 15분 멸균한다.", 52, 114), t("① 예", 52, 128)])]);
    expect(rest).toHaveLength(0);
    expect(q.stem).toBe("다음 중 옳은 것은? 121℃에서 15분 멸균한다.");
  });

  it("marks choices that refer to other choices as fixed, and keeps those marks in the text", () => {
    const [q] = splitPages([page([t("1. 옳은 것은?", 40, 100), t("① 가 ② 나 ③ 다 ④ 라", 52, 114), t("⑤ ①~④ 모두", 52, 128)])]);
    expect(q.choices.map((c) => c.text)).toEqual(["가", "나", "다", "라", "①~④ 모두"]);
    expect(q.fixedChoices).toBe(true);
  });

  it("group header: shared passage and picture go to the group's first question; members share a key", () => {
    const drafts = splitPages([
      page(
        [
          t("※ [1~2] 다음 장치의 화면을 보고 물음에 답하", 40, 100),
          t("시오.", 40, 114),
          t("1. 원리는?", 40, 200),
          t("① 가", 52, 214),
          t("2. 보관은?", 40, 240),
          t("① 나", 52, 254),
          t("3. 별개 문항", 40, 280),
          t("① 다", 52, 294),
        ],
        { images: [{ x: 50, y: 120, w: 150, h: 60 }] },
      ),
    ]);
    expect(drafts.map((d) => d.groupKey)).toEqual(["1-2", "1-2", null]);
    expect(drafts[0].groupIntro).toBe("다음 장치의 화면을 보고 물음에 답하시오.");
    expect(drafts[0].groupImages).toHaveLength(1);
    expect(drafts[1].groupIntro).toBeNull();
  });

  it("pictures: in the stem before the choices, or beside a choice marker as a picture choice", () => {
    const [a, b] = splitPages([
      page(
        [
          t("1. 그림의 A는?", 40, 100),
          t("① 표피", 52, 200),
          t("2. 플랫 배열은?", 40, 240),
          t("① ②", 52, 290),
        ],
        {
          images: [
            { x: 60, y: 110, w: 120, h: 70 }, // stem picture of 1
            { x: 64, y: 262, w: 69, h: 44 }, // ① picture
            { x: 183, y: 262, w: 69, h: 44 }, // ② picture
          ],
          items: [t("1. 그림의 A는?", 40, 100), t("① 표피", 52, 200), t("2. 플랫 배열은?", 40, 240), t("①", 52, 290), t("②", 171, 290)],
        },
      ),
    ]);
    expect(a.stemImages).toHaveLength(1);
    expect(a.choices[0].image).toBeUndefined();
    expect(b.stemImages).toHaveLength(0);
    expect(b.choices.map((c) => c.image?.box.x)).toEqual([64, 183]);
  });
});

describe("joinWrapped", () => {
  it("joins Hangul mid-word wraps without a space, others with one", () => {
    expect(joinWrapped("멸균 조", "건으로")).toBe("멸균 조건으로");
    expect(joinWrapped("어려운", "것은?")).toBe("어려운 것은?");
    expect(joinWrapped("약 15psi,", "15분")).toBe("약 15psi, 15분");
  });
});

describe("parseAnswerKey", () => {
  it("reads the common pasted formats", () => {
    expect([...parseAnswerKey("1-③, 2-①, 3-⑤")]).toEqual([
      [1, 3],
      [2, 1],
      [3, 5],
    ]);
    expect([...parseAnswerKey("1③ 2① 10②")]).toEqual([
      [1, 3],
      [2, 1],
      [10, 2],
    ]);
    expect([...parseAnswerKey("1 3, 2 1\n3:4 4.5")]).toEqual([
      [1, 3],
      [2, 1],
      [3, 4],
      [4, 5],
    ]);
  });
});

describe("test paper A (docs/samples/test)", () => {
  it("splits the text PDF: every question, choice, picture, group and answer in place", () => {
    const key = parseAnswerKey("1-②, 2-④, 3-⑤, 4-③, 5-③, 6-②, 7-②, 8-①, 9-④, 10-②, 11-②, 12-③, 13-③, 14-①, 15-②, 16-②, 17-②, 18-④, 19-②, 20-③, 21-④, 22-④, 23-②, 24-①, 25-⑤, 26-⑤");
    const drafts = applyAnswerKey(splitPages(paperA as PageData[]), key);
    const r = compareWithTruth(drafts, truth as Truth);
    const row = (label: string) => r.rows.find((x) => x.label === label)!;
    expect(drafts).toHaveLength(26);
    for (const label of ["문항(번호·경계)", "지문(공백 무시)", "그림", "묶음", "보기 고정", "정답(정답표 붙여넣기)"]) {
      expect(row(label).ok, label).toBe(row(label).total);
    }
    // Known limit: a line break that fell on a space between two Korean words loses that space.
    expect(row("지문").ok).toBeGreaterThanOrEqual(23);
    expect(row("보기").ok).toBeGreaterThanOrEqual(129);
  });
});
