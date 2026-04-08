-- 코스 라벨 요구사항 (코스별 필수 라벨 매핑)
CREATE TABLE class_label_requirements (
  class_id INTEGER NOT NULL,
  label_id INTEGER NOT NULL,
  PRIMARY KEY (class_id, label_id)
);
