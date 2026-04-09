-- 히어로 캐러셀 슬라이드 테이블
CREATE TABLE IF NOT EXISTS hero_slides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  badge_icon TEXT NOT NULL DEFAULT '',
  badge_text TEXT NOT NULL DEFAULT '',
  title_line1 TEXT NOT NULL DEFAULT '',
  title_line2 TEXT NOT NULL DEFAULT '',
  title_suffix TEXT NOT NULL DEFAULT '',
  title_gradient TEXT NOT NULL DEFAULT 'from-primary-400 to-pink-400',
  description TEXT NOT NULL DEFAULT '',
  button_text TEXT NOT NULL DEFAULT '',
  button_link TEXT NOT NULL DEFAULT '/categories',
  button_icon TEXT NOT NULL DEFAULT 'fas fa-play',
  button_color TEXT NOT NULL DEFAULT 'bg-primary-500 hover:bg-primary-600',
  button_text_color TEXT NOT NULL DEFAULT 'text-white',
  background_gradient TEXT NOT NULL DEFAULT 'linear-gradient(135deg, #1e293b 0%, #0f172a 50%, #1a1a2e 100%)',
  background_image TEXT,
  show_instructor_images INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 기존 하드코딩된 3개 슬라이드를 시드 데이터로 삽입
INSERT INTO hero_slides (sort_order, badge_icon, badge_text, title_line1, title_line2, title_suffix, title_gradient, description, button_text, button_link, button_icon, button_color, button_text_color, background_gradient, show_instructor_images) VALUES
(1, '', '실시간 라이브 양방향 코스', '당신의 성장을 위한', '라이브 양방향 코스', '가 시작됩니다', 'from-primary-400 to-pink-400', '검증된 전문 강사의 실시간 양방향 강의로 배우고, 직접 질문하고 소통하며 빠르게 성장하세요.', '코스 둘러보기', '/categories', 'fas fa-play', 'bg-primary-500 hover:bg-primary-600', 'text-white', 'linear-gradient(135deg, #1e293b 0%, #0f172a 50%, #1a1a2e 100%)', 1),
(2, 'fas fa-chalkboard-teacher text-yellow-400', '검증된 전문 강사진', '각 분야 최고의 전문가와', '함께 성장', '하세요', 'from-yellow-300 to-orange-400', '현직 전문가들의 실무 노하우를 라이브로 직접 배우고, 실시간 Q&A로 궁금한 점을 바로 해결하세요.', '강사진 보기', '/categories', 'fas fa-users', 'bg-yellow-500 hover:bg-yellow-600', 'text-gray-900', 'linear-gradient(135deg, hsl(235,55%,35%) 0%, hsl(255,45%,20%) 100%)', 0),
(3, 'fas fa-comments text-emerald-400', '실시간 양방향 소통', '일방적인 강의는 그만!', '실시간 소통', '으로 배우세요', 'from-emerald-300 to-teal-400', '라이브 수업 중 직접 질문하고, 강사와 즉시 소통하며 나만의 맞춤 학습을 경험하세요.', '라이브 수업 보기', '/categories?type=live', 'fas fa-video', 'bg-emerald-500 hover:bg-emerald-600', 'text-white', 'linear-gradient(135deg, hsl(160,50%,30%) 0%, hsl(180,45%,18%) 100%)', 0);
