-- Enrollment-based virtual account assignment
-- 수강 시 가상 계정 할당, 수강 종료 시 반납

-- Add status and expiration tracking to enrollments
ALTER TABLE enrollments ADD COLUMN status TEXT DEFAULT 'active';
ALTER TABLE enrollments ADD COLUMN expires_at DATETIME DEFAULT NULL;
ALTER TABLE enrollments ADD COLUMN updated_at DATETIME DEFAULT NULL;

-- Add virtual account reference to enrollments
ALTER TABLE enrollments ADD COLUMN classin_account_uid TEXT DEFAULT '';
ALTER TABLE enrollments ADD COLUMN classin_account_password TEXT DEFAULT '';
ALTER TABLE enrollments ADD COLUMN classin_assigned_at DATETIME DEFAULT NULL;
ALTER TABLE enrollments ADD COLUMN classin_returned_at DATETIME DEFAULT NULL;

-- Indexes for finding enrollments
CREATE INDEX IF NOT EXISTS idx_enrollments_classin_account ON enrollments(classin_account_uid);
CREATE INDEX IF NOT EXISTS idx_enrollments_status ON enrollments(status);
CREATE INDEX IF NOT EXISTS idx_enrollments_expires_at ON enrollments(expires_at);
