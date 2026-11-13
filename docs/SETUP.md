# Cloudflare 설정 절차 (사람이 하는 일)

Claude Code는 계정 생성, 결제, 대시보드 설정을 하지 않습니다. 아래 순서대로 직접 진행해 주세요.
명령은 이 폴더(`TATTO_CBT_MOGO`)에서 PowerShell 또는 터미널로 실행합니다.

1~11은 처음 한 번, 12~17은 운영(배포 자동화, 오류 알림, 요청 수 제한, 마이그레이션, 백업, 되돌리기) 절차입니다.
시험 당일 점검은 `docs/OPERATIONS.md`를 봅니다.

---

## 1. 준비물

- [ ] Node.js 20 이상 (`node -v`로 확인)
- [ ] Cloudflare 계정 (무료). 클라이언트 명의로 만듭니다.
- [ ] GitHub 계정 (4주차 자동 배포용)

## 2. wrangler 로그인

```
npx wrangler login
```

브라우저가 열리면 Cloudflare 계정으로 허용합니다.

## 3. D1 데이터베이스 만들기

```
npx wrangler d1 create tatto-cbt-db
```

- 출력에 나온 `database_id`를 `wrangler.jsonc`의 `d1_databases[0].database_id`에 붙여 넣습니다(지금은 `00000000-...` 자리표시자).
- 테스트용 DB(`tatto-cbt-db-staging`)는 4주차에 스테이징 환경과 함께 만듭니다.

## 4. R2 버킷 만들기

1. 대시보드 → **R2** → 처음이면 R2를 활성화합니다.
   - 무료 한도(10GB) 안에서는 요금이 0원이지만, 활성화할 때 결제 수단 등록을 요구할 수 있습니다. 클라이언트 확인이 필요합니다.
2. 버킷을 만듭니다.
   ```
   npx wrangler r2 bucket create tatto-cbt-files
   ```
3. 버킷 설정에서 **Public access(r2.dev 주소, 커스텀 도메인)는 켜지 않습니다.** 문제지 원본은 서버 코드로만 읽습니다.

## 5. 운영 DB에 테이블 만들기 (마이그레이션)

```
npm run db:migrate:remote
```

## 6. 첫 배포

```
npm run build
npx wrangler deploy
```

배포가 끝나면 `https://tatto-cbt-mogo.<계정>.workers.dev` 주소가 나옵니다. 7~9단계를 마칠 때까지 관리자 화면은 열리지 않는 것이 정상입니다(401).

## 7. 도메인 연결

1. 도메인을 삽니다(.kr 또는 .co.kr, 자동 연장 켜기).
2. Cloudflare 대시보드 → **사이트 추가** → 도메인 입력 → Free 플랜.
3. 등록업체 관리 화면에서 네임서버를 Cloudflare가 알려 준 2개로 바꿉니다. 반영까지 최대 하루가 걸립니다.
4. **Workers & Pages → tatto-cbt-mogo → Settings → Domains & Routes → Add → Custom domain**에 도메인(예: `cbt.example.kr`)을 넣습니다. HTTPS 인증서는 자동으로 발급됩니다.
5. 같은 화면에서 **workers.dev 주소와 Preview URLs를 끕니다.** Access는 연결한 도메인에만 걸리기 때문입니다. 서버도 토큰을 따로 검사하지만, 우회 경로는 닫아 두는 것이 안전합니다.

## 8. Cloudflare Access로 관리자 화면 보호

1. 대시보드 → **Zero Trust**. 처음이면 팀 이름을 정하고 **Free** 플랜을 고릅니다(50명까지 무료). 이때 결제 수단 등록을 요구할 수 있습니다.
   - 팀 도메인은 `https://<팀이름>.cloudflareaccess.com`이 됩니다.
2. **Settings → Authentication → Login methods → Add new → One-time PIN**을 추가합니다(이메일 일회용 코드).
3. **Access → Applications → Add an application → Self-hosted**를 고르고 아래처럼 설정합니다.
   - Application name: `타투모고 관리자`
   - Session Duration: **8 hours**
   - Public hostname을 **두 개** 추가합니다(같은 도메인).
     - 경로 `admin*` — 관리자 화면
     - 경로 `api/admin*` — 관리자 API
   - Identity providers: One-time PIN만 체크합니다.
4. 정책(Policy)을 추가합니다.
   - Action: **Allow**
   - Include → **Emails** → 관리자 이메일을 하나씩 입력합니다.
   - 관리자를 추가하거나 빼면 이 목록과 관리자 화면의 허용 목록을 **둘 다** 바꿔야 합니다. 서버는 DB의 허용 목록을 기준으로 즉시 차단합니다.
5. 저장한 뒤 애플리케이션 상세의 **Application Audience (AUD) Tag**를 복사합니다.

## 9. 서버 비밀 값 넣기

```
npx wrangler secret put ACCESS_TEAM_DOMAIN
```
→ `https://<팀이름>.cloudflareaccess.com` 입력

```
npx wrangler secret put ACCESS_AUD
```
→ 8-5에서 복사한 AUD 태그 입력

비밀 값은 저장소나 코드에 넣지 않습니다.

## 10. 최고관리자 등록

```
npm run db:bootstrap-admin -- owner@example.com --remote
```

8-4의 Access 정책에도 같은 이메일이 들어 있어야 합니다.

## 11. 확인

- [ ] `https://<도메인>/admin`에 접속하면 Cloudflare 로그인 화면이 뜬다 → 이메일 입력 → 받은 코드 입력 → 문제은행 화면이 보인다.
- [ ] 허용 목록에 없는 이메일로는 코드를 받아도 들어갈 수 없다.
- [ ] 브라우저 시크릿 창에서 `https://<도메인>/api/admin/me`를 열면 로그인 화면으로 넘어가고 데이터가 보이지 않는다.
- [ ] `https://<도메인>/`(수험자 화면)은 로그인 없이 열린다.

---

## 12. GitHub 연결 자동 배포 (Workers Builds, 무료)

`main` 브랜치에 푸시하면 Cloudflare가 직접 빌드하고 배포합니다.

1. 대시보드 → **Workers & Pages → tatto-cbt-mogo → Settings → Build → Connect**에서 GitHub 저장소를 연결합니다.
   - 저장소가 공개(public)여도 비밀 값은 저장소에 없으므로 괜찮습니다. 비밀 값은 9·13단계의 `wrangler secret`에만 있습니다.
2. 설정
   - Production branch: `main`
   - Build command: `npm run build`
   - Deploy command: `npx wrangler deploy`
   - Build variables(선택): `VITE_SENTRY_DSN` = 13단계의 DSN (화면 오류 알림용, 공개되어도 되는 값)
3. 다른 브랜치를 푸시하면 미리보기 버전만 만들고 운영에는 반영하지 않도록 **Non-production branch builds는 끕니다**(7-5에서 Preview URL을 껐기 때문).
4. 확인: 작은 수정을 `main`에 푸시 → **Deployments** 탭에 새 배포가 생기고, 사이트에 반영되는지 봅니다.

> 데이터베이스 마이그레이션은 자동 배포에 넣지 않았습니다(15단계에서 사람이 먼저 실행). 배포 토큰에 DB 권한을 주지 않기 위해서입니다.

## 13. 오류 알림 (Sentry, 무료)

1. sentry.io에서 무료 계정 → 프로젝트 두 개를 만듭니다. 플랫폼은 **Cloudflare Workers**(서버)와 **Browser JavaScript**(화면).
2. 서버 DSN:
   ```
   npx wrangler secret put SENTRY_DSN
   ```
3. 화면 DSN은 12-2의 Build variable `VITE_SENTRY_DSN`에 넣습니다. 비워 두면 화면 오류 알림은 꺼집니다.
4. Sentry 프로젝트 **Settings → Security & Privacy**에서 **Data Scrubber**와 **Prevent Storing of IP Addresses**를 켭니다. 코드는 요청 본문(수험자 이름)을 보내지 않지만 한 번 더 막아 둡니다.
5. 알림 규칙: **Alerts → Create Alert → Issues → 새 오류가 생기면 이메일**.

## 14. IP별 요청 수 제한

`wrangler.jsonc`의 `ratelimits`(Workers Rate Limiting)로 동작합니다. 따로 켤 것은 없고, 배포하면 같이 적용됩니다.

| 이름 | 대상 | 한도(같은 IP, Cloudflare 지점마다) |
| --- | --- | --- |
| `RL_API` | 모든 `/api/*` | 60초에 1,200회 |
| `RL_ENTRY` | 시험 정보·입장 (`/api/exam/info`, `/enter`) | 60초에 200회 |

- 학원에서 수험자 30~100명이 **같은 IP(공유기)** 로 들어오는 경우를 기준으로 넉넉하게 잡았습니다. 한 사람이 1분에 수십 번 요청하는 일은 없습니다.
- 넘으면 `429` + "요청이 너무 많습니다" 안내가 나갑니다. 시험 중 이 안내를 받은 수험자가 있으면 숫자를 올리고 다시 배포합니다.
- 한도는 근사치입니다(지점별로 따로 세고, 동기화에 몇 초 걸림). 무차별 요청을 막는 용도이지 정확한 계량용이 아닙니다.
- 배포 후 대시보드에서 이 기능이 무료 요금제로 동작하는지(배포가 실패하지 않는지) 확인해 주세요. 안 되면 `wrangler.jsonc`의 `ratelimits` 블록만 지우면 제한 없이 동작합니다(코드는 바인딩이 없으면 건너뜁니다).

## 15. 운영 DB 마이그레이션

스키마(`src/db/schema.ts`)가 바뀐 커밋을 배포할 때만 합니다.

1. 개발 PC에서 `npm run db:generate` → `src/db/migrations/`에 새 SQL이 생긴 것을 커밋합니다.
2. **시험이 진행 중이 아닐 때** 16단계로 백업을 받습니다.
3. 운영에 적용합니다.
   ```
   npm run db:migrate:remote
   ```
   이미 적용된 파일은 건너뛰고 새 파일만 실행합니다.
4. 그다음 코드를 `main`에 푸시합니다(12단계 자동 배포).
   - 순서: **마이그레이션 → 코드 배포**. 새 코드가 새 컬럼을 쓰기 때문입니다. 그래서 마이그레이션은 "컬럼·테이블 추가"처럼 옛 코드도 계속 돌아가는 형태로만 만듭니다. 컬럼 삭제·이름 변경은 두 번의 배포로 나눕니다.

## 16. 백업 (덤프)

D1은 최근 **7일**(무료 요금제) 안의 어느 시점으로든 되돌릴 수 있는 Time Travel을 기본으로 제공합니다. 그보다 오래 보관하려면 주 1회 덤프 파일을 받아 둡니다.

```
npx wrangler d1 export tatto-cbt-db --remote --output backup-2026-11-13.sql
```

- **시험 중에는 하지 않습니다.** 덤프하는 동안 DB가 다른 요청을 잠시 막습니다.
- 덤프 파일에는 수험자 이름·수험번호가 들어 있습니다. **저장소에 커밋하지 말고**(`*.sql`은 무시 목록에 있음), 접근이 제한된 곳(클라이언트 소유 클라우드 드라이브 등)에 둡니다.
- 문제지 원본·그림(R2)은 업로드할 때 원본 PDF가 클라이언트에게 있으므로 따로 백업하지 않습니다. 필요하면 대시보드 R2 버킷에서 내려받습니다.

복구 연습(분기 1회): 테스트용 DB를 만들어 덤프를 되살려 봅니다.

```
npx wrangler d1 create tatto-cbt-db-restore-test
npx wrangler d1 execute tatto-cbt-db-restore-test --remote --file backup-2026-11-13.sql
npx wrangler d1 execute tatto-cbt-db-restore-test --remote --command "select count(*) from attempts"
```

끝나면 대시보드에서 테스트 DB를 지웁니다.

## 17. 되돌리기

**코드만 되돌리기** (화면이 깨졌거나 새 기능에 버그):

```
npx wrangler deployments list
npx wrangler rollback <버전 ID>
```

목록에서 문제 직전 버전의 ID를 고릅니다. 대시보드 **Deployments** 탭에서도 같은 일을 할 수 있습니다. 그다음 GitHub에서 문제 커밋을 `git revert`로 되돌려 푸시해야 다음 자동 배포에서 다시 살아나지 않습니다.

**데이터 되돌리기** (잘못된 마이그레이션, 대량 오입력):

```
npx wrangler d1 time-travel info tatto-cbt-db
npx wrangler d1 time-travel restore tatto-cbt-db --timestamp=2026-11-13T09:00:00+09:00
```

- 그 시각 **이후의 모든 변경(응시 기록 포함)이 사라집니다.** 시험이 끝난 뒤, 사라질 내용을 확인하고 실행합니다.
- 실행하면 되돌리기 전 상태를 가리키는 북마크가 출력됩니다. 적어 두면 "되돌리기를 되돌리기"할 수 있습니다.
- 7일보다 오래된 시점은 16단계 덤프로 새 DB에 되살린 뒤 필요한 행만 옮깁니다.
