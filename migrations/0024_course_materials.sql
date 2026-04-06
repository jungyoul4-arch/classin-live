-- 코스 레벨 강의 자료 컬럼 추가
-- 기존 class_lessons.materials에서 classes.materials로 이동
ALTER TABLE classes ADD COLUMN materials TEXT DEFAULT '[]';
