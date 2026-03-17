-- Class Lessons: 클래스별 수업 이력 관리
-- 한 클래스에 여러 수업(레슨)을 생성할 수 있음

CREATE TABLE IF NOT EXISTS class_lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  lesson_number INTEGER NOT NULL DEFAULT 1,
  lesson_title TEXT NOT NULL,

  -- ClassIn 정보
  classin_course_id TEXT,
  classin_class_id TEXT,
  classin_instructor_url TEXT,

  -- 수업 시간
  scheduled_at DATETIME NOT NULL,
  duration_minutes INTEGER DEFAULT 60,

  -- 상태: scheduled, live, ended
  status TEXT DEFAULT 'scheduled',

  -- 다시보기 URL (수업 종료 후)
  replay_url TEXT,

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_class_lessons_class_id ON class_lessons(class_id);
CREATE INDEX IF NOT EXISTS idx_class_lessons_status ON class_lessons(status);
CREATE INDEX IF NOT EXISTS idx_class_lessons_scheduled ON class_lessons(scheduled_at);

-- 클래스에 수업 횟수 컬럼 추가
ALTER TABLE classes ADD COLUMN lesson_count INTEGER DEFAULT 0;
