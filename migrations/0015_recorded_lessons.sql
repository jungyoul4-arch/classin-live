-- 녹화 강의 지원을 위한 class_lessons 테이블 확장
-- lesson_type: live(라이브 강의) / recorded(녹화 강의)

-- 강의 유형 컬럼 추가
ALTER TABLE class_lessons ADD COLUMN lesson_type TEXT DEFAULT 'live'
  CHECK(lesson_type IN ('live', 'recorded'));

-- Cloudflare Stream 정보 (녹화 강의용)
ALTER TABLE class_lessons ADD COLUMN stream_uid TEXT;          -- Stream video UID
ALTER TABLE class_lessons ADD COLUMN stream_url TEXT;          -- HLS playback URL
ALTER TABLE class_lessons ADD COLUMN stream_thumbnail TEXT;    -- 썸네일 URL

-- 녹화 강의 가격 (개별 결제용, NULL이면 무료)
ALTER TABLE class_lessons ADD COLUMN price INTEGER DEFAULT NULL;

-- 인덱스 추가
CREATE INDEX IF NOT EXISTS idx_class_lessons_lesson_type ON class_lessons(lesson_type);
CREATE INDEX IF NOT EXISTS idx_class_lessons_stream_uid ON class_lessons(stream_uid);
