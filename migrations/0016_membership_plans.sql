-- membership plans
CREATE TABLE IF NOT EXISTS membership_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  duration_type TEXT NOT NULL DEFAULT 'month',  -- day | month | year | forever
  duration_value INTEGER NOT NULL DEFAULT 1,     -- 天数/月数/年数；forever 忽略
  price REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  benefits TEXT DEFAULT '',                      -- 权益描述，换行分隔
  sort_order INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 注意：SQL 里\n 是字面反斜杠+n，必须用 char(10) 表示真实换行
INSERT OR IGNORE INTO membership_plans (key, name, duration_type, duration_value, price, currency, benefits, sort_order, status) VALUES
  ('monthly', '月度会员', 'month', 1, 29, 'USD', '解锁全部付费文章' || char(10) || '解锁全部付费课程' || char(10) || '免费获取虚拟商品', 1, 1),
  ('quarterly', '季度会员', 'month', 3, 69, 'USD', '解锁全部付费文章' || char(10) || '解锁全部付费课程' || char(10) || '免费获取虚拟商品', 2, 1),
  ('annual', '年度会员', 'year', 1, 199, 'USD', '解锁全部付费文章' || char(10) || '解锁全部付费课程' || char(10) || '免费获取虚拟商品' || char(10) || '专属客服支持', 3, 1);
