#!/usr/bin/env node
/**
 * setup.mjs — 一键初始化 Cloudflare 资源（确定性脚本，适合人工或 AI Agent 直接执行）
 *
 * 做什么：
 *   1. 检查前置条件（CLOUDFLARE_API_TOKEN、wrangler 可用）
 *   2. 创建 D1 数据库（已存在则复用）并从输出中抓取 database_id
 *   3. 创建 R2 bucket（已存在则跳过）
 *   4. 把真实 database_id 回填进 wrangler.jsonc（替换占位符 REPLACE_WITH_D1_DATABASE_ID）
 *   5. 依序执行 migrations/*.sql（0001 → 0017）
 *   6. 生成并写入 SESSION_SECRET（wrangler secret put）
 *   7. 输出部署总结
 *
 * 用法：npm run setup
 * 环境：需要 CLOUDFLARE_API_TOKEN（或已登录 wrangler）
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CONFIG = join(ROOT, 'wrangler.jsonc');
const MIGRATIONS = join(ROOT, 'migrations');

const DB_NAME = 'm-opcgrow-db';
const R2_NAME = 'm-opcgrow-media';
const ID_PLACEHOLDER = 'REPLACE_WITH_D1_DATABASE_ID';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const RED = (s) => `\x1b[31m${s}\x1b[0m`;
const GREEN = (s) => `\x1b[32m${s}\x1b[0m`;
const YELLOW = (s) => `\x1b[33m${s}\x1b[0m`;
const CYAN = (s) => `\x1b[36m${s}\x1b[0m`;

function log(...a) { console.log(CYAN('[setup]'), ...a); }
function ok(...a) { console.log(GREEN('[ ok ]'), ...a); }
function warn(...a) { console.log(YELLOW('[warn]'), ...a); }
function fail(...a) { console.log(RED('[FAIL]'), ...a); }

/** 运行 wrangler 命令；shell:true 保证 Windows/Linux 都可用。返回 {status, stdout, stderr} */
function wrangler(args, { input, env } = {}) {
  const res = spawnSync('npx', ['wrangler', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    input,
    env: { ...process.env, CI: '1', WRANGLER_LOG: 'warn', ...env },
    timeout: 120_000,
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function firstUuid(text) {
  const m = text.match(UUID_RE);
  return m ? m[0] : null;
}

function checkPrereqs() {
  if (!process.env.CLOUDFLARE_API_TOKEN) {
    warn('未检测到 CLOUDFLARE_API_TOKEN，将尝试使用本机已有的 wrangler 登录态。');
    warn('建议显式设置：export CLOUDFLARE_API_TOKEN="cf_..."（权限见 AGENTS.md）');
  }
  const r = wrangler(['--version']);
  if (r.status !== 0) {
    fail('无法运行 wrangler。请先：npm install');
    process.exit(1);
  }
  ok('wrangler 可用：' + (r.stdout || r.stderr).trim().split('\n')[0]);
}

/** 确保 D1 存在，返回 database_id */
async function ensureD1() {
  // 1) 先查列表，看是否已存在
  const list = wrangler(['d1', 'list']);
  const listText = (list.stdout + list.stderr) || '';
  const line = listText.split('\n').find((l) => l.includes(DB_NAME));
  if (line) {
    const id = firstUuid(line);
    if (id) {
      ok(`D1 已存在：${DB_NAME} (${id})`);
      return id;
    }
    warn(`D1 列表中存在 ${DB_NAME}，但未能解析 ID，将尝试 create 输出。`);
  }
  // 2) 创建
  const r = wrangler(['d1', 'create', DB_NAME, '--non-interactive']);
  const text = (r.stdout + r.stderr) || '';
  const id = firstUuid(text);
  if (r.status === 0 && id) {
    ok(`D1 创建成功：${DB_NAME} (${id})`);
    return id;
  }
  // 3) 兜底：--non-interactive 不被支持时报错重试
  const r2 = wrangler(['d1', 'create', DB_NAME]);
  const text2 = (r2.stdout + r2.stderr) || '';
  const id2 = firstUuid(text2);
  if (r2.status === 0 && id2) {
    ok(`D1 创建成功：${DB_NAME} (${id2})`);
    return id2;
  }
  fail('创建 D1 失败，请检查 Token 是否包含 "D1 Edit" 权限。\n--- 输出 ---\n' + text + text2);
  process.exit(1);
}

/** 确保 R2 bucket 存在 */
async function ensureR2() {
  const list = wrangler(['r2', 'bucket', 'list']);
  const listText = (list.stdout + list.stderr) || '';
  if (listText.includes(R2_NAME)) {
    ok(`R2 bucket 已存在：${R2_NAME}`);
    return;
  }
  const r = wrangler(['r2', 'bucket', 'create', R2_NAME]);
  if (r.status === 0) {
    ok(`R2 bucket 创建成功：${R2_NAME}`);
    return;
  }
  const r2 = wrangler(['r2', 'bucket', 'create', R2_NAME, '--non-interactive']);
  if (r2.status === 0) {
    ok(`R2 bucket 创建成功：${R2_NAME}`);
    return;
  }
  fail('创建 R2 bucket 失败，请检查 Token 是否包含 "R2 Edit" 权限。\n--- 输出 ---\n' + (r.stdout + r.stderr) + (r2.stdout + r2.stderr));
  process.exit(1);
}

/** 把 database_id 回填进 wrangler.jsonc */
function injectDatabaseId(id) {
  if (!existsSync(CONFIG)) {
    fail(`找不到配置文件 ${CONFIG}`);
    process.exit(1);
  }
  let cfg = readFileSync(CONFIG, 'utf8');
  if (!cfg.includes(ID_PLACEHOLDER)) {
    warn('wrangler.jsonc 中未找到占位符（可能已被回填），跳过注入。');
    return;
  }
  cfg = cfg.replace(ID_PLACEHOLDER, id);
  writeFileSync(CONFIG, cfg, 'utf8');
  ok(`已把 database_id 写入 ${CONFIG}`);
}

/** 依序执行所有迁移 */
async function runMigrations(dbName) {
  if (!existsSync(MIGRATIONS)) {
    warn('没有 migrations 目录，跳过数据库迁移。');
    return;
  }
  const files = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  if (!files.length) {
    warn('migrations 目录为空，跳过迁移。');
    return;
  }
  log(`将依序执行 ${files.length} 个迁移脚本…`);
  for (const f of files) {
    const r = wrangler(['d1', 'execute', dbName, '--remote', '--file=' + join(MIGRATIONS, f)]);
    if (r.status !== 0) {
      fail(`迁移失败：${f}\n--- 输出 ---\n${r.stdout}\n${r.stderr}`);
      process.exit(1);
    }
    ok(`迁移完成：${f}`);
  }
}

/** 生成并写入 SESSION_SECRET */
async function setSecret() {
  const secret = randomBytes(32).toString('hex');
  const r = wrangler(['secret', 'put', 'SESSION_SECRET', '--non-interactive'], { input: secret + '\n' });
  if (r.status === 0) {
    ok('SESSION_SECRET 已写入（wrangler secret put）');
    return;
  }
  const r2 = wrangler(['secret', 'put', 'SESSION_SECRET'], { input: secret + '\n' });
  if (r2.status === 0) {
    ok('SESSION_SECRET 已写入（wrangler secret put）');
    return;
  }
  fail('写入 SESSION_SECRET 失败，请手动执行：echo "你的强随机值" | wrangler secret put SESSION_SECRET\n--- 输出 ---\n' + r.stdout + r.stderr + r2.stdout + r2.stderr);
  process.exit(1);
}

async function main() {
  console.log(CYAN('=============================================='));
  console.log(CYAN('  Composite Business System — Cloudflare Setup'));
  console.log(CYAN('=============================================='));
  checkPrereqs();

  log('步骤 1/4：D1 数据库');
  const d1Id = await ensureD1();

  log('步骤 2/4：R2 bucket');
  await ensureR2();

  log('步骤 3/4：回填 database_id + 执行迁移');
  injectDatabaseId(d1Id);
  await runMigrations(DB_NAME);

  log('步骤 4/4：写入 SESSION_SECRET');
  await setSecret();

  console.log(GREEN('=============================================='));
  console.log(GREEN('  ✅ 初始化完成，可以部署了：'));
  console.log(GREEN('     npm run deploy'));
  console.log(GREEN('=============================================='));
  console.log(CYAN('  部署后建议：'));
  console.log(CYAN('    1. 设置 BASE_URL 为你的域名：wrangler secret put BASE_URL'));
  console.log(CYAN('    2. 把 src/index.ts、src/render.ts、src/mcp.ts 的 SITE_URL 改为你的域名'));
  console.log(CYAN('    3. 首次登录后台创建管理员账号（见 AGENTS.md）'));
}

main().catch((e) => {
  fail('脚本异常：', e);
  process.exit(1);
});
