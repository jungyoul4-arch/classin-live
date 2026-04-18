-- Add class_ids column for bulk payments
ALTER TABLE orders ADD COLUMN class_ids TEXT DEFAULT NULL;
