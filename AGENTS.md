# AGENTS.md — AI / 开发者部署指南

本文件面向**任何 Agent（或人）**自动化部署本 Worker。请严格按下面步骤照单执行，不要自由发挥；遇到报错先查「常见报错对照表」。

---

## 1. 项目速览

- **形态**：Cloudflare Workers 全栈应用（Hono + TypeScript），前端静态资源由 Workers Assets 提供，数据库为 D1，对象存储为 R2。
- **配置**：`wrangler.jsonc`（JSONC，支持注释）
- **部署目标**：默认部署到 `https://<worker-name>.<account>.workers.dev`（`workers_dev: true`，未绑定任何自定义域名）。
- **入口脚本**：`npm run setup`（一键创建资源并回填配置，见 `scripts/setup.mjs`）。

## 2. 前置条件

| 项目 | 要求 |
|---|---|
| Node.js | >= 20（本项目在 22 上验证） |
| npm | >= 9 |
| Cloudflare 账号 | 免费版即可 |
| API Token | 见下方「3. Token 权限清单」 |

## 3. Token 权限清单（CLOUDFLARE_API_TOKEN）

在 Cloudflare 控制台 → My Profile → API Tokens → Create Token，选 **Edit Cloudflare Workers** 模板，并按下表勾选（权限必须 ≥ 下表的粒度，否则 setup/deploy 会失败）：

| 权限 | 级别 | 资源范围 | 用于 |
|---|---|---|---|
| Workers Scripts | **Edit** | Account | `wrangler deploy` / `dev` |
| Workers KV Storage | **Edit** | Account | 关联 KV（本仓库当前未用，保留以防后续） |
| Workers AI | **Edit** | Account | AI 问答（未配置 AI key 时功能降级，不影响部署） |
| D1 | **Edit** | Account | `wrangler d1 create/execute` |
| R2 | **Edit** | Account | `wrangler r2 bucket create` |
| Account Settings | **Read** | Account | 校验账号信息（部分 wrangler 命令需要） |

> 也可以直接选模板 `Edit Cloudflare Workers` 后手动追加 D1/R2 权限。Token 创建后：
> ```bash
> export CLOUDFLARE_API_TOKEN="cf_YOUR_TOKEN_HERE"
> ```

## 4. 一键部署（推荐路径）

```bash
# 1) 安装依赖
npm install

# 2) 一键初始化：创建 D1/R2、抓取 database_id 回填 wrangler.jsonc、依序执行
#    migrations/*.sql、生成并写入 SESSION_SECRET
#    （要求 CLOUDFLARE_API_TOKEN 已设置，或本机已 wrangler login）
npm run setup

# 3) 本地验证（可选）
npm run dev        # 打开 http://localhost:8787

# 4) 部署到 workers.dev
npm run deploy

# 5) 确认上线
curl -s https://<your-worker>.<your-account>.workers.dev/api/health   # 若有该端点
curl -s -X POST https://<your-worker>.<your-account>.workers.dev/mcp/ \
  -H 'content-type: application/json' -d '{"jsonrpc":"2.0","method":"initialize","id":1}'
```

## 5. 手动步骤（等价于 npm run setup，排查时用）

```bash
# 创建 D1 并记录返回的 database_id
npx wrangler d1 create m-opcgrow-db
# 把输出的 UUID 填进 wrangler.jsonc 的 database_id（替换 REPLACE_WITH_D1_DATABASE_ID）

# 创建 R2 bucket
npx wrangler r2 bucket create m-opcgrow-media

# 依序执行所有迁移
for f in migrations/*.sql; do
  npx wrangler d1 execute m-opcgrow-db --remote --file="$f"
done

# 设置 JWT 密钥（强随机）
echo "$(openssl rand -hex 32)" | npx wrangler secret put SESSION_SECRET

# 部署
npx wrangler deploy
```

## 6. secrets 清单表

### 6.1 环境变量 / Worker secrets（通过 `wrangler secret put` 或本地 `.dev.vars`）

| 变量名 | 干什么用 | 哪里获取 | 必填 | 不填会怎样 |
|---|---|---|---|---|
| `SESSION_SECRET` | JWT 签名密钥（登录/会话安全） | 自生成 `openssl rand -hex 32` | ✅ 必填 | **安全风险**：回退到硬编码开发密钥，任何人可伪造登录态。**必须填** |
| `BASE_URL` | 站点基础 URL（邮件内链接、绝对地址） | 你的域名，如 `https://xxx.workers.dev` | ⚠️ 推荐 | 邮件/链接会用代码内 `SITE_URL` 占位符，链接指向占位域名 |

### 6.2 后台系统设置（D1 `settings` 表，登录后台 → 系统设置 填写，非环境变量）

| 设置 key | 干什么用 | 哪里获取 | 必填 | 不填会怎样 |
|---|---|---|---|---|
| `site_name` / `site_tagline` / `site_slogan` / `site_logo` / `site_favicon` | 站点品牌 | 自定 | 否 | 使用默认文案 |
| `sender_email` / `sender_name` | 发件邮箱/发件人 | 你的邮箱 | 仅邮件 | 邮件功能不可用，其余正常 |
| `resend_api_key` | 邮件发送（Resend HTTP API） | resend.com → API Keys（`re_` 开头） | 否 | 邮件功能降级，其余正常 |
| `epay_api_url` / `epay_pid` / `epay_key` | 易支付（微信/支付宝/USDT 收款） | 易支付商户后台 | 否 | 易支付通道不可用，可改用 Stripe |
| `stripe_secret_key` / `stripe_publishable_key` / `stripe_enabled` | Stripe 收款 | Stripe 控制台 | 否 | Stripe 通道不可用 |
| `ai_base_url` / `ai_model` / `ai_api_key` | AI 站内问答/检索 | OpenAI 兼容 API 服务商 | 否 | AI 问答功能降级，站点其余正常 |
| `commission_rate` | 邀请返佣比例（默认 20%） | 自定 | 否 | 使用默认 20% |
| `pay_methods` | 可用的支付方式 | 自定 | 否 | 默认 alipay,wxpay,usdt |

> 设计原则：除 `SESSION_SECRET` 外，所有密钥类配置缺失时**功能降级而非崩溃**——站点、文章、会员、商城照常运行。

## 7. 部署后自定义

1. **站点域名**：
   - 设置 `BASE_URL`：`echo "https://你的域名" | npx wrangler secret put BASE_URL`
   - 编辑 `src/index.ts`、`src/render.ts`、`src/mcp.ts` 中的 `SITE_URL` 常量（默认 `https://your-worker.workers.dev`），改为你的域名（影响文章/邀请/MCP 链接）。
   - 自定义域名：见 `wrangler.jsonc` 中注释掉的 `routes` 配置，或 Cloudflare 控制台 Worker → 设置 → 域名。
2. **创建管理员**：部署后访问 `/admin`，注册账号后需把 `users.role` 改为 `admin` 并 `email_verified=1`：
   ```bash
   npx wrangler d1 execute m-opcgrow-db --remote --command \
     "UPDATE users SET role='admin', email_verified=1 WHERE email='你的邮箱'"
   ```
3. **媒体图标**：`src/render.ts` 中社交/客服图标 URL 使用占位 CDN `https://your-cdn.example.com`，请替换为你的图床或删除。

## 8. 常见报错对照表

| 报错信息 | 原因 | 解决办法 |
|---|---|---|
| `Missing credentials` / `Authentication error` / `Could not find account` | 未登录或 Token 无效 | `export CLOUDFLARE_API_TOKEN="cf_..."` 或 `npx wrangler login` |
| `You do not have permission to perform this action` | Token 权限不够 | 回看第 3 节，补 D1/R2/Workers 的 Edit 权限 |
| `A database with the name ... already exists` | D1 已存在 | 复用现有 ID：`npx wrangler d1 list` 里找 ID 填进 wrangler.jsonc |
| `database_id` 未替换就 deploy | 忘跑 setup | `npm run setup` 或用 `npx wrangler d1 list` 回填 |
| `✘ [ERROR] Processing wrangler.jsonc: ... ` | wrangler.jsonc 语法错误 | 检查注释/引号是否合法 JSONC |
| 迁移执行报 `table X already exists` | 重复执行迁移 | migrations 均为幂等（IF NOT EXISTS / OR IGNORE），可安全重跑；若个别非幂等语句报错，跳过该文件即可 |
| `wrangler d1 execute` 很慢或超时 | 首次冷启动 / 网络 | 重试一次，或分段执行 |
| 部署后 404 | 未设置 `workers_dev` 或路由冲突 | 确认 wrangler.jsonc 有 `"workers_dev": true` |
| 登录/会话失效 | `SESSION_SECRET` 变更 | 重新设置并重启部署；已有登录态会失效属正常 |
| 邮件发不出 | `resend_api_key` / 发件域名未验证 | 到 Resend 后台验证发件域名 DKIM/SPF |

## 9. 对 Agent 的硬性提示

- **不要**向任何第三方暴露 `CLOUDFLARE_API_TOKEN`、`SESSION_SECRET`、支付密钥。
- **不要**提交 `.dev.vars`、`*.db`、`.wrangler/` 等（已在 `.gitignore` 覆盖）。
- 每次部署前，确认 `wrangler.jsonc` 中 `database_id` 不是 `REPLACE_WITH_D1_DATABASE_ID`。
- 本仓库是公开模板：不要把真实生产域名、真实数据库 ID、真实邮箱写进代码或提交。
