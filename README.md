# TATTO_CBT_MOGO — 문신사 CBT 모의고사

문신사 국가시험 대비 CBT 모의고사 웹 서비스입니다. React(Vite) 화면과 Hono API를 Cloudflare Worker 하나로 서빙하고, D1·R2·Access를 씁니다.

| 문서 | 내용 |
| --- | --- |
| `CLAUDE.md` | 개발 규칙 (기술 스택, 절대 규칙, 폴더 구조, 기본 가정) |
| `docs/PLAN.md` | 기획서 개발용 요약본 |
| `docs/ANALYSIS.md` | 설계 (API, 화면, 스키마, 셔플·채점, 가정) |
| `docs/PROMPTS.md` | 단계별 작업 지시문 |
| `docs/SETUP.md` | Cloudflare 설정 절차 (사람이 하는 일) |
| `docs/reference/` | 화면·셔플 데모, 원본 기획서 |
| `docs/samples/` | 실제 문제지 PDF 샘플 (git 제외) |

## 로컬에서 실행하기

Node.js 20 이상이 필요합니다. 아래 명령은 PowerShell과 macOS/Linux 터미널에서 똑같이 동작합니다(파일 복사 한 줄만 다릅니다).

1. 패키지 설치
   ```
   npm install
   ```
2. 로컬 환경 변수 만들기 (`.dev.vars`는 git에 올라가지 않습니다)
   - PowerShell: `Copy-Item .dev.vars.example .dev.vars`
   - macOS/Linux: `cp .dev.vars.example .dev.vars`
3. 로컬 DB에 테이블 만들기
   ```
   npm run db:migrate:local
   ```
4. 데모 데이터 넣기 (4과목 20문항 + `.dev.vars`의 `ADMIN_DEV_EMAIL`을 최고관리자로 등록. **로컬 데이터를 지우고 다시 넣습니다**)
   ```
   npm run db:seed:local
   ```
5. 개발 서버 실행
   ```
   npm run dev
   ```
   - 관리자 화면: http://localhost:5173/admin
   - 수험자 화면: http://localhost:5173/ (3주차에 구현)

로컬에는 Cloudflare Access가 없으므로, `ENVIRONMENT=development`일 때만 `ADMIN_DEV_EMAIL`을 로그인한 관리자로 봅니다. 운영에서는 이 우회가 동작하지 않으며 테스트로 확인합니다.

## 명령 모음

| 명령 | 하는 일 |
| --- | --- |
| `npm run dev` | 화면 + Worker + 로컬 D1·R2 (Vite) |
| `npm run build` | 배포용 빌드 (`dist/`) |
| `npm run typecheck` | 타입 검사 |
| `npm run lint` | ESLint |
| `npm test` | Vitest (Workers 런타임에서 실행, 테스트용 D1에 마이그레이션 자동 적용) |
| `npm run db:generate` | `src/db/schema.ts`가 바뀌면 마이그레이션 SQL 생성 |
| `npm run db:migrate:local` / `db:migrate:remote` | 로컬 / 운영 D1에 마이그레이션 적용 |
| `npm run db:seed:local` | 로컬 데모 데이터 |
| `npm run db:bootstrap-admin -- <이메일> --remote` | 최초 최고관리자 등록 |
| `npm run test:e2e` | Playwright: 수험자 2명 응시·채점 (로컬 개발 서버, 처음 한 번 `npx playwright install chromium`) |
| `npm run split:measure` | 테스트 문제지(`docs/samples/test`)로 PDF 자동 분리 정확도 측정 |

## 직접 해야 하는 일

계정 생성, 결제, 도메인, Cloudflare 대시보드 설정은 `docs/SETUP.md` 순서대로 진행합니다. 실제 문제지 PDF 샘플은 2주차 전까지 `docs/samples/`에 넣어 주세요.
