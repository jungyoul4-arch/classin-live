-- lesson_enrollments: 수업별 수강 권한 테이블
-- 학생이 개별 수업을 결제하면 이 테이블에 기록됨

CREATE TABLE IF NOT EXISTS lesson_enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  class_lesson_id INTEGER NOT NULL,
  payment_id INTEGER,
  enrolled_at TEXT DEFAULT (datetime('now')),
  status TEXT DEFAULT 'active', -- active, ended, cancelled
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (class_lesson_id) REFERENCES class_lessons(id),
  FOREIGN KEY (payment_id) REFERENCES payments(id),
  UNIQUE (user_id, class_lesson_id)
);

CREATE INDEX IF NOT EXISTS idx_lesson_enrollments_user_id ON lesson_enrollments(user_id);
CREATE INDEX IF NOT EXISTS idx_lesson_enrollments_class_lesson_id ON lesson_enrollments(class_lesson_id);
