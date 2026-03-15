-- Add instructor entry URL to classes table
-- 강사 입장 URL 및 수업 상태 저장

ALTER TABLE classes ADD COLUMN classin_instructor_url TEXT DEFAULT '';
ALTER TABLE classes ADD COLUMN classin_status TEXT DEFAULT 'pending';  -- pending, scheduled, live, ended
ALTER TABLE classes ADD COLUMN classin_scheduled_at DATETIME DEFAULT NULL;
