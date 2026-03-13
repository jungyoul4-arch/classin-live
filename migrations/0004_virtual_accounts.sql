-- ClassIn Virtual Accounts Management

-- Virtual accounts table - 클래스인 가상 계정 관리
CREATE TABLE IF NOT EXISTS classin_virtual_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- ClassIn virtual account info
  account_uid TEXT NOT NULL UNIQUE,           -- 예: 0065-20000532100
  account_password TEXT DEFAULT '',            -- 기본 비밀번호
  -- Registration info
  sid TEXT NOT NULL,                           -- School ID (67411940)
  is_registered BOOLEAN DEFAULT 0,             -- ClassIn API에 등록됨 여부
  registered_at DATETIME DEFAULT NULL,
  -- Assignment info
  user_id INTEGER DEFAULT NULL,                -- 연결된 플랫폼 사용자
  assigned_at DATETIME DEFAULT NULL,
  assigned_name TEXT DEFAULT '',               -- 등록 시 사용한 이름
  -- Status: available, assigned, expired, error
  status TEXT DEFAULT 'available' CHECK(status IN ('available', 'assigned', 'expired', 'error')),
  -- Meta
  expires_at DATETIME DEFAULT NULL,            -- 만료일
  error_message TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Add ClassIn account reference to users table
ALTER TABLE users ADD COLUMN classin_account_uid TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN classin_registered BOOLEAN DEFAULT 0;

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_virtual_accounts_status ON classin_virtual_accounts(status);
CREATE INDEX IF NOT EXISTS idx_virtual_accounts_user ON classin_virtual_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_virtual_accounts_uid ON classin_virtual_accounts(account_uid);
CREATE INDEX IF NOT EXISTS idx_users_classin_account ON users(classin_account_uid);
