-- 대용량 파일 청크 업로드를 위한 테이블
CREATE TABLE IF NOT EXISTS chunked_uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  upload_id TEXT UNIQUE NOT NULL,
  filename TEXT NOT NULL,
  total_size INTEGER NOT NULL,
  total_chunks INTEGER NOT NULL,
  uploaded_chunks INTEGER DEFAULT 0,
  status TEXT DEFAULT 'uploading', -- uploading, merging, completed, failed
  stream_uid TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chunked_uploads_upload_id ON chunked_uploads(upload_id);
CREATE INDEX IF NOT EXISTS idx_chunked_uploads_status ON chunked_uploads(status);
