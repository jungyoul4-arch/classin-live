-- 기존 수업 데이터를 class_lessons로 마이그레이션
-- classes 테이블의 기존 수업 정보 + classin_sessions의 다시보기 URL

INSERT INTO class_lessons (class_id, lesson_number, lesson_title, classin_course_id, classin_class_id,
                           classin_instructor_url, scheduled_at, duration_minutes, status, replay_url)
SELECT
  c.id as class_id,
  1 as lesson_number,
  c.title || ' #1' as lesson_title,
  c.classin_course_id,
  c.classin_class_id,
  c.classin_instructor_url,
  COALESCE(c.classin_scheduled_at, c.schedule_start, datetime('now')) as scheduled_at,
  COALESCE(c.duration_minutes, 60) as duration_minutes,
  'ended' as status,
  (SELECT cs.classin_live_url FROM classin_sessions cs
   WHERE cs.class_id = c.id AND cs.classin_live_url IS NOT NULL AND cs.classin_live_url != ''
   ORDER BY cs.id DESC LIMIT 1) as replay_url
FROM classes c
WHERE c.classin_class_id IS NOT NULL
  AND c.classin_class_id != ''
  AND NOT EXISTS (SELECT 1 FROM class_lessons cl WHERE cl.class_id = c.id AND cl.classin_class_id = c.classin_class_id);

-- classes 테이블의 lesson_count 업데이트
UPDATE classes SET lesson_count = (
  SELECT COUNT(*) FROM class_lessons WHERE class_lessons.class_id = classes.id
) WHERE classin_class_id IS NOT NULL AND classin_class_id != '';
