-- 0007: 文章单独购买记录
-- 付费文章支持"单独购买"（区别于订阅会员），购买后可读
CREATE TABLE IF NOT EXISTS article_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  order_no TEXT DEFAULT '',
  amount REAL DEFAULT 0,
  status TEXT DEFAULT 'paid',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_article_purchases_user ON article_purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_article_purchases_article ON article_purchases(article_id);
