-- 反馈表：一次提交一行。context_json 存诊断摘要，ip_hash 只用于限流，不存原始 IP。
CREATE TABLE IF NOT EXISTS feedback (
  id           TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  type         TEXT NOT NULL,           -- bug | feature | other
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  contact      TEXT,
  install_id   TEXT,
  app_version  TEXT,
  context_json TEXT,
  ip_hash      TEXT,
  status       TEXT DEFAULT 'new'       -- new | read | planned | done
);

CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_rate    ON feedback (ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_type    ON feedback (type, created_at DESC);
