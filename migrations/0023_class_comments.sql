-- Q&A 게시판 (수업별 질문/답변)
CREATE TABLE IF NOT EXISTS class_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  parent_id INTEGER REFERENCES class_comments(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  is_instructor INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_class_comments_class ON class_comments(class_id, created_at DESC);
CREATE INDEX idx_class_comments_parent ON class_comments(parent_id);
