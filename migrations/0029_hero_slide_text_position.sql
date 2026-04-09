-- 히어로 슬라이드 텍스트 위치 지정 컬럼 추가
ALTER TABLE hero_slides ADD COLUMN text_position TEXT NOT NULL DEFAULT 'left center';
