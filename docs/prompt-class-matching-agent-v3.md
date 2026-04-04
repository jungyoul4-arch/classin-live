# 수업 매칭 에이전트 시스템 구현 프롬프트 (v3 — 최종)

아래 내용을 기반으로 "학생 주도형 수업 매칭 에이전트" 기능을 구현해줘.

## 프로젝트 컨텍스트

- 기존 프로젝트: ClassIn Live (src/index.tsx 단일 파일 구조)
- 환경: teachers.jung-youl.com (wrangler.teachers.jsonc)
- 이 환경에서는 `USE_INSTRUCTOR_VIRTUAL_ACCOUNT = "true"` → 강사도 가상계정 사용
- 기존 API/함수들을 최대한 재사용할 것
- 배포는 반드시 `npm run deploy:teachers` 사용 (직접 `wrangler pages deploy` 금지)

## 핵심 개념

학생이 "이런 수업이 필요해요"라고 요청하면, 가르치고 싶은 사람이 "제가 해보겠습니다"라고 지원하고, 에이전트가 대화를 통해 수업 정보를 수집한 뒤, 관리자 승인 후 ClassIn 세션까지 완전 자동으로 생성하는 시스템.

## 핵심 결정사항

1. **강사 자격 검증**: 관리자 승인 필수
2. **가격 결정**: 강사가 제안 → 관리자 최종 승인
3. **최소 인원**: 1:1 수업 가능 (최소 인원 제한 없음)
4. **에이전트 방식**: 스텝 기반 가이드 (채팅처럼 보이지만 상태 머신으로 구현)
5. **자동화 범위**: 관리자 승인 → ClassIn 세션까지 완전 자동화
6. **강사 계정**: 가상계정 사용 (teachers 환경 동일 방식)
7. **학생→강사 전환**: 기존 학생 계정 유지 + is_instructor 플래그로 듀얼 롤 지원
8. **지원 제약**: 로그인 필수 (user_id NOT NULL), 동일 요청에 중복 지원 불가, 본인 요청에 본인 지원 불가
9. **타임존**: 모든 시간은 KST(Asia/Seoul) 기준, DB 저장은 ISO 8601 UTC
10. **매칭 후 학생 등록**: 수업 생성 후 요청 학생은 자동 등록(enrollments INSERT), 결제는 별도 (관리자가 가격 조정 가능)

## DB 마이그레이션 (migrations/0022_class_request_system.sql)

### 기존 테이블 변경
```sql
ALTER TABLE users ADD COLUMN is_instructor INTEGER DEFAULT 0 CHECK(is_instructor IN (0, 1));
```

### 신규 테이블 3개

**class_requests** (수업 요청)
```sql
CREATE TABLE class_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id),
  preferred_schedule TEXT,
  budget_min INTEGER,
  budget_max INTEGER,
  interest_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'open',  -- open | matching | matched | closed
  matched_application_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**class_request_applications** (강사 지원)
```sql
CREATE TABLE class_request_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES class_requests(id),
  user_id INTEGER NOT NULL REFERENCES users(id),  -- 로그인 필수
  applicant_name TEXT NOT NULL,
  applicant_email TEXT NOT NULL,
  applicant_phone TEXT,
  bio TEXT,
  proposed_title TEXT,
  proposed_description TEXT,
  proposed_level TEXT DEFAULT 'all',  -- beginner | intermediate | advanced | all
  proposed_lessons_count INTEGER,
  proposed_duration_minutes INTEGER,
  proposed_schedule_start DATETIME,
  proposed_schedule_time TEXT,  -- 수업 시작 시각 (예: "19:00") KST 기준
  proposed_schedule_days TEXT,  -- JSON: ["mon","wed"]
  proposed_price INTEGER,
  conversation_step INTEGER DEFAULT 0,  -- 0~6 (7단계)
  status TEXT DEFAULT 'draft',  -- draft | submitted | approved | rejected
  admin_note TEXT,
  reviewed_at DATETIME,
  automation_step INTEGER DEFAULT 0,  -- 자동화 진행 단계 (아래 매핑표 참조)
  automation_error TEXT,  -- 자동화 실패 시 에러 메시지
  created_class_id INTEGER REFERENCES classes(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(request_id, user_id)  -- 동일 요청에 중복 지원 방지
);
```

**class_request_interests** (관심 표시)
```sql
CREATE TABLE class_request_interests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES class_requests(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(request_id, user_id)
);
```

인덱스:
```sql
CREATE INDEX idx_class_requests_status ON class_requests(status);
CREATE INDEX idx_class_requests_user ON class_requests(user_id);
CREATE INDEX idx_applications_request ON class_request_applications(request_id);
CREATE INDEX idx_applications_status ON class_request_applications(status);
CREATE INDEX idx_interests_request ON class_request_interests(request_id);
```

## 전체 플로우

```
[Phase 1: 학생 수업 요청]
학생 → "이런 수업 필요해요" 요청 작성 → 게시판에 공개
다른 학생들 → "나도 듣고 싶어요" 관심 표시

[Phase 2: 강사 지원 + 에이전트 대화]
로그인된 사용자 → "제가 가르쳐볼게요" 지원 버튼 클릭
  ※ 본인 요청에는 지원 불가 (request.user_id === 지원자 user_id → 403)
에이전트가 단계별로 정보 수집 (채팅 UI, 상태 머신):
  Step 0: 강사 정보 (이름, 자기소개/경력) — 로그인 정보로 이름/이메일 자동 채움
  Step 1: 수업 제목
  Step 2: 수업 설명 + 레벨
  Step 3: 수업 구성 (총 회차, 회당 시간)
  Step 4: 스케줄 (시작일, 요일/시간)
  Step 5: 가격 제안
  Step 6: 전체 요약 확인 → 제출
수집 완료 → status를 'submitted'로 변경
  ※ "이전" 입력 시 conversation_step - 1로 되돌아감 (뒤로가기 지원)

[Phase 3: 관리자 승인 → 완전 자동화]
관리자가 지원 내용 검토 → 승인 버튼 클릭
자동 실행 순서 (automation_step 매핑):
  Step 1: 지원자를 instructor로 등록
     - users.is_instructor = 1 + instructors 테이블 INSERT
     - 이미 기존 학생이면 계정 유지, is_instructor만 변경
     - 이미 강사(role='instructor' 또는 is_instructor=1)면 이 단계 스킵
  Step 2: 코스 생성 (classes 테이블 INSERT)
     - slug 자동 생성: title을 kebab-case로 변환 + Unix timestamp 접미사
     - 기존 POST /api/admin/classes 로직을 함수로 추출하여 재사용
  Step 3: ClassIn 코스 생성
     - createClassInCourse() 함수 재사용
     - 이미 classin_course_id 있으면 스킵 (멱등성)
  Step 4: 수업 세션 생성
     - createClassInLesson() × N회 호출
     - ★ 멱등성: 재시도 시 SELECT COUNT(*) FROM class_lessons WHERE class_id = ?로
       이미 생성된 레슨 수 확인 후, 그 다음 번호부터 생성 재개
     - 스케줄 계산: proposed_schedule_start + proposed_schedule_days + proposed_schedule_time 기반
       예) 시작일=4/14(월), days=["mon","wed"], time="19:00", 총 8회
       → 4/14(월) 19:00, 4/16(수) 19:00, 4/21(월) 19:00, 4/23(수) 19:00 ...
     - 시간은 KST 입력 → UTC 변환하여 ClassIn API에 전달 (KST = UTC+9)
     - 가상계정 자동 할당 (기존 로직 그대로)
  Step 5: created_class_id에 생성된 코스 ID 저장
  Step 6: class_requests.status → 'matched', matched_application_id 업데이트
     - 같은 요청의 다른 지원자들 → 자동으로 status = 'rejected' (admin_note = '다른 강사가 선정되었습니다')
     - 요청 학생을 수업에 자동 등록 (enrollments INSERT, status='active')
  Step 7: 알림 (요청 학생에게 수업이 생성되었다는 메시지)

  ** 각 단계 실행 시 automation_step을 업데이트 (1~7) **
  ** 에러 발생 시 automation_error에 에러 메시지 저장, 해당 단계에서 멈춤 **
  ** 관리자가 재시도 시 automation_step 기준으로 실패한 단계부터 재개 **

거절 시: admin_note에 사유 작성, 지원 status → 'rejected', 수업 요청은 다시 'open'
```

## 듀얼 롤 시스템 (학생 ↔ 강사) — 4중 안전장치

한 사용자가 학생이면서 동시에 강사일 수 있다. role은 'student' 유지, is_instructor=1로 강사 권한 부여.

### 안전장치 1: DB 레벨
- users.is_instructor는 0 또는 1만 허용 (CHECK 제약)
- is_instructor=1인 사용자는 반드시 instructors 테이블에 레코드 존재해야 함
- 강사 삭제 시 is_instructor도 0으로 롤백

### 안전장치 2: API 레벨 — 헬퍼 함수 통일
모든 권한 체크는 아래 헬퍼 함수만 사용 (직접 role 비교 금지):
```typescript
function isInstructorUser(user: any): boolean {
  return user.role === 'instructor' || user.is_instructor === 1;
}
```
기존 코드에서 `user.role === 'instructor'`로 체크하는 모든 곳을 `isInstructorUser(user)`로 교체할 것.

**SQL 쿼리도 동일하게 수정:**
```sql
-- 기존
WHERE u.role = 'instructor'
-- 변경
WHERE (u.role = 'instructor' OR u.is_instructor = 1)
```
수정 필요 위치: 강사용 코스 조회, 강사용 레슨 조회, 강사용 세션 생성, 강사 정보 조회 (최소 4곳)

### 안전장치 3: JWT/클라이언트 동기화
- **JWT payload에 is_instructor 필드 추가**: 로그인 시 `createJWT({ ..., is_instructor: user.is_instructor || 0 })`
- **로그인 API 응답에 is_instructor 포함**: user 객체에 is_instructor 필드 추가
- **localStorage user 객체에 반영**: 클라이언트가 `currentUser.is_instructor`로 강사 여부 판단
- **is_instructor 변경 시**: 사용자에게 재로그인 안내 (토큰 갱신 필요)

### 안전장치 4: UI 레벨
- isInstructorUser인 사용자: 네비게이션에 "내 수업"(학생) + "강의 관리"(강사) 메뉴 동시 표시
- 마이페이지 분기: 학생 마이페이지와 강사 마이페이지 둘 다 접근 가능
- 수업 상세 페이지에서 본인이 강사인 수업은 "강사 입장" 버튼, 학생으로 등록된 수업은 "학생 입장" 버튼
- 가상계정 분리: 학생=enrollments.classin_account_uid, 강사=instructors.classin_virtual_account (충돌 없음)

### 기존 코드 수정 포인트
`user.role === 'instructor'`를 `isInstructorUser(user)`로 교체해야 하는 주요 위치:
- JS: 강사 마이페이지 접근, 수업 생성/관리 권한, ClassIn 입장, 네비게이션 렌더링, 관리자 강사 목록 조회
- SQL: `WHERE u.role = 'instructor'` → `WHERE (u.role = 'instructor' OR u.is_instructor = 1)` (4곳)
- JWT: createJWT에 is_instructor 추가
- 클라이언트: localStorage user 객체의 is_instructor 참조

## API 엔드포인트

### 학생용
- `POST /api/class-requests` - 수업 요청 생성 (로그인 필수)
- `GET /api/class-requests` - 게시판 목록 (status=open인 것들)
- `GET /api/class-requests/:id` - 상세 조회
- `POST /api/class-requests/:id/interest` - 관심 표시 토글 (로그인 필수)
- `GET /api/my/class-requests` - 내 요청 목록 (로그인 필수)

### 강사 지원 + 에이전트
- `POST /api/class-requests/:id/apply` - 지원 시작 (draft 생성, 로그인 필수, 본인 요청 지원 불가)
- `POST /api/applications/:id/chat` - 에이전트 대화 메시지 전송
  - "이전" 입력 시 conversation_step - 1로 되돌림
  - 현재 step에 맞는 데이터 파싱/저장 → 다음 step 응답 반환
- `GET /api/applications/:id` - 지원 상태/대화 조회
- `POST /api/applications/:id/submit` - 최종 제출 (status → submitted)

### 관리자
- `GET /api/admin/applications` - 지원 목록 (submitted 상태)
- `GET /api/admin/applications/:id` - 지원 상세
- `POST /api/admin/applications/:id/approve` - 승인 (자동화 트리거)
- `POST /api/admin/applications/:id/reject` - 거절
- `POST /api/admin/applications/:id/retry` - 자동화 실패 시 재시도 (automation_step부터 재개)

## UI 페이지

1. **수업 요청 게시판** (`/class-requests`) - 카드 리스트, 관심 수 표시, 상태 필터
2. **수업 요청 작성** (`/class-requests/new`) - 폼 (제목, 설명, 카테고리, 희망시간대, 예산범위)
3. **수업 요청 상세** (`/class-requests/:id`) - 요청 내용 + 관심 표시 버튼 + "가르쳐보겠습니다" 지원 버튼
   - 본인 요청이면 지원 버튼 숨김
4. **강사 지원 에이전트** (`/class-requests/:id/apply`) - 채팅 UI (좌측 에이전트 말풍선 + 우측 사용자 입력)
5. **관리자 지원 검토** (`/admin/applications`) - 지원 목록 + 상세 + 승인/거절 버튼
6. **관리자 지원 상세** (`/admin/applications/:id`) - 지원자 정보, 제안 수업 내용, 원래 요청 내용 비교 표시, 자동화 진행 상태

## 에이전트 대화 상태 머신 구현

`POST /api/applications/:id/chat` API에서:

```
1. 현재 conversation_step 확인
2. 사용자 입력이 "이전"이면 → step - 1로 되돌리고 해당 step 질문 재표시
3. 사용자 입력(message)을 현재 step에 맞게 파싱/검증/저장
   - 검증 실패 시 에러 메시지와 함께 같은 step 재질문
4. conversation_step + 1로 업데이트
5. 다음 step의 에이전트 질문을 응답으로 반환
6. 마지막 step이면 요약 정보 반환
```

대화 단계는 **Step 0~6 (총 7단계)**:

| Step | 단계명 | 에이전트 메시지 | 수집 데이터 | 저장 컬럼 |
|------|--------|----------------|-------------|-----------|
| 0 | 강사 정보 | "안녕하세요! 수업을 만들어주셔서 감사합니다. 먼저 간단한 자기소개와 관련 경력을 알려주세요." | 이름, 자기소개 | applicant_name, bio |
| 1 | 수업 제목 | "좋습니다! 이제 수업 제목을 정해볼까요? 요청 내용을 참고해서 제안해주세요." | 제목 | proposed_title |
| 2 | 수업 설명 | "수업에서 무엇을 배울 수 있는지 설명해주세요. 그리고 수업 난이도는? (초급/중급/고급/전체)" | 설명, 레벨 | proposed_description, proposed_level |
| 3 | 수업 구성 | "총 몇 회 수업이고, 한 회에 몇 분으로 하실 건가요?" | 회차, 시간 | proposed_lessons_count, proposed_duration_minutes |
| 4 | 스케줄 | "수업 시작일, 요일, 시간을 정해볼까요? (예: 4월 14일 시작, 월/수, 저녁 7시)" | 시작일, 요일, 시간 | proposed_schedule_start, proposed_schedule_days, proposed_schedule_time |
| 5 | 가격 | "수강료를 얼마로 제안하시겠어요? (원 단위)" | 가격 | proposed_price |
| 6 | 확인/제출 | "[전체 요약 표시] 이 내용으로 제출하시겠습니까? (수정하려면 '이전'을 입력하세요)" | 확인 | status → submitted |

**기존 회원이 지원하는 경우**: Step 0에서 로그인 정보로 이름/이메일을 자동 채우고, 자기소개만 추가 입력받음.

### 입력 검증 규칙

| Step | 검증 | 실패 시 메시지 |
|------|------|---------------|
| 0 | 자기소개 10자 이상 | "자기소개를 좀 더 상세히 작성해주세요 (최소 10자)" |
| 1 | 제목 2자 이상 | "수업 제목을 입력해주세요" |
| 2 | 설명 20자 이상, 레벨은 초급/중급/고급/전체 중 하나 | "수업 설명을 좀 더 작성해주세요" / "난이도를 선택해주세요" |
| 3 | 회차 1~50, 시간 30~240분 | "수업 회차는 1~50회, 시간은 30~240분 범위로 입력해주세요" |
| 4 | 시작일 > 오늘, 요일 1개 이상 (mon/tue/wed/thu/fri/sat/sun), 시간 HH:MM 형식 | "시작일은 오늘 이후여야 합니다" / "유효한 요일을 선택해주세요" |
| 5 | 가격 > 0, 정수 | "유효한 금액을 입력해주세요" |
| 6 | "네"/"예"/"확인" → 제출, "이전" → Step 5로 | "제출하시려면 '네', 수정하시려면 '이전'을 입력해주세요" |

## 구현 순서

1. DB 마이그레이션 파일 생성 및 적용
2. 듀얼 롤 헬퍼 함수 + JWT/로그인 수정 + SQL 수정 (기존 코드 최소 변경)
3. 수업 요청 API + 게시판 UI
4. 강사 지원 에이전트 API + 채팅 UI (핵심)
5. 관리자 검토 패널 UI
6. 승인 후 자동화 로직 (기존 함수 조합, 멱등성 보장)
7. 매칭 후 학생 자동 등록

## 주의사항

- src/index.tsx 단일 파일 구조를 유지할 것
- Tailwind CDN 사용, JIT arbitrary class 사용 금지
- DB 변경 시 마이그레이션 파일 필수
- 기존 가상계정 할당 로직을 그대로 재사용 (강사용 가상계정)
- 에러 발생 시 해당 단계에서 멈추고 관리자에게 에러 표시 + 재시도 가능하게
- 기존 코드 수정은 최소한으로: 헬퍼 함수 추가 → 기존 체크를 헬퍼 호출로 교체
- 기존 POST /api/admin/classes의 코스 생성 로직은 함수로 추출하여 재사용 (코드 복사 금지)
- 배포: `npm run deploy:teachers` (절대 직접 `wrangler pages deploy` 금지)
- 보리스 워크플로우 5원칙 적용: Plan → 구현 → 자기확인 → 실수노트 → 세션로그
