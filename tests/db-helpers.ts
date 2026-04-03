/**
 * Database test helpers for applying migrations and seed data
 * to a fresh D1 database instance in vitest.
 *
 * All SQL is embedded directly to avoid filesystem access issues
 * in the workerd runtime used by @cloudflare/vitest-pool-workers.
 */

/** Ordered list of all 20 migration file names */
export const MIGRATION_FILES = [
  "0001_initial_schema.sql",
  "0002_classin_integration.sql",
  "0003_subscriptions.sql",
  "0004_virtual_accounts.sql",
  "0005_test_accounts.sql",
  "0006_enrollment_virtual_account.sql",
  "0007_instructor_classin_uid.sql",
  "0008_class_classin_ids.sql",
  "0009_class_instructor_url.sql",
  "0010_admin_auth.sql",
  "0011_enrollment_subscription.sql",
  "0012_class_lessons.sql",
  "0013_migrate_existing_lessons.sql",
  "0014_lesson_enrollments.sql",
  "0015_recorded_lessons.sql",
  "0016_lesson_curriculum.sql",
  "0017_instructor_virtual_account.sql",
  "0018_chunked_uploads.sql",
  "0019_instructor_registered_account.sql",
  "0020_homepage_sort_order.sql",
] as const;

// ─── Embedded migration SQL ────────────────────────────────────────

const MIGRATION_SQL: Record<string, string[]> = {
  "0001_initial_schema.sql": [
    `CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  avatar TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  role TEXT DEFAULT 'student' CHECK(role IN ('student', 'instructor', 'admin')),
  subscription_plan TEXT DEFAULT NULL CHECK(subscription_plan IN (NULL, 'monthly', 'annual')),
  subscription_expires_at DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`,
    `CREATE TABLE IF NOT EXISTS instructors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  bio TEXT DEFAULT '',
  profile_image TEXT DEFAULT '',
  specialty TEXT DEFAULT '',
  total_students INTEGER DEFAULT 0,
  total_classes INTEGER DEFAULT 0,
  rating REAL DEFAULT 0.0,
  verified INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
)`,
    `CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  icon TEXT DEFAULT '',
  description TEXT DEFAULT '',
  parent_id INTEGER DEFAULT NULL,
  sort_order INTEGER DEFAULT 0,
  FOREIGN KEY (parent_id) REFERENCES categories(id)
)`,
    `CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  subtitle TEXT DEFAULT '',
  description TEXT NOT NULL,
  thumbnail TEXT DEFAULT '',
  preview_video TEXT DEFAULT '',
  instructor_id INTEGER NOT NULL,
  category_id INTEGER NOT NULL,
  level TEXT DEFAULT 'beginner' CHECK(level IN ('beginner', 'intermediate', 'advanced', 'all')),
  class_type TEXT DEFAULT 'live' CHECK(class_type IN ('live', 'recorded', 'hybrid')),
  price INTEGER NOT NULL DEFAULT 0,
  original_price INTEGER DEFAULT 0,
  discount_percent INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'KRW',
  duration_minutes INTEGER DEFAULT 0,
  total_lessons INTEGER DEFAULT 0,
  max_students INTEGER DEFAULT 0,
  current_students INTEGER DEFAULT 0,
  rating REAL DEFAULT 0.0,
  review_count INTEGER DEFAULT 0,
  is_bestseller INTEGER DEFAULT 0,
  is_new INTEGER DEFAULT 0,
  is_subscription INTEGER DEFAULT 1,
  status TEXT DEFAULT 'active' CHECK(status IN ('draft', 'active', 'archived')),
  schedule_start DATETIME DEFAULT NULL,
  schedule_end DATETIME DEFAULT NULL,
  tags TEXT DEFAULT '',
  what_you_learn TEXT DEFAULT '',
  requirements TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (instructor_id) REFERENCES instructors(id),
  FOREIGN KEY (category_id) REFERENCES categories(id)
)`,
    `CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL,
  chapter_title TEXT DEFAULT '',
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  duration_minutes INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  is_preview INTEGER DEFAULT 0,
  lesson_type TEXT DEFAULT 'video' CHECK(lesson_type IN ('video', 'live', 'assignment', 'quiz')),
  FOREIGN KEY (class_id) REFERENCES classes(id)
)`,
    `CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
  content TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (class_id) REFERENCES classes(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
)`,
    `CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  order_type TEXT NOT NULL CHECK(order_type IN ('class', 'subscription')),
  class_id INTEGER DEFAULT NULL,
  subscription_plan TEXT DEFAULT NULL,
  amount INTEGER NOT NULL,
  currency TEXT DEFAULT 'KRW',
  payment_method TEXT DEFAULT '',
  payment_status TEXT DEFAULT 'pending' CHECK(payment_status IN ('pending', 'completed', 'failed', 'refunded', 'cancelled')),
  card_last4 TEXT DEFAULT '',
  transaction_id TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (class_id) REFERENCES classes(id)
)`,
    `CREATE TABLE IF NOT EXISTS enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  class_id INTEGER NOT NULL,
  progress INTEGER DEFAULT 0,
  enrolled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME DEFAULT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (class_id) REFERENCES classes(id),
  UNIQUE(user_id, class_id)
)`,
    `CREATE TABLE IF NOT EXISTS wishlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  class_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (class_id) REFERENCES classes(id),
  UNIQUE(user_id, class_id)
)`,
    `CREATE TABLE IF NOT EXISTS cart (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  class_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (class_id) REFERENCES classes(id),
  UNIQUE(user_id, class_id)
)`,
    `CREATE INDEX IF NOT EXISTS idx_classes_category ON classes(category_id)`,
    `CREATE INDEX IF NOT EXISTS idx_classes_instructor ON classes(instructor_id)`,
    `CREATE INDEX IF NOT EXISTS idx_classes_status ON classes(status)`,
    `CREATE INDEX IF NOT EXISTS idx_reviews_class ON reviews(class_id)`,
    `CREATE INDEX IF NOT EXISTS idx_enrollments_user ON enrollments(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_wishlist_user ON wishlist(user_id)`,
  ],

  "0002_classin_integration.sql": [
    `CREATE TABLE IF NOT EXISTS classin_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL,
  enrollment_id INTEGER DEFAULT NULL,
  user_id INTEGER NOT NULL,
  classin_course_id TEXT DEFAULT '',
  classin_class_id TEXT DEFAULT '',
  classin_join_url TEXT DEFAULT '',
  classin_live_url TEXT DEFAULT '',
  session_title TEXT NOT NULL,
  instructor_name TEXT DEFAULT '',
  scheduled_at DATETIME NOT NULL,
  duration_minutes INTEGER DEFAULT 60,
  status TEXT DEFAULT 'ready' CHECK(status IN ('pending', 'ready', 'live', 'ended', 'cancelled')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME DEFAULT NULL,
  FOREIGN KEY (class_id) REFERENCES classes(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (enrollment_id) REFERENCES enrollments(id)
)`,
    `ALTER TABLE enrollments ADD COLUMN classin_join_url TEXT DEFAULT ''`,
    `ALTER TABLE enrollments ADD COLUMN classin_session_id INTEGER DEFAULT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_classin_sessions_class ON classin_sessions(class_id)`,
    `CREATE INDEX IF NOT EXISTS idx_classin_sessions_user ON classin_sessions(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_classin_sessions_enrollment ON classin_sessions(enrollment_id)`,
  ],

  "0003_subscriptions.sql": [
    `CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  plan_type TEXT NOT NULL CHECK(plan_type IN ('all_monthly', 'class_monthly')),
  class_id INTEGER DEFAULT NULL,
  amount INTEGER NOT NULL,
  payment_method TEXT DEFAULT 'card',
  card_last4 TEXT DEFAULT '',
  billing_day INTEGER NOT NULL,
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'paused', 'cancelled', 'expired', 'payment_failed')),
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  current_period_start DATETIME DEFAULT CURRENT_TIMESTAMP,
  current_period_end DATETIME NOT NULL,
  next_billing_date DATETIME NOT NULL,
  cancelled_at DATETIME DEFAULT NULL,
  failed_attempts INTEGER DEFAULT 0,
  last_payment_error TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (class_id) REFERENCES classes(id)
)`,
    `CREATE TABLE IF NOT EXISTS subscription_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  payment_status TEXT DEFAULT 'completed' CHECK(payment_status IN ('completed', 'failed', 'refunded')),
  transaction_id TEXT DEFAULT '',
  billing_period_start DATETIME NOT NULL,
  billing_period_end DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
)`,
    `CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status)`,
    `CREATE INDEX IF NOT EXISTS idx_subscriptions_next_billing ON subscriptions(next_billing_date)`,
    `CREATE INDEX IF NOT EXISTS idx_subscription_payments_sub ON subscription_payments(subscription_id)`,
  ],

  "0004_virtual_accounts.sql": [
    `CREATE TABLE IF NOT EXISTS classin_virtual_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_uid TEXT NOT NULL UNIQUE,
  account_password TEXT DEFAULT '',
  sid TEXT NOT NULL,
  is_registered BOOLEAN DEFAULT 0,
  registered_at DATETIME DEFAULT NULL,
  user_id INTEGER DEFAULT NULL,
  assigned_at DATETIME DEFAULT NULL,
  assigned_name TEXT DEFAULT '',
  status TEXT DEFAULT 'available' CHECK(status IN ('available', 'assigned', 'expired', 'error')),
  expires_at DATETIME DEFAULT NULL,
  error_message TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
)`,
    `ALTER TABLE users ADD COLUMN classin_account_uid TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN classin_registered BOOLEAN DEFAULT 0`,
    `CREATE INDEX IF NOT EXISTS idx_virtual_accounts_status ON classin_virtual_accounts(status)`,
    `CREATE INDEX IF NOT EXISTS idx_virtual_accounts_user ON classin_virtual_accounts(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_virtual_accounts_uid ON classin_virtual_accounts(account_uid)`,
    `CREATE INDEX IF NOT EXISTS idx_users_classin_account ON users(classin_account_uid)`,
  ],

  "0005_test_accounts.sql": [
    `ALTER TABLE users ADD COLUMN is_test_account BOOLEAN DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN test_expires_at DATETIME DEFAULT NULL`,
    `CREATE TABLE IF NOT EXISTS test_access_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  max_uses INTEGER DEFAULT 1,
  used_count INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT 1,
  expires_at DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`,
    `INSERT INTO test_access_codes (code, description, max_uses, is_active, expires_at) VALUES ('CLASSIN-TEST-2024', '기본 테스트 코드', 100, 1, '2028-12-31 23:59:59')`,
  ],

  "0006_enrollment_virtual_account.sql": [
    `ALTER TABLE enrollments ADD COLUMN status TEXT DEFAULT 'active'`,
    `ALTER TABLE enrollments ADD COLUMN expires_at DATETIME DEFAULT NULL`,
    `ALTER TABLE enrollments ADD COLUMN updated_at DATETIME DEFAULT NULL`,
    `ALTER TABLE enrollments ADD COLUMN classin_account_uid TEXT DEFAULT ''`,
    `ALTER TABLE enrollments ADD COLUMN classin_account_password TEXT DEFAULT ''`,
    `ALTER TABLE enrollments ADD COLUMN classin_assigned_at DATETIME DEFAULT NULL`,
    `ALTER TABLE enrollments ADD COLUMN classin_returned_at DATETIME DEFAULT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_enrollments_classin_account ON enrollments(classin_account_uid)`,
    `CREATE INDEX IF NOT EXISTS idx_enrollments_status ON enrollments(status)`,
    `CREATE INDEX IF NOT EXISTS idx_enrollments_expires_at ON enrollments(expires_at)`,
  ],

  "0007_instructor_classin_uid.sql": [
    `ALTER TABLE instructors ADD COLUMN classin_uid TEXT DEFAULT ''`,
    `ALTER TABLE instructors ADD COLUMN classin_registered_at DATETIME DEFAULT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_instructors_classin_uid ON instructors(classin_uid)`,
  ],

  "0008_class_classin_ids.sql": [
    `ALTER TABLE classes ADD COLUMN classin_course_id TEXT DEFAULT ''`,
    `ALTER TABLE classes ADD COLUMN classin_class_id TEXT DEFAULT ''`,
    `ALTER TABLE classes ADD COLUMN classin_created_at DATETIME DEFAULT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_classes_classin_course ON classes(classin_course_id)`,
  ],

  "0009_class_instructor_url.sql": [
    `ALTER TABLE classes ADD COLUMN classin_instructor_url TEXT DEFAULT ''`,
    `ALTER TABLE classes ADD COLUMN classin_status TEXT DEFAULT 'pending'`,
    `ALTER TABLE classes ADD COLUMN classin_scheduled_at DATETIME DEFAULT NULL`,
  ],

  "0010_admin_auth.sql": [
    `CREATE TABLE IF NOT EXISTS admin_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  setting_key TEXT UNIQUE NOT NULL,
  setting_value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`,
    `CREATE TABLE IF NOT EXISTS admin_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_token TEXT UNIQUE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL
)`,
    `INSERT OR IGNORE INTO admin_settings (setting_key, setting_value) VALUES ('admin_username', 'admin')`,
    `INSERT OR IGNORE INTO admin_settings (setting_key, setting_value) VALUES ('admin_password_hash', 'jungyoul1234')`,
    `CREATE INDEX IF NOT EXISTS idx_admin_sessions_token ON admin_sessions(session_token)`,
    `CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at)`,
  ],

  "0011_enrollment_subscription.sql": [
    `ALTER TABLE enrollments ADD COLUMN subscription_id INTEGER DEFAULT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_enrollments_subscription ON enrollments(subscription_id)`,
  ],

  "0012_class_lessons.sql": [
    `CREATE TABLE IF NOT EXISTS class_lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  lesson_number INTEGER NOT NULL DEFAULT 1,
  lesson_title TEXT NOT NULL,
  classin_course_id TEXT,
  classin_class_id TEXT,
  classin_instructor_url TEXT,
  scheduled_at DATETIME NOT NULL,
  duration_minutes INTEGER DEFAULT 60,
  status TEXT DEFAULT 'scheduled',
  replay_url TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`,
    `CREATE INDEX IF NOT EXISTS idx_class_lessons_class_id ON class_lessons(class_id)`,
    `CREATE INDEX IF NOT EXISTS idx_class_lessons_status ON class_lessons(status)`,
    `CREATE INDEX IF NOT EXISTS idx_class_lessons_scheduled ON class_lessons(scheduled_at)`,
    `ALTER TABLE classes ADD COLUMN lesson_count INTEGER DEFAULT 0`,
  ],

  "0013_migrate_existing_lessons.sql": [
    // Data migration - references existing data, runs as no-op on empty DB
    `INSERT OR IGNORE INTO class_lessons (class_id, lesson_number, lesson_title, classin_course_id, classin_class_id, classin_instructor_url, scheduled_at, duration_minutes, status, replay_url)
SELECT c.id as class_id, 1 as lesson_number, c.title || ' #1' as lesson_title, c.classin_course_id, c.classin_class_id, c.classin_instructor_url, COALESCE(c.classin_scheduled_at, c.schedule_start, datetime('now')) as scheduled_at, COALESCE(c.duration_minutes, 60) as duration_minutes, 'ended' as status, (SELECT cs.classin_live_url FROM classin_sessions cs WHERE cs.class_id = c.id AND cs.classin_live_url IS NOT NULL AND cs.classin_live_url != '' ORDER BY cs.id DESC LIMIT 1) as replay_url
FROM classes c WHERE c.classin_class_id IS NOT NULL AND c.classin_class_id != '' AND NOT EXISTS (SELECT 1 FROM class_lessons cl WHERE cl.class_id = c.id AND cl.classin_class_id = c.classin_class_id)`,
    `UPDATE classes SET lesson_count = (SELECT COUNT(*) FROM class_lessons WHERE class_lessons.class_id = classes.id) WHERE classin_class_id IS NOT NULL AND classin_class_id != ''`,
  ],

  "0014_lesson_enrollments.sql": [
    `CREATE TABLE IF NOT EXISTS lesson_enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  class_lesson_id INTEGER NOT NULL,
  payment_id INTEGER,
  enrolled_at TEXT DEFAULT (datetime('now')),
  status TEXT DEFAULT 'active',
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (class_lesson_id) REFERENCES class_lessons(id),
  FOREIGN KEY (payment_id) REFERENCES payments(id),
  UNIQUE (user_id, class_lesson_id)
)`,
    `CREATE INDEX IF NOT EXISTS idx_lesson_enrollments_user_id ON lesson_enrollments(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_lesson_enrollments_class_lesson_id ON lesson_enrollments(class_lesson_id)`,
  ],

  "0015_recorded_lessons.sql": [
    `ALTER TABLE class_lessons ADD COLUMN lesson_type TEXT DEFAULT 'live' CHECK(lesson_type IN ('live', 'recorded'))`,
    `ALTER TABLE class_lessons ADD COLUMN stream_uid TEXT`,
    `ALTER TABLE class_lessons ADD COLUMN stream_url TEXT`,
    `ALTER TABLE class_lessons ADD COLUMN stream_thumbnail TEXT`,
    `ALTER TABLE class_lessons ADD COLUMN price INTEGER DEFAULT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_class_lessons_lesson_type ON class_lessons(lesson_type)`,
    `CREATE INDEX IF NOT EXISTS idx_class_lessons_stream_uid ON class_lessons(stream_uid)`,
  ],

  "0016_lesson_curriculum.sql": [
    `ALTER TABLE class_lessons ADD COLUMN description TEXT DEFAULT ''`,
    `ALTER TABLE class_lessons ADD COLUMN curriculum_items TEXT DEFAULT '[]'`,
    `ALTER TABLE class_lessons ADD COLUMN materials TEXT DEFAULT '[]'`,
  ],

  "0017_instructor_virtual_account.sql": [
    `ALTER TABLE instructors ADD COLUMN classin_virtual_account TEXT DEFAULT ''`,
  ],

  "0018_chunked_uploads.sql": [
    `CREATE TABLE IF NOT EXISTS chunked_uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  upload_id TEXT UNIQUE NOT NULL,
  filename TEXT NOT NULL,
  total_size INTEGER NOT NULL,
  total_chunks INTEGER NOT NULL,
  uploaded_chunks INTEGER DEFAULT 0,
  status TEXT DEFAULT 'uploading',
  stream_uid TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
)`,
    `CREATE INDEX IF NOT EXISTS idx_chunked_uploads_upload_id ON chunked_uploads(upload_id)`,
    `CREATE INDEX IF NOT EXISTS idx_chunked_uploads_status ON chunked_uploads(status)`,
  ],

  "0019_instructor_registered_account.sql": [
    `ALTER TABLE instructors ADD COLUMN classin_registered_account TEXT DEFAULT ''`,
  ],

  "0020_homepage_sort_order.sql": [
    `ALTER TABLE classes ADD COLUMN homepage_sort_order INTEGER DEFAULT 0`,
  ],
};

// ─── Seed SQL statements ───────────────────────────────────────────

const SEED_SQL: string[] = [
  `INSERT OR IGNORE INTO users (id, email, password_hash, name, avatar, role) VALUES
(1, 'admin@classin.kr', 'pbkdf2_test1234', '관리자', '', 'admin'),
(2, 'park.sw@classin.kr', 'pbkdf2_test1234', '박서욱', '/static/instructors/park-sw.jpg', 'instructor'),
(3, 'lee.jh@classin.kr', 'pbkdf2_test1234', '이지후', '/static/instructors/lee-jh.jpg', 'instructor'),
(4, 'park.jy@classin.kr', 'pbkdf2_test1234', '박지영', '/static/instructors/park-jy.jpg', 'instructor'),
(5, 'cho.wj@classin.kr', 'pbkdf2_test1234', '조우제', '/static/instructors/cho-wj.jpg', 'instructor'),
(6, 'choi.hs@classin.kr', 'pbkdf2_test1234', '최희성', '/static/instructors/choi-hs.jpg', 'instructor'),
(7, 'kim.ds@classin.kr', 'pbkdf2_test1234', '김다슬', '/static/instructors/kim-ds.jpg', 'instructor'),
(8, 'student1@test.com', 'pbkdf2_test1234', '테스트학생', '', 'student'),
(9, 'yang.biz@classin.kr', 'pbkdf2_test1234', '양승현', 'https://api.dicebear.com/7.x/avataaars/svg?seed=yangsh', 'instructor'),
(10, 'shin.lang@classin.kr', 'pbkdf2_test1234', '신유리', 'https://api.dicebear.com/7.x/avataaars/svg?seed=shinyuri', 'instructor')`,

  `INSERT OR IGNORE INTO instructors (id, user_id, display_name, bio, profile_image, specialty, total_students, total_classes, rating, verified) VALUES
(1, 2, '박서욱', '사람은 쉽게 변한다. 국어 전문 강사로서 중등·고등 국어를 명쾌하게 풀어드립니다. 문학과 비문학 영역에서 핵심을 짚는 강의로 유명합니다.', '/static/instructors/park-sw.jpg', '국어 (중3·고1·고2)', 15200, 10, 4.9, 1),
(2, 3, '이지후', '러닝 퍼실리테이터. 학생 참여를 이끌어내는 양방향 국어 수업의 전문가. 쉽고 재미있는 국어 강의로 수강생 만족도가 높습니다.', '/static/instructors/lee-jh.jpg', '국어 (중3·고1·고2)', 12800, 8, 4.8, 1),
(3, 4, '박지영', '나와 너와 문제를 푸는 즐거움! 국어 비문학과 문법을 탄탄한 기초부터 심화까지 체계적으로 가르칩니다.', '/static/instructors/park-jy.jpg', '국어 (중3·고1·고2)', 11500, 7, 4.8, 1),
(4, 5, '조우제', '러닝 퍼실리테이터. 최상위권을 만드는 수학 전문가. 고2·고3 심화 수학과 수능 대비에 특화된 강의를 진행합니다.', '/static/instructors/cho-wj.jpg', '수학 (고2·고3)', 18700, 12, 4.9, 1),
(5, 6, '최희성', '수학, 문제를 바라보는 시선을 바꿔드립니다. 개념 이해부터 고난도 문제 풀이까지, 수학의 본질에 접근하는 강의를 합니다.', '/static/instructors/choi-hs.jpg', '수학', 16300, 9, 4.8, 1),
(6, 7, '김다슬', '중3·고1·고2 대상 수업을 진행하는 선생님. 꼼꼼한 커리큘럼과 학생 맞춤형 피드백으로 성적 향상을 이끌어냅니다.', '/static/instructors/kim-ds.jpg', '종합 (중3·고1·고2)', 13400, 8, 4.7, 1),
(7, 9, '양승현', '연매출 100억 쇼핑몰 대표. 실전 창업과 마케팅 노하우를 공유합니다.', 'https://api.dicebear.com/7.x/avataaars/svg?seed=yangsh', '비즈니스·마케팅', 11000, 6, 4.7, 1),
(8, 10, '신유리', 'JLPT N1, HSK 6급 보유. 10년간 다국어 강의 경험. 실생활에 바로 쓰는 외국어를 알려드립니다.', 'https://api.dicebear.com/7.x/avataaars/svg?seed=shinyuri', '외국어·어학', 14200, 9, 4.8, 1)`,

  `INSERT OR IGNORE INTO categories (id, name, slug, icon, description, sort_order) VALUES
(1, '국어', 'korean', 'fa-book', '문학, 비문학, 문법, 독서까지', 1),
(2, '수학', 'math', 'fa-square-root-variable', '기초 수학부터 수능 수학까지', 2),
(3, '영어', 'english', 'fa-language', '영어 내신, 수능, 회화까지', 3),
(4, '과학', 'science', 'fa-flask', '물리, 화학, 생명과학, 지구과학', 4),
(5, '사회', 'social', 'fa-globe', '한국사, 사회문화, 윤리, 지리', 5),
(6, '논술·면접', 'essay', 'fa-pen-fancy', '대입 논술, 면접 대비', 6),
(7, '코딩·IT', 'coding', 'fa-code', '프로그래밍, AI, 정보 교과', 7),
(8, '예체능', 'arts', 'fa-palette', '음악, 미술, 체육 실기', 8),
(9, '진로·진학', 'career', 'fa-graduation-cap', '진학 상담, 학습법, 자기소개서', 9),
(10, '자격증', 'certification', 'fa-certificate', '한국사능력검정, 컴활, 토익', 10)`,

  `INSERT OR IGNORE INTO classes (id, title, slug, subtitle, description, thumbnail, instructor_id, category_id, level, class_type, price, original_price, discount_percent, duration_minutes, total_lessons, max_students, current_students, rating, review_count, is_bestseller, is_new, is_subscription, schedule_start, tags, what_you_learn, requirements) VALUES
(1, '[국어] 박서욱의 내신 국어 완성 - 중3/고1/고2', 'park-sw-korean', '사람은 쉽게 변한다 - 국어 성적도 쉽게 변합니다', '박서욱 선생님의 체계적인 국어 강의입니다. 문학 작품 분석부터 비문학 독해 전략, 문법 핵심 정리까지 한 번에 정리해드립니다. 양방향 라이브 수업으로 모르는 부분은 바로 질문하고 해결하세요.', '/static/instructors/park-sw.jpg', 1, 1, 'all', 'live', 189000, 270000, 30, 120, 32, 40, 37, 4.9, 487, 1, 0, 1, '2026-03-01 19:00:00', '국어,내신,중3,고1,고2,문학,비문학', '현대시·소설 작품 분석법|비문학 독해 5단계 전략|문법 핵심 개념 총정리|서술형 답안 작성법', '해당 학년 교과서'),
(2, '[국어] 이지후의 양방향 국어 클래스 - 문학 마스터', 'lee-jh-korean-lit', '러닝 퍼실리테이터가 이끄는 참여형 국어 수업', '이지후 선생님의 양방향 국어 클래스입니다.', '/static/instructors/lee-jh.jpg', 2, 1, 'all', 'live', 169000, 240000, 30, 90, 24, 30, 28, 4.8, 356, 1, 0, 1, '2026-03-03 20:00:00', '국어,문학,양방향,참여형,토론', '작품별 핵심 주제 파악|갈래별 문학 감상법|실전 문제 풀이 전략|서술형·논술형 대비', '필기도구'),
(3, '[국어] 박지영의 비문학·문법 완전정복', 'park-jy-korean-grammar', '나와 너와 문제를 푸는 즐거움', '박지영 선생님과 함께하는 비문학·문법 전문 클래스입니다.', '/static/instructors/park-jy.jpg', 3, 1, 'intermediate', 'live', 159000, 220000, 28, 90, 28, 35, 31, 4.8, 298, 1, 0, 1, '2026-03-05 19:30:00', '국어,비문학,문법,독해,지문분석', '비문학 지문 구조 분석법|핵심 논지 빠르게 파악하기|국어 문법 핵심 50개 완성|오답률 높은 유형 집중 공략', '국어 기본 개념 학습 완료자'),
(4, '[수학] 조우제의 최상위권 수학 - 고2/고3', 'cho-wj-math-top', '최상위를 만드는 수학 러닝 퍼실리테이터', '조우제 선생님의 고등 심화 수학 클래스입니다.', '/static/instructors/cho-wj.jpg', 4, 2, 'advanced', 'live', 219000, 310000, 29, 120, 36, 30, 28, 4.9, 623, 1, 0, 1, '2026-03-02 20:00:00', '수학,고2,고3,수능,킬러문항,심화', '킬러 문항 유형별 풀이법|수학 사고력 확장 훈련|모의고사 실전 시간 관리|1등급 달성 로드맵', '수학 기본 개념 학습 완료'),
(5, '[수학] 최희성의 수학 개념 완성', 'choi-hs-math-concept', '수학, 문제를 바라보는 시선을 바꿔드립니다', '최희성 선생님의 수학 개념 완성 클래스입니다.', '/static/instructors/choi-hs.jpg', 5, 2, 'intermediate', 'live', 179000, 250000, 28, 100, 30, 35, 32, 4.8, 534, 1, 0, 1, '2026-03-04 19:00:00', '수학,개념,사고력,문제풀이,수능', '수학 핵심 개념 재정립|문제 해석 능력 강화|자주 출제되는 유형 완벽 정리|오답 분석 & 약점 보완 전략', '기본 수학 교과서'),
(6, '[종합] 김다슬 선생님의 맞춤형 학습 클래스', 'kim-ds-custom-class', '중3·고1·고2 맞춤형 커리큘럼', '김다슬 선생님의 맞춤형 학습 클래스입니다.', '/static/instructors/kim-ds.jpg', 6, 1, 'all', 'live', 149000, 210000, 29, 80, 20, 25, 22, 4.7, 267, 1, 1, 1, '2026-03-07 18:00:00', '종합,맞춤형,내신,수능,중3,고1,고2', '학생별 맞춤 학습 계획|내신 기출 분석 & 대비|취약 영역 집중 보강|학습 습관 & 시간 관리', '학습 목표 설정 필요'),
(7, '월 1000만원 스마트스토어 창업', 'smartstore-startup', '0원에서 시작하는 이커머스 창업기', '네이버 스마트스토어를 활용한 온라인 쇼핑몰 창업 과정입니다.', 'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=600&h=400&fit=crop', 7, 7, 'beginner', 'live', 129000, 180000, 28, 120, 30, 35, 33, 4.7, 456, 0, 0, 1, '2026-03-03 20:00:00', '창업,스마트스토어,이커머스,부업,마케팅', '스마트스토어 개설 & 세팅|상품 소싱 전략|SEO & 광고 마케팅|매출 1000만원 달성 로드맵', '노트북 또는 PC'),
(8, '비즈니스 일본어 JLPT N2 완성', 'business-japanese-n2', '3개월 만에 JLPT N2 합격하기', '실제 비즈니스 상황에서 사용하는 일본어를 중심으로 JLPT N2 합격까지 준비할 수 있는 과정입니다.', 'https://images.unsplash.com/photo-1528164344705-47542687000d?w=600&h=400&fit=crop', 8, 3, 'intermediate', 'live', 109000, 160000, 32, 90, 32, 25, 21, 4.8, 312, 0, 0, 1, '2026-03-12 19:00:00', '일본어,JLPT,비즈니스,회화,어학', 'JLPT N2 문법 & 어휘 완성|비즈니스 일본어 회화|면접 & 프레젠테이션 일본어|실전 모의시험 & 해설', 'JLPT N3 수준'),
(9, '[국어] 박서욱의 수능 국어 파이널', 'park-sw-korean-final', '수능 국어 실전 대비 파이널 특강', '수능 직전 실전 감각을 극대화하는 파이널 특강입니다.', '/static/instructors/park-sw.jpg', 1, 1, 'advanced', 'live', 199000, 280000, 29, 150, 40, 50, 45, 4.9, 421, 0, 1, 1, '2026-03-06 20:00:00', '국어,수능,파이널,실전,모의고사', '최근 3개년 수능 트렌드 분석|시간 배분 최적화 전략|고난도 문항 풀이법|실전 모의고사 3회', '국어 기본 개념 학습 완료'),
(10, '[수학] 조우제의 수능 수학 킬러 특강', 'cho-wj-math-killer', '킬러 문항을 정복하는 특별한 전략', '수능 수학 킬러 문항만을 집중적으로 다루는 특별 강의입니다.', '/static/instructors/cho-wj.jpg', 4, 2, 'advanced', 'live', 239000, 340000, 30, 120, 36, 30, 27, 4.9, 578, 0, 1, 1, '2026-03-08 19:00:00', '수학,수능,킬러,21번,30번,심화', '킬러 문항 출제 패턴 분석|유형별 최단시간 풀이법|실전 시뮬레이션 훈련|오답 분석 & 복습 시스템', '수학 심화 개념 학습 완료'),
(11, '[영어] 수능 영어 독해 마스터 클래스', 'english-reading-master', '빈칸추론부터 순서배열까지 완벽 대비', '수능 영어 독해의 핵심 유형을 집중적으로 다루는 클래스입니다.', 'https://images.unsplash.com/photo-1434030216411-0b793f4b4173?w=600&h=400&fit=crop', 8, 3, 'intermediate', 'live', 159000, 220000, 28, 90, 28, 35, 30, 4.8, 345, 0, 1, 1, '2026-03-10 20:00:00', '영어,수능,독해,빈칸추론,순서배열', '유형별 독해 전략 마스터|지문 구조 분석법|시간 단축 풀이 테크닉|실전 모의고사 풀이', '기본 영어 어휘력'),
(12, '[과학] 물리학 개념+실전 완성', 'physics-concept-master', '물리학의 핵심을 꿰뚫는 명강의', '물리학의 핵심 개념을 직관적으로 이해하고 실전 문제 풀이까지 연결하는 강의입니다.', 'https://images.unsplash.com/photo-1635070041078-e363dbe005cb?w=600&h=400&fit=crop', 5, 4, 'intermediate', 'live', 179000, 250000, 28, 100, 32, 30, 25, 4.8, 289, 0, 0, 1, '2026-03-15 19:00:00', '물리,과학,역학,수능,내신', '핵심 개념 직관적 이해|공식 유도 과정 완벽 이해|기출 문제 유형별 풀이|실전 모의고사 대비', '수학 기본 개념')`,

  `INSERT OR IGNORE INTO lessons (id, class_id, chapter_title, title, duration_minutes, sort_order, is_preview, lesson_type) VALUES
(1, 1, '문학 기초', '현대시 감상법 - 이미지와 화자 파악', 20, 1, 1, 'live'),
(2, 1, '문학 기초', '현대소설 서술 시점과 갈등 구조', 25, 2, 0, 'live'),
(3, 1, '문학 기초', '고전문학 핵심 작품 총정리', 25, 3, 0, 'live'),
(4, 1, '비문학 독해', '비문학 지문 구조 파악법', 20, 4, 1, 'live'),
(5, 1, '비문학 독해', '인문·사회 지문 독해 전략', 25, 5, 0, 'live'),
(6, 1, '비문학 독해', '과학·기술 지문 독해 전략', 25, 6, 0, 'live'),
(7, 1, '문법', '음운의 변동 핵심 정리', 20, 7, 0, 'live'),
(8, 1, '문법', '품사와 문장 성분 총정리', 20, 8, 0, 'live'),
(9, 4, '미적분 심화', '극한과 연속성 심화 문제', 25, 1, 1, 'live'),
(10, 4, '미적분 심화', '미분법 응용 - 킬러 유형 분석', 30, 2, 0, 'live'),
(11, 4, '미적분 심화', '적분법 응용 - 넓이와 부피', 30, 3, 0, 'live'),
(12, 4, '확률과 통계', '확률의 성질과 조건부 확률', 25, 4, 0, 'live'),
(13, 4, '확률과 통계', '이산확률분포와 연속확률분포', 25, 5, 0, 'live'),
(14, 4, '기하', '벡터의 연산과 내적', 25, 6, 1, 'live'),
(15, 4, '기하', '공간도형과 공간좌표', 30, 7, 0, 'live'),
(16, 4, '실전 모의', '킬러 문항 집중 훈련 (1회)', 30, 8, 0, 'live'),
(17, 4, '실전 모의', '킬러 문항 집중 훈련 (2회)', 30, 9, 0, 'live'),
(18, 5, '수와 식', '다항식의 연산과 나머지정리', 20, 1, 1, 'live'),
(19, 5, '수와 식', '인수분해와 항등식', 25, 2, 0, 'live'),
(20, 5, '방정식과 부등식', '이차방정식과 판별식 활용', 25, 3, 0, 'live'),
(21, 5, '방정식과 부등식', '부등식의 영역과 활용', 25, 4, 0, 'live'),
(22, 5, '함수', '함수의 개념과 합성·역함수', 25, 5, 0, 'live'),
(23, 5, '함수', '이차함수와 그래프 활용', 25, 6, 0, 'live'),
(24, 5, '수열', '등차·등비수열과 합', 25, 7, 0, 'live'),
(25, 5, '수열', '수학적 귀납법', 25, 8, 0, 'live')`,

  `INSERT OR IGNORE INTO reviews (id, class_id, user_id, rating, content, created_at) VALUES
(1, 1, 8, 5, '박서욱 선생님 국어 수업 듣고 내신 2등급에서 1등급으로 올랐습니다! 비문학 독해 전략이 정말 효과적이에요.', '2026-01-15 10:30:00'),
(2, 4, 8, 5, '조우제 선생님 킬러 문항 풀이가 정말 명쾌합니다. 수학 1등급 목표 달성할 수 있을 것 같아요!', '2026-01-20 14:20:00'),
(3, 5, 8, 5, '최희성 선생님 덕분에 수학 개념이 확실히 잡혔어요. 문제를 보는 시선이 완전히 달라졌습니다.', '2026-02-01 08:00:00'),
(4, 2, 8, 5, '이지후 선생님 양방향 수업이 정말 좋아요! 질문하면 바로 답해주시고, 참여형이라 집중이 잘 됩니다.', '2026-01-18 16:45:00'),
(5, 3, 8, 4, '박지영 선생님 비문학 수업 들은 후 국어 비문학에서 거의 안 틀려요. 문법도 쉽게 설명해주세요.', '2026-02-05 20:10:00'),
(6, 6, 8, 5, '김다슬 선생님 맞춤형 수업이 제 약점을 정확히 잡아주셨어요. 성적이 눈에 띄게 올랐습니다.', '2026-02-08 11:30:00'),
(7, 1, 8, 4, '라이브 수업이라 궁금한 거 바로 물어볼 수 있어서 좋아요. 녹화도 제공되니까 복습도 편합니다.', '2026-01-25 19:00:00'),
(8, 4, 8, 5, '고3 수학 킬러 문항이 두려웠는데, 조우제 선생님 강의 듣고 자신감이 생겼어요!', '2026-01-28 21:15:00')`,
];

// ─── Public API ────────────────────────────────────────────────────

/**
 * Apply all 20 migrations in order to the given D1 database.
 * Returns an array of results for each migration file.
 */
export async function applyAllMigrations(
  db: D1Database
): Promise<{ file: string; success: boolean; error?: string }[]> {
  const results: { file: string; success: boolean; error?: string }[] = [];

  for (const file of MIGRATION_FILES) {
    try {
      const statements = MIGRATION_SQL[file];
      if (!statements) {
        results.push({ file, success: false, error: `No SQL found for ${file}` });
        continue;
      }
      for (const stmt of statements) {
        // Collapse whitespace to a single line - D1's exec() in workerd
        // fails on multi-line SQL with "incomplete input" errors.
        const oneLine = stmt.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
        try {
          await db.exec(oneLine);
        } catch (stmtErr: unknown) {
          const msg = stmtErr instanceof Error ? stmtErr.message : String(stmtErr);
          // Ignore "duplicate column" errors (ALTER TABLE re-runs)
          // and "table already exists" errors (idempotent migrations)
          if (msg.includes('duplicate column name') || msg.includes('already exists') || msg.includes('UNIQUE constraint failed')) {
            continue;
          }
          throw stmtErr;
        }
      }
      results.push({ file, success: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ file, success: false, error: message });
    }
  }
  return results;
}

/**
 * Apply seed data after migrations.
 */
export async function applySeedData(
  db: D1Database
): Promise<{ success: boolean; error?: string }> {
  try {
    for (const stmt of SEED_SQL) {
      const oneLine = stmt.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
      await db.exec(oneLine);
    }
    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

/**
 * All tables expected after running all 20 migrations.
 */
export const EXPECTED_TABLES = [
  "users",
  "instructors",
  "categories",
  "classes",
  "lessons",
  "reviews",
  "orders",
  "enrollments",
  "wishlist",
  "cart",
  "classin_sessions",
  "subscriptions",
  "subscription_payments",
  "classin_virtual_accounts",
  "test_access_codes",
  "admin_settings",
  "admin_sessions",
  "class_lessons",
  "lesson_enrollments",
  "chunked_uploads",
] as const;

/**
 * Expected indexes created across all migrations.
 */
export const EXPECTED_INDEXES = [
  // 0001
  "idx_classes_category",
  "idx_classes_instructor",
  "idx_classes_status",
  "idx_reviews_class",
  "idx_enrollments_user",
  "idx_orders_user",
  "idx_wishlist_user",
  // 0002
  "idx_classin_sessions_class",
  "idx_classin_sessions_user",
  "idx_classin_sessions_enrollment",
  // 0003
  "idx_subscriptions_user",
  "idx_subscriptions_status",
  "idx_subscriptions_next_billing",
  "idx_subscription_payments_sub",
  // 0004
  "idx_virtual_accounts_status",
  "idx_virtual_accounts_user",
  "idx_virtual_accounts_uid",
  "idx_users_classin_account",
  // 0006
  "idx_enrollments_classin_account",
  "idx_enrollments_status",
  "idx_enrollments_expires_at",
  // 0007
  "idx_instructors_classin_uid",
  // 0008
  "idx_classes_classin_course",
  // 0010
  "idx_admin_sessions_token",
  "idx_admin_sessions_expires",
  // 0011
  "idx_enrollments_subscription",
  // 0012
  "idx_class_lessons_class_id",
  "idx_class_lessons_status",
  "idx_class_lessons_scheduled",
  // 0014
  "idx_lesson_enrollments_user_id",
  "idx_lesson_enrollments_class_lesson_id",
  // 0015
  "idx_class_lessons_lesson_type",
  "idx_class_lessons_stream_uid",
  // 0018
  "idx_chunked_uploads_upload_id",
  "idx_chunked_uploads_status",
] as const;
