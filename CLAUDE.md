# 프로젝트 헌법 (CLAUDE.md)

## 프로젝트 개요
- 프로젝트명: **ClassIn Live (L)** - 학생용 플랫폼
- 기술 스택: Hono, TypeScript, Cloudflare Workers, D1 SQLite, R2 Storage, Cloudflare Stream
- 배포 환경: Cloudflare Pages → https://live.jung-youl.com
- 외부 API: ClassIn (EEO.cn) 라이브 수업, 헥토파이낸셜 PG 결제

## ⚠️ L/T 분리 구조 (2026-04-15~)
> **L (Live, 학생용)과 T (Teachers, 강사용)는 별도의 Git 저장소로 분리됨**

| 항목 | L (학생용) | T (강사용) |
|------|-----------|-----------|
| 폴더 | `C:/classin/classin-live` | `C:/classin/classin-teachers` |
| Git | 별도 저장소 | 별도 저장소 |
| 배포 | `npm run deploy` → classin-live | `npm run deploy` → classin-teachers |
| D1 DB | classin-live-db | classin-teachers-db-v2 |
| URL | live.jung-youl.com | teachers.jung-youl.com |

### 중요 규칙
- **L 수정은 classin-live 폴더에서, T 수정은 classin-teachers 폴더에서 작업**
- **절대 한 폴더에서 다른 프로젝트로 배포하면 안 됨** (코드가 덮어씌워짐)
- 소스 코드가 다르게 분기되었으므로 기능 변경 시 양쪽 동기화 필요 여부 확인

## 핵심 규칙
- 단일 파일 구조: `src/index.tsx` 하나에 모든 라우트, HTML, JS 포함 (~14000줄)
- Tailwind CDN 사용 - JIT arbitrary class 사용 금지, 커스텀 스타일은 인라인 또는 style 태그에
- 관리자 인증: admin / jungyoul1234
- 테스트 학생: student1@test.com / test1234

## 폴더 구조
- `src/index.tsx` - 메인 앱 (모든 API + 페이지)
- `migrations/` - D1 SQL 마이그레이션 파일들
- `wrangler.jsonc` - Cloudflare Pages 환경 설정

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

### 2026-04-04: 수업 매칭 자동화 runAutomation 다수 버그
- **실수 1**: `virtual_accounts` → 실제 테이블명은 `classin_virtual_accounts`, 컬럼명도 불일치
- **실수 2**: `createClassInLesson`을 객체로 호출 (`config, { courseId, ... }`) → 개별 인자 필요
- **실수 3**: `created_class_id`를 Step 5에서야 저장 → Step 4 실패 후 재시도 시 classId가 null
- **실수 4**: `class_lessons`의 `sort_order` 컬럼이 teachers DB에는 `lesson_number`로 다름
- **실수 5**: 강사 입장 시 수업 생성에 사용된 ClassIn UID와 다른 UID로 입장 → 강사 권한 미부여
- **교훈**:
  - live와 teachers DB 스키마가 **다를 수 있음** → 양쪽 `PRAGMA table_info()` 확인 필수
  - 함수 호출 시 **시그니처(인자 순서/개수)** 반드시 확인 — 객체 vs 개별 인자 혼동 주의
  - 재시도(retry) 설계 시 **중간 상태를 즉시 저장** — 마지막 Step에 몰아두면 재시도 broken
  - ClassIn 가상계정은 수업 생성 시 teacherUid와 **동일한 UID**로 입장해야 강사 권한 부여됨

### 2026-04-05: Cloudflare Workers setHours() 타임존 버그
- **실수**: `setHours(19, 0)`으로 KST 19:00을 설정했으나, Workers는 UTC 환경이므로 UTC 19:00이 설정됨 → KST 표시 시 다음날 04:00
- **원인**: `setHours()`는 로컬 타임존(Workers에서는 UTC) 기준으로 동작
- **해결**: `new Date('YYYY-MM-DDThh:mm:00+09:00')` 형식으로 KST 오프셋을 명시적으로 지정
- **교훈**:
  - Workers에서 **절대 `setHours/setMinutes`로 KST 시간을 설정하지 말 것** → `+09:00` 오프셋 명시
  - 날짜 계산 시 `getDay()` 대신 `getUTCDay()` 사용, Date 대신 문자열로 날짜 관리
  - `getUTCFullYear/getUTCMonth/getUTCDate`를 사용하여 날짜 추출

### 2026-04-05: D1 datetime() 함수 에러로 메인 페이지 500
- **실수**: `datetime('now', '-3 hours')` SQL을 메인 페이지에 try-catch 없이 실행 → 전체 사이트 다운
- **원인**: D1 원격 환경에서 datetime() 함수 호환 문제
- **해결**: JS에서 ISO 문자열을 계산하여 바인딩 파라미터로 전달 + try-catch 방어
- **교훈**:
  - D1 쿼리에서 **SQLite 내장 함수(datetime, strftime 등) 사용 시 반드시 try-catch** 감싸기
  - 메인 페이지 등 **핵심 라우트에 새 쿼리 추가 시 반드시 방어 코드** 포함
  - 가능하면 날짜 계산은 JS에서 하고 결과를 바인딩으로 전달

### 2026-04-06: 강사 입장 시 다른 사람(학생) 이름으로 ClassIn 입장
- **실수**: 율고미(강사)가 강의실 입장하면 박상혁(학생)의 이름으로 ClassIn에 입장됨
- **원인**: `runAutomation`에서 강사용 가상계정을 ClassIn에 등록 후, `classin_virtual_accounts.status`를 'assigned'로 변경하지 않아 같은 VA가 학생에게 재할당됨 → 학생 등록 시 `editUserInfo`로 닉네임이 덮어씌워짐
- **해결**:
  1. `runAutomation`에서 강사 VA 등록 후 즉시 점유 표시 (status='assigned', classin_uid, assigned_name 저장)
  2. `instructor-enter`에서 강사 입장 시 `editUserInfo`로 닉네임 자동 복구
- **교훈**:
  - 가상계정을 사용한 후 **반드시 상태를 즉시 업데이트** — status, classin_uid, assigned_name 모두
  - Teachers에서는 한 사람이 강사+학생 동시 가능 → **역할별 별도 VA 필수**, 절대 겹치면 안 됨
  - 외부 API(ClassIn) 등록 시 **DB 상태도 같이 동기화** — 한쪽만 업데이트하면 불일치 발생

### 2026-04-06: runAutomation 후 중복 레슨("#5") 생성
- **실수**: 자동화로 4개 레슨 생성 후, 학생 수강 등록 시 `createClassInSession`이 5번째 레슨을 중복 생성
- **원인 (3 Whys)**:
  - Why 1: `createClassInSession`이 `classes.classin_class_id = NULL`을 보고 "레슨 없음"으로 판단
  - Why 2: `runAutomation`이 `class_lessons`에만 저장, 부모 `classes` 테이블 미업데이트
  - Why 3 (근원): 두 기능이 **같은 DB 상태를 공유하는 "계약"이 명시되지 않음**
- **해결**:
  1. `runAutomation` Step 4 완료 후 `classes.classin_class_id` 설정
  2. `createClassInSession`에 방어 로직: `class_lessons`에 이미 레슨이 있으면 중복 생성 건너뜀
- **교훈 (이 세션의 3개 버그 공통 패턴)**:
  - DB 상태를 변경할 때 **해당 상태를 읽는 다른 모든 기능을 확인**할 것
  - 자식 테이블(class_lessons) 변경 시 **부모 테이블(classes)의 참조 필드도 동기화**
  - 방어적 프로그래밍: 상태를 읽을 때 **단일 소스가 아닌 복수 소스를 확인** (fallback 패턴)

### 2026-04-15: teachers 사이트 CLASSIN_SID/SECRET 누락으로 Internal Server Error
- **실수**: teachers 사이트에서 ClassIn 관련 기능(수업 생성, 입장 등) 사용 시 "Internal Server Error" 발생
- **원인**: classin-teachers Pages 프로젝트에 `CLASSIN_SID`와 `CLASSIN_SECRET` secret이 미설정
  - classin-live에는 설정되어 있었으나, classin-teachers에는 누락됨
  - `wrangler pages secret list`로 비교 시 발견
- **해결**:
  ```bash
  echo "86799720" | npx wrangler pages secret put CLASSIN_SID --project-name=classin-teachers
  echo "ReldwKsx" | npx wrangler pages secret put CLASSIN_SECRET --project-name=classin-teachers
  npx wrangler pages deploy dist --project-name=classin-teachers
  ```
- **교훈**:
  - live와 teachers는 **별도 Cloudflare Pages 프로젝트** → secret도 각각 설정 필요
  - 새 프로젝트/환경 구성 시 **양쪽 secret list를 비교**하여 누락 확인
  - 외부 API(ClassIn, PG 등) 자격증명은 **환경별로 다를 수 있음** → 올바른 값인지 검증
  - `wrangler pages secret list --project-name=XXX`로 필수 secret 체크리스트:
    - `JWT_SECRET` (인증)
    - `CLASSIN_SID`, `CLASSIN_SECRET` (ClassIn API)
    - `CF_ACCOUNT_ID`, `CF_STREAM_TOKEN` (Cloudflare Stream)

## DB 상태 계약 (ClassIn 관련 필수 동기화 규칙)
- **class_lessons 생성 시** → `classes.classin_class_id`, `classes.classin_course_id` 반드시 설정
- **강사 가상계정 사용 시** → `classin_virtual_accounts.status='assigned'` + `classin_uid` + `assigned_name` + `instructors.classin_virtual_account` 모두 업데이트
- **학생 가상계정 할당 시** → `classin_virtual_accounts.status='assigned'` + `classin_uid` + `user_id` + `enrollments.classin_account_uid` 모두 업데이트
- **원칙**: 한 테이블만 변경하고 관련 테이블을 누락하면, 다른 기능에서 잘못된 판단을 하게 됨

## 작업 컨벤션
- 커밋 메시지: 한글 또는 영어, feat/fix/refactor 프리픽스
- DB 변경 시 마이그레이션 파일 생성 필수 (migrations/00XX_*.sql)
- 보리스 워크플로우 5원칙 적용: Plan → 구현 → 자기확인 → 실수노트 → 세션로그

## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- After modifying code files in this session, run `graphify update .` to keep the graph current (AST-only, no API cost)
