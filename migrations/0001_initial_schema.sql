-- Classes platform database schema

-- Users table
CREATE TABLE IF NOT EXISTS users (
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
);

-- Instructors table
CREATE TABLE IF NOT EXISTS instructors (
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
);

-- Categories table
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  icon TEXT DEFAULT '',
  description TEXT DEFAULT '',
  parent_id INTEGER DEFAULT NULL,
  sort_order INTEGER DEFAULT 0,
  FOREIGN KEY (parent_id) REFERENCES categories(id)
);

-- Classes table
CREATE TABLE IF NOT EXISTS classes (
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
);

-- Curriculum / Lessons table
CREATE TABLE IF NOT EXISTS lessons (
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
);

-- Reviews table
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
  content TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (class_id) REFERENCES classes(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Orders / Payments table
CREATE TABLE IF NOT EXISTS orders (
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
);

-- Enrollments table
CREATE TABLE IF NOT EXISTS enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  class_id INTEGER NOT NULL,
  progress INTEGER DEFAULT 0,
  enrolled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME DEFAULT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (class_id) REFERENCES classes(id),
  UNIQUE(user_id, class_id)
);

-- Wishlist / Favorites
CREATE TABLE IF NOT EXISTS wishlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  class_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (class_id) REFERENCES classes(id),
  UNIQUE(user_id, class_id)
);

-- Cart
CREATE TABLE IF NOT EXISTS cart (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  class_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (class_id) REFERENCES classes(id),
  UNIQUE(user_id, class_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_classes_category ON classes(category_id);
CREATE INDEX IF NOT EXISTS idx_classes_instructor ON classes(instructor_id);
CREATE INDEX IF NOT EXISTS idx_classes_status ON classes(status);
CREATE INDEX IF NOT EXISTS idx_reviews_class ON reviews(class_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_user ON enrollments(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_user ON wishlist(user_id);
