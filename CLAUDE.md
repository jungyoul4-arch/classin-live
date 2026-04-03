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
- `migrations/` - D1 SQL 마이그레이션 파일들 (0001~0019)
- `wrangler.live.jsonc` - 프로덕션(live) 환경 설정
- `wrangler.teachers.jsonc` - 강사용 환경 설정

## 실수 노트 (Mistake Log)
### 2026-04-03: 레거시 비밀번호 형식 누락
- **실수**: 보안 패치 시 seed.sql의 비밀번호 형식이 `pbkdf2_test1234`인 것을 놓쳐 레거시 로그인 실패
- **원인**: `hash_` 형식만 가정하고 seed 데이터 미확인
- **해결**: verifyPassword에 `pbkdf2_` 형식 추가 (3가지 형식 지원: `pbkdf2:`, `hash_`, `pbkdf2_`)
- **교훈**: DB 스키마 변경 시 반드시 seed.sql과 실제 프로덕션 DB 데이터 형식 모두 확인

## 작업 컨벤션
- 커밋 메시지: 한글 또는 영어, feat/fix/refactor 프리픽스
- DB 변경 시 마이그레이션 파일 생성 필수 (migrations/00XX_*.sql)
- 보리스 워크플로우 5원칙 적용: Plan → 구현 → 자기확인 → 실수노트 → 세션로그
