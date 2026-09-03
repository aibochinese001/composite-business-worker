-- 0014: 课程视频绑定相关文章
ALTER TABLE course_videos ADD COLUMN article_id INTEGER NOT NULL DEFAULT 0;
