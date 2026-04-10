-- 히어로 슬라이드 아이템 테이블 (카드 모드용)
-- slide_items가 있으면 카드 모드 (레이아웃 자동 전환), 없으면 기존 배너 모드
-- 각 아이템이 독립적인 콘텐츠(제목/설명/이미지/링크)를 직접 보유
CREATE TABLE IF NOT EXISTS hero_slide_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slide_id INTEGER NOT NULL REFERENCES hero_slides(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'main',
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  thumbnail TEXT NOT NULL DEFAULT '',
  category_label TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
