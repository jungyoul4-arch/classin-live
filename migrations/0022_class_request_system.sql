-- 수업 매칭 에이전트 시스템
-- 학생 주도형 수업 요청 → 강사 지원 → 관리자 승인 → 자동 수업 생성

-- 듀얼 롤: 기존 학생이 강사 역할도 수행 가능
ALTER TABLE users ADD COLUMN is_instructor INTEGER DEFAULT 0 CHECK(is_instructor IN (0, 1));

-- 수업 요청 (학생이 "이런 수업 필요해요")
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

-- 강사 지원 (에이전트 대화로 정보 수집)
CREATE TABLE class_request_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES class_requests(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
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
  proposed_schedule_time TEXT,  -- KST 기준 시작 시각 (예: "19:00")
  proposed_schedule_days TEXT,  -- JSON: ["mon","wed"]
  proposed_price INTEGER,
  conversation_step INTEGER DEFAULT 0,  -- 0~6 (7단계)
  status TEXT DEFAULT 'draft',  -- draft | submitted | approved | rejected
  admin_note TEXT,
  reviewed_at DATETIME,
  automation_step INTEGER DEFAULT 0,  -- 자동화 진행 단계 (1~7)
  automation_error TEXT,
  created_class_id INTEGER REFERENCES classes(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(request_id, user_id)
);

-- 관심 표시 ("나도 듣고 싶어요")
CREATE TABLE class_request_interests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES class_requests(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(request_id, user_id)
);

-- 인덱스
CREATE INDEX idx_class_requests_status ON class_requests(status);
CREATE INDEX idx_class_requests_user ON class_requests(user_id);
CREATE INDEX idx_applications_request ON class_request_applications(request_id);
CREATE INDEX idx_applications_status ON class_request_applications(status);
CREATE INDEX idx_interests_request ON class_request_interests(request_id);
