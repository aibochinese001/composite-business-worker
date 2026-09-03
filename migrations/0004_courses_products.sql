-- 0004: 分章节视频课程 + 商品/课程单品购买

-- 课程章节 (course_id → articles.id, type='course')
CREATE TABLE IF NOT EXISTS course_chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chapters_course ON course_chapters(course_id);

-- 课程视频
CREATE TABLE IF NOT EXISTS course_videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  video_type TEXT DEFAULT 'direct',
  video_url TEXT NOT NULL,
  is_free INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_videos_chapter ON course_videos(chapter_id);

-- 单品购买记录 (课程/商品, 区别于会员订阅)
CREATE TABLE IF NOT EXISTS item_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  order_no TEXT DEFAULT '',
  amount REAL DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  status TEXT DEFAULT 'paid',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_item_purchases_user ON item_purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_item_purchases_item ON item_purchases(item_id);

-- payment_orders 扩展：单品订购
ALTER TABLE payment_orders ADD COLUMN item_id INTEGER DEFAULT NULL;
ALTER TABLE payment_orders ADD COLUMN item_type TEXT DEFAULT '';
