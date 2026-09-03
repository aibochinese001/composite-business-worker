-- 0005: 独立课程 + 独立商品（实物/虚拟）+ 商品订单（地址/物流）
-- 课程/商品从 articles 独立出来，参照独立课程/商品模型

-- 1. 课程表
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  cover_image TEXT DEFAULT '',
  intro TEXT DEFAULT '',
  access_type TEXT DEFAULT 'public',
  price REAL DEFAULT 0,
  status INTEGER DEFAULT 1,
  is_top INTEGER DEFAULT 0,
  sticky_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_courses_status ON courses(status);

-- 2. 课程购买记录
CREATE TABLE IF NOT EXISTS course_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  order_no TEXT DEFAULT '',
  amount REAL DEFAULT 0,
  status TEXT DEFAULT 'paid',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_course_purchases_user ON course_purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_course_purchases_course ON course_purchases(course_id);

-- 3. 商品表
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category_id INTEGER DEFAULT 0,
  type TEXT DEFAULT 'physical',
  price REAL DEFAULT 0,
  sale_price REAL DEFAULT 0,
  stock INTEGER DEFAULT 0,
  cover TEXT DEFAULT '',
  images TEXT DEFAULT '[]',
  description TEXT DEFAULT '',
  is_featured INTEGER DEFAULT 0,
  is_hot INTEGER DEFAULT 0,
  status INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  file_url TEXT DEFAULT '',
  file_name TEXT DEFAULT '',
  file_size INTEGER DEFAULT 0,
  hidden_content TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_products_type ON products(type);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);

-- 4. 商品订单（含地址快照 + 物流）
CREATE TABLE IF NOT EXISTS product_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  product_name TEXT DEFAULT '',
  product_image TEXT DEFAULT '',
  product_type TEXT DEFAULT 'physical',
  quantity INTEGER DEFAULT 1,
  unit_price REAL DEFAULT 0,
  total_amount REAL DEFAULT 0,
  status TEXT DEFAULT 'pending',
  payment_method TEXT DEFAULT '',
  trade_no TEXT DEFAULT '',
  address_name TEXT DEFAULT '',
  address_phone TEXT DEFAULT '',
  address_country TEXT DEFAULT '',
  address_province TEXT DEFAULT '',
  address_city TEXT DEFAULT '',
  address_detail TEXT DEFAULT '',
  address_zip TEXT DEFAULT '',
  tracking_no TEXT DEFAULT '',
  tracking_company TEXT DEFAULT '',
  remark TEXT DEFAULT '',
  paid_at TEXT DEFAULT NULL,
  shipped_at TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_product_orders_user ON product_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_product_orders_status ON product_orders(status);
CREATE INDEX IF NOT EXISTS idx_product_orders_product ON product_orders(product_id);

-- 清理旧的 articles 型课程/商品测试数据（课程/商品已独立成表）
DELETE FROM course_videos;
DELETE FROM course_chapters;
DROP TABLE IF EXISTS item_purchases;
