-- initial schema

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT DEFAULT '',
  role TEXT DEFAULT 'user',
  email_verified INTEGER DEFAULT 0,
  verify_token TEXT DEFAULT '',
  invite_code TEXT UNIQUE NOT NULL,
  invited_by INTEGER DEFAULT NULL,
  membership_tier TEXT DEFAULT '',
  membership_expires_at TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  slug TEXT UNIQUE,
  category_id INTEGER DEFAULT NULL,
  content TEXT DEFAULT '',
  excerpt TEXT DEFAULT '',
  cover_image TEXT DEFAULT '',
  access_type TEXT DEFAULT 'public',
  status TEXT DEFAULT 'draft',
  author_id INTEGER DEFAULT NULL,
  view_count INTEGER DEFAULT 0,
  published_at TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status);
CREATE INDEX IF NOT EXISTS idx_articles_category ON articles(category_id);

CREATE TABLE IF NOT EXISTS payment_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT UNIQUE NOT NULL,
  user_id INTEGER DEFAULT NULL,
  amount REAL DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  plan TEXT DEFAULT '',
  payment_method TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  trade_no TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  paid_at TEXT DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_user ON payment_orders(user_id);

CREATE TABLE IF NOT EXISTS invite_tracking (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inviter_id INTEGER DEFAULT NULL,
  invitee_id INTEGER DEFAULT NULL,
  invite_code TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email TEXT DEFAULT '',
  subject TEXT DEFAULT '',
  type TEXT DEFAULT '',
  status TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Default settings
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('site_name', '财经资讯站'),
  ('site_tagline', '私递值钱的知识和信息'),
  ('site_slogan', '关注强支撑的资产，研究最伟大的公司，做永不亏钱的投资！'),
  ('sender_email', 'noreply@example.com'),
  ('sender_name', '财经资讯站'),
  ('epay_api_url', ''),
  ('epay_pid', ''),
  ('epay_key', ''),
  ('stripe_secret_key', ''),
  ('stripe_publishable_key', ''),
  ('stripe_enabled', '0'),
  ('plan_monthly_price', '29'),
  ('plan_quarterly_price', '69'),
  ('plan_annual_price', '199'),
  ('plan_monthly_label', '月度会员'),
  ('plan_quarterly_label', '季度会员'),
  ('plan_annual_label', '年度会员'),
  ('currency', 'USD');

-- Seed default category
INSERT OR IGNORE INTO categories (name, slug, description, sort_order) VALUES
  ('投资研究', 'investment-research', '研究最伟大的公司', 1),
  ('资产配置', 'asset-allocation', '关注强支撑的资产', 2),
  ('市场洞察', 'market-insight', '市场前沿与机会', 3);
