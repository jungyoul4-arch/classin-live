-- Add column to store the account (phone/email) used for ClassIn registration
ALTER TABLE instructors ADD COLUMN classin_registered_account TEXT DEFAULT '';
