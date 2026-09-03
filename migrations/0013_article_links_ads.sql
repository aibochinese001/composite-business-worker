-- 0013: 文章关联内容 + 广告 (Adsense)

-- 文章关联内容：相关文章 / 关联课程 / 热门商品
CREATE TABLE IF NOT EXISTS article_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL,
  item_type TEXT NOT NULL,          -- 'article' | 'course' | 'product'
  item_id INTEGER NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_article_links_article ON article_links(article_id, item_type);

-- 广告（Adsense）：封面图片 + 标题 + 跳转链接，前端随机轮播
CREATE TABLE IF NOT EXISTS ads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL DEFAULT '',   -- 封面图片 URL
  url TEXT NOT NULL DEFAULT '',     -- 跳转链接（新标签页打开）
  status INTEGER NOT NULL DEFAULT 1, -- 1 启用 / 0 停用
  sort_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ads_status ON ads(status);
