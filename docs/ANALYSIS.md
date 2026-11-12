# 0단계 분석 — 문신사 CBT 모의고사

작성일: 2026-11-12 · 기준 문서: `CLAUDE.md`, `docs/PLAN.md`, `docs/reference/cbt-demo.html`
이 문서는 설계 초안입니다. 1주차는 이 문서를 기준으로 진행하고, 바뀌면 이 문서를 먼저 고칩니다.

---

## 1. 서비스 요약

1. 문신사 국가시험 준비생이 실제 CBT와 같은 화면으로 모의고사를 보는 반응형 웹 서비스다.
2. 수험자는 가입 없이 시험 코드 + 수험번호 + 이름으로 들어와 응시하고, 제출하면 과목별 점수·과락·합격 여부와 (설정 시) 해설을 본다.
3. 관리자는 Cloudflare Access 이메일 인증으로 들어와 PDF 문제지를 올려 브라우저에서 문항으로 분리·검수하고, 문제은행에서 문항을 골라 시험을 연다.
4. 같은 시험이라도 attempt마다 서버가 만든 seed로 문항·보기 순서가 달라지며, 정답·해설은 제출 전까지 브라우저로 나가지 않고 채점은 서버가 한다.
5. Cloudflare 무료 요금제(Workers + D1 + R2 + Access)만으로 운영하므로 무거운 연산은 브라우저에서 하고 서버는 셔플·저장·채점만 한다.

---

## 2. API 목록 초안

공통: JSON, 시각은 epoch ms(UTC). 오류는 `{ error: { code, message } }` 형태로 응답하고 `message`는 한국어로 쓴다.

### 2-1. 수험자용 `/api/exam/*`

인증: 입장 시 발급하는 attempt 세션 토큰을 httpOnly·Secure·SameSite=Strict 쿠키로 보낸다. DB에는 토큰의 SHA-256 해시만 저장한다.

| 메서드 | 경로 | 요청 | 응답 요지 |
| --- | --- | --- | --- |
| GET | `/api/exam/info?code=` | 시험 코드 | 시험명, 과목별 문항 수, 제한 시간, 합격 기준, 유의사항, 열림 여부. **문항 내용 없음** |
| POST | `/api/exam/enter` | `{ code, examineeNo, name }` | `{ status: 'in_progress' \| 'submitted' }` + 세션 쿠키. 같은 수험번호면 기존 attempt로 이어서 응시하고, 이름이 다르면 403 |
| GET | `/api/exam/paper` | — | `{ exam: { title, subjects }, examinee, paperCode, serverNow, deadlineAt, questions: [{ no, subjectName, stem, stemImage?, choices: [{ no, text, image? }] }], answers: [{ no, choice }] }` — 화면 순서만 담는다. 정답·해설·choice id·원래 순서는 넣지 않는다 |
| PUT | `/api/exam/answers` | `{ no, choice \| null }` (화면 번호, 1부터) | `{ savedAt, serverNow, deadlineAt }`. 마감 뒤에는 409를 돌려주고 자동 제출 처리 |
| POST | `/api/exam/submit` | — | `{ status: 'submitted' }` (이미 제출했으면 같은 응답, 멱등) |
| GET | `/api/exam/result` | — | 제출 전에는 409. `{ avgPct, totalCorrect, total, passed, subjects: [{ name, correct, total, pct, failed }], durationSec }`, 해설 공개 시 `review: [{ no, code, subjectName, stem, choices(화면 순서), correctNo, pickedNo, explanation }]` |
| GET | `/api/exam/media/:key` | — | 이 attempt의 시험에 속한 이미지일 때만 R2에서 스트리밍 |

### 2-2. 관리자용 `/api/admin/*`

미들웨어(요청마다): `Cf-Access-Jwt-Assertion` 검증(팀 도메인 JWKS, `aud`, 만료) → 이메일로 `admins` 조회 → `status=active` 확인 → 역할 확인.
`ENVIRONMENT=development`이고 `ADMIN_DEV_EMAIL`이 있을 때만 그 이메일을 쓰는 우회를 허용한다. 운영에서는 이 경로가 동작하지 않음을 테스트로 확인한다.

| 메서드 | 경로 | 요청 | 응답 요지 | 권한 |
| --- | --- | --- | --- | --- |
| GET | `/api/admin/me` | — | `{ email, role }` | admin |
| GET/POST/PATCH | `/api/admin/subjects[/:id]` | `{ name, sortOrder }` | 과목 목록·생성·수정 | admin |
| GET | `/api/admin/questions` | `?subject&status&q&source&page` | 최신 버전 목록 `{ items: [{ id, code, version, subject, stemPreview, status, usedInAttempts }], total }` | admin |
| GET | `/api/admin/questions/:id` | — | 문항 전체(보기, 정답, 해설, 버전 이력) | admin |
| POST | `/api/admin/questions` | `{ subjectId, stem, stemImageKey?, choices: [{ text, imageKey?, isCorrect }], explanation, fixedChoices, groupKey? }` | 생성(`status=active`) | admin |
| POST | `/api/admin/questions/bulk` | `{ sourceFileId, items: [...] }` | PDF 검수 결과를 한 번에 등록(`batch`) | admin |
| PUT | `/api/admin/questions/:id` | 생성과 같음 | 응시 기록이 없으면 그 행을 수정하고, 있으면 `version+1`로 새 행을 만든다 → `{ id, version, newVersion: boolean }` | admin |
| POST | `/api/admin/questions/:id/disable` · `/enable` | — | 사용 중지·재사용 | admin |
| POST | `/api/admin/source-files` | multipart PDF (`application/pdf`, ≤20MB, `%PDF-` 시그니처 확인) + `roundLabel`, `subjectId?` | R2 저장 + `source_files` 행 | admin |
| GET | `/api/admin/source-files[/:id]` · `/:id/file` | — | 목록·상세·원본 스트리밍(검수 화면에서 pdf.js가 읽음) | admin |
| PATCH | `/api/admin/source-files/:id` | `{ status }` | 처리 상태 변경 | admin |
| POST | `/api/admin/media` | PNG/JPEG (≤2MB) | `{ key }` (내용과 무관한 랜덤 키) | admin |
| GET | `/api/admin/media/:key` | — | 이미지 스트리밍 | admin |
| GET/POST | `/api/admin/exams` | 생성: `{ title, timeLimitMin, opensAt, closesAt, passSubjectPct, passAvgPct, shuffleQuestions, shuffleWithinSubject, shuffleChoices, revealExplanations, notice }` | 목록·생성(`status=draft`, 시험 코드 자동 발급) | admin |
| GET/PATCH | `/api/admin/exams/:id` | 일부 필드 | 첫 attempt가 생긴 뒤에는 기간·해설 공개·안내문만 바꿀 수 있다 | admin |
| PUT | `/api/admin/exams/:id/questions` | `[{ questionId, points }]` | 문항 구성. attempt가 있으면 409 | admin |
| POST | `/api/admin/exams/:id/open` · `/close` | — | 상태 변경 | admin |
| GET | `/api/admin/exams/:id/attempts` | — | 응시 현황: 응시 중·제출 인원, 수험자별 답한 수/전체, 마지막 활동, 기기 전환 횟수 | admin |
| GET | `/api/admin/exams/:id/results` | — | 수험자별 점수·과목 점수·합격, 공통 문항 번호별 정답률 | admin |
| POST | `/api/admin/exams/:id/export` | — | 엑셀용 원자료(JSON). 감사 로그에 남기고, xlsx 파일은 브라우저에서 만든다 | admin |
| GET/POST/PATCH | `/api/admin/admins[/:id]` | `{ email, role }` / `{ status, role }` | 허용 목록 조회·추가·정지 | super_admin |
| GET | `/api/admin/audit-logs` | `?adminId&action&from&to&page` | 접속·작업 기록 | super_admin |

---

## 3. 화면 목록 초안

### 수험자

| 경로 | 들어가는 요소 |
| --- | --- |
| `/` | 시험 코드 입력 → 시험 정보 표(과목·문항 수·제한 시간·합격 기준), 유의사항, 수험번호·이름 입력, 동의 체크, "시험 시작" |
| `/exam` | 상단바(수험번호, 이름, 문제지 유형, 서버 기준 남은 시간, 1분 이하 경고), 도구줄(글자 크기 3단계, 1단·2단, 전체/안 푼 문제 수), 문제 영역(과목 태그, 지문·이미지, 보기 ①~⑤, 이전/다음), 답안 표기란(번호별 버블, 현재 문항 강조, 안 푼 문제로 이동, 제출), 모바일 하단 슬라이드 패널, 제출 확인 모달(안 푼 문제 바로가기), 시간 종료 모달, 저장 실패·오프라인 표시, 단축키(1~5, ←/→) |
| `/result` | 합격/불합격 도장, 과목 평균 점수와 정답 수, 과락 사유, 소요 시간, 과목별 막대(40% 기준선), 해설(전체/오답만, 공통 문항 번호, 정답·내 답 표시) — 해설은 공개 설정일 때만 보인다 |
| `/privacy`, `/terms` | 문구 자리(4주차) |

### 관리자 (`/admin`, Access 보호)

| 경로 | 들어가는 요소 |
| --- | --- |
| `/admin` | 대시보드: 열린 시험, 응시 중 인원, 검수 대기 PDF |
| `/admin/questions` | 문제은행 표(공통 번호, 버전, 과목, 지문 미리보기, 상태, 사용 여부), 과목·상태·출처 필터, 검색, 사용 중지·재사용 |
| `/admin/questions/new`, `/admin/questions/:id` | 문항 편집 폼(과목, 지문, 이미지, 보기 N개 추가·삭제, 정답 라디오, 해설, 보기 고정, 묶음 키), 버전 이력, "응시 기록이 있어 새 버전으로 저장됩니다" 안내 |
| `/admin/import` | PDF 업로드(회차명, 과목), 업로드 목록과 처리 상태 |
| `/admin/import/:sourceId` | 검수: 왼쪽 원본 페이지(pdf.js, 영역 드래그 자르기), 오른쪽 분리된 문항 카드(편집, 합치기·나누기, 과목 지정), 정답표 붙여넣기, 등록 |
| `/admin/exams` | 시험 목록(상태, 코드, 기간, 응시 인원) |
| `/admin/exams/new`, `/admin/exams/:id` | 설정 폼(제한 시간, 기간, 합격 기준, 셔플 옵션, 해설 공개, 안내문), 문항 선택(과목 필터, 배점), 시험 코드 표시·복사, 열기·닫기 |
| `/admin/exams/:id/monitor` | 응시 현황(인원, 수험자별 진행률, 마지막 활동, 기기 전환 횟수), 수동 새로고침 |
| `/admin/exams/:id/results` | 수험자별 성적 표, 공통 문항 번호별 정답률, 엑셀 내보내기 |
| `/admin/admins` | 허용 목록, 추가·정지·역할 변경 (super_admin) |
| `/admin/audit-logs` | 기록 표와 필터 (super_admin) |

---

## 4. Drizzle 스키마 초안 (D1 / SQLite)

규칙: PK는 `integer` 자동 증가, 시각은 `integer`(epoch ms), 불리언은 `integer({ mode: 'boolean' })`, JSON은 `text({ mode: 'json' })`.

### admins
| 컬럼 | 타입 | 비고 |
| --- | --- | --- |
| id | integer PK | |
| email | text not null | **unique**, 소문자로 저장 |
| role | text not null | `admin` \| `super_admin` |
| status | text not null | `active` \| `suspended` |
| invited_by | integer → admins.id | null 허용(최초 관리자) |
| created_at, last_login_at | integer | |

### subjects
| 컬럼 | 타입 | 비고 |
| --- | --- | --- |
| id | integer PK | |
| name | text not null | unique |
| sort_order | integer not null | 인덱스 |
| created_at | integer | |

### source_files
| 컬럼 | 타입 | 비고 |
| --- | --- | --- |
| id | integer PK | |
| r2_key | text not null | unique, 랜덤 키 |
| filename, round_label | text | |
| subject_id | integer → subjects.id | null 허용 |
| size_bytes | integer | |
| kind | text | `text` \| `scan` (검수 중 판단) |
| status | text not null | `uploaded` \| `reviewing` \| `done` \| `failed` |
| uploaded_by | integer → admins.id | |
| created_at | integer | 인덱스 `(status, created_at)` |

### questions (버전 = 행)
| 컬럼 | 타입 | 비고 |
| --- | --- | --- |
| id | integer PK | 버전마다 새 id |
| code | integer not null | **공통 문항 번호**, 버전이 바뀌어도 그대로 |
| version | integer not null | 1부터 |
| is_latest | integer(bool) not null | 문제은행 목록은 최신 버전만 보여 준다 |
| subject_id | integer → subjects.id not null | |
| source_file_id | integer → source_files.id | null 허용 |
| source_no | integer | 원본 문제지의 번호 |
| stem | text not null | 지문(일반 텍스트 + 줄바꿈, HTML 저장 안 함) |
| stem_image_key | text | R2 키 |
| explanation | text | |
| fixed_choices | integer(bool) not null default false | 보기 고정 |
| group_key | text | 묶음 문항 키(같은 시험 안에서 함께 이동) |
| status | text not null | `review` \| `active` \| `disabled` |
| created_by | integer → admins.id | |
| created_at, updated_at | integer | |

인덱스: unique `(code, version)`, `(is_latest, subject_id, status)`, `(source_file_id)`, `(group_key)`

### choices
| 컬럼 | 타입 | 비고 |
| --- | --- | --- |
| id | integer PK | 브라우저로 보내지 않는다 |
| question_id | integer → questions.id not null | |
| ord | integer not null | 원래 순서(0부터) |
| body | text | |
| image_key | text | |
| is_correct | integer(bool) not null | 문항당 정확히 1개(서버에서 검증) |

인덱스: unique `(question_id, ord)`

### exams
| 컬럼 | 타입 | 비고 |
| --- | --- | --- |
| id | integer PK | |
| title | text not null | |
| code | text not null | **unique**, 시험 코드(혼동 문자를 뺀 6자리) |
| status | text not null | `draft` \| `open` \| `closed` |
| time_limit_min | integer not null | |
| opens_at, closes_at | integer | null이면 제한 없음 |
| pass_subject_pct | integer not null default 40 | |
| pass_avg_pct | integer not null default 60 | |
| shuffle_questions | integer(bool) default true | |
| shuffle_within_subject | integer(bool) default true | |
| shuffle_choices | integer(bool) default true | |
| reveal_explanations | integer(bool) default true | |
| notice | text | 유의사항 |
| layout | text(json) | 셔플 입력. 첫 attempt 때 한 번 저장한다(5-3). null이 아니면 시험 구성이 잠긴 것이다 |
| created_by | integer → admins.id | |
| created_at | integer | |

### exam_questions
| 컬럼 | 타입 | 비고 |
| --- | --- | --- |
| id | integer PK | |
| exam_id | integer → exams.id not null | |
| question_id | integer → questions.id not null | 특정 버전을 가리킨다 |
| position | integer not null | 기본 순서(셔플 입력의 기준 정렬) |
| points | integer not null default 1 | |

인덱스: unique `(exam_id, question_id)`, `(exam_id, position)`, `(question_id)` (응시 기록 여부 조회용)

### attempts
| 컬럼 | 타입 | 비고 |
| --- | --- | --- |
| id | integer PK | |
| exam_id | integer → exams.id not null | |
| examinee_no | text not null | 최대 16자 |
| examinee_name | text not null | 최대 12자 |
| seed | text not null | 128비트 난수의 hex 값. 응답으로 보내지 않는다 |
| session_hash | text not null | 현재 기기의 세션 토큰 해시 |
| started_at | integer not null | |
| deadline_at | integer not null | `min(started_at + 제한 시간, closes_at)` |
| submitted_at | integer | null이면 응시 중 |
| submit_reason | text | `manual` \| `timeout` \| `admin` |
| total_correct | integer | |
| avg_pct | integer | 과목 평균 × 100 (소수 둘째 자리까지 보존) |
| passed | integer(bool) | |
| subject_scores | text(json) | `[{ subjectId, earned, possible }]` |
| last_seen_at | integer | |
| device_switches | integer default 0 | |

인덱스: unique `(exam_id, examinee_no)`, `(exam_id, submitted_at)`, `(session_hash)`

### answers
| 컬럼 | 타입 | 비고 |
| --- | --- | --- |
| attempt_id | integer → attempts.id | PK 1 |
| exam_question_id | integer → exam_questions.id | PK 2 |
| choice_id | integer → choices.id | null = 답 취소 |
| saved_at | integer not null | |

PK `(attempt_id, exam_question_id)`, upsert로 저장. 인덱스 `(exam_question_id, choice_id)`는 정답률·보기 선택 비율용.

### audit_logs
| 컬럼 | 타입 | 비고 |
| --- | --- | --- |
| id | integer PK | |
| admin_id | integer → admins.id | |
| admin_email | text not null | 관리자가 지워져도 남도록 함께 저장 |
| action | text not null | `login`, `question.create`, `question.update`, `question.version`, `question.disable`, `exam.*`, `results.export`, `admin.*` … |
| target_type, target_id | text | |
| detail | text(json) | 바뀐 필드 요약 |
| ip | text | `CF-Connecting-IP` |
| created_at | integer not null | 인덱스 `(created_at)`, `(admin_id, created_at)` |

`login`은 Access가 처리하므로, 하루 중 그 관리자의 첫 API 요청을 로그인으로 기록한다(`last_login_at`과 비교).

---

## 5. seed 기반 셔플과 채점 설계

### 5-1. PRNG

- **seed 생성**: 입장해서 attempt를 만들 때 서버가 `crypto.getRandomValues(16 bytes)`로 만들고 hex로 저장한다. 데모처럼 수험번호로 seed를 만들지 않는다. 수험번호로 만들면 문제지를 예측할 수 있다.
- **해시**: `cyrb128(string) → [u32, u32, u32, u32]`
- **PRNG**: `sfc32(a, b, c, d)`. 32비트 정수 연산만 쓰고, 빠르고, 시드 128비트를 그대로 받으며, 결정적이다. 암호용 PRNG가 필요 없는 이유는 seed 자체가 비밀이고 암호학적 난수이기 때문이다.
- **스트림 분리**: 용도마다 따로 만든다.
  - 문항 순서: `rng(seed + '|q')`
  - 보기 순서: 문항마다 `rng(seed + '|c|' + exam_question_id)`
  - 이렇게 하면 한 문항의 보기 순서가 다른 문항이나 문항 순서 셔플에 영향을 받지 않는다.
- **셔플**: Fisher–Yates, `j = floor(rng() * (i + 1))`.
- **문제지 유형 코드**: `cyrb128(seed + '|paper')[0] % 36^3` → 3자리 base36. 표시용일 뿐이다.

### 5-2. 문제지 만들기 — `src/shared/paper.ts`, 순수 함수

입력: `seed`, 시험 옵션, 정렬된 문항 목록 `[{ eqId, subjectOrder, groupKey, fixedChoices, choiceCount }]` (`exam_questions.position` 오름차순)

1. **단위 만들기**: 같은 `groupKey`인 문항은 한 단위로 묶고 단위 안의 순서는 유지한다. 묶음 없는 문항은 1개짜리 단위가 된다.
2. **문항 섞기**
   - `shuffleQuestions=false`이면 과목 순서, position 순으로 둔다.
   - `shuffleWithinSubject=true`이면 과목 순서는 유지하고 과목마다 단위를 섞는다.
   - 둘 다 아니면 모든 단위를 섞는다.
   - 마지막에 단위를 펼친다.
3. **보기 섞기**: 문항마다 `order = [0..choiceCount-1]`. `shuffleChoices && !fixedChoices`일 때만 섞는다.
4. **출력**: `paper = [{ eqId, order }]`
   - 화면 번호 `n`(0부터)은 `paper[n]`이다.
   - 화면 보기 `m`(0부터)의 원래 순서는 `paper[n].order[m]`이다.

### 5-3. 역변환과 저장

#### 셔플 입력(layout)을 시험 단위로 한 번만 만든다

셔플에 필요한 정보는 문항 내용이 아니라 아래 최소 정보뿐이다.

```ts
type LayoutItem = {
  eqId: number;          // exam_questions.id
  questionId: number;    // questions.id (특정 버전)
  subjectId: number;
  subjectOrder: number;  // 잠글 때의 subjects.sort_order
  groupKey: string | null;
  fixedChoices: boolean;
  choiceCount: number;
};
```

- **만드는 시점**: 시험의 첫 attempt를 만들 때 `exams.layout`(JSON 텍스트)이 비어 있으면 만들어 저장한다.
  - `exam_questions`·`questions`·`choices` 개수를 묶어 한 번 읽는다(60문항 기준 약 420행). 시험당 1회뿐이다.
  - 같은 시점에 시험 구성이 잠긴다. 그 뒤로는 문항 구성 변경(`PUT /exams/:id/questions`)이 409로 막히고, 그 시험에 들어간 문항을 고치면 새 버전이 생긴다. 따라서 layout은 바뀌지 않는다.
- **동시 생성**: 첫 수험자 여럿이 동시에 들어와도 입력이 같으므로 같은 layout이 나온다. `UPDATE exams SET layout=? WHERE id=? AND layout IS NULL`로 처음 한 번만 쓴다.
- **Worker 메모리 캐시**: `Map<examId, LayoutItem[]>`를 isolate 전역에 둔다. layout은 한 번 저장되면 바뀌지 않으므로 무효화가 필요 없다. 캐시가 없으면 `exams` 1행만 읽는다.
- layout은 섞기 **전**의 입력이다. 수험자별 순서를 저장하지 않는다는 규칙 3과 맞는다.

#### 답안 저장 1회의 흐름 — `PUT /api/exam/answers { no, choice }` (1부터)

1. `attempts`를 `session_hash`로 1행 읽는다. 여기서 `seed`, `exam_id`, `deadline_at`, `submitted_at`을 얻는다.
2. layout을 가져온다. 메모리 캐시에 있으면 0행, 없으면 `exams` 1행이다.
3. `paper = buildPaper(seed, options, layout)`를 계산한다. 문항 100개 기준 마이크로초 단위다.
4. 답한 문항을 찾는다: `item = paper[no-1]`, 원래 순서는 `orig = item.order[choice-1]`.
5. 답한 문항의 보기만 `choices`에서 `(question_id, ord) = (item.questionId, orig)`로 **1행** 조회한다. 유니크 인덱스를 쓴다.
6. `answers`에 upsert한다. PK 조회 1행 + 쓰기 1행.
- 5와 6은 한 쿼리로 합친다:
  `INSERT INTO answers (...) SELECT ?, ?, id, ? FROM choices WHERE question_id=? AND ord=? ON CONFLICT DO UPDATE ...`
- 답 취소(`choice: null`)는 5를 건너뛰고 `choice_id = NULL`로 upsert한다.

#### 저장 1회당 읽는 행 수 (추정)

| 단계 | 캐시 있음 | 캐시 없음 |
| --- | --- | --- |
| attempts (session_hash 인덱스) | 1 | 1 |
| exams.layout | 0 | 1 |
| choices (question_id, ord) | 1 | 1 |
| answers upsert의 PK 조회 | 1 | 1 |
| **합계** | **약 3행** | **약 4행** |

- 인덱스 탐색이 rows_read에 조금 더 잡힐 수 있어 여유를 두면 **5행 이하**로 본다.
- 하루 추정: 100명 × 60회 × 5행 = 30,000행. 하루 읽기 한도(500만 행)의 **0.6%**다. 이전 설계(1회 약 420행 → 252만 행, 50%)보다 약 80배 줄어든다.
- 다른 경로 참고치(60문항, 보기 5개 기준):
  - `/paper` 1회는 약 430행(문항 60 + 보기 300 + 답안 60 + 기타)이다. 입장과 새로고침 때만 부른다. 100명이 각 3회면 약 13만 행이다.
  - 제출과 채점 1회는 약 130행(답안 60 + 정답 보기 60 + 기타)이다.
  - 하루 합계는 약 20만 행으로 한도의 4% 안쪽이다(추정).
- **실측**: D1 응답의 `meta.rows_read`·`meta.rows_written`을 경로별로 모으는 개발용 로그를 두고, 4주차 부하 스크립트에서 저장 1회당 실제 rows_read를 측정해 보고한다. 추정치(5행 이하)를 넘으면 원인을 적는다.

#### 그 밖의 규칙

- **저장하는 값**: 화면 번호가 아니라 원래 보기의 `choice_id`다. 그래서 채점과 통계가 셔플과 무관하다.
- **정방향 변환**(`/paper`, `/result`): `pos = order.indexOf(orig)`로 저장된 답을 화면 번호로 바꿔 보낸다.
- **입력 검증**: `no`는 1..문항 수, `choice`는 1..`choiceCount` 범위만 받고 밖이면 400이다. 제출 뒤나 마감 뒤에는 409다.
- **문항 내용 고정**: 응시 기록이 있는 문항을 수정하면 새 버전 행이 생기고, `exam_questions`는 옛 버전을 그대로 가리킨다(규칙 8).

### 5-4. 채점 — `src/shared/grade.ts`, 순수 함수

- **문항 정답**: `answers.choice_id`가 그 문항의 `is_correct` 보기이면 정답이다. 정답이면 `points`를 받는다.
- **과목 점수**
  - 과목 득점률 = 과목 획득 배점 / 과목 총 배점
  - 과목 평균 = 과목 득점률들의 산술평균. 데모와 같은 방식이다.
- **합격**: 모든 과목 득점률 ≥ `pass_subject_pct`이고 과목 평균 ≥ `pass_avg_pct`.
- **제출**: 제출할 때 한 번 계산해 `attempts`에 저장하고, 결과 화면은 저장된 값을 읽는다.

### 5-5. 시간

- **마감 시각**: `deadline_at`은 attempt를 만들 때 정한다.
- **화면 타이머**: 응답의 `serverNow`로 기기 시계와의 차이를 보정해 표시만 한다.
- **자동 제출**: 별도 작업 없이 처리한다(lazy finalize). `deadline_at`이 지난 attempt에 요청(조회·저장·제출·관리자 현황)이 오면 그 자리에서 채점하고 `submit_reason=timeout`으로 닫는다. 브라우저를 닫고 떠난 사람도 관리자 현황이나 결과 조회 때 닫힌다.
- **보조 수단**: 무료 Cron Trigger(10분마다)로 남은 attempt를 정리한다.
- **네트워크 지연 유예**: 마감 뒤 5초까지는 저장을 받는다. 상수 하나로 둔다.

### 5-6. 테스트로 확인할 것

- 같은 seed → 같은 paper, 다른 seed → 다른 paper(통계적으로 1000쌍 중 충돌 0)
- 화면→원래→화면 왕복이 항등
- 과목 순서 유지, 보기 고정, 묶음 문항이 붙어서 이동
- `/paper`·`/answers` 응답 JSON에 `is_correct`, `explanation`, `choice id`, `ord`, `seed`가 없음(키 이름과 값 모두 검사)
- 마감 뒤 저장 거절과 자동 제출
- 운영 환경에서 개발용 관리자 우회가 꺼져 있음

---

## 6. 모호하거나 맞지 않는 부분과 가정

| # | 문제 | 가정 |
| --- | --- | --- |
| 1 | 데모는 **수험번호로 seed**를 만들고, 기획은 **서버 난수 seed**다 | 서버 난수 seed를 쓴다. "같은 수험번호로 다시 들어오면 같은 문제지"는 같은 attempt로 이어지는 것으로 충족한다 |
| 2 | 데모에서는 **수험자가 셔플 옵션을 고르고**, 기획에서는 관리자가 정한다 | 시험 설정값으로만 정하고 수험자 화면에서는 뺀다 |
| 3 | 데모 점수는 **과목 평균**, 기획에는 "총점"이라는 말도 있다 | 합격 판정과 큰 점수는 과목 평균(데모 방식)으로 하고, 정답 수/전체는 함께 보여 준다. 배점은 과목 득점률 계산에 반영한다 |
| 4 | **"한 번에 한 기기"** vs **"재접속 시 이어서 응시"** — 동시 응시를 막으면서 기기 고장 뒤 이어 보기를 허용해야 한다 | **마지막 기기 우선**: 다른 기기로 다시 입장하면 새 세션이 발급되고, 이전 기기는 다음 요청에서 "다른 기기에서 접속" 오류로 멈춘다. 동시 응시는 불가능해진다. 전환 횟수는 `device_switches`로 관리자에게 보여 준다 |
| 5 | 같은 수험번호에 **다른 이름**으로 입장 | 403으로 거절한다(다른 사람이 이어 받는 것 방지). 수험번호 비교는 앞뒤 공백을 뺀 값으로 한다 |
| 6 | **제출 뒤 재입장** | 결과 화면으로 보낸다. 새 attempt는 만들지 않는다(재응시와 오답 다시 풀기는 2차) |
| 7 | **열리는 기간과 제한 시간**의 관계 | `deadline = min(시작 + 제한 시간, closes_at)`. 닫힌 시험에는 새로 입장할 수 없다 |
| 8 | **묶음 문항의 공통 지문**을 어디에 저장할지 정해져 있지 않다 | 테이블을 늘리지 않는다. 공통 지문은 묶음 첫 문항의 지문 앞에 넣고(검수 화면에서 처리), `group_key`는 함께 이동하는 데만 쓴다. 묶음은 같은 과목이어야 한다(서버 검증) |
| 9 | **공통 문항 번호와 버전** | `code`는 버전이 바뀌어도 유지하고 `id`는 버전마다 다르다. 화면에는 `#123 (v2)`로 표시하고, 정답률은 `code` 기준으로 모은다 |
| 10 | 복수 정답 / 출제 오류로 **전원 정답 처리** | 1차는 문항당 정답 1개다. 응시 뒤 정답을 고치면 새 버전이 생기고 과거 성적은 바뀌지 않는다(규칙 8). 지난 성적 재채점은 2차 |
| 11 | **관리자 허용 목록이 두 곳**: Access 정책과 `admins` 테이블 | 서버 권한은 `admins` 테이블이 기준이다(정지 즉시 반영). Access 정책은 사람이 대시보드에서 같은 이메일을 넣는다. `docs/SETUP.md`에 절차를 쓰고, 관리자 추가 화면에 "Access에도 추가해야 함" 안내를 띄운다. Access API 자동화는 비밀 토큰이 필요하므로 하지 않는다 |
| 12 | Access 보호 범위가 `/admin`만 적혀 있다 | `/admin*`과 `/api/admin*` **둘 다** Access 애플리케이션으로 보호한다. 서버도 따로 JWT를 검증한다 |
| 13 | 세션 8시간 | Access 애플리케이션의 세션 시간을 8시간으로 둔다(사람이 설정). 서버는 JWT의 `exp`를 믿는다 |
| 14 | **최초 최고관리자**를 누가 만드는가 | 마이그레이션 뒤 `npm run db:bootstrap-admin -- email`(로컬/원격 D1에 1행 넣기)으로 만든다. 절차는 SETUP.md에 둔다 |
| 15 | **이미지 URL로 정답이 샐 위험** (`choice-1.png` 같은 이름) | R2 키는 내용과 무관한 랜덤 값으로 한다. 응시 중에는 attempt 권한을 확인하는 `/api/exam/media/:key`로만 보낸다 |
| 16 | 응시 응답에 **choice id**가 들어가면 원래 순서를 추정할 수 있다 | 화면 번호와 내용만 보낸다(id, ord 제외) |
| 17 | 엑셀 내보내기를 Worker에서 만들면 **CPU 10ms**를 넘을 수 있다 | 서버는 JSON만 주고 xlsx는 관리자 브라우저에서 만든다. 라이브러리는 4주차에 정한다 |
| 18 | **IP별 요청 수 제한**의 수단 | Workers Rate Limiting 바인딩을 쓴다. 4주차에 무료 요금제에서 쓸 수 있는지 확인하고, 안 되면 isolate 메모리 기반 간이 제한으로 대신한다(정확하지 않음을 보고) |
| 19 | **자동 제출 시점**: Workers에는 상주 타이머가 없다 | 5-5의 lazy finalize와 Cron(무료)으로 처리한다 |
| 20 | **보기 개수**: 5지선다 가정이지만 고정하지 않는다 | 보기는 2~8개로 검증한다. 답안 표기란의 버블 수는 문항별 보기 수를 따른다(데모는 5개 고정) |
| 21 | **지문 서식**(굵게, 밑줄, 표) | 1차는 일반 텍스트 + 이미지다. 표는 이미지로 자른다(기획 4장과 같다). HTML을 저장하지 않으므로 XSS 걱정도 없다 |
| 22 | 수험자 **개인정보 보관 기간**이 정해져 있지 않다 | 기간을 정하지 않고, 처리방침 자리에 "클라이언트 확정 필요"라고 적는다. 시험 삭제 기능은 1차에서 빼고 닫기만 둔다 |
| 23 | 시험 코드 형식 | 6자리, 혼동 문자(0/O/1/I/L)를 뺀 대문자+숫자. 대소문자는 구분하지 않는다 |
| 24 | 과목은 전역인가, 시험마다 다른가 | 전역 `subjects`를 쓰고, 시험의 과목은 들어간 문항의 과목으로 정해진다. 과목 순서는 `subjects.sort_order`를 따른다 |
| 25 | 데모의 "틀린 문제만 다시 풀기" 버튼 | 2차 기능이므로 1차 결과 화면에서는 뺀다 |
| 26 | 실제 문제지 샘플 PDF가 아직 없다 (`docs/samples/` 비어 있음) | 2주차 전까지 받지 못하면 일반적인 2단·5지선다·①~⑤ 형식을 가정하고, 규칙은 `rules.ts` 한 곳에 모은다 |

---

## 7. 주차별 세부 체크리스트

### 1주차 — 기반
- [ ] `git init`, `.gitignore`(`node_modules`, `dist`, `.dev.vars`, `.wrangler`, `docs/samples/*.pdf`)
- [ ] Vite + React + TS + Tailwind + shadcn/ui 초기화, `src/client` 라우터(`/`, `/exam`, `/result`, `/admin/*`)
- [ ] Hono Worker `src/server/index.ts`, `wrangler.jsonc`(Static Assets + SPA fallback, D1 `DB`, R2 `FILES`, `ENVIRONMENT`)
- [ ] npm 스크립트: `dev`, `build`, `typecheck`, `lint`, `test`, `db:generate`, `db:migrate:local`, `db:seed:local` (셸 전용 문법 없이)
- [ ] ESLint + Prettier, Vitest 설정
- [ ] Drizzle 스키마 10개 테이블(4장), 첫 마이그레이션
- [ ] 시드: 데모 4과목·20문항 → subjects/questions/choices, 개발 관리자 1명
- [ ] `db:bootstrap-admin` 스크립트(최초 super_admin)
- [ ] 관리자 인증 미들웨어: Access JWT(JWKS 캐시, `aud`, `iss`, `exp`) + admins 조회 + 역할 검사, dev 우회
- [ ] 테스트: JWT 없음/위조/만료 → 401, 정지된 관리자 → 403, production에서 dev 우회 꺼짐
- [ ] 감사 로그 헬퍼 `audit(c, action, target, detail)`
- [ ] 문항 API: 목록(필터·검색·페이지), 상세, 생성, 수정(버전 규칙), 중지·재사용, 과목 CRUD
- [ ] 버전 규칙 테스트: 응시 기록 없음 → 그 행 수정, 있음 → 새 행 + `is_latest` 이동 + 옛 행은 그대로
- [ ] 관리자 화면: 문제은행 목록, 문항 편집 폼(보기 추가·삭제, 정답, 해설, 보기 고정, 과목), 중지 버튼
- [ ] 390px 폭 확인
- [ ] `docs/SETUP.md`: 계정 → D1(운영·테스트)·R2 생성 → `wrangler.jsonc`에 id 넣기 → 원격 마이그레이션 → Access 앱(`/admin*`, `/api/admin*`, OTP, 8시간, 허용 이메일) → `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` 시크릿 → 도메인 연결
- [ ] `.dev.vars.example`, README 실행 방법
- [ ] 보고

### 2주차 — PDF 분리
- [ ] 업로드 API: 타입·시그니처·20MB 검사, R2 랜덤 키, `source_files` 기록, 감사 로그
- [ ] 이미지 업로드 API `/api/admin/media`(PNG/JPEG, 2MB)
- [ ] pdf.js 워커 설정(Vite), 원본 스트리밍 API로 불러오기
- [ ] `rules.ts`: 줄 재구성(y 좌표로 묶기), 단 감지(x 분포로 2단 판단, 왼쪽 단 먼저), 문항 번호 정규식, ①~⑤ 분리, 머리글·바닥글·쪽 번호 제거
- [ ] `rules.ts` 단위 테스트(가짜 텍스트 아이템 fixture: 1단, 2단, 보기 한 줄 배치, 보기 여러 줄)
- [ ] 그림 영역 감지(operator list의 이미지 bbox) → 캔버스로 잘라 업로드 → 지문에 연결
- [ ] 검수 화면: 왼쪽 페이지 렌더 + 문항 영역 하이라이트, 오른쪽 카드 편집, 합치기·나누기, 과목 지정
- [ ] 정답표 파서(`1-③, 2-①`, `1③`, `1 3` 등) + 테스트
- [ ] 스캔본: 드래그로 영역 지정 → 지문/보기 n 이미지로 자르기
- [ ] 일괄 등록 API(`batch`), 정답이 없는 문항은 등록 막기, `source_files.status=done`
- [ ] 샘플 PDF 자동 분리 정확도 측정(문항 수 / 바르게 나뉜 수)
- [ ] 보고

### 3주차 — 응시·채점
- [ ] `shared/prng.ts`(cyrb128, sfc32), `shared/paper.ts`, `shared/grade.ts` + 단위 테스트(5-6)
- [ ] 시험 API: 생성(코드 발급), 설정 수정 제한, 문항 구성(attempt 생기면 잠금), 열기·닫기
- [ ] 시험 개설 화면: 설정 폼, 과목 필터 문항 선택, 배점, 코드 복사
- [ ] `/api/exam/info`, `/enter`(seed·세션 발급, 이어서 응시, 마지막 기기 우선, 이름 불일치 거절)
- [ ] 첫 attempt 때 `exams.layout` 생성·잠금 + isolate 메모리 캐시(5-3)
- [ ] `/paper`(정답 없는 응답), `/answers`(layout + 보기 1행 조회로 역변환 저장), `/submit`, `/result`(공개 설정 반영), `/media/:key`
- [ ] lazy finalize + Cron Trigger, 마감 유예 5초
- [ ] 응시 화면 React 이식: 상단바, 도구줄, 1단·2단, 글자 크기, 답안 표기란, 모바일 하단 패널, 제출·시간 종료 모달, 단축키, 저장 실패 재시도 표시
- [ ] 결과 화면 이식(해설 필터, 공통 문항 번호)
- [ ] 보안 테스트: 응시 중 응답 JSON에 금지 키·값 없음, 다른 attempt 세션으로 접근 불가, 마감 뒤 저장 거절
- [ ] Playwright: 수험자 2명 → 서로 다른 문제지 → 정해진 답 제출 → 기대 점수 일치
- [ ] 390px 확인
- [ ] 보고

### 4주차 — 오픈 준비
- [ ] 응시 현황 API·화면(인원, 진행률, 마지막 활동, 기기 전환)
- [ ] 성적 API·화면, `code`별 정답률, 내보내기(브라우저에서 xlsx 생성 + 감사 로그)
- [ ] 관리자 허용 목록 화면(super_admin), Access에도 추가하라는 안내
- [ ] 접속 기록 화면(super_admin), 로그인 기록
- [ ] IP 요청 수 제한(입장·답안 저장 경로 우선)
- [ ] Sentry(Worker + 화면, DSN은 환경 변수)
- [ ] 부하 스크립트: 30명 입장·저장·제출, 요청 수와 D1 읽기/쓰기 출력. **저장 1회당 실제 `rows_read`를 측정해 5-3 추정치(5행 이하)와 비교 보고**
- [ ] `/privacy`, `/terms` 문구 자리
- [ ] SETUP.md 보강(GitHub 자동 배포, 운영 마이그레이션, D1 덤프 백업, 되돌리기), `docs/OPERATIONS.md` 시험일 체크리스트
- [ ] 보고 + 사람이 할 일 목록
