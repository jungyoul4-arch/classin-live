-- Add ClassIn UID to instructors table
-- 강사도 ClassIn API register로 UID를 받아 저장

ALTER TABLE instructors ADD COLUMN classin_uid TEXT DEFAULT '';
ALTER TABLE instructors ADD COLUMN classin_registered_at DATETIME DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_instructors_classin_uid ON instructors(classin_uid);
