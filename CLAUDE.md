# 프로젝트 헌법 (CLAUDE.md)

## 프로젝트 개요
- 프로젝트명: ClassIn Live
- 기술 스택: Hono, TypeScript, Cloudflare Workers, D1 SQLite, R2 Storage, Cloudflare Stream
- 배포 환경: Cloudflare Workers (live: classin-live.jung-youl.com / teachers: classin-teachers.jung-youl.com)
- 외부 API: ClassIn (EEO.cn) 라이브 수업, 헥토파이낸셜 PG 결제

## 핵심 규칙
- 단일 파일 구조: `src/index.tsx` 하나에 모든 라우트, HTML, JS 포함 (~14000줄)
- Tailwind CDN 사용 - JIT arbitrary class 사용 금지, 커스텀 스타일은 인라인 또는 style 태그에
- 관리자 인증: admin / jungyoul1234
- 테스트 학생: student1@test.com / test1234

## 폴더 구조
- `src/index.tsx` - 메인 앱 (모든 API + 페이지)
- `migrations/` - D1 SQL 마이그레이션 파일들 (0001~0021)
- `wrangler.live.jsonc` - 프로덕션(live) 환경 설정
- `wrangler.teachers.jsonc` - 강사용 환경 설정

## 실수 노트 (Mistake Log)
### 2026-04-03: 레거시 비밀번호 형식 누락
- **실수**: 보안 패치 시 seed.sql의 비밀번호 형식이 `pbkdf2_test1234`인 것을 놓쳐 레거시 로그인 실패
- **원인**: `hash_` 형식만 가정하고 seed 데이터 미확인
- **해결**: verifyPassword에 `pbkdf2_` 형식 추가 (3가지 형식 지원: `pbkdf2:`, `hash_`, `pbkdf2_`)
- **교훈**: DB 스키마 변경 시 반드시 seed.sql과 실제 프로덕션 DB 데이터 형식 모두 확인

### 2026-04-04: teachers 사이트 JWT_SECRET 누락 + DB 비밀번호 더미값
- **실수**: teachers 사이트에서 로그인/회원가입 불가 (Internal Server Error)
- **원인 1**: teachers DB(classin-teachers-db-v2)의 비밀번호가 `$2a$10$defaulthash` (bcrypt 더미값) → verifyPassword가 처리 불가
- **원인 2**: teachers Pages 프로젝트에 JWT_SECRET secret이 미설정 → 토큰 생성 시 에러
- **해결**: DB 비밀번호를 `hash_` 형식으로 업데이트 + `wrangler pages secret put JWT_SECRET` 후 재배포
- **교훈**:
  - live와 teachers는 **별도 DB**를 사용함 → 데이터 변경 시 양쪽 모두 확인
  - Pages secret은 설정 후 **재배포 필수** (Workers와 다름)
  - `wrangler pages secret list`로 필수 secret 존재 여부를 먼저 확인할 것
  - 새 환경 구성 시 체크리스트: DB 시드 데이터 형식 + JWT_SECRET + 기타 secret 모두 확인

### 2026-04-04: 배포 시 잘못된 DB 연결 (live/teachers 혼선)
- **실수**: `wrangler pages deploy`를 직접 실행하여 teachers 사이트를 live DB로 배포
- **원인**: 배포 스크립트가 `cp wrangler.{env}.jsonc wrangler.jsonc` 후 배포하는 구조인데, 직접 `wrangler pages deploy`만 실행하면 현재 `wrangler.jsonc`(live 설정)이 그대로 적용됨
- **해결**: `npm run deploy:teachers` / `npm run deploy:live` 스크립트로 재배포
- **교훈**:
  - **절대 `wrangler pages deploy`를 직접 실행하지 말 것** → 반드시 `npm run deploy:teachers` 또는 `npm run deploy:live` 사용
  - live와 teachers는 완전히 독립된 서비스, 독립된 DB → 배포 시 올바른 config가 적용되었는지 API 호출로 검증

## 작업 컨벤션
- 커밋 메시지: 한글 또는 영어, feat/fix/refactor 프리픽스
- DB 변경 시 마이그레이션 파일 생성 필수 (migrations/00XX_*.sql)
- 보리스 워크플로우 5원칙 적용: Plan → 구현 → 자기확인 → 실수노트 → 세션로그
