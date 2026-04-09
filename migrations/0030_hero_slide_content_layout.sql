-- 히어로 슬라이드 콘텐츠 레이아웃 (텍스트/버튼 자유 배치 좌표)
-- JSON 형식: {"text":{"x":5,"y":30},"btn":{"x":5,"y":75}}
ALTER TABLE hero_slides ADD COLUMN content_layout TEXT NOT NULL DEFAULT '{"text":{"x":5,"y":30},"btn":{"x":5,"y":75}}';
