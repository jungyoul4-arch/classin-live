-- Add ClassIn course and class IDs to classes table
-- 클래스별로 한 번만 생성된 ClassIn 코스/수업 ID 저장

ALTER TABLE classes ADD COLUMN classin_course_id TEXT DEFAULT '';
ALTER TABLE classes ADD COLUMN classin_class_id TEXT DEFAULT '';
ALTER TABLE classes ADD COLUMN classin_created_at DATETIME DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_classes_classin_course ON classes(classin_course_id);
