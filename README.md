# 复合业务系统 (Cloudflare Workers)

一个基于 Cloudflare Workers 的全栈财经资讯站点：支持文章、付费订阅会员、课程、商品商城、邀请返佣、MCP 公开接入等能力。单仓库、零服务器。

> 本仓库为开源模板。仓库内的数据库 ID、域名等均为占位符，首次部署请运行 `npm run setup` 自动创建并回填，详见 [AGENTS.md](./AGENTS.md) 的 AI 部署指南。

## ✨ 功能特性

- **内容体系**：文章（SEO 服务端渲染）/ 课程（分章节视频）/ 商品（实物+虚拟）/ 分类导航
- **商业化**：会员订阅（月度/季度/年度）、文章/课程/商品单品购买、邀请返佣与提现
- **支付**：易支付（微信/支付宝/USDT）+ Stripe（可选），后台可配置
- **账号体系**：PBKDF2 密码哈希、JWT 会话、邮箱验证、密码重置、多地址收货簿
- **AI 能力**：公开 MCP 端点（JSON-RPC）+ AI 站内问答/检索
- **运营后台**：文章/课程/商品/订单/媒体/广告/系统设置 一站式管理
- **基础设施**：D1 (SQLite) 数据库、R2 对象存储、Workers Assets 静态资源

## 🧱 技术栈

| 层 | 技术 |
|---|---|
| 运行时 | Cloudflare Workers (Hono + TypeScript) |
| 数据库 | D1 (SQLite) |
| 对象存储 | R2 |
| 静态资源 | Workers Assets (`./static`) |
| 会话 | JWT (HS256) |
| 邮件 | Resend (HTTP API，可选) |
| 密码 | PBKDF2 (SHA-256, 100000 次) |

## 📁 目录结构

```
src/
  index.ts   主路由（页面渲染 + API + 后台 + MCP）
  lib.ts     D1 查询/设置/MD5
  auth.ts    PBKDF2 密码 + JWT + cookie
  email.ts   邮件发送（Resend）
  epay.ts    易支付签名/下单
  mcp.ts     公开 MCP（JSON-RPC）
  render.ts  SEO 服务端渲染
migrations/  D1 schema（按编号顺序执行）
static/      前端（css + 登录/注册 + 后台 SPA + .well-known/mcp）
scripts/
  setup.mjs  一键初始化脚本（建 D1/R2、回填 ID、跑迁移、设密钥）
```

## 🚀 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 一键初始化（自动创建 D1/R2、回填 database_id、执行迁移、设置密钥）
npm run setup

# 3. 本地开发
npm run dev

# 4. 部署到 workers.dev（默认开启，不占用自定义域名）
npm run deploy
```

详细步骤、所需 Token 权限、常见报错对照表见 **[AGENTS.md](./AGENTS.md)**（AI 可直接照单执行）。

## 🔑 环境变量与密钥

| 变量 | 用途 | 必填 | 获取方式 |
|---|---|---|---|
| `SESSION_SECRET` | JWT 签名密钥 | ✅ | 自生成强随机值，`wrangler secret put SESSION_SECRET` |
| `BASE_URL` | 站点基础 URL（邮件链接等） | ⚠️ 推荐 | 你的域名，如 `https://xxx.workers.dev` |
| D1/R2 绑定 | `DB` / `MEDIA` | ✅ | `npm run setup` 自动配置 |

> 支付（易支付网关）、邮件（Resend）、AI 问答的密钥均存于**后台系统设置**（D1 settings 表），不填时对应功能优雅降级，不影响站点运行。完整清单见 [AGENTS.md](./AGENTS.md) 的「secrets 清单」。

## 🤖 MCP 接入（公开无鉴权）

- 端点：`POST /mcp/` (JSON-RPC 2.0)
- 发现：`GET /.well-known/mcp`
- 规则：公开内容返回全文；付费内容仅返回标题 + 链接，绝不暴露正文。

```bash
curl -X POST https://<your-worker>.workers.dev/mcp/ -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1}'
```

## ⚙️ 部署后自定义

- **站点名称/口号/Logo/导航**：后台「系统设置」配置（默认存于 D1 settings 表）
- **站点域名**：部署后设置 `BASE_URL`，并把 `src/index.ts`、`src/render.ts`、`src/mcp.ts` 里的 `SITE_URL` 常量（默认 `https://your-worker.workers.dev`）改为你的域名
- **自定义域名**：见 `wrangler.jsonc` 中注释的 `routes` 配置，或在 Cloudflare 控制台添加

## 🧾 License

MIT
