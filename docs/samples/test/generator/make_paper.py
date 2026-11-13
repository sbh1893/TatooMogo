"""Builds the TAT-Q test question paper: text PDF, scanned-look PDF, answer key and ground-truth JSON.

All content is original (demo questions + own illustrations), so it can live in the repo.
"""
import base64
import json
import random
from pathlib import Path

from PIL import Image, ImageFilter, ImageOps
from playwright.sync_api import sync_playwright

HERE = Path(__file__).parent
IMG = HERE / "img"
OUT = HERE / "out"
OUT.mkdir(exist_ok=True)
CIRC = "①②③④⑤"

bank = json.loads((HERE / "bank.json").read_text())
by = {s: [b for b in bank if b["s"] == s] for s in ("hyg", "skin", "tech", "law")}

def demo(b):
    return {"stem": b["q"], "choices": [{"text": c} for c in b["c"]], "answer": b["a"] + 1, "explanation": b["e"]}

# --- new picture questions ---------------------------------------------------------------------
AUTOCLAVE_GROUP = {
    "key": "autoclave",
    "intro": "다음은 시술 기구를 멸균하는 장치의 작동 화면이다. 물음에 답하시오.",
    "image": "autoclave_panel.png",
    "items": [
        {"stem": "화면에 표시된 장치의 멸균 원리로 옳은 것은?",
         "choices": [{"text": t} for t in ["건조한 뜨거운 공기", "포화 수증기의 압력과 열", "자외선 조사", "에틸렌옥사이드 가스", "알코올 증기"]],
         "answer": 2, "explanation": "121℃·약 1.1 kgf/cm² 조건은 포화 수증기를 쓰는 고압증기멸균(오토클레이브)이다."},
        {"stem": "화면의 조건에서 멸균을 마친 기구의 보관 방법으로 가장 적절한 것은?",
         "choices": [{"text": t} for t in ["포장을 뜯어 시술대 위에 펼쳐 둔다", "멸균 포장 상태로 건조하고 청결한 곳에 보관한다", "물기가 남은 채 밀폐 용기에 넣는다", "다시 알코올에 담가 둔다", "사용 직전에 손으로 닦아 둔다"]],
         "answer": 2, "explanation": "멸균한 기구는 포장을 유지한 채 건조하고 청결한 곳에 보관해야 오염되지 않는다."},
    ],
}
SKIN_PICTURE = {
    "stem": "그림은 피부의 단면을 나타낸 것이다. 콜라겐과 탄력섬유가 많고 혈관·땀샘이 분포하며, 켈로이드가 생길 때 콜라겐이 과도하게 만들어지는 층은?",
    "image": "skin_layers.png",
    "choices": [{"text": t} for t in ["A", "B", "C", "D", "E"]],
    "answer": 3, "explanation": "C는 진피층이다. A는 각질층, B는 표피, D는 피하지방층, E는 근육이다.",
}
BLOWOUT_PHOTO = {
    "stem": "다음 사진처럼 시술한 선의 일부가 번져 보이는 현상을 줄이는 방법으로 가장 적절한 것은?",
    "image": "blowout_photo.jpg",
    "choices": [{"text": t} for t in ["바늘을 피하지방층까지 깊게 넣는다", "바늘 깊이를 진피 상부로 일정하게 유지한다", "색소를 물로 묽게 희석해 쓴다", "피부를 느슨하게 둔 채 시술한다", "바늘을 피부와 거의 평행하게 눕혀 넣는다"]],
    "answer": 2, "explanation": "블로아웃은 과도한 깊이·각도로 색소가 진피 아래로 퍼지는 현상이므로, 깊이를 진피 상부로 일정하게 유지하고 피부를 팽팽하게 당겨 시술한다.",
}
NEEDLE_CHOICES = {
    "stem": "다음은 바늘 묶음을 끝에서 본 모습이다. 플랫(Flat) 배열에 해당하는 것은?",
    "choices": [{"image": f"{n}.png"} for n in ["needle_1_rl3", "needle_2_rl7", "needle_3_flat5", "needle_4_mag9", "needle_5_single"]],
    "answer": 3, "explanation": "플랫은 바늘을 한 줄로 나란히 묶은 배열이다. ①·②는 라운드, ④는 두 줄이 엇갈린 매그넘, ⑤는 단일 바늘이다.",
}
FIXED_CHOICES = {
    "stem": "「문신사법」에 따라 문신사가 시술 전 고객에게 설명해야 하는 내용으로 옳은 것은?",
    "choices": [{"text": t} for t in ["문신의 부작용 가능성", "시술 후 관리 방법", "시술 부위와 범위", "문신을 지우기 어려울 수 있다는 점", "①~④ 모두"]],
    "answer": 5, "fixed": True,
    "explanation": "설명의무에 해당하는 내용이 모두 포함되므로 ⑤가 정답이다. 보기 위치에 의존하므로 보기를 섞으면 안 된다(보기 고정).",
}

SUBJECTS = [
    ("위생·감염관리", [demo(b) for b in by["hyg"]] + [AUTOCLAVE_GROUP]),
    ("피부과학", [demo(b) for b in by["skin"]] + [SKIN_PICTURE]),
    ("문신 기법·기기", [demo(b) for b in by["tech"]] + [BLOWOUT_PHOTO, NEEDLE_CHOICES]),
    ("문신사 관계법규", [demo(b) for b in by["law"]] + [FIXED_CHOICES]),
]

def data_uri(name):
    mime = "image/jpeg" if name.endswith(".jpg") else "image/png"
    return f"data:{mime};base64,{base64.b64encode((IMG / name).read_bytes()).decode()}"

def choices_html(q):
    cs = q["choices"]
    if any("image" in c for c in cs):
        cells = "".join(f"<div class='ic'><span>{CIRC[i]}</span><img src='{data_uri(c['image'])}'></div>" for i, c in enumerate(cs))
        return f"<div class='imgchoices'>{cells}</div>"
    if all(len(c["text"]) <= 9 for c in cs):  # short choices share one line, like real papers
        return "<div class='inline'>" + "".join(f"<span>{CIRC[i]} {c['text']}</span>" for i, c in enumerate(cs)) + "</div>"
    return "".join(f"<div class='ch'>{CIRC[i]} {c['text']}</div>" for i, c in enumerate(cs))

def question_html(no, q):
    img = f"<div class='fig'><img src='{data_uri(q['image'])}'></div>" if q.get("image") else ""
    return f"<div class='q'><div class='stem'><b>{no}.</b> {q['stem']}</div>{img}{choices_html(q)}</div>"

truth, body, no = [], [], 0
for si, (subject, items) in enumerate(SUBJECTS, 1):
    first = no + 1
    parts = []
    for it in items:
        if "items" in it:  # grouped questions sharing one passage
            nos = list(range(no + 1, no + 1 + len(it["items"])))
            parts.append(f"<div class='group'>※ [{nos[0]}~{nos[-1]}] {it['intro']}<div class='fig'><img src='{data_uri(it['image'])}'></div></div>")
            for sub in it["items"]:
                no += 1
                parts.append(question_html(no, sub))
                truth.append({"no": no, "subject": subject, **sub, "group": it["key"], "groupIntro": it["intro"], "groupImage": it["image"]})
        else:
            no += 1
            parts.append(question_html(no, it))
            truth.append({"no": no, "subject": subject, **it})
    body.append(f"<div class='subj'>제{si}과목 {subject} ({first}~{no})</div>" + "".join(parts))

HTML = f"""<!doctype html><html lang='ko'><head><meta charset='utf-8'><style>
@page {{ size: A4; margin: 22mm 14mm 18mm 14mm; }}
body {{ font-family: 'Noto Serif CJK KR', serif; font-size: 9.6pt; line-height: 1.55; color: #000; margin: 0; }}
.cover {{ border: 2px solid #000; padding: 8px 12px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }}
.cover h1 {{ font-size: 15pt; margin: 0; letter-spacing: -0.3px; }}
.cover .meta {{ font-size: 9pt; text-align: right; line-height: 1.4; }}
.cover table {{ border-collapse: collapse; font-size: 9pt; }}
.cover td {{ border: 1px solid #000; padding: 3px 10px; }}
.notice {{ font-size: 8.4pt; border: 1px solid #000; padding: 4px 8px; margin-bottom: 10px; }}
.cols {{ column-count: 2; column-gap: 9mm; column-rule: 1px solid #000; }}
.subj {{ font-weight: 700; font-family: 'Noto Sans CJK KR', sans-serif; font-size: 10pt; border-top: 2px solid #000; border-bottom: 1px solid #000; padding: 2px 0; margin: 2px 0 8px; break-after: avoid; }}
.q {{ break-inside: avoid; margin-bottom: 11px; }}
.stem {{ margin-bottom: 3px; text-indent: -1.3em; padding-left: 1.3em; }}
.ch {{ padding-left: 1.3em; text-indent: -1.1em; margin-left: 1.1em; }}
.inline {{ padding-left: 1.3em; display: flex; flex-wrap: wrap; gap: 2px 14px; }}
.group {{ break-inside: avoid; break-after: avoid; border: 1px solid #000; padding: 4px 6px; margin-bottom: 8px; }}
.fig {{ text-align: center; margin: 4px 0 5px; }}
.fig img {{ max-width: 92%; }}
.imgchoices {{ display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px 6px; padding-left: 1.3em; }}
.ic {{ display: flex; align-items: center; gap: 3px; }}
.ic img {{ width: 92px; }}
</style></head><body>
<div class='cover'>
  <div><h1>2027년도 문신사 국가시험 모의고사</h1><div style='font-size:9pt'>TAT-Q 개발용 테스트 문제지 · 실제 시험과 무관</div></div>
  <div class='meta'><table><tr><td>교시</td><td>1교시</td><td>문제지 유형</td><td>A형</td></tr><tr><td>성명</td><td style='width:70px'></td><td>수험번호</td><td style='width:70px'></td></tr></table></div>
</div>
<div class='notice'>※ 각 문항의 정답을 하나만 고르시오. 문항 수: {no}문항 · 시험 시간: {no}분</div>
<div class='cols'>{''.join(body)}</div>
</body></html>"""

HEADER = "<div style='font-size:7.5pt;width:100%;padding:0 14mm;display:flex;justify-content:space-between;font-family:Noto Sans CJK KR'><span>문신사 모의고사 1교시</span><span>A형</span></div>"
FOOTER = "<div style='font-size:8pt;width:100%;text-align:center;font-family:Noto Sans CJK KR'>- <span class='pageNumber'></span> -</div>"

text_pdf = OUT / "TATQ_test_paper_A_text.pdf"
with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page()
    page.set_content(HTML, wait_until="load")
    page.pdf(path=str(text_pdf), format="A4", print_background=True, display_header_footer=True,
             header_template=HEADER, footer_template=FOOTER,
             margin={"top": "22mm", "bottom": "18mm", "left": "14mm", "right": "14mm"})
    b.close()

# --- answer key and ground truth -------------------------------------------------------------
(OUT / "TATQ_test_paper_A_answers.txt").write_text(", ".join(f"{t['no']}-{CIRC[t['answer'] - 1]}" for t in truth) + "\n", encoding="utf-8")
(OUT / "TATQ_test_paper_A_truth.json").write_text(json.dumps({
    "source": "TATQ_test_paper_A_text.pdf",
    "note": "Ground truth for measuring the PDF splitter. answer is 1-based. image fields are file names in images/.",
    "questions": truth,
}, ensure_ascii=False, indent=1), encoding="utf-8")
print("questions:", len(truth))
