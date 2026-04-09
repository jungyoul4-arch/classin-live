-- 히어로 슬라이드 이미지 위치 지정 컬럼 추가
ALTER TABLE hero_slides ADD COLUMN image_position TEXT NOT NULL DEFAULT 'center center';
