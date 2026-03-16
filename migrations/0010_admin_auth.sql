-- Admin authentication settings
CREATE TABLE IF NOT EXISTS admin_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  setting_key TEXT UNIQUE NOT NULL,
  setting_value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Admin sessions
CREATE TABLE IF NOT EXISTS admin_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_token TEXT UNIQUE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL
);

-- Insert default admin credentials (password will be hashed)
-- Default: admin / jungyoul1234
INSERT OR IGNORE INTO admin_settings (setting_key, setting_value) VALUES ('admin_username', 'admin');
INSERT OR IGNORE INTO admin_settings (setting_key, setting_value) VALUES ('admin_password_hash', 'jungyoul1234');

-- Index for session lookup
CREATE INDEX IF NOT EXISTS idx_admin_sessions_token ON admin_sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at);
