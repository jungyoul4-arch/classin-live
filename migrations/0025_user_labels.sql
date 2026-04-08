-- 회원 라벨 시스템
CREATE TABLE user_labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  color TEXT DEFAULT 'blue',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_label_assignments (
  user_id INTEGER NOT NULL,
  label_id INTEGER NOT NULL,
  assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, label_id)
);

INSERT INTO user_labels (name, display_name, color) VALUES ('parent', '학부모', 'blue');
