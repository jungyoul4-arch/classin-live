-- 라벨에 가격 대치 텍스트 필드 추가
-- 이 필드가 설정된 라벨이 코스에 부여되면, 코스 목록에서 가격 대신 해당 텍스트가 표시됨
ALTER TABLE user_labels ADD COLUMN price_text TEXT DEFAULT '';
