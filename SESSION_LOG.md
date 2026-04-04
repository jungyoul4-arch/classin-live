# 세션 로그 — 2026-04-04 (세션 5: 수업 매칭 에이전트 시스템 구현)

## 이전 세션 (세션 4) 완료 항목
- 수업 매칭 에이전트 v3 프롬프트 설계 완료
- teachers 사이트 장애 3건 해결
- CLAUDE.md 실수 노트 추가

## 세션 5 완료 작업

### 1. DB 마이그레이션 (Phase A)
- `migrations/0022_class_request_system.sql` 생성
  - `users.is_instructor` 컬럼 추가 (듀얼 롤)
  - `class_requests` 테이블 (수업 요청)
  - `class_request_applications` 테이블 (강사 지원, 7단계 에이전트)
  - `class_request_interests` 테이블 (관심 표시)
  - 인덱스 5개

### 2. 듀얼 롤 시스템 (Phase A)
- `isInstructorUser()` 서버 헬퍼 함수 추가
- SQL 4곳 수정: `u.role = 'instructor'` → `(u.role = 'instructor' OR u.is_instructor = 1)`
- JS 클라이언트 13곳 수정: 모든 instructor 체크에 `is_instructor === 1` 추가
- JWT payload에 `is_instructor` 필드 추가
- 로그인/회원가입 API 응답에 `is_instructor` 포함
- 관리자 사용자 목록에 `is_instructor` 표시

### 3. 수업 요청 시스템 (Phase B)
- **API 5개**: POST/GET /api/class-requests, GET /:id, POST /:id/interest, GET /api/my/class-requests
- **UI 3페이지**: /class-requests (게시판), /class-requests/new (작성), /class-requests/:id (상세)
- 관심 표시 토글 (DB.batch 원자적 처리)
- 네비게이션에 "수업 요청" 링크 추가

### 4. 강사 지원 에이전트 (Phase C)
- **API 4개**: POST /apply, POST /chat, GET /applications/:id, POST /submit (chat 내장)
- **7단계 상태 머신**: validateAndSaveStep() + getAgentMessage()
  - Step 0: 강사 정보 (자기소개)
  - Step 1: 수업 제목
  - Step 2: 수업 설명 + 레벨
  - Step 3: 수업 구성 (회차, 시간)
  - Step 4: 스케줄 (시작일, 요일, 시간)
  - Step 5: 가격 제안
  - Step 6: 전체 요약 확인 → 제출
- "이전" 입력으로 뒤로가기 지원
- **채팅 UI**: /class-requests/:id/apply (에이전트 말풍선 + 사용자 입력)

### 5. 관리자 매칭 관리 (Phase D)
- **API 5개**: GET/GET/:id /api/admin/applications, POST approve/reject/retry
- **자동화 7단계**: runAutomation() 함수
  - Step 1: 강사 등록 (is_instructor + instructors 테이블)
  - Step 2: 코스 생성 (classes INSERT, slug 자동 생성)
  - Step 3: ClassIn 코스 생성 (createClassInCourse 재사용)
  - Step 4: 수업 세션 생성 (createClassInLesson × N회, KST→UTC 변환, 멱등성)
  - Step 5: created_class_id 저장
  - Step 6: 매칭 완료 + 다른 지원자 거절 + 학생 자동 등록
  - Step 7: 완료
- 재시도: automation_step 기준으로 실패한 단계부터 재개
- **관리자 UI**: /admin/applications (목록 + 상세 모달 + 승인/거절/재시도)
- 관리자 대시보드에 "수업 매칭 관리" 메뉴 추가

### 6. 팀 에이전트 리뷰 (2차 루프)
- **보안 리뷰 (code-reviewer)**:
  - [수정완료] 관리자 API 5개 인증 누락 → requireAdminAPI() 추가
  - [수정완료] XSS 취약점 (innerHTML) → escHtml() 함수 추가
- **아키텍처 리뷰 (code-architect)**:
  - [수정완료] classId null on retry → app_row.created_class_id로 초기화
  - [수정완료] is_instructor 누락 2곳 (openMyPage, authArea nav)
  - [확인] POST /submit 별도 엔드포인트 미구현 → chat step 6에서 처리 (기능 동일)
  - [확인] Step 2 레벨 기본값 → 'all'로 기본 설정 (사용성 우선)

## 현재 상태
- **코드**: 빌드 성공 (616.84 kB)
- **미배포**: DB 마이그레이션 적용 + 배포 필요
- **미커밋**: 전체 변경사항 미커밋

## 배포 전 체크리스트
- [ ] `wrangler d1 migrations apply classin-teachers-db-v2 --remote` (0022 적용)
- [ ] `npm run deploy:teachers` (teachers 사이트 배포)
- [ ] teachers 사이트에서 /class-requests 접근 테스트
- [ ] 관리자에서 /admin/applications 접근 테스트
- [ ] (선택) live DB에도 마이그레이션 적용 시 `wrangler d1 migrations apply classin-live-db --remote`

## 파일 변경 내역
- `migrations/0022_class_request_system.sql` — 신규 (3 테이블 + 인덱스)
- `src/index.tsx` — 수정 (~800줄 추가, ~25곳 수정)
  - 듀얼 롤 헬퍼 + SQL/JS 수정
  - 수업 요청 API 5개 + 에이전트 API 4개 + 관리자 API 5개
  - 자동화 함수 runAutomation()
  - UI 페이지 4개 + 관리자 페이지 1개
  - 네비게이션 메뉴 추가
