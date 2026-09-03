-- 商品简短描述
ALTER TABLE products ADD COLUMN short_description TEXT DEFAULT '';

-- 商品评论/评价
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  user_name TEXT DEFAULT '',
  user_email TEXT DEFAULT '',
  rating INTEGER DEFAULT 5,
  content TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  reply TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_product ON comments(product_id);
CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status);

-- 购物车
CREATE TABLE IF NOT EXISTS cart_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_cart_user ON cart_items(user_id);
