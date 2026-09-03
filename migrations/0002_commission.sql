-- 0002: 共创计划 (邀请返佣 + 提现)

CREATE TABLE IF NOT EXISTS commissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inviter_id INTEGER NOT NULL,
  invitee_id INTEGER NOT NULL,
  order_id INTEGER DEFAULT NULL,
  order_no TEXT DEFAULT '',
  amount TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_commissions_inviter ON commissions(inviter_id);
CREATE INDEX IF NOT EXISTS idx_commissions_invitee ON commissions(invitee_id);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount TEXT NOT NULL,
  method TEXT NOT NULL,
  account TEXT NOT NULL,
  account_name TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  reject_reason TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  processed_at TEXT DEFAULT NULL,
  processed_by INTEGER DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);

-- 用户提现账户
ALTER TABLE users ADD COLUMN withdraw_name TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN withdraw_wechat TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN withdraw_alipay TEXT DEFAULT '';

-- 返佣比例设置（百分比，默认 20%）
INSERT OR IGNORE INTO settings (key, value) VALUES ('commission_rate', '20');
