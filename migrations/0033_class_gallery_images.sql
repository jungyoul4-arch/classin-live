-- 강의 상세 페이지 상단 캐러셀용 갤러리 이미지 배열
-- JSON 배열 문자열로 저장 (예: '["https://.../1.jpg","https://.../2.jpg"]')
ALTER TABLE classes ADD COLUMN gallery_images TEXT DEFAULT '[]';
