-- 0006: 用户收货地址簿（多地址 + 默认地址）
CREATE TABLE IF NOT EXISTS user_addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  country TEXT DEFAULT '',
  province TEXT DEFAULT '',
  city TEXT DEFAULT '',
  detail TEXT NOT NULL,
  zip TEXT DEFAULT '',
  is_default INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_user_addresses_user ON user_addresses(user_id);
