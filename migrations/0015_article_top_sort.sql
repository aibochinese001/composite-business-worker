-- 0015: 文章置顶 + 排序
-- 与 courses(is_top/sticky_order)、products(is_featured/sort_order) 对齐，文章支持置顶 + 手动排序
-- 置顶 is_top=1 排最前；同置顶状态下 sort_order 数字越小越靠前（与 products 一致）

ALTER TABLE articles ADD COLUMN is_top INTEGER DEFAULT 0;
ALTER TABLE articles ADD COLUMN sort_order INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_articles_top ON articles(is_top, sort_order);
