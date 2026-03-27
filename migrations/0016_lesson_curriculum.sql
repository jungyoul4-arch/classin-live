-- 회차별 커리큘럼 + 강의자료 첨부 기능
ALTER TABLE class_lessons ADD COLUMN description TEXT DEFAULT '';
ALTER TABLE class_lessons ADD COLUMN curriculum_items TEXT DEFAULT '[]';
ALTER TABLE class_lessons ADD COLUMN materials TEXT DEFAULT '[]';
