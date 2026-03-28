-- 강사에게 가상계정 할당 (ClassIn SMS 인증 없이 입장 가능)
ALTER TABLE instructors ADD COLUMN classin_virtual_account TEXT DEFAULT '';
