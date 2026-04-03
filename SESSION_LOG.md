# 세션 로그 — 2026-04-03

## 완료된 작업

### 1. GitHub Pull
- `origin/main`에서 최신 코드 pull (e50ea2d → 410c476)
- 헥토 PG 결제 연동, 관리자 결제 관리, 강사 가상계정, 청크 업로드 등 다수 커밋 포함
- `wrangler.jsonc`가 원격에서 삭제됨 → stash 후 pull

### 2. 관리자 홈페이지 관리 기능 구현
- **커밋**: `4e6c2da` - `feat: 관리자 홈페이지 관리 기능 추가`
- **DB 마이그레이션**: `migrations/0020_homepage_sort_order.sql` - `homepage_sort_order` 컬럼 추가
- **API 3개 추가**:
  - `GET /api/admin/homepage/sections` - 3개 섹션별 코스 목록 조회
  - `PUT /api/admin/classes/:id/homepage-flags` - 베스트/신규 토글
  - `PUT /api/admin/homepage/reorder` - 순서 일괄 업데이트 (D1 batch)
- **홈페이지 쿼리 수정**: 3개 섹션 ORDER BY에 `homepage_sort_order ASC` 추가
- **관리자 대시보드**: "홈페이지 관리" 바로가기 카드 추가
- **새 페이지 `/admin/homepage`**: 3개 섹션 관리 UI
  - 베스트 코스: 추가/제거/순서변경
  - 라이브 코스: 순서만 변경 (class_type='live' 자동 포함)
  - 신규 코스: 추가/제거/순서변경
  - 드래그앤드롭 + 위/아래 버튼 순서 변경
  - 코스 검색 모달로 추가

### 3. Playwright MCP 테스트 검증
- 코스 추가: 6/8 → 7/8 (통과)
- 코스 제거: 7/8 → 6/8 (통과)
- 순서 변경: DB 저장 확인 (통과)
- 홈페이지 반영: 변경된 순서대로 표시 (통과)
- 콘솔 에러: 0개

### 4. 배포 완료
- 프로덕션 D1 마이그레이션 적용 (account: 8df9097bbfeeeb95dc7c44e4103bc656)
- Cloudflare Pages 배포: https://classin-live.jung-youl.com
- GitHub push 완료

### 5. CRITICAL 보안 패치 (4건 → 8개 패치)
- **감사 보고서 3개 생성** (병렬 에이전트):
  - `docs/audit-a1-api-contracts.md` — 119개 API 엔드포인트 계약 문서화
  - `docs/audit-a2-security-stability.md` — CRITICAL 4건, HIGH 6건+ 발견
  - `docs/audit-a3-performance.md` — HIGH 7건, MEDIUM 9건 성능 병목
- **PATCH 0**: Bindings 타입에 `JWT_SECRET` 추가, wrangler 설정 업데이트
- **PATCH 1**: PBKDF2 비밀번호 해싱 헬퍼 (`hashPassword`, `verifyPassword`)
- **PATCH 2**: HMAC-SHA256 JWT 헬퍼 (`createJWT`, `verifyJWT`)
- **PATCH 3**: 로그인 — 비밀번호 검증 추가 + JWT 서명
- **PATCH 4**: 회원가입 — `hash_${password}` → PBKDF2 해싱
- **PATCH 5**: 스트리밍 토큰 검증 — base64 디코딩 → `verifyJWT()` 
- **PATCH 6**: 클라이언트측 `alg: "none"` 토큰 생성 제거 (2곳)
- **PATCH 7**: 관리자 API 미들웨어 추가 (42개 엔드포인트 보호) + 하드코딩 키 제거
- **검증 결과**: 6/6 테스트 통과 (회원가입, 로그인, 잘못된 비밀번호 거부, 레거시 비밀번호, 관리자 API 거부, 위조 토큰 거부)
- **주의**: 배포 시 `wrangler secret put JWT_SECRET` 필요, 기존 사용자 재로그인 필요

## 진행 중인 작업 (미완료)
- 이전 세션의 마이페이지 리디자인 재적용 (GitHub pull로 초기화됨)
- 커리큘럼 기능 남은 단계 (어드민 강의 목록 표시 개선, 학생 페이지 커리큘럼 표시)

## 중요 결정사항
- 홈페이지 관리는 별도 `/admin/homepage` 페이지로 분리 (기존 코스 CRUD와 독립)
- 기존 `is_bestseller`, `is_new` DB 필드 활용 (새 테이블 불필요)
- `homepage_sort_order` 1개 컬럼만 추가하여 3개 섹션 모두 정렬 제어
- 라이브 코스 섹션은 class_type 기반 자동 포함, 순서만 관리자 제어

## 프로젝트 구조 요약
- **단일 파일**: `src/index.tsx` (~14500줄) - 모든 라우트, HTML, JS
- **DB**: Cloudflare D1 SQLite (바인딩명: DB)
- **스토리지**: Cloudflare R2 (바인딩명: IMAGES)
- **외부 API**: ClassIn (EEO.cn), 헥토파이낸셜 PG, Cloudflare Stream
- **GitHub**: `jungyoul4-arch/classin-live` (main 브랜치)
- **Cloudflare Account ID**: `8df9097bbfeeeb95dc7c44e4103bc656`
- **관리자**: admin / jungyoul1234
- **테스트 학생**: student1@test.com / test1234
