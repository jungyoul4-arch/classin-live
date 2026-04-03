-- Homepage sort order for admin-controlled course ordering
ALTER TABLE classes ADD COLUMN homepage_sort_order INTEGER DEFAULT 0;
