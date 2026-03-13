-- Test Accounts - 결제 없이 테스트할 수 있는 계정

-- Add test account flag to users table
ALTER TABLE users ADD COLUMN is_test_account BOOLEAN DEFAULT 0;
ALTER TABLE users ADD COLUMN test_expires_at DATETIME DEFAULT NULL;

-- Create test access codes table (for generating temporary test access)
CREATE TABLE IF NOT EXISTS test_access_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  max_uses INTEGER DEFAULT 1,
  used_count INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT 1,
  expires_at DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Insert default test access code
INSERT INTO test_access_codes (code, description, max_uses, is_active, expires_at)
VALUES ('CLASSIN-TEST-2024', '기본 테스트 코드', 100, 1, '2028-12-31 23:59:59');
