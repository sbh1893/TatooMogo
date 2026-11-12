# Cloudflare 설정 절차 (사람이 하는 일)

Claude Code는 계정 생성, 결제, 대시보드 설정을 하지 않습니다. 아래 순서대로 직접 진행해 주세요.
명령은 이 폴더(`TATTO_CBT_MOGO`)에서 PowerShell 또는 터미널로 실행합니다.

배포 자동화(GitHub 연결), 운영 백업, 되돌리기는 4주차에 이 문서에 보강합니다.

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
   - Application name: `CBT 관리자`
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
