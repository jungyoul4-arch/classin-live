-- Subscriptions table - 월간 자동결제(정기구독) 관리
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  -- 구독 대상: 'all' (전체 구독) 또는 class_id (개별 클래스 구독)
  plan_type TEXT NOT NULL CHECK(plan_type IN ('all_monthly', 'class_monthly')),
  class_id INTEGER DEFAULT NULL,
  -- 결제 정보
  amount INTEGER NOT NULL,
  payment_method TEXT DEFAULT 'card',
  card_last4 TEXT DEFAULT '',
  -- 결제 주기 정보
  billing_day INTEGER NOT NULL,
  -- 구독 상태
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'paused', 'cancelled', 'expired', 'payment_failed')),
  -- 날짜
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  current_period_start DATETIME DEFAULT CURRENT_TIMESTAMP,
  current_period_end DATETIME NOT NULL,
  next_billing_date DATETIME NOT NULL,
  cancelled_at DATETIME DEFAULT NULL,
  -- 결제 실패 추적
  failed_attempts INTEGER DEFAULT 0,
  last_payment_error TEXT DEFAULT '',
  -- Meta
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (class_id) REFERENCES classes(id)
);

-- 구독 결제 이력
CREATE TABLE IF NOT EXISTS subscription_payments (
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
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_next_billing ON subscriptions(next_billing_date);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_sub ON subscription_payments(subscription_id);
