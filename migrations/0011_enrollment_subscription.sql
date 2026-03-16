-- Link enrollments to subscriptions for tracking
-- 수강권이 구독에서 왔는지 추적

-- Add subscription_id to enrollments
ALTER TABLE enrollments ADD COLUMN subscription_id INTEGER DEFAULT NULL;

-- Index for finding subscription-based enrollments
CREATE INDEX IF NOT EXISTS idx_enrollments_subscription ON enrollments(subscription_id);
