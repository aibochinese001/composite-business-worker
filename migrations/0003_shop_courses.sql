-- 0003: 统一内容模型 — 课程 + 商城
-- 复用 articles/categories，加 type 区分内容板块，加 price 用于课程/商品定价

ALTER TABLE categories ADD COLUMN type TEXT DEFAULT 'article';
ALTER TABLE articles ADD COLUMN type TEXT DEFAULT 'article';
ALTER TABLE articles ADD COLUMN price REAL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_articles_type ON articles(type);
CREATE INDEX IF NOT EXISTS idx_categories_type ON categories(type);
