/** Scores splitter output against a truth file (docs/samples/test/*_truth.json). */
import type { Draft } from "./split-rules";

export type Truth = {
  questions: {
    no: number;
    subject: string;
    stem: string;
    choices: { text?: string; image?: string }[];
    answer: number;
    image?: string;
    group?: string;
    groupIntro?: string;
    groupImage?: string;
    fixed?: boolean;
  }[];
};

/** Whitespace-normalized comparison (README: "공백 정규화 후 비교"). */
export const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const loose = (s: string) => s.replace(/\s+/g, "");

export function compareWithTruth(drafts: Draft[], truth: Truth) {
  const byNo = new Map(drafts.map((d) => [d.no, d]));
  const counts = { questions: 0, stems: 0, stemsLoose: 0, choices: 0, choicesTotal: 0, images: 0, imagesTotal: 0, answers: 0, groups: 0, groupsTotal: 0, fixed: 0 };
  const problems: string[] = [];
  let perfect = 0;
  const groupFirst = new Set<string>();

  for (const t of truth.questions) {
    const d = byNo.get(t.no);
    if (!d) {
      problems.push(`${t.no}번: 분리되지 않음`);
      counts.choicesTotal += t.choices.length;
      continue;
    }
    counts.questions++;
    let ok = true;

    if (norm(d.stem) === norm(t.stem)) counts.stems++;
    else {
      ok = false;
      problems.push(`${t.no}번 지문: "${norm(d.stem)}" ≠ "${norm(t.stem)}"`);
    }
    if (loose(d.stem) === loose(t.stem)) counts.stemsLoose++;

    t.choices.forEach((tc, i) => {
      counts.choicesTotal++;
      const dc = d.choices[i];
      const textOk = dc && norm(dc.text) === norm(tc.text ?? "");
      const imgOk = dc && !!dc.image === !!tc.image;
      if (textOk && imgOk) counts.choices++;
      else {
        ok = false;
        problems.push(`${t.no}번 보기 ${i + 1}: "${dc ? norm(dc.text) : "(없음)"}"${dc?.image ? " +그림" : ""} ≠ "${norm(tc.text ?? "")}"${tc.image ? " +그림" : ""}`);
      }
    });
    if (d.choices.length !== t.choices.length) {
      ok = false;
      problems.push(`${t.no}번 보기 수: ${d.choices.length} ≠ ${t.choices.length}`);
    }

    // Pictures: stem picture, group picture (on the group's first question), picture choices.
    const wantStemImg = !!t.image;
    const isFirstOfGroup = !!t.group && !groupFirst.has(t.group);
    if (t.group) groupFirst.add(t.group);
    const wantGroupImg = isFirstOfGroup && !!t.groupImage;
    const wantChoiceImgs = t.choices.some((c) => c.image);
    if (wantStemImg || wantGroupImg || wantChoiceImgs || d.stemImages.length || d.groupImages.length) {
      counts.imagesTotal++;
      const good =
        d.stemImages.length === (wantStemImg ? 1 : 0) &&
        d.groupImages.length === (wantGroupImg ? 1 : 0) &&
        t.choices.every((c, i) => !!d.choices[i]?.image === !!c.image);
      if (good) counts.images++;
      else {
        ok = false;
        problems.push(`${t.no}번 그림: 지문 ${d.stemImages.length}, 묶음 ${d.groupImages.length} (기대 ${wantStemImg ? 1 : 0}, ${wantGroupImg ? 1 : 0})`);
      }
    }

    if (t.group) {
      counts.groupsTotal++;
      const introOk = !isFirstOfGroup || norm(d.groupIntro ?? "") === norm(t.groupIntro ?? "");
      if (d.groupKey && introOk) counts.groups++;
      else {
        ok = false;
        problems.push(`${t.no}번 묶음: key=${d.groupKey}, 공통 지문 "${norm(d.groupIntro ?? "")}"`);
      }
    }
    if (d.fixedChoices === !!t.fixed) counts.fixed++;
    else {
      ok = false;
      problems.push(`${t.no}번 보기 고정: ${d.fixedChoices} ≠ ${!!t.fixed}`);
    }

    if (d.answer === t.answer) counts.answers++;
    else {
      ok = false;
      problems.push(`${t.no}번 정답: ${d.answer} ≠ ${t.answer}`);
    }
    if (ok) perfect++;
  }
  const extra = drafts.filter((d) => !truth.questions.some((t) => t.no === d.no));
  for (const d of extra) problems.push(`${d.no}번: 정답 데이터에 없는 문항이 분리됨`);

  const n = truth.questions.length;
  return {
    perfect,
    problems,
    counts,
    rows: [
      { label: "문항(번호·경계)", ok: counts.questions - extra.length, total: n },
      { label: "지문", ok: counts.stems, total: n },
      { label: "지문(공백 무시)", ok: counts.stemsLoose, total: n },
      { label: "보기", ok: counts.choices, total: counts.choicesTotal },
      { label: "그림", ok: counts.images, total: counts.imagesTotal },
      { label: "묶음", ok: counts.groups, total: counts.groupsTotal },
      { label: "보기 고정", ok: counts.fixed, total: n },
      { label: "정답(정답표 붙여넣기)", ok: counts.answers, total: n },
    ],
  };
}
