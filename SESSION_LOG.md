# 세션 로그 — 2026-03-27

## 완료된 작업

### 1. 프로젝트 클론 및 환경 설정
- GitHub `jungyoul4-arch/classin-live` (SSH) 클론 → `~/Desktop/classin live`
- Hono + Vite + Cloudflare Workers + D1 프로젝트
- npm install + DB 마이그레이션 (0001~0015) + seed 데이터 적용
- Vite dev 서버 http://localhost:5173 구동

### 2. 마이페이지(나의 강의실) UI 리디자인 (Class101 참고)
- **작업 완료 후 GitHub pull로 초기화됨** (로컬 변경 discard)
- Firecrawl로 Class101 크롤링 → 디자인 패턴 분석 (컬러 #FF5D00, Pretendard 폰트, 카드형 레이아웃)
- 변경 내용 (현재 코드에는 반영 안 됨, 재적용 필요):
  - 사이드바 헤더: 졸업모자 아이콘 + "나의 강의실" + 그라디언트 배경
  - 프로필: 그라디언트 사각형 아바타 + 수강 통계 카드 (수강중 N / 수강완료 N)
  - 탭: pill → 언더라인 스타일
  - 수강중 카드: 큰 썸네일(h-36) + LIVE 배지 + D-day 카운트다운 + 전체 너비 CTA
  - 수강완료 탭: 리뷰 작성하기 CTA 추가

### 3. 어드민 - 코스별 강의 추가 버튼
- 코스 펼침 시 "라이브 강의 추가" + "녹화 강의 추가" 버튼 표시
- `loadCourseLessons()` 수정 + `buildLessonAddButtons()` 함수 추가
- API `/api/admin/classes/:classId/lessons`에 `courseInfo` 반환 추가
- 라이브 강의 버튼: ClassIn UID 없어도 활성화 상태로 변경

### 4. 회차별 커리큘럼 + 강의자료 첨부 기능
- **DB 마이그레이션**: `migrations/0016_lesson_curriculum.sql`
  - `class_lessons`에 `description`, `curriculum_items` (JSON), `materials` (JSON) 컬럼 추가
- **파일 업로드 API**: `POST /api/admin/upload-material`
  - 허용: PDF, DOCX, PPTX, HWP, ZIP, XLS, XLSX, TXT (최대 50MB)
  - R2 저장: `materials/{timestamp}-{random}.{ext}`
  - 서빙: `GET /api/materials/*`
- **어드민 UI - 강의 생성 모달 개선**:
  - `addLessonRow()`: 강의 설명 textarea + 커리큘럼 항목 동적 추가 (제목+설명) + 강의 자료 업로드 (최대 5개)
  - `addCurriculumItem()`, `uploadMaterial()`, `collectLessonData()` 함수 추가
  - `confirmCreateSession()`에서 `collectLessonData()` 사용하도록 수정
- **API 수정**:
  - `POST /api/admin/classes/:classId/create-sessions`: description, curriculumItems, materials 저장
  - `POST /api/admin/classes/:classId/create-recorded-lesson`: 동일하게 새 필드 저장

## 진행 중인 작업 (미완료)

### 마이페이지 리디자인 재적용
- GitHub pull로 초기화됨 → 새 코드 기반으로 재적용 필요
- 계획 파일: `~/.claude/plans/jazzy-humming-penguin.md` 참고

### 커리큘럼 기능 - 남은 단계
1. **어드민 강의 목록 표시 개선** (`renderLessonRow()` 수정)
   - 강의명 옆에 커리큘럼 항목 수 배지 표시
   - 자료 있으면 📎 아이콘 표시
   - 행 클릭/확장 시 커리큘럼 상세 표시
2. **학생 페이지 - 강의 목록에 커리큘럼 표시** (`/class/:slug` 7200줄 부근)
   - 각 강의 아래에 커리큘럼 항목 표시 (아코디언 펼침)
   - 자료 다운로드 링크 (수강생만)
3. **녹화 강의 모달에도 커리큘럼 UI 추가** (`openRecordedLessonModal()`)

## 중요 결정사항
- `class_lessons` 테이블에 커리큘럼 통합 (별도 `lessons` 테이블 대신)
- 커리큘럼 항목: 제목 + 설명 구조
- 강의 자료: 회차당 최대 5개, 문서류 전체 허용 (PDF, DOCX, PPTX, HWP, ZIP, XLS, TXT)
- 어드민 비밀번호: admin / jungyoul1234
- 테스트 학생: student1@test.com / test1234 (user_id=8)
- Playwright로 localhost:5173 브라우저 테스트 가능 (Chrome 별도 프로필)

## 프로젝트 구조 요약
- **단일 파일**: `src/index.tsx` (~10700줄) - 모든 라우트, HTML, JS
- **DB**: Cloudflare D1 SQLite (바인딩명: DB)
- **스토리지**: Cloudflare R2 (바인딩명: IMAGES) - 이미지 + 자료 파일
- **외부 API**: ClassIn (EEO.cn) 라이브 수업, Cloudflare Stream 녹화 강의
- **GitHub**: `jungyoul4-arch/classin-live` (main 브랜치)

## 보리스 워크플로우 스킬
- `boris-workflow` 설치됨 - 개발 작업 시 5원칙 자동 적용
