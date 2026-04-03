-- 성능 최적화: 홈페이지 및 주요 쿼리용 인덱스 추가
-- is_bestseller: 홈페이지 베스트 코스 섹션 (매 페이지 로드마다 조회)
CREATE INDEX IF NOT EXISTS idx_classes_is_bestseller ON classes(is_bestseller);

-- is_new: 홈페이지 신규 코스 섹션
CREATE INDEX IF NOT EXISTS idx_classes_is_new ON classes(is_new);

-- status + class_type: 라이브 코스 필터링 (복합 인덱스)
CREATE INDEX IF NOT EXISTS idx_classes_status_type ON classes(status, class_type);

-- orders.class_id: 관리자 결제 관리 JOIN
CREATE INDEX IF NOT EXISTS idx_orders_class_id ON orders(class_id);

-- homepage_sort_order: 홈페이지 섹션 정렬
CREATE INDEX IF NOT EXISTS idx_classes_homepage_sort ON classes(homepage_sort_order);
