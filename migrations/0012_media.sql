-- 0012: 媒体库 (media library)
-- 记录后台通过 /api/admin/upload 上传到 R2 的每个文件元数据，
-- 供「媒体库」页面列表、筛选、搜索/分页/删除使用。
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,          -- R2 对象 key，如 uploads/169...-abcd12.png
  filename TEXT NOT NULL DEFAULT '', -- 原始文件名
  ext TEXT NOT NULL DEFAULT '',      -- 小写扩展名（不含点）
  content_type TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,   -- 字节
  url TEXT NOT NULL DEFAULT '',      -- /media/<key>
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_media_ext ON media(ext);
CREATE INDEX IF NOT EXISTS idx_media_created ON media(id DESC);
