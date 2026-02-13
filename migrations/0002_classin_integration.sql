-- ClassIn API Integration - 수업 세션 관리 테이블

-- ClassIn sessions table - 각 수업의 ClassIn 세션 정보 저장
CREATE TABLE IF NOT EXISTS classin_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL,
  enrollment_id INTEGER DEFAULT NULL,
  user_id INTEGER NOT NULL,
  -- ClassIn API response data
  classin_course_id TEXT DEFAULT '',
  classin_class_id TEXT DEFAULT '',
  classin_join_url TEXT DEFAULT '',
  classin_live_url TEXT DEFAULT '',
  -- Session details
  session_title TEXT NOT NULL,
  instructor_name TEXT DEFAULT '',
  scheduled_at DATETIME NOT NULL,
  duration_minutes INTEGER DEFAULT 60,
  -- Status: pending, ready, live, ended, cancelled
  status TEXT DEFAULT 'ready' CHECK(status IN ('pending', 'ready', 'live', 'ended', 'cancelled')),
  -- Meta
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME DEFAULT NULL,
  FOREIGN KEY (class_id) REFERENCES classes(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (enrollment_id) REFERENCES enrollments(id)
);

-- Add ClassIn related columns to enrollments
ALTER TABLE enrollments ADD COLUMN classin_join_url TEXT DEFAULT '';
ALTER TABLE enrollments ADD COLUMN classin_session_id INTEGER DEFAULT NULL;

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_classin_sessions_class ON classin_sessions(class_id);
CREATE INDEX IF NOT EXISTS idx_classin_sessions_user ON classin_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_classin_sessions_enrollment ON classin_sessions(enrollment_id);
