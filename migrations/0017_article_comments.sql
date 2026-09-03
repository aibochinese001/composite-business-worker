-- 文章评论支持（复用 comments 表）
-- 文章评论：product_id=0, article_id=文章ID；商品评论：article_id=0, product_id=商品ID
ALTER TABLE comments ADD COLUMN article_id INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_comments_article ON comments(article_id);
