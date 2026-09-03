-- Password reset / change support
ALTER TABLE users ADD COLUMN reset_token TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN reset_expires_at TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN pending_password_hash TEXT DEFAULT '';
