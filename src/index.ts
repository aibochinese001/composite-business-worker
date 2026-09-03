import { Hono } from 'hono';
import type { Env } from './lib';
import { json, html, withCookie, first, query, run, getSetting, setSetting, randHex } from './lib';
import {
  hashPassword,
  verifyPassword,
  issueToken,
  verifyToken,
  genInviteCode,
  generateVerifyToken,
  authCookie,
  clearCookie,
  getCookie,
  currentUser,
  type JWTPayload,
} from './auth';
import { sendEmail, siteBase } from './email';
import { epaySign, buildOrderParams, normalizeApiUrl, verifyCallbackSign, type EpayConfig } from './epay';
import { handleMcp } from './mcp';
import { layout, renderHome, renderArticle, renderCategory, renderArticles, renderGrid, renderCourse, renderProduct, renderCart, renderAbout, renderHelper, renderAccountOverview, renderAccountPurchased, renderAccountAddresses, renderAccountInvite, renderAccountPassword, renderResetPassword, renderLogin, renderRegister, esc } from './render';

// TODO: 部署后把 SITE_URL 替换为你的站点域名（也可用 .dev.vars 的 BASE_URL 覆盖，见 AGENTS.md）
const SITE_URL = 'https://your-worker.workers.dev';

export const PAY_METHODS = [
  { key: 'alipay', label: '支付宝', type: 'alipay' },
  { key: 'wxpay', label: '微信', type: 'wxpay' },
  { key: 'usdt', label: 'USDT', type: 'usdt' },
  { key: 'stripe', label: 'Stripe', type: 'fiatstripe' },
];

export function methodType(key: string): string {
  const m = PAY_METHODS.find((m) => m.key === key);
  return m ? m.type : key;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

type AppEnv = { Bindings: Env; Variables: { user: JWTPayload } };
const app = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function siteInfo(env: Env) {
  return {
    siteName: await getSetting(env.DB, 'site_name', '财经资讯站'),
    tagline: await getSetting(env.DB, 'site_tagline', '私递值钱的知识和信息'),
    slogan: await getSetting(env.DB, 'site_slogan', '关注强支撑的资产，研究最伟大的公司，做永不亏钱的投资！'),
    favicon: await getSetting(env.DB, 'site_favicon', ''),
    logo: await getSetting(env.DB, 'site_logo', ''),
    social: {
      bilibili: await getSetting(env.DB, 'social_bilibili', ''),
      douyin: await getSetting(env.DB, 'social_douyin', ''),
      xiaohongshu: await getSetting(env.DB, 'social_xiaohongshu', ''),
      facebook: await getSetting(env.DB, 'social_facebook', ''),
      x: await getSetting(env.DB, 'social_x', ''),
      youtube: await getSetting(env.DB, 'social_youtube', ''),
      instagram: await getSetting(env.DB, 'social_instagram', ''),
    },
    cs: {
      chat_url: await getSetting(env.DB, 'cs_chat_url', ''),
      wechat_qr: await getSetting(env.DB, 'cs_wechat_qr', ''),
      whatsapp: await getSetting(env.DB, 'cs_whatsapp', ''),
      telegram: await getSetting(env.DB, 'cs_telegram', ''),
    },
    navMenu: parseNavMenu(await getSetting(env.DB, 'nav_menu', '[]')),
  };
}

async function getEnabledPayMethods(env: Env): Promise<string[]> {
  const payMethods = await getSetting(env.DB, 'pay_methods', 'alipay,wxpay,usdt');
  return payMethods.split(',').map((s) => s.trim()).filter(Boolean);
}

type NavMenuItem = { id: string; label: string; url: string; target?: string; children?: NavMenuItem[] };

function parseNavMenu(raw: string): NavMenuItem[] {
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function loadUser(env: Env, request: Request) {
  const token = await currentUser(env, request);
  if (!token) return null;
  const row = await first<{ id: number; email: string; name: string; role: string; membership_tier: string; membership_expires_at: string | null }>(
    env.DB,
    'SELECT id, email, name, role, membership_tier, membership_expires_at FROM users WHERE id = ?',
    [token.uid]
  );
  if (!row) return null;
  return { ...row, isVip: row.role === 'admin' || hasActiveMembership(row) };
}

function hasActiveMembership(row: { membership_tier: string; membership_expires_at: string | null } | null): boolean {
  if (!row) return false;
  if (!row.membership_tier) return false;
  // 永久会员：有 tier 但无到期时间 = 永久有效
  if (!row.membership_expires_at) return true;
  return new Date(row.membership_expires_at).getTime() > Date.now();
}

// 会员方案表类型
type MembershipPlan = {
  id: number;
  key: string;
  name: string;
  duration_type: string;   // day | month | year | forever
  duration_value: number;
  price: number;
  currency: string;
  benefits: string;
  sort_order: number;
  status: number;
};

async function getEnabledPlans(db: D1Database): Promise<MembershipPlan[]> {
  return await query<MembershipPlan>(
    db,
    "SELECT id, key, name, duration_type, duration_value, price, currency, benefits, sort_order, status FROM membership_plans WHERE status = 1 ORDER BY sort_order ASC, id ASC"
  );
}

async function getPlanByKey(db: D1Database, key: string): Promise<MembershipPlan | null> {
  return await first<MembershipPlan>(
    db,
    "SELECT id, key, name, duration_type, duration_value, price, currency, benefits, sort_order, status FROM membership_plans WHERE key = ? AND status = 1",
    [key]
  );
}

function durationLabel(p: MembershipPlan): string {
  if (p.duration_type === 'forever') return '永久';
  if (p.duration_type === 'day') return `${p.duration_value} 天`;
  if (p.duration_type === 'month') return `${p.duration_value} 个月`;
  if (p.duration_type === 'year') return `${p.duration_value} 年`;
  return '';
}

function calcExpiry(p: MembershipPlan, base?: Date): string | null {
  if (p.duration_type === 'forever') return null; // NULL = 永久
  const now = base ? new Date(base) : new Date();
  let exp = new Date(now);
  if (p.duration_type === 'day') exp.setDate(exp.getDate() + p.duration_value);
  else if (p.duration_type === 'month') exp.setMonth(exp.getMonth() + p.duration_value);
  else if (p.duration_type === 'year') exp.setFullYear(exp.getFullYear() + p.duration_value);
  return exp.toISOString();
}

async function ownsCourse(db: D1Database, courseId: number, userId: number): Promise<boolean> {
  const row = await first<{ id: number }>(db, "SELECT id FROM course_purchases WHERE course_id = ? AND user_id = ? AND status = 'paid'", [courseId, userId]);
  return !!row;
}

async function ownsProduct(db: D1Database, productId: number, userId: number): Promise<boolean> {
  const row = await first<{ id: number }>(db, "SELECT id FROM product_orders WHERE product_id = ? AND user_id = ? AND status IN ('paid','shipped','completed')", [productId, userId]);
  return !!row;
}

async function ownsArticle(db: D1Database, articleId: number, userId: number): Promise<boolean> {
  const row = await first<{ id: number }>(db, "SELECT id FROM article_purchases WHERE article_id = ? AND user_id = ? AND status = 'paid'", [articleId, userId]);
  return !!row;
}

async function activateMembership(db: D1Database, userId: number, plan: string): Promise<void> {
  const p = await getPlanByKey(db, plan);
  if (!p) return;
  // 续费：若当前仍是有效会员，从原到期时间起算，否则从现在起算
  const cur = await first<{ membership_expires_at: string | null }>(
    db,
    'SELECT membership_expires_at FROM users WHERE id = ?',
    [userId]
  );
  let base: Date | undefined;
  if (cur?.membership_expires_at && new Date(cur.membership_expires_at).getTime() > Date.now()) {
    base = new Date(cur.membership_expires_at);
  }
  const expires = calcExpiry(p, base); // 永久返回 null
  await run(db, 'UPDATE users SET membership_tier = ?, membership_expires_at = ?, updated_at = datetime(\'now\') WHERE id = ?', [
    p.key,
    expires,
    userId,
  ]);
}

function adminAuth() {
  return async (c: any, next: any) => {
    const token = await currentUser(c.env, c.req.raw);
    if (!token) return json({ error: 'unauthorized' }, 401);
    const row = await first<{ role: string }>(c.env.DB, 'SELECT role FROM users WHERE id = ?', [token.uid]);
    if (!row || row.role !== 'admin') return json({ error: 'forbidden' }, 403);
    c.set('user', { ...token, role: row.role });
    await next();
  };
}

async function readEpayConfig(env: Env): Promise<EpayConfig> {
  return {
    apiUrl: await getSetting(env.DB, 'epay_api_url', ''),
    pid: await getSetting(env.DB, 'epay_pid', ''),
    key: await getSetting(env.DB, 'epay_key', ''),
  };
}

// ---------------------------------------------------------------------------
// Invite cookie tracking middleware
// ---------------------------------------------------------------------------
app.use('*', async (c, next) => {
  const ref = new URL(c.req.url).searchParams.get('ref');
  await next();
  if (ref) {
    c.header('Set-Cookie', `fc_ref=${ref}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
  }
});

// ---------------------------------------------------------------------------
// Server-rendered pages
// ---------------------------------------------------------------------------

app.get('/', async (c) => {
  const info = await siteInfo(c.env);
  const user = await loadUser(c.env, c.req.raw);
  const hotCourses = await query<any>(
    c.env.DB,
    'SELECT id, title, cover_image, price, access_type, is_top FROM courses WHERE status = 1 ORDER BY is_top DESC, sticky_order DESC, created_at DESC LIMIT 16'
  );
  const featuredProducts = await query<any>(
    c.env.DB,
    'SELECT id, name, cover, price, sale_price, type, is_featured FROM products WHERE status = 1 ORDER BY is_featured DESC, sort_order ASC, created_at DESC LIMIT 16'
  );
  const latestArticles = await query<any>(
    c.env.DB,
    `SELECT a.id, a.title, a.cover_image, a.excerpt, a.access_type, a.published_at, a.is_top, c.name AS category_name
     FROM articles a LEFT JOIN categories c ON a.category_id = c.id
     WHERE a.status='published' AND a.type = 'article' ORDER BY a.is_top DESC, a.sort_order ASC, a.published_at DESC LIMIT 16`
  );
  const [noticeArticles, noticeCourses, noticeProducts] = await Promise.all([
    query<any>(c.env.DB, "SELECT id, title FROM articles WHERE status='published' AND type='article' ORDER BY is_top DESC, sort_order ASC, published_at DESC LIMIT 3"),
    query<any>(c.env.DB, "SELECT id, title FROM courses WHERE status=1 ORDER BY created_at DESC LIMIT 3"),
    query<any>(c.env.DB, "SELECT id, name FROM products WHERE status=1 ORDER BY created_at DESC LIMIT 3"),
  ]);
  const noticeItems = shuffle([
    ...noticeArticles.map((a: any) => ({ type: 'article', id: a.id, title: a.title, href: `/article/${a.id}` })),
    ...noticeCourses.map((c: any) => ({ type: 'course', id: c.id, title: c.title, href: `/course/${c.id}` })),
    ...noticeProducts.map((p: any) => ({ type: 'product', id: p.id, title: p.name, href: `/product/${p.id}` })),
  ]);
  return html(renderHome({ ...info, hotCourses, featuredProducts, latestArticles, noticeItems, user }));
});

app.get('/about', async (c) => {
  const info = await siteInfo(c.env);
  const user = await loadUser(c.env, c.req.raw);
  const aboutContent = await getSetting(c.env.DB, 'about_content', '');
  return html(renderAbout({ ...info, about_content: aboutContent, user }));
});

app.get('/helper', async (c) => {
  const info = await siteInfo(c.env);
  const user = await loadUser(c.env, c.req.raw);
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1);
  const pageSize = 15;
  const offset = (page - 1) * pageSize;
  const helperCat = await first<{ id: number }>(c.env.DB, "SELECT id FROM categories WHERE name = '帮助中心' AND type = 'article' LIMIT 1");
  const catId = helperCat?.id || 0;
  let total = 0;
  let articles: any[] = [];
  if (catId > 0) {
    const totalRow = await first<{ c: number }>(c.env.DB, "SELECT COUNT(*) AS c FROM articles WHERE status='published' AND type='article' AND category_id = ?", [catId]);
    total = totalRow?.c || 0;
    articles = await query<any>(c.env.DB, "SELECT id, title FROM articles WHERE status='published' AND type='article' AND category_id = ? ORDER BY is_top DESC, sort_order ASC, published_at DESC LIMIT ? OFFSET ?", [catId, pageSize, offset]);
  }
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return html(renderHelper({ ...info, articles, page, totalPages, user }));
});

async function searchAll(db: D1Database, q: string): Promise<{ type: string; label: string; title: string; url: string }[]> {
  const like = `%${q}%`;
  const articles = await query<any>(
    db,
    "SELECT id, title FROM articles WHERE status='published' AND type='article' AND title LIKE ? ORDER BY is_top DESC, sort_order ASC, published_at DESC LIMIT 20",
    [like]
  );
  const products = await query<any>(
    db,
    'SELECT id, name AS title FROM products WHERE status = 1 AND name LIKE ? ORDER BY created_at DESC LIMIT 20',
    [like]
  );
  const courses = await query<any>(
    db,
    'SELECT id, title FROM courses WHERE status = 1 AND title LIKE ? ORDER BY created_at DESC LIMIT 20',
    [like]
  );
  return [
    ...articles.map((a: { id: number; title: string }) => ({ type: 'article', label: '文章', title: a.title, url: `/article/${a.id}` })),
    ...products.map((p: { id: number; title: string }) => ({ type: 'product', label: '商品', title: p.title, url: `/product/${p.id}` })),
    ...courses.map((c: { id: number; title: string }) => ({ type: 'course', label: '课程', title: c.title, url: `/course/${c.id}` })),
  ];
}

app.get('/api/search', async (c) => {
  const q = (c.req.query('q') || '').trim();
  if (!q) return json({ results: [] });
  const results = await searchAll(c.env.DB, q);
  return json({ results });
});

function extractKeywords(q: string): string[] {
  const raw = q.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  const stopWords = ['如何', '怎么', '怎样', '是什么', '在哪里', '哪里', '哪些', '哪个', '多少钱', '多少', '能不能', '可以', '能否', '是否', '有没有', '请问', '我想', '你们', '你的', '我要', '帮我', '告诉', '呢', '吗', '吧', '啊', '呀', '一下', '一些', '知道', '了解', '安装', '使用', '设置', '配置', '搭建', '开通', '注册', '购买', '下载', '有', '的', '了', '是', '在', '和', '与', '或', '及', '让', '把', '被', '从', '向', '对', '到', '用', '给', '为', '什么', '这个', '那个', '这', '那', '做', '能'];
  let temp = raw;
  for (const sw of stopWords) temp = temp.split(sw).join('|');
  temp = temp.replace(/\|+/g, '|');
  const parts = temp.split('|').filter((s) => s.length >= 2);
  const keywords: string[] = [];
  for (const part of parts) {
    if (!/[\u4e00-\u9fa5]/.test(part)) continue;
    const plen = part.length;
    for (let segLen = Math.min(4, plen); segLen >= 2; segLen--) {
      for (let i = 0; i <= plen - segLen; i++) {
        const seg = part.slice(i, i + segLen);
        if (!keywords.includes(seg)) keywords.push(seg);
      }
    }
  }
  return keywords.slice(0, 6);
}

async function listByType(db: D1Database, type: string): Promise<{ type: string; label: string; title: string; url: string }[]> {
  if (type === 'course') {
    const rows = await query<any>(db, 'SELECT id, title FROM courses WHERE status = 1 ORDER BY is_top DESC, created_at DESC LIMIT 10');
    return rows.map((c: { id: number; title: string }) => ({ type: 'course', label: '课程', title: c.title, url: `/course/${c.id}` }));
  }
  if (type === 'article') {
    const rows = await query<any>(db, "SELECT id, title FROM articles WHERE status = 'published' AND type = 'article' ORDER BY is_top DESC, sort_order ASC, published_at DESC LIMIT 10");
    return rows.map((a: { id: number; title: string }) => ({ type: 'article', label: '文章', title: a.title, url: `/article/${a.id}` }));
  }
  if (type === 'product') {
    const rows = await query<any>(db, 'SELECT id, name AS title FROM products WHERE status = 1 ORDER BY created_at DESC LIMIT 10');
    return rows.map((p: { id: number; title: string }) => ({ type: 'product', label: '商品', title: p.title, url: `/product/${p.id}` }));
  }
  return [];
}

const TYPE_HINTS: { re: RegExp; type: string }[] = [
  { re: /课程|教程|网课|视频课/, type: 'course' },
  { re: /文章|资讯|博客|帖子/, type: 'article' },
  { re: /商品|产品|源码|工具|服务/, type: 'product' },
];
const TYPE_RE = /课程|教程|网课|视频课|文章|资讯|博客|帖子|商品|产品|源码|工具|服务/;

async function ragContext(db: D1Database, question: string): Promise<string> {
  const seen = new Map<string, string>();
  // 1. 识别类型名词（课程/文章/商品）→ 直接列出该类型全部内容
  for (const tw of TYPE_HINTS) {
    if (tw.re.test(question)) {
      const items = await listByType(db, tw.type);
      for (const r of items) {
        if (seen.size >= 10) break;
        seen.set(`${r.type}:${r.title}`, `${r.label} ${r.title} → ${SITE_URL}${r.url}`);
      }
    }
  }
  // 2. 具体关键词搜索（过滤掉类型名词本身）
  const keywords = extractKeywords(question);
  const terms = keywords.filter((k) => !TYPE_RE.test(k));
  for (const kw of terms) {
    if (seen.size >= 10) break;
    const results = await searchAll(db, kw);
    for (const r of results) {
      if (seen.size >= 10) break;
      seen.set(`${r.type}:${r.title}`, `${r.label} ${r.title} → ${SITE_URL}${r.url}`);
    }
  }
  return [...seen.values()].join('\n');
}

app.post('/api/chat', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const question = String(body.question || '').trim();
  if (!question) return json({ error: '请输入问题' }, 400);

  const aiBase = (await getSetting(c.env.DB, 'ai_base_url', '')).replace(/\/+$/, '');
  const aiModel = await getSetting(c.env.DB, 'ai_model', '');
  const aiKey = await getSetting(c.env.DB, 'ai_api_key', '');
  if (!aiBase || !aiModel || !aiKey) return json({ error: 'AI 客服尚未配置，请联系管理员' }, 500);

  const siteName = await getSetting(c.env.DB, 'site_name', '财经资讯站');
  const tagline = await getSetting(c.env.DB, 'site_tagline', '私递值钱的知识和信息');

  const context = await ragContext(c.env.DB, question);
  const system = `你是「${siteName}」网站的智能客服助手。请根据提供的网站信息回答客户问题。规则：1. 用中文回答，简洁友好，200字以内；2. 只依据提供的资料回答，不编造；3. 涉及具体文章/课程/商品时，用 Markdown 链接 [标题](完整URL) 格式给出；4. 不知道就如实说不知道。`;
  const userMsg = `网站介绍：${siteName} - ${tagline}\n\n相关搜索结果：\n${context || '（无匹配结果）'}\n\n客户问题：${question}`;

  let reply = '';
  try {
    const resp = await fetch(`${aiBase}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${aiKey}` },
      body: JSON.stringify({
        model: aiModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userMsg },
        ],
        temperature: 0.6,
        max_tokens: 800,
      }),
    });
    const data = (await resp.json()) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
    reply = data.choices?.[0]?.message?.content || data.error?.message || '抱歉，暂时无法回答，请稍后再试。';
  } catch {
    return json({ error: 'AI 服务调用失败，请稍后再试' }, 502);
  }
  return json({ reply });
});

app.get('/article/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (!id) return c.notFound();
  const info = await siteInfo(c.env);
  const user = await loadUser(c.env, c.req.raw);
  const a = await first<any>(
    c.env.DB,
    `SELECT a.*, c.name AS category_name FROM articles a
     LEFT JOIN categories c ON a.category_id = c.id WHERE a.id = ? AND a.status='published'`,
    [id]
  );
  if (!a) return c.notFound();
  await run(c.env.DB, 'UPDATE articles SET view_count = view_count + 1 WHERE id = ?', [id]);

  // 关联内容（相关文章/课程/商品）+ 广告
  const linkRows = await query<any>(c.env.DB, `SELECT al.item_type, al.item_id, al.sort_order,
    CASE al.item_type WHEN 'article' THEN a2.title WHEN 'course' THEN co.title WHEN 'product' THEN p.name END AS title,
    CASE al.item_type WHEN 'article' THEN a2.cover_image WHEN 'course' THEN co.cover_image WHEN 'product' THEN p.cover END AS cover
    FROM article_links al
    LEFT JOIN articles a2 ON al.item_type='article' AND a2.id=al.item_id
    LEFT JOIN courses co ON al.item_type='course' AND co.id=al.item_id
    LEFT JOIN products p ON al.item_type='product' AND p.id=al.item_id
    WHERE al.article_id = ? ORDER BY al.item_type ASC, al.sort_order ASC, al.id ASC`, [id]);
  const links: Record<string, any[]> = { article: [], course: [], product: [] };
  for (const r of linkRows) {
    if (!r.title) continue;
    const url = r.item_type === 'article' ? `/article/${r.item_id}` : r.item_type === 'course' ? `/course/${r.item_id}` : `/product/${r.item_id}`;
    links[r.item_type as string].push({ id: r.item_id, title: r.title, cover: r.cover || '', url });
  }
  const ads = await query<any>(c.env.DB, 'SELECT id, title, image, url FROM ads WHERE status = 1 ORDER BY sort_order ASC, id ASC');

  const memberRow = user
    ? await first<{ membership_tier: string; membership_expires_at: string | null }>(
        c.env.DB,
        'SELECT membership_tier, membership_expires_at FROM users WHERE id = ?',
        [user.id]
      )
    : null;
  const vipArticleOpen = (await getSetting(c.env.DB, 'vip_article_access', '1')) !== '0';
  const canRead = a.access_type === 'public' || user?.role === 'admin' || (vipArticleOpen && hasActiveMembership(memberRow)) || (user ? await ownsArticle(c.env.DB, id, user.id) : false);
  return html(renderArticle({ ...info, article: a, canRead, payMethods: await getEnabledPayMethods(c.env), user, links, ads }));
});

app.get('/category/:slug', async (c) => {
  const slug = c.req.param('slug');
  const info = await siteInfo(c.env);
  const user = await loadUser(c.env, c.req.raw);
  const cat = await first<{ name: string; description: string }>(
    c.env.DB,
    'SELECT name, description FROM categories WHERE slug = ?',
    [slug]
  );
  if (!cat) return c.notFound();
  const articles = await query<any>(
    c.env.DB,
    `SELECT a.id, a.title, a.excerpt, a.access_type, a.published_at FROM articles a
     JOIN categories c ON a.category_id = c.id
     WHERE c.slug = ? AND a.status='published' ORDER BY a.is_top DESC, a.sort_order ASC, a.published_at DESC LIMIT 50`,
    [slug]
  );
  return html(renderCategory({ ...info, category: cat, articles, user }));
});

app.get('/articles', async (c) => {
  const info = await siteInfo(c.env);
  const user = await loadUser(c.env, c.req.raw);
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1);
  const categoryId = parseInt(c.req.query('category') || '0', 10) || 0;
  const pageSize = 8;
  const offset = (page - 1) * pageSize;
  const where = categoryId > 0 ? 'AND a.category_id = ?' : '';
  const catParams: any[] = categoryId > 0 ? [categoryId] : [];
  const totalRow = await first<{ c: number }>(c.env.DB, `SELECT COUNT(*) AS c FROM articles a WHERE a.status='published' AND a.type = 'article' ${where}`, catParams);
  const total = totalRow?.c || 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const articles = await query<any>(
    c.env.DB,
    `SELECT a.id, a.title, a.cover_image, a.excerpt, a.access_type, a.published_at, c.name AS category_name
     FROM articles a LEFT JOIN categories c ON a.category_id = c.id
     WHERE a.status='published' AND a.type = 'article' ${where} ORDER BY a.is_top DESC, a.sort_order ASC, a.published_at DESC LIMIT ? OFFSET ?`,
    [...catParams, pageSize, offset]
  );
  const categories = await query<any>(c.env.DB, "SELECT id, name FROM categories WHERE type = 'article' ORDER BY sort_order ASC, id ASC");
  return html(renderArticles({ ...info, articles, page, totalPages, basePath: '/articles', categories, currentCategory: categoryId, user }));
});

app.get('/courses', async (c) => {
  const info = await siteInfo(c.env);
  const user = await loadUser(c.env, c.req.raw);
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1);
  const pageSize = 8;
  const offset = (page - 1) * pageSize;
  const totalRow = await first<{ c: number }>(c.env.DB, 'SELECT COUNT(*) AS c FROM courses WHERE status = 1');
  const total = totalRow?.c || 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const items = await query<any>(
    c.env.DB,
    `SELECT id, title, cover_image, price, access_type, created_at AS published_at, 'course' AS type, '' AS category_name
     FROM courses WHERE status = 1 ORDER BY is_top DESC, sticky_order DESC, created_at DESC LIMIT ? OFFSET ?`,
    [pageSize, offset]
  );
  const categories = await query<any>(c.env.DB, "SELECT id, name FROM categories WHERE type = 'course' ORDER BY sort_order ASC, id ASC");
  return html(renderGrid({ ...info, title: '课程', subtitle: '系统化学习，掌握投资核心方法', items, page, totalPages, basePath: '/courses', categories, currentCategory: 0, user }));
});

app.get('/shop', async (c) => {
  const info = await siteInfo(c.env);
  const user = await loadUser(c.env, c.req.raw);
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1);
  const categoryId = parseInt(c.req.query('category') || '0', 10) || 0;
  const pageSize = 8;
  const offset = (page - 1) * pageSize;
  const where = categoryId > 0 ? 'AND p.category_id = ?' : '';
  const catParams: any[] = categoryId > 0 ? [categoryId] : [];
  const totalRow = await first<{ c: number }>(c.env.DB, `SELECT COUNT(*) AS c FROM products p WHERE p.status = 1 ${where}`, catParams);
  const total = totalRow?.c || 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const items = await query<any>(
    c.env.DB,
    `SELECT p.id, p.name AS title, p.cover AS cover_image,
       (CASE WHEN p.sale_price > 0 THEN p.sale_price ELSE p.price END) AS price,
       (CASE WHEN (p.sale_price > 0 OR p.price > 0) THEN 'paid' ELSE 'public' END) AS access_type,
       p.created_at AS published_at, 'product' AS type, p.type AS product_type, c.name AS category_name
     FROM products p LEFT JOIN categories c ON p.category_id = c.id
     WHERE p.status = 1 ${where} ORDER BY p.is_featured DESC, p.sort_order ASC, p.created_at DESC LIMIT ? OFFSET ?`,
    [...catParams, pageSize, offset]
  );
  const categories = await query<any>(c.env.DB, "SELECT id, name FROM categories WHERE type = 'product' ORDER BY sort_order ASC, id ASC");
  return html(renderGrid({ ...info, title: '商城', subtitle: '精选工具与研究服务', items, page, totalPages, basePath: '/shop', categories, currentCategory: categoryId, user }));
});

app.get('/course/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (!id) return c.notFound();
  const info = await siteInfo(c.env);
  const user = await loadUser(c.env, c.req.raw);
  const course = await first<any>(c.env.DB, 'SELECT * FROM courses WHERE id = ? AND status = 1', [id]);
  if (!course) return c.notFound();
  const chapters = await query<any>(c.env.DB, 'SELECT * FROM course_chapters WHERE course_id = ? ORDER BY sort_order ASC, id ASC', [id]);
  for (const ch of chapters) {
    ch.videos = await query<any>(c.env.DB, 'SELECT * FROM course_videos WHERE chapter_id = ? ORDER BY sort_order ASC, id ASC', [ch.id]);
    for (const v of ch.videos) {
      v.article_title = v.article_id ? ((await first<any>(c.env.DB, 'SELECT title FROM articles WHERE id = ?', [v.article_id]))?.title || '') : '';
    }
  }
  let canAccess = course.access_type === 'public';
  let purchased = false;
  if (user) {
    const vipCourseOpen = (await getSetting(c.env.DB, 'vip_course_access', '1')) !== '0';
    if (user.role === 'admin' || (user.isVip && vipCourseOpen)) canAccess = true;
    if (await ownsCourse(c.env.DB, id, user.id)) { canAccess = true; purchased = true; }
  }
  return html(renderCourse({ ...info, course, chapters, canAccess, purchased, payMethods: await getEnabledPayMethods(c.env), user }));
});

app.get('/product/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (!id) return c.notFound();
  const info = await siteInfo(c.env);
  const user = await loadUser(c.env, c.req.raw);
  const product = await first<any>(c.env.DB, 'SELECT * FROM products WHERE id = ? AND status = 1', [id]);
  if (!product) return c.notFound();
  let canAccess = false;
  let purchased = false;
  if (user) {
    const vipVirtualOpen = (await getSetting(c.env.DB, 'vip_virtual_access', '0')) !== '0';
    if (user.role === 'admin') { canAccess = true; purchased = true; }
    else if (product.type === 'virtual' && user.isVip && vipVirtualOpen) { canAccess = true; purchased = true; }
    else if (product.type === 'virtual' && await ownsProduct(c.env.DB, id, user.id)) { canAccess = true; purchased = true; }
  }
  const vipDiscount = parseInt(await getSetting(c.env.DB, 'vip_product_discount', '100')) || 100;
  return html(renderProduct({ ...info, product, canAccess, purchased, vipDiscount, payMethods: await getEnabledPayMethods(c.env), user }));
});

// ---- 购物车 ----
app.get('/api/cart/count', async (c) => {
  const token = await currentUser(c.env, c.req.raw);
  if (!token) return json({ count: 0 });
  const row = await first<{ n: number }>(c.env.DB, 'SELECT COUNT(*) AS n FROM cart_items WHERE user_id = ?', [token.uid]);
  return json({ count: row?.n ?? 0 });
});

app.get('/api/cart', async (c) => {
  const token = await currentUser(c.env, c.req.raw);
  if (!token) return json({ error: '请先登录' }, 401);
  const items = await query<any>(
    c.env.DB,
    'SELECT ci.id, ci.quantity, p.id AS product_id, p.name, p.cover, p.price, p.sale_price, p.type, p.stock, p.status FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.user_id = ? ORDER BY ci.id DESC',
    [token.uid]
  );
  // 会员折扣信息（购物车页面显示 VIP 价）
  const member = await first<{ membership_tier: string; membership_expires_at: string | null }>(c.env.DB, 'SELECT membership_tier, membership_expires_at FROM users WHERE id = ?', [token.uid]);
  const isVip = token.role === 'admin' || hasActiveMembership(member);
  const vipDiscount = parseInt(await getSetting(c.env.DB, 'vip_product_discount', '100')) || 100;
  return json({ items, isVip, vipDiscount });
});

app.post('/api/cart', async (c) => {
  const token = await currentUser(c.env, c.req.raw);
  if (!token) return json({ error: '请先登录' }, 401);
  const { product_id, quantity } = await c.req.json().catch(() => ({}));
  const pid = parseInt(product_id, 10);
  const qty = Math.max(1, parseInt(quantity, 10) || 1);
  if (!pid) return json({ error: '参数错误' }, 400);
  const product = await first<any>(c.env.DB, 'SELECT id, status FROM products WHERE id = ?', [pid]);
  if (!product || product.status != 1) return json({ error: '商品不存在或已下架' }, 400);
  const existing = await first<any>(c.env.DB, 'SELECT id FROM cart_items WHERE user_id = ? AND product_id = ?', [token.uid, pid]);
  if (existing) await run(c.env.DB, 'UPDATE cart_items SET quantity = quantity + ? WHERE id = ?', [qty, existing.id]);
  else await run(c.env.DB, 'INSERT INTO cart_items (user_id, product_id, quantity) VALUES (?, ?, ?)', [token.uid, pid, qty]);
  return json({ ok: true });
});

app.put('/api/cart/:id', async (c) => {
  const token = await currentUser(c.env, c.req.raw);
  if (!token) return json({ error: '请先登录' }, 401);
  const id = parseInt(c.req.param('id'), 10);
  const { quantity } = await c.req.json().catch(() => ({}));
  const qty = Math.max(1, parseInt(quantity, 10) || 1);
  await run(c.env.DB, 'UPDATE cart_items SET quantity = ? WHERE id = ? AND user_id = ?', [qty, id, token.uid]);
  return json({ ok: true });
});

app.delete('/api/cart/:id', async (c) => {
  const token = await currentUser(c.env, c.req.raw);
  if (!token) return json({ error: '请先登录' }, 401);
  const id = parseInt(c.req.param('id'), 10);
  await run(c.env.DB, 'DELETE FROM cart_items WHERE id = ? AND user_id = ?', [id, token.uid]);
  return json({ ok: true });
});

// 合并下单
app.post('/api/cart/checkout', async (c) => {
  const token = await currentUser(c.env, c.req.raw);
  if (!token) return json({ error: '请先登录' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const method = String(body.method || 'usdt');

  const items = await query<any>(
    c.env.DB,
    'SELECT ci.id AS cart_id, ci.quantity, p.* FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.user_id = ? ORDER BY ci.id',
    [token.uid]
  );
  if (!items.length) return json({ error: '购物车是空的' }, 400);

  const member = await first<{ membership_tier: string; membership_expires_at: string | null }>(c.env.DB, 'SELECT membership_tier, membership_expires_at FROM users WHERE id = ?', [token.uid]);
  const isVip = token.role === 'admin' || hasActiveMembership(member);
  const vipVirtualOpen = (await getSetting(c.env.DB, 'vip_virtual_access', '0')) !== '0';
  const vipDiscount = parseInt(await getSetting(c.env.DB, 'vip_product_discount', '100')) || 100;

  // 实物地址
  const hasPhysical = items.some((it) => it.type === 'physical');
  let addr = { name: '', phone: '', country: '', province: '', city: '', detail: '', zip: '' };
  if (hasPhysical) {
    if (body.address_id) {
      const saved = await first<any>(c.env.DB, 'SELECT * FROM user_addresses WHERE id = ? AND user_id = ?', [Number(body.address_id), token.uid]);
      if (!saved) return json({ error: '收货地址不存在' }, 400);
      addr = { name: saved.name, phone: saved.phone, country: saved.country || '', province: saved.province || '', city: saved.city || '', detail: saved.detail, zip: saved.zip || '' };
    } else {
      addr.name = String(body.name || '').trim();
      addr.phone = String(body.phone || '').trim();
      addr.country = String(body.country || '').trim();
      addr.province = String(body.province || '').trim();
      addr.city = String(body.city || '').trim();
      addr.detail = String(body.address || '').trim();
      addr.zip = String(body.zip || '').trim();
    }
    if (!addr.name || !addr.phone || !addr.detail) return json({ error: '请填写收货人、电话和详细地址' }, 400);
  }

  const payMethods = await getSetting(c.env.DB, 'pay_methods', 'alipay,wxpay,usdt');
  const enabledMethods = payMethods.split(',').map((s) => s.trim()).filter(Boolean);
  if (!enabledMethods.includes(method)) return json({ error: '该支付方式未开通' }, 400);

  const batchNo = 'FPO' + Date.now() + randHex(6).slice(0, 6);
  let total = 0;
  const pendingList: { it: any; unitPrice: number; quantity: number; sub: number }[] = [];

  for (const it of items) {
    const price = it.sale_price > 0 ? it.sale_price : it.price;
    const quantity = Math.max(1, Number(it.quantity) || 1);

    // 已购买的虚拟商品：移除购物车项
    if (it.type === 'virtual') {
      const owned = await first<any>(c.env.DB, "SELECT id FROM product_orders WHERE product_id = ? AND user_id = ? AND status IN ('paid','shipped','completed')", [it.id, token.uid]);
      if (owned) { await run(c.env.DB, 'DELETE FROM cart_items WHERE id = ?', [it.cart_id]); continue; }
    }
    // 实物库存校验
    if (it.type === 'physical' && (it.stock <= 0 || quantity > it.stock)) {
      return json({ error: `「${it.name}」库存不足` }, 400);
    }

    // VIP 免费虚拟：直接生成 paid 订单
    if (it.type === 'virtual' && isVip && vipVirtualOpen) {
      const freeOrderNo = 'FPO' + Date.now() + randHex(6).slice(0, 6) + Math.random().toString(36).slice(2, 5);
      await run(c.env.DB, "INSERT INTO product_orders (order_no, user_id, product_id, product_name, product_image, product_type, quantity, unit_price, total_amount, status, payment_method, batch_no) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 'paid', 'vip', ?)", [freeOrderNo, token.uid, it.id, it.name, it.cover, it.type, quantity, batchNo]);
      continue;
    }

    if (!(price > 0)) continue;

    const unitPrice = (isVip && vipDiscount < 100 && vipDiscount > 0) ? Math.round(price * vipDiscount) / 100 : price;
    const sub = Math.round(unitPrice * quantity * 100) / 100;
    total += sub;
    pendingList.push({ it, unitPrice, quantity, sub });
  }

  // 生成待支付订单
  for (let idx = 0; idx < pendingList.length; idx++) {
    const po = pendingList[idx];
    const it = po.it;
    const orderNo = `${batchNo}-${idx + 1}`;
    await run(c.env.DB, "INSERT INTO product_orders (order_no, user_id, product_id, product_name, product_image, product_type, quantity, unit_price, total_amount, status, payment_method, address_name, address_phone, address_country, address_province, address_city, address_detail, address_zip, batch_no) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)", [orderNo, token.uid, it.id, it.name, it.cover, it.type, po.quantity, po.unitPrice, po.sub, method, addr.name, addr.phone, addr.country, addr.province, addr.city, addr.detail, addr.zip, batchNo]);
    if (it.type === 'physical') {
      await run(c.env.DB, 'UPDATE products SET stock = stock - ? WHERE id = ?', [po.quantity, it.id]);
    }
  }

  // 清空购物车
  await run(c.env.DB, 'DELETE FROM cart_items WHERE user_id = ?', [token.uid]);

  if (total <= 0) return json({ free: true });

  const cfg = await readEpayConfig(c.env);
  if (!cfg.apiUrl || !cfg.pid || !cfg.key) return json({ error: '支付网关未配置' }, 500);
  const gatewayType = methodType(method);
  await run(c.env.DB, "INSERT INTO payment_orders (order_no, user_id, amount, currency, plan, payment_method, status, item_id, item_type) VALUES (?, ?, ?, 'USD', ?, ?, 'pending', 0, 'cart')", [batchNo, token.uid, total, '购物车合并订单', method]);
  const base = siteBase(c.env);
  const params = buildOrderParams(cfg, { type: gatewayType, outTradeNo: batchNo, notifyUrl: `${base}/api/payment/callback`, returnUrl: `${base}/api/payment/return?order_no=${batchNo}`, name: '购物车合并订单', money: String(total) });
  return json({ submit_url: normalizeApiUrl(cfg.apiUrl), params });
});

// ---- 评论 ----
app.get('/api/products/:id/comments', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const rows = await query<any>(
    c.env.DB,
    "SELECT id, user_name, rating, content, reply, created_at FROM comments WHERE product_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 100",
    [id]
  );
  return json({ comments: rows });
});

app.post('/api/products/:id/comments', async (c) => {
  const token = await currentUser(c.env, c.req.raw);
  if (!token) return json({ error: '请先登录' }, 401);
  const id = parseInt(c.req.param('id'), 10);
  const { rating, content } = await c.req.json().catch(() => ({}));
  const text = (content || '').trim();
  if (!text) return json({ error: '评论内容不能为空' }, 400);
  const r = parseInt(rating, 10);
  const rate = r >= 1 && r <= 5 ? r : 5;
  const user = await first<any>(c.env.DB, 'SELECT name, email FROM users WHERE id = ?', [token.uid]);
  await run(c.env.DB, "INSERT INTO comments (product_id, user_id, user_name, user_email, rating, content, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')", [id, token.uid, user?.name || '', user?.email || '', rate, text]);
  return json({ ok: true });
});

// ---- 文章评论 ----
app.get('/api/articles/:id/comments', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const rows = await query<any>(
    c.env.DB,
    "SELECT id, user_name, content, reply, created_at FROM comments WHERE article_id = ? AND product_id = 0 AND status = 'approved' ORDER BY id DESC LIMIT 200",
    [id]
  );
  return json({ comments: rows });
});

app.post('/api/articles/:id/comments', async (c) => {
  const token = await currentUser(c.env, c.req.raw);
  if (!token) return json({ error: '请先登录' }, 401);
  const id = parseInt(c.req.param('id'), 10);
  const { content } = await c.req.json().catch(() => ({}));
  const text = (content || '').trim();
  if (!text) return json({ error: '评论内容不能为空' }, 400);
  if (text.length > 2000) return json({ error: '评论内容不能超过 2000 字' }, 400);
  const user = await first<any>(c.env.DB, 'SELECT name, email FROM users WHERE id = ?', [token.uid]);
  await run(c.env.DB, "INSERT INTO comments (product_id, article_id, user_id, user_name, user_email, rating, content, status) VALUES (0, ?, ?, ?, ?, 5, ?, 'pending')", [id, token.uid, user?.name || '', user?.email || '', text]);
  return json({ ok: true });
});

app.get('/cart', async (c) => {
  const info = await siteInfo(c.env);
  const user = await loadUser(c.env, c.req.raw);
  const payMethods = await getEnabledPayMethods(c.env);
  return html(renderCart({ ...info, payMethods, user }));
});

app.get('/pricing', (c) => c.redirect('/vip'));
app.get('/vip', async (c) => {
  const info = await siteInfo(c.env);
  const user = await loadUser(c.env, c.req.raw);
  const plans = await getEnabledPlans(c.env.DB);
  const currency = await getSetting(c.env.DB, 'currency', 'USD');

  const loggedIn = !!user;

  const tierLabels: Record<string, string> = {};
  for (const p of plans) tierLabels[p.key] = p.name;
  const vipStatusHtml = user && user.isVip
    ? `<div class="vip-status vip-status-active">
        <div class="vip-status-title">👑 当前会员</div>
        <div class="vip-status-body">${esc(user.membership_tier ? (tierLabels[user.membership_tier] || '会员') : '会员')} · 到期时间：${user.membership_expires_at ? esc((user.membership_expires_at || '').slice(0, 10)) : '永久'}</div>
      </div>`
    : `<div class="vip-status">
        <div class="vip-status-title">普通会员</div>
        <div class="vip-status-body">到期时间：永久 · 订阅后解锁全站付费文章、课程和虚拟商品</div>
      </div>`;

  const payMethods = await getSetting(c.env.DB, 'pay_methods', 'alipay,wxpay,usdt');
  const enabledMethods = payMethods.split(',').map((s) => s.trim()).filter(Boolean);
  const methodRadios = PAY_METHODS.filter((m) => enabledMethods.includes(m.key))
    .map((m, idx) => `<label><input type="radio" name="pay_method" value="${m.key}" ${idx === 0 ? 'checked' : ''}> ${m.label}</label>`)
    .join('');

  const content = `
    ${vipStatusHtml}
    <h1 class="page-title">会员方案</h1>
    <p class="page-sub">${esc(info.slogan)}</p>
    <div class="pay-methods">
      <span class="pay-methods-label">支付方式：</span>
      ${methodRadios || '<span class="pay-methods-label" style="color:var(--danger);">暂无可用的支付方式</span>'}
    </div>
    <div class="pricing-grid">
      ${plans
        .map(
          (p) => `
        <div class="card price-card">
          <div class="price-label">${esc(p.name)}</div>
          <div class="price-amount"><span class="cur">${esc(p.currency || currency)}</span> ${esc(String(p.price))}<span class="per">/ ${esc(durationLabel(p))}</span></div>
          <div class="price-benefits">${(p.benefits || '').split('\n').filter(Boolean).map((b) => `<div class="price-benefit">✓ ${esc(b)}</div>`).join('')}</div>
          <button class="btn-primary" onclick="fcPay('${esc(p.key)}', this)">立即订阅</button>
        </div>`
        )
        .join('')}
    </div>
    <script>
    window.__fc_logged_in__ = ${loggedIn ? 'true' : 'false'};
    function fcPay(plan, btn) {
      if (!window.__fc_logged_in__) { location.href = '/login?plan=' + encodeURIComponent(plan); return; }
      var m = document.querySelector('input[name="pay_method"]:checked');
      var method = m ? m.value : 'usdt';
      if (btn) { btn.disabled = true; btn.textContent = '创建订单中…'; }
      fetch('/api/order', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan: plan, method: method })
      }).then(function(r) { return r.json(); }).then(function(d) {
        if (d.error) { alert(d.error); if (btn) { btn.disabled = false; btn.textContent = '立即订阅'; } return; }
        var form = document.createElement('form');
        form.method = 'post';
        form.action = d.submit_url;
        for (var k in d.params) {
          var inp = document.createElement('input');
          inp.type = 'hidden'; inp.name = k; inp.value = d.params[k];
          form.appendChild(inp);
        }
        document.body.appendChild(form);
        form.submit();
      }).catch(function() { alert('创建订单失败，请重试'); if (btn) { btn.disabled = false; btn.textContent = '立即订阅'; } });
    }
    </script>`;

  return html(layout({ title: '会员方案', description: '订阅解锁全部付费内容', content, ...info, user }));
});

async function loadAccountUser(env: Env, token: { uid: number }) {
  return first<any>(
    env.DB,
    'SELECT id, email, name, role, invite_code, membership_tier, membership_expires_at, email_verified, withdraw_name, withdraw_wechat, withdraw_alipay, avatar, created_at FROM users WHERE id = ?',
    [token.uid]
  );
}

function toAccountUser(u: any, active: boolean) {
  return {
    name: u.name || '',
    email: u.email,
    role: u.role,
    invite_code: u.invite_code,
    membership_tier: u.membership_tier || '',
    membership_expires_at: u.membership_expires_at,
    email_verified: u.email_verified,
    active,
    withdraw_name: u.withdraw_name || '',
    withdraw_wechat: u.withdraw_wechat || '',
    withdraw_alipay: u.withdraw_alipay || '',
    avatar: u.avatar || '',
  };
}

function accountLayout(title: string, info: any, u: any, content: string) {
  const isVip = u.role === 'admin' || hasActiveMembership(u);
  return html(layout({ title, content, ...info, user: { name: u.name, email: u.email, role: u.role, isVip } }));
}

app.get('/account', async (c) => {
  const token = await currentUser(c.env, c.req.raw);
  if (!token) return c.redirect('/login');
  const info = await siteInfo(c.env);
  const u = await loadAccountUser(c.env, token);
  if (!u) return c.redirect('/login');

  const orders = await query<any>(
    c.env.DB,
    'SELECT order_no, plan, amount, currency, payment_method, status, created_at, paid_at FROM payment_orders WHERE user_id = ? ORDER BY id DESC LIMIT 50',
    [token.uid]
  );
  const active = hasActiveMembership(u) || u.role === 'admin';
  const plans = await getEnabledPlans(c.env.DB);
  const planLabels: Record<string, string> = {};
  for (const p of plans) planLabels[p.key] = p.name;
  const content = renderAccountOverview({ ...info, user: toAccountUser(u, active), orders, planLabels });
  return accountLayout('用户中心', info, u, content);
});

app.get('/account/purchased', async (c) => {
  const token = await currentUser(c.env, c.req.raw);
  if (!token) return c.redirect('/login');
  const info = await siteInfo(c.env);
  const u = await loadAccountUser(c.env, token);
  if (!u) return c.redirect('/login');

  const active = hasActiveMembership(u) || u.role === 'admin';
  const purchasedCourses = await query<any>(
    c.env.DB,
    "SELECT cp.course_id, cp.amount, cp.created_at, c.title, c.cover_image FROM course_purchases cp JOIN courses c ON c.id = cp.course_id WHERE cp.user_id = ? AND cp.status = 'paid' ORDER BY cp.id DESC LIMIT 100",
    [token.uid]
  );
  const purchasedProducts = await query<any>(
    c.env.DB,
    "SELECT o.product_id, o.total_amount, o.created_at, o.status, o.tracking_no, o.tracking_company, p.name, p.cover, p.type FROM product_orders o JOIN products p ON p.id = o.product_id WHERE o.user_id = ? AND o.status IN ('paid','shipped','completed') ORDER BY o.id DESC LIMIT 100",
    [token.uid]
  );
  const purchasedArticles = await query<any>(
    c.env.DB,
    "SELECT ap.article_id, ap.amount, ap.created_at, a.title FROM article_purchases ap JOIN articles a ON a.id = ap.article_id WHERE ap.user_id = ? AND ap.status = 'paid' ORDER BY ap.id DESC LIMIT 100",
    [token.uid]
  );
  const content = renderAccountPurchased({ ...info, user: toAccountUser(u, active), purchasedCourses, purchasedProducts, purchasedArticles });
  return accountLayout('已购订单', info, u, content);
});

app.get('/account/addresses', async (c) => {
  const token = await currentUser(c.env, c.req.raw);
  if (!token) return c.redirect('/login');
  const info = await siteInfo(c.env);
  const u = await loadAccountUser(c.env, token);
  if (!u) return c.redirect('/login');
  const addresses = await query<any>(c.env.DB, 'SELECT * FROM user_addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC', [token.uid]);
  const content = renderAccountAddresses({ ...info, user: toAccountUser(u, hasActiveMembership(u) || u.role === 'admin'), addresses });
  return accountLayout('收货地址', info, u, content);
});

app.get('/account/password', async (c) => {
  const token = await currentUser(c.env, c.req.raw);
  if (!token) return c.redirect('/login');
  const info = await siteInfo(c.env);
  const u = await loadAccountUser(c.env, token);
  if (!u) return c.redirect('/login');
  const content = renderAccountPassword({ ...info, user: toAccountUser(u, hasActiveMembership(u) || u.role === 'admin') });
  return accountLayout('修改密码', info, u, content);
});

app.get('/account/invite', async (c) => {
  const token = await currentUser(c.env, c.req.raw);
  if (!token) return c.redirect('/login');
  const info = await siteInfo(c.env);
  const u = await loadAccountUser(c.env, token);
  if (!u) return c.redirect('/login');

  const active = hasActiveMembership(u) || u.role === 'admin';
  const commissionRate = await getSetting(c.env.DB, 'commission_rate', '20');
  const [earnedRow, paidRow, pendingRow] = await Promise.all([
    first<{ s: number }>(c.env.DB, 'SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) AS s FROM commissions WHERE inviter_id = ?', [token.uid]),
    first<{ s: number }>(c.env.DB, "SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) AS s FROM withdrawals WHERE user_id = ? AND status = 'paid'", [token.uid]),
    first<{ s: number }>(c.env.DB, "SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) AS s FROM withdrawals WHERE user_id = ? AND status = 'pending'", [token.uid]),
  ]);
  const earned = earnedRow?.s ?? 0;
  const paid = paidRow?.s ?? 0;
  const pending = pendingRow?.s ?? 0;
  const available = Math.max(0, earned - paid - pending);

  const invited = await query<any>(
    c.env.DB,
    'SELECT u.email, u.name, t.created_at FROM invite_tracking t JOIN users u ON u.id = t.invitee_id WHERE t.inviter_id = ? ORDER BY t.id DESC LIMIT 100',
    [token.uid]
  );
  const withdrawals = await query<any>(
    c.env.DB,
    'SELECT id, amount, method, account, status, reject_reason, created_at FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 100',
    [token.uid]
  );

  const content = renderAccountInvite({
    ...info,
    user: toAccountUser(u, active),
    commissionRate,
    earned: earned.toFixed(2),
    paid: paid.toFixed(2),
    pending: pending.toFixed(2),
    available: available.toFixed(2),
    invited,
    withdrawals,
  });
  return accountLayout('共创计划', info, u, content);
});

// ---------------------------------------------------------------------------
// Auth API
// ---------------------------------------------------------------------------

app.post('/api/register', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const name = String(body.name || '').trim() || email.split('@')[0];

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: '邮箱格式不正确' }, 400);
  if (password.length < 8) return json({ error: '密码至少 8 位' }, 400);

  const exists = await first(c.env.DB, 'SELECT id FROM users WHERE email = ?', [email]);
  if (exists) return json({ error: '该邮箱已注册' }, 409);

  const passwordHash = await hashPassword(password);
  const inviteCode = await genInviteCode();
  const verifyToken = generateVerifyToken();

  const ref = getCookie(c.req.raw, 'fc_ref');
  let invitedBy: number | null = null;
  if (ref) {
    const inviter = await first<{ id: number }>(c.env.DB, 'SELECT id FROM users WHERE invite_code = ?', [ref]);
    if (inviter) invitedBy = inviter.id;
  }

  const result = await run(
    c.env.DB,
    `INSERT INTO users (email, password_hash, name, role, email_verified, verify_token, invite_code, invited_by)
     VALUES (?, ?, ?, 'user', 0, ?, ?, ?)`,
    [email, passwordHash, name, verifyToken, inviteCode, invitedBy]
  );
  const uid = (result.meta as any).last_row_id as number;

  if (invitedBy) {
    await run(c.env.DB, 'INSERT INTO invite_tracking (inviter_id, invitee_id, invite_code) VALUES (?, ?, ?)', [
      invitedBy,
      uid,
      ref,
    ]);
  }

  const base = siteBase(c.env);
  c.executionCtx.waitUntil(
    sendEmail(
      c.env,
      email,
      `欢迎加入 ${await getSetting(c.env.DB, 'site_name', '财经资讯站')} — 验证邮箱`,
      `请点击链接验证邮箱：${base}/api/verify-email?token=${verifyToken}\n\n如果这不是你本人操作，请忽略。`,
      undefined,
      'register_verify'
    )
  );

  const token = await issueToken(c.env, { id: uid, email, role: 'user', name });
  return withCookie(json({ ok: true, user: { id: uid, email, name, invite_code: inviteCode, email_verified: 0 } }), authCookie(token));
});

app.post('/api/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  const user = await first<{ id: number; email: string; name: string; role: string; password_hash: string; email_verified: number; invite_code: string }>(
    c.env.DB,
    'SELECT * FROM users WHERE email = ?',
    [email]
  );
  if (!user) return json({ error: '邮箱或密码错误' }, 401);
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return json({ error: '邮箱或密码错误' }, 401);

  const token = await issueToken(c.env, { id: user.id, email: user.email, role: user.role, name: user.name });
  return withCookie(json({
    ok: true,
    user: { id: user.id, email: user.email, name: user.name, role: user.role, email_verified: user.email_verified, invite_code: user.invite_code },
  }), authCookie(token));
});

app.get('/api/logout', (c) => {
  return withCookie(c.redirect('/'), clearCookie());
});

app.get('/api/verify-email', async (c) => {
  const token = c.req.query('token');
  if (!token) return c.redirect('/');
  const user = await first<{ id: number }>(c.env.DB, 'SELECT id FROM users WHERE verify_token = ?', [token]);
  if (!user) return html('<h1>验证链接无效或已过期</h1>', 400);
  await run(c.env.DB, "UPDATE users SET email_verified = 1, verify_token = '' WHERE id = ?", [user.id]);
  return c.redirect('/?verified=1');
});

// 重新发送验证邮件（登录用户，链接可能已失效）
app.post('/api/account/resend-verification', async (c) => {
  const token = await currentUser(c.env, c.req.raw);
  if (!token) return json({ error: '请先登录' }, 401);
  const user = await first<{ id: number; email: string; email_verified: number }>(
    c.env.DB,
    'SELECT id, email, email_verified FROM users WHERE id = ?',
    [token.uid]
  );
  if (!user) return json({ error: '用户不存在' }, 404);
  if (user.email_verified) return json({ ok: true, already_verified: true });
  const verifyToken = generateVerifyToken();
  await run(c.env.DB, "UPDATE users SET verify_token = ?, updated_at = datetime('now') WHERE id = ?", [verifyToken, user.id]);
  const base = siteBase(c.env);
  const siteName = await getSetting(c.env.DB, 'site_name', '财经资讯站');
  const result = await sendEmail(
    c.env,
    user.email,
    `验证邮箱 - ${siteName}`,
    `请点击链接验证邮箱：${base}/api/verify-email?token=${verifyToken}\n\n如果这不是你本人操作，请忽略。`,
    undefined,
    'register_verify'
  );
  if (!result.ok) return json({ error: '邮件服务未配置，请联系管理员' }, 500);
  return json({ ok: true });
});

app.post('/api/forgot-password', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  if (!email) return json({ error: '请输入邮箱' }, 400);
  const user = await first<{ id: number }>(c.env.DB, 'SELECT id FROM users WHERE email = ?', [email]);
  if (user) {
    const token = generateVerifyToken();
    const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    await run(c.env.DB, "UPDATE users SET reset_token = ?, reset_expires_at = ?, pending_password_hash = '' WHERE id = ?", [token, expires, user.id]);
    const link = `${siteBase(c.env)}/reset-password?token=${token}`;
    const siteName = await getSetting(c.env.DB, 'site_name', '财经资讯站');
    await sendEmail(c.env, email, `重置密码 - ${siteName}`, `请点击链接重置密码（30分钟内有效）：\n${link}\n\n如果这不是你本人操作，请忽略。`, `<p>请点击 <a href="${link}">这里</a> 重置密码（30分钟内有效）。</p>`, 'password_reset');
  }
  return json({ ok: true, message: '如果该邮箱已注册，重置邮件已发送，请查收' });
});

app.post('/api/change-password', async (c) => {
  const user = await loadUser(c.env, c.req.raw);
  if (!user) return json({ error: '未登录' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const oldPassword = String(body.old_password || '');
  const newPassword = String(body.new_password || '');
  if (newPassword.length < 6) return json({ error: '新密码至少 6 位' }, 400);
  if (oldPassword === newPassword) return json({ error: '新密码不能与当前密码相同' }, 400);
  const full = await first<{ email: string; password_hash: string }>(c.env.DB, 'SELECT email, password_hash FROM users WHERE id = ?', [user.id]);
  if (!full) return json({ error: '用户不存在' }, 404);
  const ok = await verifyPassword(oldPassword, full.password_hash);
  if (!ok) return json({ error: '当前密码错误' }, 401);
  const token = generateVerifyToken();
  const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const pendingHash = await hashPassword(newPassword);
  await run(c.env.DB, 'UPDATE users SET reset_token = ?, reset_expires_at = ?, pending_password_hash = ? WHERE id = ?', [token, expires, pendingHash, user.id]);
  const link = `${siteBase(c.env)}/reset-password?token=${token}`;
  const siteName = await getSetting(c.env.DB, 'site_name', '财经资讯站');
  await sendEmail(c.env, full.email, `确认修改密码 - ${siteName}`, `请点击链接确认修改密码（30分钟内有效）：\n${link}\n\n如果这不是你本人操作，请忽略。`, `<p>请点击 <a href="${link}">这里</a> 确认修改密码（30分钟内有效）。</p>`, 'password_change');
  return json({ ok: true, message: '验证邮件已发送，请查收并点击链接确认' });
});

app.get('/reset-password', async (c) => {
  const token = c.req.query('token') || '';
  const info = await siteInfo(c.env);
  const row = await first<{ id: number; pending_password_hash: string }>(c.env.DB, 'SELECT id, pending_password_hash FROM users WHERE reset_token = ?', [token]);
  const valid = !!row;
  const isConfirm = valid && !!row.pending_password_hash;
  return html(renderResetPassword({ ...info, token, valid, isConfirm }));
});

app.post('/api/reset-password', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const token = String(body.token || '');
  const password = String(body.password || '');
  if (!token) return json({ error: '无效的链接' }, 400);
  const row = await first<{ id: number; pending_password_hash: string; reset_expires_at: string | null }>(c.env.DB, 'SELECT id, pending_password_hash, reset_expires_at FROM users WHERE reset_token = ?', [token]);
  if (!row) return json({ error: '链接无效或已使用' }, 400);
  if (row.reset_expires_at && new Date(row.reset_expires_at).getTime() < Date.now()) {
    return json({ error: '链接已过期，请重新发起' }, 400);
  }
  let newHash = row.pending_password_hash;
  if (!newHash) {
    if (password.length < 6) return json({ error: '新密码至少 6 位' }, 400);
    newHash = await hashPassword(password);
  }
  await run(c.env.DB, "UPDATE users SET password_hash = ?, reset_token = '', reset_expires_at = NULL, pending_password_hash = '' WHERE id = ?", [newHash, row.id]);
  return json({ ok: true, message: '密码已更新，请重新登录' });
});

app.get('/api/me', async (c) => {
  const user = await loadUser(c.env, c.req.raw);
  if (!user) return json({ user: null });
  const full = await first<any>(c.env.DB, 'SELECT id, email, name, role, email_verified, invite_code, membership_tier, membership_expires_at, created_at FROM users WHERE id = ?', [user.id]);
  return json({ user: full });
});

// ---------------------------------------------------------------------------
// Public content API
// ---------------------------------------------------------------------------

app.get('/api/articles', async (c) => {
  const category = c.req.query('category');
  const page = parseInt(c.req.query('page') || '1', 10);
  const limit = 20;
  const offset = (page - 1) * limit;
  const where = category ? 'AND c.slug = ?' : '';
  const params: unknown[] = category ? [category, limit, offset] : [limit, offset];
  const rows = await query<any>(
    c.env.DB,
    `SELECT a.id, a.title, a.slug, a.excerpt, a.access_type, a.cover_image, a.published_at, c.name AS category_name
     FROM articles a LEFT JOIN categories c ON a.category_id = c.id
     WHERE a.status='published' ${where}
     ORDER BY a.is_top DESC, a.sort_order ASC, a.published_at DESC LIMIT ? OFFSET ?`,
    params
  );
  return json({ articles: rows });
});

app.get('/api/articles/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const a = await first<any>(
    c.env.DB,
    `SELECT a.id, a.title, a.content, a.excerpt, a.access_type, a.published_at, a.view_count, c.name AS category_name
     FROM articles a LEFT JOIN categories c ON a.category_id = c.id WHERE a.id = ? AND a.status='published'`,
    [id]
  );
  if (!a) return json({ error: 'not found' }, 404);
  const token = await currentUser(c.env, c.req.raw);
  let canRead = a.access_type === 'public';
  if (token) {
    const u = await first<{ role: string; membership_tier: string; membership_expires_at: string | null }>(
      c.env.DB,
      'SELECT role, membership_tier, membership_expires_at FROM users WHERE id = ?',
      [token.uid]
    );
    if (u && (u.role === 'admin' || hasActiveMembership(u))) canRead = true;
  }
  if (!canRead) {
    return json({ article: { id: a.id, title: a.title, excerpt: a.excerpt, access_type: a.access_type, locked: true, url: `${SITE_URL}/article/${a.id}` } });
  }
  return json({ article: { ...a, locked: false, url: `${SITE_URL}/article/${a.id}` } });
});

app.get('/api/categories', async (c) => {
  const rows = await query<any>(
    c.env.DB,
    `SELECT c.id, c.name, c.slug, c.description, COUNT(a.id) AS count
     FROM categories c LEFT JOIN articles a ON a.category_id = c.id AND a.status='published'
     GROUP BY c.id ORDER BY c.sort_order ASC`
  );
  return json({ categories: rows });
});

app.get('/api/pricing', async (c) => {
  const plans = await getEnabledPlans(c.env.DB);
  const currency = await getSetting(c.env.DB, 'currency', 'USD');
  return json({
    currency,
    plans: plans.map((p) => ({
      key: p.key,
      label: p.name,
      price: String(p.price),
      duration_type: p.duration_type,
      duration_value: p.duration_value,
    })),
  });
});


// ---------- PWA ----------
const ICON_192_B64 =

  "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" ;
const ICON_512_B64 =

  "iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAYAAAD0eNT6AAEAAElEQVR4nOy9aaBlx1Ue+q3a+9yx50HdGluyJlvyINvCI7ZaZkgC" +

  "CSGE7hAgEMgLTnh5IZA8SMJwu4FHeAxJSIBgkgDPIQG6Y5IAJgke1PJsY8nyIFmyJGuwZqnnO56zd633o2qtWlV7n9stWbJb0lm2" +

  "+t57zt4111rfGmoVMKEJTWhCE5rQhF50RF/tBkxoQhN6GsRMDNCB8vMjR9zevXtxBEeAI93XjgC4+dd/nXHNNTy27IPm9wUA115L" +

  "N+zcSQCwVz7fuxc4cgTYu9fbV2N7mIjGlz+hCU3onKIJAJjQhM4BYmaCCPYjR5wI2oO//uuMw4etsP2yBKzD2W16BuDP+FTfi0wg" +

  "U8PCAi3s3evkzzuefJIP7dvHAEBEz6iKCU1oQs8OTQDAhCb03BMxMw4DDocP4/aoVR85cgQ3HzzYnOnlAZJAbpnrNaxd8cDakO5+" +

  "9FE8cOwYGjRzF2zZ9bIR4YLTKys4PWxwcmUFS8MhllbWMPQejqqZy7Zve3Vdua0MTLUMHrUNsUuC3gFwVHFFFcH71acWT9718MlT" +

  "922cmcHm2Wns2DzHuzZuo81Ey1949KGP1RUtvWT7BXT57m187cbtmAYec0THCQlotDgLILGw4Bb27nXYuxfXHj7MALBv3z5PAUhM" +

  "LAoTmtBzRBMAMKEJPRsUNHgwQIcBuv3IEQKAgzfeuK6An60cGu8x9Lz57uHSS/7sttt5w6bZVy9W7pK7H3qM5weDl7lBddWTp07h" +

  "9JpH4/2GzRs2XDVkxppvMfQMJod6eho0GKBlBjPQwsMzwXuOIpTQtA08e3D8iMFwcGAwGIQka8PvrqpQVQ4gj9oRagC1IxCAtdOL" +

  "ADNm6hozIGwY1FhZXXtsZTR8ZGpQYevcHHbMb0TV+idOL5/+5O5NG5pds/PLR5889YFXv/Ty4Wt37lzcVLm7HTmste14Kb9vX7Xw" +

  "gz9I1+7dG4BBbPrE1TChCX35NAEAE5rQ06RorsdhwN1+5AgdAXDzGEE/W1dYHjUEYNfHl09deutdd22Ynpu78YsnFquTS6ubN81N" +

  "veWJ1RVaYd4yNZi+4NjqCjA1Ax4M0HigHbVomiEAgFwFbhnNygrIOVSOUDPgidiz98579s6hYgbHnU3kAO+DiHdimycwMUTQEwhM" +

  "DoCABQfAg5g5SFmWt8Cew2tEFUDEnkFgtAzUU9OoB3V41nswAFc5zAxqOAJqMJrlVWyYncL0aDgasb/7/E1b4NvRXXP19Beu2LLF" +

  "rzWr733l+buXXrVp+2cBrIwV9NFqEIDBYezDPj8BBROa0NOjCQCY0ITWoxB0h8OA+7Wo1fcJ+/nBAIvD4eATS09ce+uXjm1ZWVt7" +

  "yyOrqzvaZvTmE95vWVoebRvMb9i60oyAQY0GDk3rMRwN4UBA22I4XOOaADjnwcxEADETEEQbIwhtgndgBohUb2eKWjtRMLlzFNRw" +

  "IGZ4ZpBz4XMQAA+278OBIN8BwXDPIERgAICIw8dEAHsQCMQAUXjTMTOR4wgpOHxNDN+G5sEBQNX6FuwcDaam0bCHm6oxU09jCg7U" +

  "DrHBMVZX1r60e9OmIdq1T168ddPj1Wr78VdceeUjr9qw4bGNwL2OaNQn7W+46aZ6L4Br9+7lfYAnEGLHJjShCRU0AQATmpAlZloA" +

  "CEeOuHE+emaeAk7O//69D7/mVIu3PLC4dMGpldXrTw2xY3U4vHg4PY2RB3xdY3VlBWACswe3jXfOwbH3RIADgRxckOUMZnIOALiN" +

  "JvmoozMF4QsWuR8pbV+mIOgRzfniPudUSoAO+ld8myN4iH8Qh985Pik1MCe/PqtXn6LRgOFifxwAlkrUq8AgCmCBU5kMDlU3YG7h" +

  "onGBXcst6qkp14IxPTXAlKvgRi02zkzDLS8Ot87OPM7c3nrBxs2Pbplx77t2+5bHX7/zkk/N1vXiatt2pvSGhYV67969wN69/sDE" +

  "fTChCSlNAMCEXtTEzHQgCvw7nnySD+/fn0mQubrGvaPj57379i++4YHF0y9fZLpmuDx841PDdjPNTG0fUoVVZiwPRwADbTsCMfyA" +

  "4IkBR84Fgc5ERFEhjRozKJnqY32eGQSPjogygp+toq4UJG40FYTniOEjGCAA8hVLYVGoW2lNFMpnLSdWRpyqNJ9bMBGD9iCOAyff" +

  "xwYnEKMQAEwRCcAFkKB/wRMT2vh16yoaNi2Rg6tqh6nBFAZ1hRlqMTNqMecGT0wBD2yepjun4d533Y7dj/6lKy/787nB4PhKU2C4" +

  "Q4eqhZ07aQIIJvRipwkAmNCLiqzAj0fs2vL7z5968spPPPrUW+87dvzrH1tdvWoJfPlaPb1pGQ7MNYYrywB7cOu9Y/ZwBMfsPPkg" +

  "QqPxW0SmI0C2WsQAJrY9aMdgo10bcRTksM+Ea/g9/pfJrmCad0RRsEZp3jcOEYgglqeiV8uPYl3eDxI+CXTBEPq89IaTayC1ChpL" +

  "wAA7ymP7YxksgIAAeHFKhBLZuBkQbB0MeG5B1LbsqrqmqnaoBhWmiDDLHvO+Pb65nvnijpnpz1w4P//eN19x2a2XTk/fS0SjbDAM" +

  "IDgYJmQCCCb0oqAJAJjQC5skcc54gT93L9Yu/JM//9TrnxoN33q8ab/m2Ki5tp3ZNFhqGgzbFrzWgJnbOsbPM5Fz7IkBYiLVcJPJ" +

  "PWnHVjgKUXwnmMW9WgQgsfgcg/dY/ug7SEdQ1d4I+UwT10+4I6gLX0LS5O0zxMGcD/PoGECRSgn/Ok6jYc8XAEBL4XtiVsEeAEMw" +

  "m6hFgQFPMgzJ7EFMYLSpTnIgeGZmrpzz8IwRw1HlXOUGGExPY75iTA3Xmvmpwb1b6/ozF23Y8v63XXXZB66cnn6QiBZtL25YWKj/" +

  "zwMHQgzBBAxM6AVMEwAwoRccLTC7aw8fpv233844eDCTnsy85f1PPLTn9see+gtH14Zf/8TqypVLI3/RSjWoVxlYa0Zoh0OA0Tjn" +

  "ULEPsgpETFFT9S5sHIrO7ijB1DKOJOTldxCBmKHB99H8T+Dou09EIEiwvSMyPveCCnARmsFwIZIAzNEKUYCEvIgktLUMbX/oH0fH" +

  "wTrFxLJc/J5RWbEfwQbLT6mPGd7EMzj9W+IF4pjGdwUEOPkbhXUhxiF47+HCqQZuCUwcziR4UF0NBhgMaszWA8ysDf2WmfqhzTP1" +

  "x7cQ/a9vvOaqI2/YvPOLy0NjIIinDQ6EzIcTd8GEXlA0AQATekHQArPDkSPu4JEj3gp9Zq7e98gDr7rjyadufHRp5a0nhu31x0bN" +

  "BWvTs1gejtCMGnDToHJoKwaDyDliAjPp0TgQfI8m36WkpXY0bgJcBAAczf6ekrnckotCkjWenqOyL8I4Rd4nYZ0LRGtliA1SQVq6" +

  "E0gc/9oHqFtC9PjQFulL/1iIGT90N/a1pz4zN7EfEqCY3CYKNoy3IAt9SKEOqc2xnwIasjEN9TETcQtwG/BE7RxhamaAWXaYa9t2" +

  "51z9ue1zc++76rxtH//2Cy/7QEX0mIVfE+vAhF5INAEAE3peEjPT4cOH3a/t3Ek3m2N5NYAnmS991523v/LYqPlb9544fu3pkX/Z" +

  "ytQ0lpsWo7UhuGlRgxoQyMVjdoGfQwPUnPxuBZbYpcMT8WfQlMkE1qEQcqCg3SaPtgi5KK6z6L7cXC6kYQQ2PmAcKCm0etOYvGwD" +

  "IrS/UdvvlK8hAYW1ImuDEfQRAOTV52BA3pffPeVluHhsUVqkAt68k7VlzBjIHISyGC0oBCi2zHDEHNIbcEtU11M1pqZrzFbA/Nro" +

  "2K7Z+U/vmqv/5HV7XnLTm7ZsuYeITmsdCwvu0IEDNAEDE3q+0gQATOh5Q+OE/hQR/vTBe1752ZOn/tK9x06/7VTTvvm0q+ZXPKMd" +

  "NmhGDWpwQ+Qphs25ENBWJUGEJGRFD7XCCVFTTcLdpe9tcFwPSUBcOOrXfd4ZQazaLpdCOAXllYKfEMGJ3c5Gu0/t8jE9AMW8AUj1" +

  "ayAeZ8ozxaoJUUAbC4Z5ottnAOAU0Ciavvj77ViRuEQQHA0WpqRAwJxy7b8P8ORoiQ34CWMgwCJCMh/CN5nABPINM7Fz1dT0NGbr" +

  "CvPE2Ob4oR2zc3/08l3n/a9vvfCSj1RER9U6sG9fdejQIUzAwISeTzQBABM6p4mZSZLwWKHPzDPveuDe137uice+/qnGf+vRpdGr" +

  "VqdnaXHUYLS6Bue9r8jHXDfOiVDXW2nMb0WNMQicOoFyKkAIIDj9zgozF60ADKQjfuzH16ZmcANCTF2EeDRQTg+Mo/L7wqqgnnJ7" +

  "isDISIn8zwRz9MsThXTB3gCg9Pw6AMBYAUQAM4UAwHFvANC4AAtKxteQ/u0AAA4ZDyXE0nMOCKSPzD53GaTvmJ3zzJ49o8KgptnZ" +

  "GczxCJsJj1+4ce5jL9288137LrvsfRXRIwoGDh2qDu3bNwEDEzrnaQIAJnRO0gKzO3LkiCuE/tT/fOihr//08ae+7b6njr9tkarL" +

  "ToAwHI7QNC0qoKnZEwjOq84ZgtOEHMSKTz0mbUmg46M1oDDly1MaZU/w0TevgipZm3VziW5r388FbS7wbXtY1G82KXQKkiBD9LQx" +

  "tr7oA2WP5/ECebs6Znzx2WenH6QO0p/hXY5gCQqKPHh9AEDhAiFrgekdex8fJgAUTlIkF0fsnw/2HjmuWFpXxAIgf7i++SYzN0y+" +

  "dexbz85VtRtMDbDR1djSDk9s2zz//qt3bvnjv33JVX9KRE9oQRMwMKFzmCYAYELnDC0sLDjs3esO3nhjCwlBYx788SMP3njrQw/9" +

  "pceW1/7qkyO+bLmusbQ2hBu1viLnHbXhIjsiDSKzPuCOyTwGt/UJ1FwIyvG5UJIII4myB5COsUWtmjgk8QkJeHxehwlq00/LyPj4" +

  "mQo/o9lzPDKIkDUwAQx90QQMkivcCKEGRgIp3e2fy6dSUEubfPZa6WZIzznrVgAFDVwMD0YDhz3xiBAMKAGPZdmlVSC4M3pgiAAa" +

  "djrmHM80pvKSSwYo2lWsmdZYPxwDFRM3IB9dCBVmK2wc1Ni8vPLUeXPT73nljh3v/s6XXvteInpcyth36FC1b98+7Ac8JmBgQucA" +

  "TQDAhL6qJCb+/QcO6JG9mcrhoyePXvf+ex74m3efPPnNJ0DXHhs1WFsbAqOGazdoa/LOA46JOsLMqdBMmfacaKecTMwEwHEeWQ8k" +

  "rdfDG+EaLsgRLTeZwG3VElEvgWecWQdy/VoHwFgUEumzPYK1pCDwkwMh9+eXohHmbwDkTB25790KUuuH5zFso4zw19TBnDISgn08" +

  "x9/XRlIrQe9pgaLvfSctVKFXAFDGEMSgTWP96ZRTkKZKjkNIEa14HYeWAee5BZxzVTU7hbkpwpZhc+yiDZv+17XnbfrDv77nyvcT" +

  "0XEpc9+hQ9U1+/bxQepN8jChCX1FaAIAJvRVoQVecHccvpYk9W4F4OGVlZe88/bbv+6BxRPf82SLNy+5KVpaWUU7avw0OQ9iByKn" +

  "/nKiqBEDiTsHoe6M1juO8oC3pAUmrTyGpfUIh/ECKVoHbBxBfF5M1J2EPPZ95xQs5OUm4R7Ky9ttP+wR8wGMsJw7CLkFxEqQ904E" +

  "N2Vl5E6MVDNl3yWrCgNqAQCCBm2nSYdImx6FNQUAUFJ5aiB3QSQzvlokINo+QvCltzcgSnnl/BkQSGk0PIW+sO2ptiEUSV6jShjg" +

  "tgETU1VNzc5jY+Wxs6LHL56e/d3Xnr/7z952wQVHiGgoXT/E7CYuggl9NWgCACb0FSNmpgNHjlT2rD4zb/i9++75pjtOnPw79z91" +

  "/C2npzfMLq6uYDhcQw3XVNw6BjlRvZI/nwAKx7lAPmlmjuAy8zglgd4RIkhlcTI7O5Kz71nrrdTtEUTdz7pR+P2UTPxsTPdRYKqm" +

  "Ol7rHne+/qzItpElUFJiBFK7w92AgIsBgR3gEBtrY/htOmAR6rlLpGyngId4FdF6lhMtgmLrEogIY+bNMwyCi/EUHJMsiQUnCXxW" +

  "AJFDGiaK7pDwuScD9hjq9klXMLNYgdjD+ZYJjly1cW4eGzDEPPk7rtq29c/etO2Cd77lkl2fWvOhrhsWFuq9gD9YJK+a0ISeK5oA" +

  "gAk957TA7I4cOODkZj0C8J5HvnDNRx9+8u8+cHL5rx2jes8J7zFabTBgbpwDefYOJDpRvLKGgv89yMOk7ZIy3uh71u9yMzZRyBLX" +

  "Lyy92QzJvJ/M87kmXwYIZkBAYgRM0J3exGPaKTXFBAPFqHkEX/94sBH6EpIVna3A7wUkZMaXow8+C1KMYYxiCe+zZJT1ABprUVI/" +

  "QBEER9FKYFwzjJgkqKf9LO91qQRmHGMQOBtv0ejT+ASKFgS4eHLBBBOSwLO4ztiHgEfpuLiGWLoSrjZicDsk7+qpGTdTEbY1LfZs" +

  "nH3vNVu2/M7feOlL/wfFlMT7Dh2q9gHYX1xMNaEJPds0AQATek5Izuzv379flEcw847fuv2zf+W2J5/49oeWVvcuz83NLS0PUbXe" +

  "V84xETswE8OpCT/plE7jpkSYC4nfvdT6yV46U6iRyYfv9euSOnkAegRXpukDKjgpJrHRwD9TTnewSh239E2na4CtoOr39eeOj3EB" +

  "egk0SPa+BEikL/K3iwJZhHDpkiAi4/Fgc9SvDLMsTPYiQKVNpoMKtOL8ezuG5dj1AABrmgfFe4eZzZhBBbq0JdkuHIhiDEhEPRZI" +

  "tjBlcCzb+wxSiAuEieJ9BmEtOALgnWeG99zWbmYKW2emsW20ev9LZqd/4+9cfe3vbdu27UHpx8JNN9UH9u5tJ+6BCT0XNAEAE3pW" +

  "Sc388fjeFIBbjh171Z988Z7vv/vo0b9xfGp216lRi9HaCBV8Qw7OtcGSz1HIB96dtPjwfxddAF3NUb4TwSIBbGW0eBSlomDGYLBg" +

  "UXAWQRgRmgm7suZSuNqf5h2i/GUrs4LgqyAaZ5Ci4y3A/fEA/WLWttO+WwrSAGByYSgFyLFJ6xJh6q9byvfcxjlwRnDmo5SHQbD5" +

  "vGfcY10ecqywAC3ZO7GdnK8JW47+LvMSXQchckDAJtCihYupiGzb2QAycEqQRFHIsyOpRAZYLRAaNxDnuQXaxjPcYFBtmaqxebR2" +

  "+qINm//wa3dv+89/7aqXvWelDUaASdDghJ4LmgCACT0rVAp+Zq5+7777vvmzTz7xf999+vTXrFSz00unlwHy7SDcMufYqW6FoO07" +

  "EHkwu0LDB4QpJwqc3hGp5hgy94ZLdyzbdpBkL1a7FaEjZlyjnVIuKDoCttRUU4u6ZFwVyWRvu8Cwh+VtGbmgjtpwoc3Ld8xUjE8q" +

  "wznXea/XDE9JcPVZDhA1XrnDwBuBG17NXRvhvz6NPyY3sgNRUG7RsOF3sR0UxXVnHjh5XiCNS2NRDI6pPwQJqnAGwBSOMvYNLJv3" +

  "2Zl+x+nUZ8p6YtIhHx9gABUIFXs/Arh1rpqencWG4TIu3bDhtms2bf71v33ttX9IREelkEPMbj/RxD0woS+bJgBgQl8WMbPbf/iw" +

  "RvMz89zvf+m+H/zUo0/9rS+urL7y+FqD0WiEmtE48lWw6pNRjT3Cda5aIqxwJhLmHjQzIZK4ADHHhj/CNbQi3Aga+a5X6rJTBh0E" +

  "rmit4VkA0Qox3uJqTeQi/UqNm/VrCVzkIFjhkkCKAt+LoghA0/VSruWmssZp+2GM+oIS+9pvyyw/6/PtW0sKMn+3WFKiEDX1iSUm" +

  "tTS9pOmErbA27bc/fd9sEMC+6wI5U8BlfChzRiQI2vM+lW4M5B4b6r6n3bJWH3UlsLpJqHjGw8MFKNqO2Fc0mKJNVY0LiJ98yebN" +

  "//kv7dnzH67bvv32eFfhBAhM6MumCQCY0DOiBWZ38MABmGj+i3/ngQe+79ZHH/vORz1d/eTiEmht5KcHjrltHTMTiOORqlAGR62+" +

  "TMkj8icJImMeFoEbGX8F6hdisSCO1gALAACYiG2joEE0Vg1bMG1Kfupy06wvUIOOh6it9glw8U3bsvNyGH1yzcqhTjvPQH3WglTq" +

  "2ZWXAhHD397n1gaHdHXv2EbbYeqpVwAAzGPiFrJAQeoo3R/rEeu4RpDmvV40ZAFFaUHJyqB15qBoDHO0RBWBKSzBARyBEQdLAbPz" +

  "DHDruJqfmcWOdtRctWXTTTdccumvfN3u3e9e9WFNH2KuJscIJ/RMaAIAJvS0aIHZHTx8mLB/f+sAPMr8qnfdeef33n7s1Pd+ibHt" +

  "5OISqBk2A+ec861rkbRzEfVp0UW/PgBQ10xN5ncgmJ/DxTk2wQ96hUdgvqy+3cBrKRNACQQkKST6KZALmFQ40IUAZf0FqDBBZ8k3" +

  "7VUrjJVJ8ShFmTUvKzji4IroOzNfjkWfRSD5/Ps1/z7BPy7osM89kdp7pjsMFA0aq0fRHma9KTBo3113Bii3HIgKnubCjKzxxes4" +

  "iBsJ+bO2HfnpAwacKywh4y0vtk49ohgtQ5y5Q+JgRBeLYwYcMVrnW0I1NTuFHTNTuGhq6kNv3Lbt3//lyy77PSIaAQEITLIMTujp" +

  "0AQATOisaIHZHdx/mHB4f0sAPrV4/NU3fenRH77z+MnvenQEd2JpCZX3Te3giIPgFyHsqAIyoVGIOUoBeoUOr+84CgBAArb0qR6T" +

  "cRIQYnIPGfyIXTImU8xGF10RKviJAR/dCw5dP7ORmfYEAGL7oUJ6zNbKhH58j9JJBDli55JMUiHvINH2QXMV7bMvKPDMZnGrhfbH" +

  "D/SRRL3ndVlA0SXXA5mSWycBkXIu44O9ZnbbT+0GixYNAzh72iVWIHCQlWbJrGc96Q2mjN1ItzGmNcBIoyz1yRILbey37KRyGJ5C" +

  "bELVAjU5bsF+FS1Nzcy5HfUAF6K97TXnnfcvv+Pqq3/fAoGJRWBCZ0MTADChdWlhYcEd2bvX3XzjjQ0B+NDD9730psee/Ml7Tg/3" +

  "PwFXn15cxBShqcEVkwteTkm1CgBgPRImQXpCVgQJVxRfsgRTiUB3opsRIQS89Wii3ghqrYFATs5lE8hR8h0bbTo5ZKM2i/g8sTJq" +

  "ESYp+2AiI8+kQ532BXMywXuJS5CX8otqKLbJIRcipTDLLuIrtM5cC81KKNrtTDvz3AeW9K0eq0i/myCMYyn8Jc2vMX6bhEFpTsRo" +

  "46lrxchqEdO/BSTy00fgB1JLg6wDJumHR0jq272vMbkHEhi10fzJahCPq5agi9LZDh2rgGSk550Kw90SMbeDvB375ikEPtbk0DC1" +

  "rfdE07XbOTeDixh3XHf+zn/9XZdd9Z+IaBWYAIEJnZkmAGBCvbSwsODuuDal6v3kYw++4t0PPf6jd588vf+JwdTU2ukhBuxbqlAF" +

  "rSZEuHsGKETiAUhM0xF1mF4pOKqEGoJWRlRcSBP9zUwAdRk2OJXOSRWPdcUHgGAJ4Hg0jczLRkBaLb7PtK239EUBI2+q0Jb3mQBq" +

  "kSoyPxnBOsGBsWd1aD0GePSY80Xg2aN5WTlGu7VWlqJH5vkxJwRklPriGIx5W0p2+lsOlihaXaRfPqIvFVEKQMLn9uKhrmUj1Zc3" +

  "KFp3rGk+GwgBO4IA5X4COx45bJH6bX/lciN9q68psW511XCwonRBk8QHACAXcwukY5XiepLTLPEveIIfAuwGg2rn9Ax2+eau1+zY" +

  "+Uvf+7KX/WciWgGia2ASLDihHpoAgAllVAr+B3nlit++5dP/8Iunl7//iWpmfnlxhBqj1pFz7FsSZu2UZwtzHS9ExvmanQoqCoJB" +

  "AIA60L2a4UVjs1qwK/3Q0XyqmrwBALGiKAw9xKdbarjSP294fThi6KPWbfogmq26IkSQ5MBHTNQuNAbsoQDA+r3FPWHtxHZcNb9+" +

  "fESsCuN89aFPUVsVQMRUPCNV9s9ff5kJa4V2kF4FXMpER2QAAMfc/yLcQlBnNk4ub0NWn8ZTyOdhXhyqqNnnpnrNaFgIXh0TXbdy" +

  "jVG6HrrPpWLHO/wqlqOudUTM/8m63x3HZA+Kt0lGsOTjXElmRSZZgXHNBauUH3rHbnpQbZ2ucQG1d775oj2/vG/Pnt8lolUc2lcd" +

  "wr5JdsEJZTQBABMCADAz7T982Ingf5RXLn3nbXf+8J2nT3//4zTYsLS0ikHr2wrsQJ48WdOuMFFLQSqRy0+Cp2+FHSN9G48DBiGa" +

  "/0IkzD0JmU6JNpJadV3RQJOGTexUCEa2n8T0GE1atPvwS6lNpoe4/Iilt1EnNuVbq0R6Pv0tGfjYm7ZrvEEypzMjXCLkQ4Q5RSHr" +

  "TYAdgNRH/ZAyAWbLl0ecrce0sQwCVDwBpKyAGShIbcjmjvJARnXH2Db3AAkBgqUoh05Nd8UhWgXaOK7k5SkRt+m9MrahdCuVRWdu" +

  "Ja26aKCszV6XiX2N0QLq9pJKQrphF49F+liOC+BRMS37NTA7V1fnb9iAi6j989ds2vqL33XttYej5HexP5OEQhOaAIAXO3GRwOf4" +

  "yspl/+6uz/zQnSdWvv+4m964uLSC2rcNHFdRpYZG7iNfQJZJchSyIB+O6nWej9poruDGMqx5nyHmWooCO5MQEO0xJQpSAeuS9pee" +

  "TNpmkH/eyPLcxNsXdEbMMJ5lc8OcEa0qMKI1pBgn1TI5af5SvgQBSl0OIfVsMUjxFztOEnsRryxmOasfgZgADyKQjy4Z1S5zyiw0" +

  "SFWXV/iWVpKIREC+X/vPyue0hqSdyS1DgE/JnHidNo6Lti9JjUixPo7ja4V83nfpn8yeWJHOTCzurjh/oU4b7d/jypF2xdpCBuMI" +

  "fs3+CX1pY3phRAtOyCHAgjGZ4Zh827Tez07V51UOu9D86V+49LJf+WuXX/1na8zAwoJbOHAABydA4EVNEwDwIqZDhw5V+1MCn23/" +

  "+rO3/dTtx0/9H49TPb+0tALHaAdgBzD5eCmKCBOgqwup0FOTdHiWfHkCwHcELJlCydQVygsavZrUixSvIYOggxdNWawTAi5IGCzp" +

  "0bRQl48CvCtQxp0uIMTLcpC00z4AED6tYpesyThp5czhhIJqmdEeIa4PPaceLQ5ZZHwp6BgIxypbxOhJABJfIFaBHDSBGS2lWdHz" +

  "9WZO+0BQrCkACDsPcbwrcvCs1/egjyQAryzX1muzJnZOBvRo0F2KtiAO3h2koU9zixjU2WmqASTxb3nbAjVdjuNa0AEW8QSHASTa" +

  "KANEwp/RzZWlhg7jJtYdjqmDbBZDinks4grwIwBTM9NulyO8bHb2PX/xpVceuH7z9o94ADfcdFN9ZHLXwIuWJgDgRUgLCwvuIAAc" +

  "POiZeeZXb/nzv3PH4uKPPFzNvOTU4gqmwI1jXzETsRMWWUczb/B9g3xn8ZQatPBpV/BtSrZXFdb6ZxTykvM9vCBardEZC35FEL9t" +

  "ImWyxo+cHxXMgch47TYXhGJiL++XH2faDdpjWb/caojQP0+p+QSQMftzISiymwkRBGXZBzGDd/qi7YvWCbEKIFpGYp+y/movjeWE" +

  "bbskiJG0jrOXJnlQX+k+cU6EYN6/klSDLoERhVMfusKM68o+b9dgp4WFRaevHRI3IKAhfOW1T8zJgsBp4rXtEtHRF1CZqknvyTww" +

  "i+UglR28I+F/Ti0I1Da+panZKbfDgV+2ccPvf8cllx24/LzzvgCES4cORivghF48NAEALyJiZtp75EB1840HmxrAH913zze97+GH" +

  "/sX97F55YqVF1fqmZl95ZlIzJkUNmylEJkM0WSQNHV7N7UHw54JGTl1bDk/KwIwAgAj9DBLoNwyvzLW08loAkGluTGAnGnCu1XEB" +

  "AJjPkPVN2moFRo/JuRNkRjJcVniY7+M4mxLGSiPHkqfQHE+DM3n57XXHScgnIeuz79bT0Lt9kTfTMT4xcbcGAJxJWNt+KrAwdUq9" +

  "6/2dSsh7UAK1zhwZK0IvVBvX5gIhJLAoxYb1J9acsEYN8OCojxuwA5jTD4huE1nbZpFnwZvylVo3krslgYeYbTC2mSNgJWZwhXbU" +

  "kJudHdAu55fecMH5//4HrrrmF4joUSwsuEPXXkuTQMEXD00AwIuE9h06VEmA38efeOiq/3HPfT/5QIvvfnx1BDf0TUXsPLxjZe+i" +

  "5kFT6bbkQFwhBc5JBHm6aEdy8QNQZphMuZLwJoaWsRVilr8aoS/Mj8hoUSrBVdvJAAAKxiu3CKppvM1qVDPwOjTOZZG7CWDaDKS0" +

  "w16/y46oiSwS0z9k2Dk1PZp8mVMEvVCUIVH4JwHHUqqL6W1zo75q+1JGgloi1lMfiaOZXzVZo7sabdpr9cUY2ekqBGsI6kzt0AHQ" +

  "96322z8HfdH5fdTr0pF2WNeCttuMgzzTASBnZp9kByCbh7gWWGZAALasHQ+5HTPI8vSs4G4pzfbbW8Gf1czwaFFThaoFWkftkH21" +

  "ZfMGXMb+S6/ZuePnv++l1/z6EMANCwv13gMH/CQ+4IVPEwDwAqcFk7Ofmef+1S23/OPbl5Z/7PGW5pfWVv0AgPN6s052kxkR4pE5" +

  "DkIUQQjbZVOJRIofpSxnUThEU6bcoJcEvo3Kj3aEcjWauoPgcdDsbRkRgr89l442618I9jOAxbybepyEcS/L7hH65edZ863AiWlj" +

  "CQ7MHo5CYGPwqMT3STS9bhnS0rLr3nRBTMsCvOSrXPyH2+dEsjLCMKfAyELqRrIpl+3RNmmbF/tNn0sFqVi276tFBVpncmd0rRPj" +

  "hPh6Foc+t075fUmZm6h0J3TKiluHWMc/rSXoPujWncCgrEc78xTtK7pWzeaw8Qdlu+VRiudWdSR1jGU+CMTgln3LVNXb52awuxq+" +

  "9y/uOf9n/sIl134AEKVhn++uugm9UGgCAF6gxCa6fwDgt+68ff+tR0/+3IMtLj+xvIqK0Va+qdp4TM9xcJV7FYDCXINfWLVPudku" +

  "mizLTG+ZdsWmHH1IgESwMgarQRACnbz27NAhCQiEFSapAgnsitVHAcOJ+VEpVBzyICvzHQrhqdaMbjR8GaTGLFpz0OCdC2Z6wAGc" +

  "LtABk54qCEOV0gKX7oksOj8pejpu6j4hESh5XzJbiyiaQB5jABRiCFED5Q6z0GRLihkS+CAiIJ4GsGVyT1/OlhRscLct67yUCeAz" +

  "gQdxG8g71j3VmQNKp08S+ErHSmHWRbfOMFekma5Yb4UEortK10OcVwMiGFzulgxkBFdQBJmO9J183GKMgAe3QEuzg3qTX8XVMzO/" +

  "+YOvetW/PX/j9s/Fch1NrAEvSJoAgBcg2ej+248+eu277n3gV+5YGX7dsRFAo6atuHUtQOQIFfebgYUSQwwJSMRsSS6cUxYhKwqG" +

  "vK0LS2/hiyKIgjHSGYHRy1lK4U9eLQIU2xM0HJf4omaYSTn/kxUitWWs5hixghw/07S1mck1Bd2Jhtc1bXMaScvU1cQrIEgGzJmc" +

  "QawJX/o0PBu5LrJDYwK0x+lEgeqppom9QilNGOz8c5TuLtP0BVCQQMFO2WdDmXXjDJq6Fc5S/zOhcdYaiV3ps+JYzT/MvbzDpixn" +

  "3k9xGKX2fyYLRQ5oOa5pOeTvwd60P67JgG85ATFFW8E1542FKe2HdEW1A4fgW6J26L2bn5+h82teecXWzT/zg9e++heJqNl36FB1" +

  "aN++SVrhFxhNAMALiIro/o3/8Y47/t4tTx498CWq54Yrq+2APfkYEy+BQyIY2ijYwJKARBhY/D1Iu8AAwVGLLbRpY1pOQrULABDr" +

  "DSyOk3WTyQhX0tUp5YTLfMLHIuJZGCYAjgld8mUtv/t4uQ8yTSpvK+BYkuhATdx6CVHpNx5n3mVSc37fFktgKZ1NU8FKYrkwfHyM" +

  "n1uYOZfd5WSy95SsBX1ldS0ilAl0vR43mFuy7xwjnXlfl4ykMvRMLQEd03z3ARWkTweQjBuXzJISAUAS2BLp76AxKpyApoxdXy4D" +

  "qStvA0I5KINRExgIVzBTcgPE+fXRqoZYRqA2gORkcpKawBwyeJL3ulJjBFCzCF9v2TiFK6cGH/mm3Rf86NsuveLDQK5cTOj5TxMA" +

  "8AIhOcZTAXjXF+/+lo88fvwXH2BcdfTUImpwS0BFvgVTOJsut7qJRp0YVBBKcg496JcuaoASrZ3XXZoV0085ghTOoycpFN0OFBOY" +

  "6LtOX+9E1idDOcTynLQz0Ubb+EUuqEnzFHcFQemztlq1h4eLLgo5Z81AOilgXB1Wewt5DFJ9er6+MF1bMKJs2SKAcYK/57PEwPWp" +

  "ZEnooV7ha/z/5bjoqX7r1+c8biNpyaXQJbAnkMttPdL/pwMCetvNqW2h3G5QZ19sQtH5hMzQt/7Sc8ltRNlzErvgKM0NcQjebNUu" +

  "NKZPkODQuM88QYNrEbP9KdozriGkNqurK67DFAxLEahBXTNA3JJsXWoCqsMfHr6tpmfr3QMeXjU79cv//Po3/zIRHZ1YA144NAEA" +

  "z3PKtP6lpQt/7s47/9XdK6N9j6yuAmujpq5cBbCcugukwotSOnVObDMwhCrIA7RBU41Mn+2ZeiRNM2isDG980EKJSaYIZnS0s1xw" +

  "B2NBUF8zrTO2UoPO9CvDvNSMLT+zYguNLhcGKRc9hwx8sbwqtk0ur1mXGAgR3F7BSeiHEfDp0V6FVoWZ71pagCQI+7RbhxRiSVJ2" +

  "YYbuC2K038UvbIcykvz08cGxQ2F6hE4hyC0p0pY+YFMK7047k11eCl4XWPSBlPCuRzAVmbFRgCGadXzOQK7UhFgmC3gMVhKPlMjJ" +

  "kST5jfECERB7Su0ORzujos1ypXV8h1PkjQZjyi7R5Sk1JFeagLi0Z82RQUOeADlOyozWt6hmNs3g6kF9/zfuOu8f/oXLr/pjYHLJ" +

  "0AuBJgDgeUyi9Q8A/PYdd/yfR546+lOP+/q85ZWVdhqeHCrHSJeiAID4mDnamD0AMRlzFLoB2AsTzBm0kA2WAgQ0iFVBIu7T8+tF" +

  "YGsAlXERMJB874a5O9WWpGlsZVt0bYwBAKYf43yxchyivMwmWF9JmXwZJd4VyBRBkZhqUzsFo5ylZVoF4DgtliD1MDzLzYtFGfaD" +

  "M7gBLNl4htQegndAnlNgPKU6DKCQf3vqX88Ej844IwNWNmivr1UKIMzvCRhT9GtA59W2WM3zuiZ7glTj0zIDpfmfWQBA3FsWNGSW" +

  "ItH6SX/XLeyjiq6nB1hBeL6mJHQzPOcBEDlNMRzaw7BROEThlkMmjsGWhJqJG8CPyFe75qbx6g0z/+ZHX/vGnyWiJ29YWKiPHDgw" +

  "yST4PKUJAHgeEjMTHThAOHjQHzt2bM+v3XPPL3xu2O5/bHkV041vp8AVkz0f3vWMA7DmvlxY6xsiYEiFVs4W89KYoutAJZx84zNR" +

  "PE5zzSOwoTUxcYrvi1xOL8rJGGj4LF29mgBFKXzGtkH6roI2allE2SB1dF/DfTP3QCyPYwbFMsr8bEi10DFav52NTokCogB16/Sx" +

  "ai3XkWqkAhw5giESYGTqKX3bhU4dPrNWHkrjK16hToxDIczD51JgBKQ8HlSebWxBKjKU2Wl7BnzFhB5PccDEGIgmrws3jJ5propY" +

  "B9snNqWnNqWA/1CWg4NHq+/72GZ1Koh1LrOVEaAnCVL/rMUsWBPkd222fisKgE/7z695j80bN7oLXHvfDTu2/ZO/ec11fwjkeUYm" +

  "9PyhCQB4npFo/TWAf3PLLd9x68lT/+aRanbn6vLpZtqjQpWweCZ0IZufLGdWLTfXKAuNL76sQXi9zFU0iVR+YiL91Kf5CdO1mrb6" +

  "5aMwdtFSYXtpo8RtVAFzvOVXU+2endB1GaOMmpnRGINPlVTH6huNcf0dG9RnhXvHeJFAwNMiOWvOnOmrWgpBBaoIEcsWFNcYCWX7" +

  "K3PS9YWb+SXSexrImj96LEt2Hvu+k/VHxedZYwvrTFaOMenb74ouavtzABDOh5CJzA/gyJwuMSDQHpFN+Ro4xJQU9VtS9won8O4j" +

  "hHAc3FBpmcg68j372CE5DgI5iLOgiMfosQoxc+pPzHPgGPCem+H0oN49cHjp9NTv/NSb3vLDRHRicq/A848mAOB5QlbrP/3Y6V3/" +

  "zz2f/tUveP72Y8sjTHluXUUVcRv95mliNTCNu4xZgo885ZtftBTru0+X2KTjTvn3ECSRZbJT06SYO1Um9J9xzxhxaeIWsMLJ+Gpz" +

  "rIf3xSMqpQmltlLv9zmJ4dWKRbYCWr6lfgBQCiF1c1DKgpgelfFMfSCuBEGlC4tsi88CCCRTchgRnUIqRiZMUJynNALSGiBZxsUa" +

  "I4Kn7zZBrbuYUwWPnGJBxKKQAihjuUjjYcdR/h4b3d8DTrP11AdeDejoezdZ0UibkjAHx8uhROsPz4axT1YAJtHsU4AimbZpU5DG" +

  "tDIozcNn42iaHtvi84YJMEgbTtsnZn+KINYsKlNwqC8bY0oWAwfnV9nzzNx0dfV09eDe3bv+8bde/rL/CkxOCjyfaAIAngckwTY1" +

  "gP9y951/671feuwX7nVu9/LqaruBycVEbhljccgjlAEoU5KNHix84qvP0X9gDi3UaKlCiCBHjMLnkTGSj0LGBh0Ju4rJxLgQvAoQ" +

  "jPaInGGLYAgf5H1ykS0SSHPhE8EkVAFALn4gjFASq8hHqUV2tIiSFUBM4Lmojwx1HZNzX0BdykbIKG/Dy5gtJ7dLdsyOk47e8YUb" +

  "C05i9kFoIwoezfRYAJAEs2DAXmxAHDObfMgCKfFz577u7ph4DnctkIxpjyBnM65W2GXlZUKp0Ojjez7rn7kK0I6hWpuMBQElUwyA" +

  "TerW9agVRmAXb2JkpPboUVd1rSThHqwAKZNC2gyK+zIIVibJ0vFgOx/peQEhYf6kTXkGTMELwa3Ayd2lIKc7ZjJMnsP9DzVcw5Wr" +

  "d0w5vGxu7ud//PVv/GkiWomWyjYf+AmdazQBAOcwscnmx8zn/dynbvs3n1pa/BuPrY4w3TatA1dyHWhFTrUYR1RcwRvLQxIEEjSm" +

  "7IJT8pyM9LpcwOhxBjgEBhuS+1jtOGquDICqqFGUiXgKhUxzBUTNin28wCcevQP0MsJQUGSLYk5mYU5WWFQRyNijVl0FWlkwJ+Fj" +

  "Ra8NYusLIOwMmwEG7DlmX3BGkCUA0K/NlpDEas/9PLX/8yjATKlZmaHgAM6ywM1Qvxw/kz5K4qhO3UgabtZedMd2XNv7A/jSX/a4" +

  "XPltNk8saZGSNpw+z9vXZx3IWmjvkijamYIIw9yCkmXHugCIooBlMqMagLIzAKAjdE19pfgun4m9hF2zbE0PrrtuMkA1zqIi5cd2" +

  "+KhEeAJaEGrPqEF+hUJswCVoPvstF1z89992xRUfBjMtAHRwkkXwnKUJADhHaYHZycZ5z70PfO3/ePzh372r9XuWF1faeYbzVcgi" +

  "ajyTGWMiXzBiMRMaUUCQpCbhuyBMybwHZHZjozGLZUAODwqTkjgDBqvm6DiJU48ywgBgapWJEoK/OKRIFSYuR5xEexTmJVZG0nZI" +

  "PYk5y/0B8RtV9kgTqmivrPAXLUgHI4yBsldxdRSmfhm3ZF0hLTtdSi/vWO2vH1iUWlhWnvRWNHXRBdXVAzATJA2CvGvPm0dMqPWF" +

  "9+3Rw6SKyvGxJFZNd4DgJ4596wT1Afms96Ew029NdiPqsLTP1JeAHxcXSObjqeCVuxDXQFr9J2nXDJD4/cdbeiSBFhtLgefgLw+n" +

  "a2TOLKwJNRN53WJj3RoR0HiH3jEbBwDkOwVNlOaGZTzthCKfL21LDyhh86zsPQ9u3FRd73KE1+7c/HM/dt0bfnzVt5MAwXOYJgDg" +

  "HCQJ9GPm+l/edstP3XJs8ScfblvAN+2AXCUR8CJsSWVzZIhExnwd97Oe900X7Ih2oIKeAbZ2XCOgJGudHpGOws1qZDkDSwAgu8FO" +

  "+b4xcRu/ZWJWorUmzTsIYJ/aAom/htYvVYuQE2EC6UkheCzMkO+EkeoNSUiZAUsJosw0O6tdjoUTBpnG0wrYQnD3lWHBSuqDPQKZ" +

  "3CXynrwr9zjI9ymXgYxjKTAZFkQJlfc+aM0iVIj1WGmfwMyAg/m9DwakPojcYvtleteCMDtmhcZ+puBJjQAgk4GP8tMzpfDPAu76" +

  "+svWLC/C1pr+KaxzzsekLyAPSFcGsfmcTT1nsrA45xIIUvMdg9v+eZJy+1xNvmc8GR7E8EPPtHXbPF3u/fu/96VX/r1rz7v47kny" +

  "oHOTJgDgHCJmJjp82GH//vbBE49f8Y4v3P87nx3xm0+cOu1nAld1YvInl3y8kqc9HcHLjxupN56Ttmmv1c01iOTDD0mAAMQ7AMJD" +

  "MasfBHUQSqGqpBZGnx5PfTVMp+q8Lxp7ihuIfysf9fEkQJfZ94xrxixdwdDGCSEr8Iy+nWn7WUdR9sECFwEZEZQhBC8mYdMFAJ0+" +

  "mFrSfFrtNAdw1p1h2a5XdVcEqV0HBCJv5i5pw4yUKCmdPSdTrgjs/vlIKy4bpP61s85bZbl6XbEpb90S7dyrJSQU4KxQ7bNcIO9z" +

  "Hwgov0uf5+MjK88Vje1zo1jyHI7mSSf7xjWzwPS0NX0IpMDAHKTZfpVllQAg9S/ypZFvBnMz9cWz1bEbdu/4h99x1cv/MzBJHnSu" +

  "0QQAnCMkkbMVgN/63K3fe9NTJ/7fL/FgV7uyOpomDAAEc1vcd46SkExMhVIEfxQI4Syw70y0DXAjIj3OJdp+eTVtAB5B9gcem/Lu" +

  "W81bTNtybjw2uzBla/pBECrlv6odswhLSX+Kjn95HJ1J45Q+j38/ySMS8zlSFjWpQ4CEWBvWAyFqto+pjgVwqCk+AqS8XWnkk5aL" +

  "LM3sGQGDaP6CvqJg9GTcNnJZQGbFyedM+lMKKnnHAstkToHJP29AVkcoWovG2N7EAo31yvRz3VVhrAHl+Ei7dKXGPpMzVi1JiCVA" +

  "qmy3oXUtDbGPaQxJj9ZR3ADjwGteF+taHF9VDgJtGzp7wf5SzHlom8yx7V84laAApAOmGY4ZnqkdOq52zk/juvnp3/6n17/5/yai" +

  "o/uYq8MTEHBO0AQAnAN0iA9V+2l/y8zzv/DpP//lTy2uvf3hpVVMeWprcBWEoZ2qoKXpJ8wgcmGDa/Cf0eoZuQoopQhaB9IRO8CY" +

  "UFPWsKRYpuxvonE650LK2vhcqL3taIhK5nazXHsW64P9PH5nGNQ4Tcv+LSVC+hT7Gx9Y1zQs8siZYWuNfEPBYIkotQ0VVLzHeWH2" +

  "IOcgBywV7ChD9hCT/VhTsmqq3fPbfaDDAgA7qgHAxfFR4S9jGN0M4mpRIRD65wQnGOtAGo4eTbWwlth1nPW18+bZUwkASgGdYgnG" +

  "jWkyn8PZczRi5SA4R9la1rHtLS9vW0kWAMSnevvUBzQU+BGFANl1wEifO6lL5R7I65HxyYqKW5HlVI9ZjwlUhZ8eDO/BLTxvmZ93" +

  "F7n2zr98wQV/7xuvuuZm7NtXLVxzDR88eHASIPhVpAkA+CrTa9/xjsEtb3/76L5TT73sN++8+w9uWxm9YmlptZ0BO+/CASYSY7SZ" +

  "LXucT3y8hjeHZ1TVTIzeEjE0kI2N6TRotMHsT/p3qFM1WfQw/qyKpD1k2rExPUvUdLIgxOQqSIIICO4OVudyofkU2mPG6Mx3egJC" +

  "tHHuez8fQdKfimr6XQBs+hhTyScAIMJE+l1o2gDs+Wr5PBtMo2HnMfBFM0w/mJF8vgr02DQ1WiMch3FnIMUwULooRoBX0IXH1tkR" +

  "QEA69y7fFdaF0hVzNsRZS0pNuChrvIyFzHUQ/nG9UQpoM1jRFEW6XuR5AQ8MaH9KgZ0JainXrAV5dpwQVwsJKVzMujUuZqADksOH" +

  "mTUBWTv6Ax1z/z/MOwEosixkWacsXCTEhNTew/uqGU1X9aWzA9x4/vaf+9tXvfLHG0xcAl9tmgCArxLZS3x++7O3/PWPn1r5jS+s" +

  "jnZgbdjUjJopaNiOKGj3BWWbmH3m808CNed8vT7yQp4JMwuarDwiUfTJTBBkcxLUCaBEJCK2bkDvMM+Fc8+FQWzrt2AgMiE2fSb9" +

  "rbOIRTsrA5dU1hMgfk95v9eqEMcwCfEkNPJxBTRHgTkKZt8LIM4FywiCFkfqVkmMOJlavTJVEsHEqS8ljfvMEaX7AfoGS/rLccQp" +

  "tJCQ4khy/XD9ejVgrRT+Wg6hXIL67lmUX36uOidzVm4uXu2HBHtFta6oaPIRq5Zq/AnRKelYIll/7LrotUYV/cgOuYx5Tyxxcquj" +

  "nQdGyikwDnSU46UxDQo45e/0vZj403jmwKI8ORP2kLgboaA2zU8Eo+EgpF9hxu4tG93LBu6/LLz+zf+IiJ6UoGdM6CtOEwDwVSBB" +

  "vTOuwi/ddsu//uDxoz/06BAYNNwO4KvEKEk3Ya/wDt9EuZt/bwOYzlbL6tZhhUYsrwAAogUlbdmkSDXVdjWU3O9dmlOT8IkWiowx" +

  "Jc5ZyrS+Mej61gtgFB7qLaNsn/r/OTBgIoQbENVrwcpQU3mIAxYFiTPgIgKA5AePgZ0uByhyn0LW7rMAAtpbBT6hLWJ4d/FoGQNJ" +

  "0MSkNWCCd5y5QqSOM5m/xbugpwmkCQpOkU3cmRhR2S8dm3XM/ACQCTHwWAAAsMGX1Pu+kNN1ZcCztQys03Zxu4W1I+PMY/tIZIBF" +

  "MZliZZG+9Z/R6JufHtDG6ShlnmthTH8MYE4WJiBzCagyQAH4xjUxarmZ2zhfXzXt7vreiy59+ysvueTmBeb6INEEBHyFaQIAvsKU" +

  "jvid2vmzt939n29dHn7DyZOLPADDOxAxwYlgddXYclQgeYbNVAaYSS3M40+b1CRvCuWc0ZALgp4FCDDAhoEQKLvVL2kPbWDALjCK" +

  "Utt0kTEyAd6YWm3/zyYOAPE95xzEX67fW0Zm219oRP1xDJZFEiTDn97bbuzPau6n/MgkxKIS35AsAcLeOTLjIGXaxLbHzqn0L4E/" +

  "m9TPpqIlJAEULo6SnkSLC5l5A7p3I6AfCNixzzIDWgHJmj1CBtCMU78QLP3ion32Uf/akLfkswROwJySNcltf5m1R4BDChaUEc6g" +

  "pbG8ZWvHi1oc5yguvXHHKrOxjcisO9b5egp77uxuZ+xgAZljCLAK4jzdgFmMhiAfs38yWM2cz4/uFa8XLratb5rBVH3VhpnmTXOb" +

  "vu17XnvdH+PQoYonRwW/ojTuPssJPQckwv9D9933xh/6yKePfHR59A2nTy2NpsCg6O93RNHsjw5zCdpAHnwE6pr79KsxGuL6ZtUu" +

  "ExZBYnPA22NsGmgoR/Yil0y+X1tJKrVkf8SBOaiwGWcrRpf5K1My5n/5T03qYBCx+ugRzbfkuizTul16tU/K+0eOIRkHU0fL438+" +

  "Wks4AilWbZRYgvSSthowAkHvDuDxAXMKKMY8kQEoRTocj9BxmlVKFhx78kFgjSS18VKn1QLN2OtYyYjoc7aJDhKLoONq3zXvdF1X" +

  "42WEApFi4ZGZs/J1cjEmwhzNDEItCu9oBpG0yuU+ISm0DxSJHIesenEIUdamrD3Z3uF8/qwgZoTbG+PvvfvClFlap8S6I/EesvqE" +

  "z8jnVaxWLHIKIJGmM1M8pA/xQ0fS63CbIVWuHoya9gsnV6s/Of7Uf/v1z376oNu/vyUiLCwsTOTSV4gmFoCvADEz7T1woLr54MHm" +

  "dz7/6W/5+Kml/3rvqbUBjUYNHNWi5RF79Q2G28OcMlnV1oB0DJ9FyCcm7Ozmw3gtqV+zlXfSPeRqDrQZAe0bVtszZkQpjkT6QWSO" +

  "mITj7WZGK+22BFHYnCnyX6Ltcw1Ux8S5aCYuR6G7/KUMRxUY+dhK2bGrndczLVX7nd7rNVEDYLG0mNwMpMesSDXA/r4XbVCzq4ED" +

  "8e8W+bpwkNMdacIknTKbM/1yg5zctyDCT45Baj9CwcEsz1Gjlm+1ihSLQWQuPCqsWHY8gSISHbkFoJxFLsaoTyCnIDxOCj6kYdmI" +

  "QMwkNhg0gCU7dnlL+ubIgfTyo/S+aVenH8m9ByRwiL6x0OrjGhJA3FOq/VSPDZtik6Uo9F/XdSxWxtfGA2R90L7HsFOfRpPhg0Ek" +

  "1sHe8woYF+7YSq+uq1/70evf8MNENJoEB35laAIAnmNaiCl9HYB/97nP/MxNTzz5448NgRlm75gr75ImHBRTYZxpYwoJvxXGIEw4" +

  "EyxmE2Z/nxWJqlKYaIEO01EtP36ZouN7BJ1oKoTA6FHFn8l0mMyd4QPbbw9WE3KnxR1et47Zvu/FdcZCgvYyM3T8pj8hUMHIpS89" +

  "JmzEPjtOxn3xledznqwZpVArteUsPgE6RYrdPAF6BFOfkAc4HxIi0c/RiiWA7XgHSxV8shIIaJD3x8+ACNPipESP9izHKHVAWcbS" +

  "rLnSYkVd03xppk4m9hQ82IUTrPMH867CmihwWQFBAivOkQ4xoy+HQrd9JUngpwLmhO3SOJp3vW6c5Nrp1EFIx39FiehWrGCDEPJG" +

  "VIhuFA73ADhyaLl0d5kiBACI3hDnUP+Oc9+GXcZN49sNG+fq6+emP/STr9/zrUQXHZ0EBz73NAEAzyFJch9mnvnZT3z01+5k9/2P" +

  "HF/0s+zJOxcN+onJBG01Cf9ASQsFxCLg9bPEb3OBm/lLC02on9EKFySjiTpRUeNxQamQtDxphej0oomn8j3UzCsMyDJ+z9nZdCHL" +

  "MG1EeZ8gjSNg5HE/U8r6ehYAILg02rHj1qvlcX/SIPsOkBivj2OqwXK2jtjGrM9qgejOqdTPnIR5HP1sLPMBSUmZyjbm45YEnrUA" +

  "mIR0sS/rl6Ofjzma2q3XaOqgGHdKEH+yFZLpHQ55FwqhH2Rjj+kesV/MADm1ZISxjkLMCEQARsD2g82g7UugXh5SZ9vbcbeVa9yM" +

  "u21XAkcGRMe6BHo1qu3Lv2k0IlQpMobCrDFSgOSJNe14QoGEdNBPYoVyfmP7IVZF+dzHoFZPAPkwn61HMzU9V182wB3fdcWeH3zT" +

  "JS+5+YabbqpvnoCA54wmAOA5IpPPf8fP3HLLu/98dfi60ycXm1lyFYhJ9Gs1PUbtQXhoLswCSQyAMHh9ojT3FVoim88zgaQaEClb" +

  "SMfS4t/C9O0RvHLZGFAAIhVmiXHHZDiQDqsepmZVq5FZYc5GOGpfkTPKvCGkzE00JDFVrqdBZ93h1EcxVcrvmgpRRsxwdmXQ0qfY" +

  "pDGW2GTRGaMFE6cz332m1uAWilnZUjNgXSqZEJQ2GRJrjJXkydTd13gz/8YCxb2dLOuygFHqyAcpBzvQ9a6946JtzBmQ6FvftuXy" +

  "sdara7m7rsOYsRk8s++ydWzeo5AuWZrIJAI7PSlusc7Ijlub7JOVDOjMi/1TrDOy7zWDt8huyI60/ZQLxdIAafvjSxYAhDJJT41I" +

  "2/XSI9OX3Erl1UWoYMEYd5wHqEXbzExVl9S8+rbd2/7Wd778Nf91Ehz43NEk2OI5IBH+9z96/2X/6MiR9310ceV1q6eWRjOuqr1L" +

  "OhhHzRmKpAOJ0FVFEMLszZnbkpj1v46wjL+LsLHMFkQ9F3sQRAiHPR4YL2UgwP5n3jQbP/xnpA4xQLnZUNtk2xZfKTPXlUQFw1Hz" +

  "ovnXDGjOjJDK7fjlKQQ4JkVczLsEIwHM50nOcGy/VGLZvIyJdN8b7d5KZytW4kyY8SzqNe2WTH0a5Y/UFHLyfJeHCsaT58LZbfuc" +

  "ASEqWwnknAYuntHlkkpJ2id3GVBoS7QuYBxIE6GfA5fwavZHNk50Fu1M6zGWI9syfqZzaAfNgnSE/dQaaZuVJ2vCzGfW/z5gGteH" +

  "Xd+5gOVs/UtLbPtk2fkowPMWFy4TBfMAx1RkCtjiFwxWRcECzqQHpL2V7zPKtpG+xwA7Rlv7yo9W/d2ro+n3H106/I5bb/v5SXDg" +

  "c0dn3rUTelokV1++94EvfMOfPPzkH3xmaW1rNUJbs688MRyJH1nS4catJ2evI6Vgs67vt6RSg+x8P+bzXi3a3H/OEvikzCvXtrJ3" +

  "QonZn5kRoDAzC4MKUee5YLMm7KLBXSHesQJk3wYLgAFCVjui3kry8Qndtu2RziXBYyMh7HCJMEhgLm+/IxeFbeDIpOphqNMGaOV3" +

  "NSQfLjhomY7H90XFgAK6tJYkHbBqkLHs0odsQdt6tJ5lRUbKSVsyTT0HLODge/ad9WlcFrFJ5doZT+v1wYBSEdgxBbBadXRNdfuM" +

  "+Fhqq4yjCNw0l9YC0AcAsjaUVgkFH+i8LwJWrT4UQXQ2hnm8kIMrrFxpFrw5QxrWA+lRQTHGwCfhb11fZb8UsCAMgAIWRbsM8RIQ" +

  "gLoFr3nyO7dvql4xM/j1f3r99T9ERA0zO6Iii9iEnjFNENWzRMxMNyws1P91//72d2699XveeffDf/zpxdHWwVrbDuArT0FDk9Cq" +

  "KBYgQioT/uiyqT7tJTevjT/eJ3X0tFk3fBCOch4uCmRmhNjxqLV3pUIoh+S/dKQtMOiooUWtv0+rzLRL0yfv0+fqsy/GIchUyt7P" +

  "+kmJGcqzan8wQACUa0BSjvcpVXE+tPEiJNUuhSnHkxMxjXIAUOlvy8+D/9aAitgGBSeiZSEcx3McE9CwPMvh3gdEk3PP+DAicCAz" +

  "bYWZmVzSIKUHMqc6U5waPk6LXg+AmulIuqYZ+3D80xx1E6FJYb+wdwA7UCb8ZfwJTk7LFG3pfpb+LluppyHUCuXC8brcjoLuOiad" +

  "x3SEUIQdx2uk83o9RWFZgPocwHACC5zetlYYmP2rTwhYjQCJkLTt1AddhJ3+cNy7XkwGLPkKkp1AXJH2yo5sRHrWSEfJiGPr4rMU" +

  "45tkvFsHmq5RPXn8dPOJ5dEP/tItt97MzJuJyB9iHp8gZUJPi84M6Sd0RlpYWHAHr72WsH9/+6u3fvLn/3xl9GP3HV/iGeIAmikP" +

  "ahP/eFj0rKi3xPtnY1YVsubhkiSNfpftaU1RftkIceQMV+pBOFMvFgopVRLhJLdo/l5vrYXQ6GOEpam7z9rR6XHUzu2Z9nV7b4BC" +

  "NobGQlD64EttU0CCzZgvaX81CJIAcEy0a7UuUDbCIhS1Rnk2NQcgBrFbF8FbjSw23HbayJUuCMtdG9aCkQTKuJgKa1nK51EApLHA" +

  "2DHVjWDny6IXAtDGzIkxjbIm7hmvFFLR1zSErGAqD4grAi7DJ/3zbcZMkk11LQTpiKodW8f9Y6XvcfjH1Jo/o6DFcg9O3zFpoKTd" +

  "Jcp/7BqzfQDSKQBGcuvZsWSJMWA4ny5+EhA7DhAmgBvIx1tFuedZB8Cxw5rnZsPGDfUVM/jEj1x3zXecP7v1vskxwWeHJgDgy6SF" +

  "eMxvtqrwj9/7vt/4HFVvP7YybGa9r6IeCYmolbPyIjwpbmAih8QWA+XmebNlGCDXn/60tAiIaY+N1tAHEqQORnouCHMRvj7xFnJJ" +

  "kFAeZZ3aSNF6Wtxch3RhSqo3tUsYrv1OBBDMCInpvhRuIq/JkZUjKsg75uSCOgCgaItopvaNpFizao3SWz3xnSVHSNqhfJqEYfe8" +

  "u+hEQdli7YsdBxFTZVgZq/k5PutT3dB5kGjv2LYzcARZU2nEzkxRlJj4vfR+cp/4WLi2HqKtchSEYbuQSEbo6JXIWdvaI1St5UfN" +

  "6Wl+DOZLnxtBn9qW9y6VP34Esr2K4Lax670PAGR+9jg+LBVFF4nUIGs+AUcyrhYLABCtGyUkNgBcK0qv2j0VlhMrT8tHpQtq7N+p" +

  "NazrX8Y4ex4EYo8aFVbZN7xhur5+bvqhH7v6mhu3bNlyz+SY4JdPEwDwZZA55rfl//n4xw5/fKX5+qXVYTPVtrV3FLX+JOxUwxWG" +

  "Qj4JrcJc2dGsKNvCCCVz0pwiyVa0gonPMM3hvHupQQXznNZhNX6RQ2NKC1qbj0y7EErFk1mfzWdJw7Jv5WBIGXnRZ/lOLQBlPT3a" +

  "mG1TJlwt05L5Q9KqcrFQBkom4ADSeH5tqyRGkrzw0qYglFP7XCnjmNE6WThA1eOWEepYAQRA9Fgf+oVXqnk9H/uZ/O8WAoXgPpfV" +

  "pyfCLVASMz8HgJCeFwdJKNeB0EYAJJ+Pb4kdSU5zYsFAzDEgs5vcc3Zu5dlkPcrHIz5pAHX4m7O1Pi4/QDovYfZbuV4ZaIuYHJte" +

  "OBsH2bCckoV1RynfX0IStqzfxqFKcSnjqVRKUltYh908kIApUcxuGDhT6wBiblBN1ddtmHvkH1y151sv2XnBny/wTfVBmoCAZ0oT" +

  "APAMyQj/zT9zy5//74+tDV+/enJ5NMVuwCRH3gDRajMBbwCA7KrSb1lq9qqZiCA26Jsj05L6hHmGrz3YIPKSrOkSCGBAGp9ElXRG" +

  "GBOZT0oyKVWNyOvUW3xeAgBk31kNor+svI3St/DXeLBS1GPbRgV3KhivALIkCsSIbPoRAWBI4uJMW2ISpPhyJqQpiTeJFrdntWVW" +

  "vOlRX055HS/l+90R6LUwgbIU0r3JZOQ5SuXI9/ZvSwIgmYHu6XOEvWDcA6Gn4ZSBxpTE4FTPXrVntQYRhYyR6BFr2VRyx3Qv/Qzj" +

  "jd5F2NWWoQ+WwDWRfJPXmb7uHYmsvnL/leV4YkhqvXDPEcP13B6ahCrS2kpMKoEYSgoBm/4lFpNbrvooCfpyLxZQXtIqSwW2p3YN" +

  "Iikx5OF9VbnXbpld+tYLz//m113ykpt/4JOfHPzm9dePxjRnQuvQBAA8AxL/EzNvOvDxD//ZJ1ba16+srI5m4AYcGXvapCbQTgVH" +

  "FK3hY6PpJqri1Cj6ZoTz3sJI43/kk1naQAxlH4LYs80aGaZ9XoUnOYhfleymNWf3i6IK7aTLgvsVy6Th9AVwmQeNqwPgTMOOfWXr" +

  "dxWma7QMc3/8mcgycqux5P0zbTP/hm4lwUgma51MfnJplCMlcQLpmJkIJBdUYEhQGZA0xz53hRVquYJ1Nv1PQrgz0oWWTz3fpWf6" +

  "1wEzQS9fYABGsye4aNKWFHoEJh9iUaQlRuO12rOsIz92jsv1UrR3jGsom+0MMJXfmnHo/SYvQyx368Vw2JhbMmZ8vQFQ3QIRACAI" +

  "1L7rwwGTUyLufwUfASHGISd9NpzPif014zMOTCblBACVsw9tZ7YyjDWqWyi0T1J/xQyPqm0cqpfMD5beMjfzLd95/RveP0kY9Mxo" +

  "cgrgadKhQ4eq/UTtqUce2fmPjtz0nk+stq9fW1ppZjwPvAh/CBNLx5OION68EWMBiBGYfoyAteI4MhHx3zGLxhe1HZH+DPXvZ26A" +

  "aDqz4lg3WZLY+my+Ac2RMIJpq0IO/S9oYKnN8v44ygOYKDCDMcI/jFkh0DimWA1PwDJz+Yw5fS58zWZOPFPbykAv+Sy1w/5nuhMb" +

  "6GLWNIoBWAIamGWuBfzlOqUKoTjxxHJJTgB4PjJnSc9Lxdjl/YjaElsNLIIKXY/9IirZbWKvrJAtNP1+oSDr1KV2yDjGRlEENKJy" +

  "MgPsKYQoFNpgMs3nn4twTGOjNfSs6fRu3/xm6674OytB56wEgmZVjLF+lC49EoRdPK5Y0Vyra+Npg0vOZ+t+PBzJSbiMAgjTXhlH" +

  "T2G9OalLrAU8Jm+BtNlwIM5aVIxVYQro25VakjAYs1c8OYB85Xzr71v18//z2Kk//tUP/NnX3Xzjjc3CTTfVZxiCCRU0AQBPgxZu" +

  "uqnev39/e/ejj177k3fd+eHPg163dnq5rRzVktM/6U/CH0XrswIyaUhhjXe3QTgm1G1DD/YO/+oGNcLBAIPEQ3PhXwqDgB36t2Xf" +

  "f13jcypHmidty+rp7UtXEJcMO+EY0ZSjsM/84Fz8zMu3ZZdCzTmXfWdLSPWXPt9ijDuUj1LIfi7NSyJFPpSjeUDU1kSok6yxfByz" +

  "mvQrB1CFYEsKsEGDOrl/7ruUhG8PK1dZHboR9VkR/CLc5MiXQZU6eqrZmWA12TOxM6JxkxHwqX5K98zI8K3XG5Yxot71ZR+0fdVn" +

  "Uc6kGQf7eyEsu+68WL+AGFNCAt0p/iYMo+EfRBg3bWVgbccHH7V/IIxyACIRAEQFxoWbyCBrLgeF/WNVARrTov2Mteic2/UWzf/l" +

  "GiRBFHmn4nFBOT4NkCM3WBv5ow3NfcoP3nvozs/+4MEbb2xuuOmmeuzgTKhDk5E6S5KI01sfvPdrfueBB/7X51aabW6taV2FKi7/" +

  "sKGMqZjMsbpcy4jMknyCDOFHx8zaR2UwTYa3y/fHMLuOOVe1oaqjrYS+9LUkaSkd7dC06WzJmvoFIFmmndWlplsAYBN8l2GcJBGN" +

  "GdG217azBCj9jXTFUUdEAWfeEisE2cdiLIDMvfbD6/Op7lbXhZhprStIg+Dj5yHvfPjMxkpIAhpCODXiHMFz926D3vVGcUULkzZf" +

  "KbzqrJPiPSSB6bNVGspwcJnJPvB+MqAi/ENunLCW9b/+6Q4pKusDd9/JzNhahV1M48vWnhmTPHr2V9YPszbF5Ve6J4oGqkAuLX7d" +

  "tctWzzhzywWIxBz/kCBTdF0a+bz7wOeMJUF4oSo+JImG8+DKEhilmyvis/K+VhxiEyiu8yooOH6VGBdtnHffuH3Dge+45rqDN9x0" +

  "U31k796WJqmDz0gTk8lZ0AJzfZCo+cSDj9zwzge++IefPr26rWLXoqJKtggp4gWCwLRbRtJpGg0iMn4xEzsGrBK7HpO2pj/d40bA" +

  "ZZsqvu+9V17Q5zcW6hfkJQvoJ0HzHXfDWVDuk415CFSoFmWolhAZiM+f69P0yv4BqdQ+Dc6OZVbGGGGgvv40ymM6Go5PORWU1HmW" +

  "IjN2opqBFegxCFVP0XK0T7XnohUCCiTzon4mGmU2NqTyQ8gXQqdvbJKFJLoZFPhw93uG5snPzMISPErhRAUjX5P5fEpMTL/w7Lic" +

  "wkO9e6BX4MrnxWd9dZDtR3xPou3HuQWCgcVozGb/jAc0aa5IgPl6e4zzKH4x54sawgk5qtsKsqdin2ycge2/gPV0dTSrFSBPiS2o" +

  "FZ25yhqagRoTvGvAvBypJaJwAoLhpgF+6NRK+966OvD7t3/Kfce1r17Yu7BQM6Ol/ujNCUWaAIAz0A+84x2Dg0SjD3zxCzf87oP3" +

  "/ulnFpfnBly1FdrKo4LekqdmNSFhDLLVzDd6PM7Ac7NJyw091iLAKfxsXcuB3WxjtBJtbHxGW9jLXAR62FfNxpZvz1L4d0FHvIPe" +

  "czT75UwSMH31AMytaNK6XPFJQjTXOKSPgYGV7ciFjzClJOCVt1ASziTVlX0kQoj5iBevaOMs6uOQmpdjgigknUlmhBHSCxHkGJ0I" +

  "TOGxoX0af8CA5HFQ10OsK4SlUDyFECwTUms6UDdeOOZWrSIJDsfjjawiKw6o1ej0HyWxkYTbb0X7H7e2+9dXKaCzObfVm/kuQTB1" +

  "9nP3PX3f/F6CAC3bc7hngdN3kmFPCpF12x3rKIAjQJI2w3NwgTijWGjdsgftZyGo0omCwlHLpgCk0pl+CSiMvMtzvBNAgopZkyiB" +

  "HeADoPUcTpA4VGBwPJwgMQRBe3euZ06yOdMRTX0XLMGyj/LvmEHTaN2DR08272f81Ds/+yn63le8+qf2YqFmPjCxBKxDEwCwDv3A" +

  "O94x+M23v330p1/84g2/+9AD775raW2ubr0noqp1FNOXRmFgZTkhYyBisso2aUz+I4tbDflsfjdklWkVTAVjPpP2kPskARsCkgCE" +

  "iLIzk0RnBw0gmgKlgT17rrdtRnPK/JVjGKL4RNXMDWSZyvS5+LkKNKkm07Tsw6UWjHzQZY5Tww2HFe1f+mgy/0HZJgQKJrKCuc20" +

  "ZxHi8jZ7SZUatSkWUKDN12NakPnl9F3GaL20SI6QioYHXZOhaUaLy3qe/NO6bijNAUEEbdRSIzjry9Wn7edUNjKh0L3JMS8gf777" +

  "NWXPWkCX3F79FrZx1NeW3s+Q1rwKV1Vro1WlrNu+r/yE0lJrvQIJNaB4aMIgEeyEHGspEGSx5oSjqDZFNKcHlTx7OHLwaMOacA7k" +

  "aoCBJjyNmhguwlTPAEvOi2gF4rhmO/srG2sLCkJnKT2U5hgUA5+jiykyAU9EM4T6/mOLI2b6yXd84iPu773uTT+xd+/empknIGAM" +

  "nZ2K9iKkH3jHJwe/+fbrR3/0hTtu+B+PPPnue1fW5qcb70HsJHGLbEAgR+ClRuEEKQt7pHRUJyo4cc/5FN08RptX/7fPtZleTSW8" +

  "oFYFBQ76jpz5j66ICAACU3KwmzKrHyWAEOAQ/k4ZzDhnggIAKCZJYglw6u2qjmXfWNhPqPi7nyJQM88m7UsmgZXZ2DGTOpQRG9VK" +

  "y7DaZZS6nROL+hZHK5BYHgjiPmAvZl1W4RfMrZTOd5No6D4DL1bgA0DyvPqoPcWMkyJx1dIT6hc7BssphIBZ4jve9C83VQsAMN7d" +

  "BIbN/LAKg2LCzXjmA0aA3C8xRlAqhlsHBOj34qvuxzWp7EI77fs+A6sGKGZugb52r2epg4yVACd9SUEdM9IFPHZwkViMuHa8gGU4" +

  "M9/Q9eI4HC0mEBwHvpRWAdRKwQSwq+HJYW00RONbTBNhvq4wBcKKH2G5acFwmJ8aAJAMhSFexkUtKFlgunNtY3i691DYuABFuhGo" +

  "yliHDyoQlplH52+aHbx2euoXfuh1r/+xSUzAeJoAgB4Sn/8ffubWG/7HU0ffff/Qz9cjeEfeJaFIcFFaW01CKIGAqCEi/mpO1waU" +

  "ngRIaXaVcliuyYKsect8pN4eIVmY10rGm95ynfYH8hF4pxvDwjNey0utKsuUTZkYpEP4kuLNh6LNWy0kmd8N4jdjqlYM7WRkCFbl" +

  "7qE+pq4aCZFJUSzWHNYgOqfm0tjnTlmkwWtJm06AKGubD2ZtFkGrrUknOFRby1qqNcX+yBgFcFlq+Tr2cU2pfzYK57TukihlCOAg" +

  "ZIGN8ad2jSjeIggVLGG2JRgxjosXsJsAQWpzOVcyZmQmVyS1T/MVxz3516PAXEfwd1wBdm1lVqnockooT9eX3UP6To/lKZ8t85lZ" +

  "M2MtCAiXIsmQC2RNaz2Cl4im0jCRDpsF3HmCKQERZKaHFQgAQEvQxEsVwhphENa8x1rbYHPlcM3mebxm+zZcvWUrzpvfgGlyWPYN" +

  "vnT8ON7/yKP4yBPHwHWNKWI0VEV4KRaJ7sikeB+XjZ0FdmaXxbXJBvx4M15xBIjRtNyct2G+ftOG6mf//vVv+sl9hw5Vh/ft85iA" +

  "gIwmLoCCFm66qT5I1PzJp29/6x8++ei7719r5msPz5Vz6tOTRDkq4LvCv0PKL3yHATCClcCL6c68JkIp/V4Um9UVTbo9GkdmRs+a" +

  "RcoOu3VYhmjblEBLAhWq+5kHRYOLY6Zo3wgrwGSe445gEO2hFQGc1RYK4/wT7Yfts9yd0CFKwpORYyQx2Ku1xY5hMSjpzD9ShjNp" +

  "mQhSiO/Vqm1xfhwgt8kFAFK4U+QnIdyOF7meML7OMUhOQjONv1ftECzjwfAkINWsS0oBdgmUCkCRS6JkLTAs4Aj/82AXA8s4gMZs" +

  "2O0eEADHzjwh0Q8yFpyZuXX0i2u0x1kCsr+TRFGgLvuss8fiFi/9/uhbi2PICuVxlIHJuDyiUT21mZBAnAEtFjwqwADUVC5t8ArQ" +

  "9K00yvFdRwQ4hxUwVkcN5rjFtRs34g3nXYTX796FS7ds6fR4G4CLNmzCGy/eg4986UH82mc/h5M0ZSyB+RjmwxDGP0vqpMpGAdwV" +

  "tMoPjm5Ijm5IijkMCLNA9eTplebDNPMT7/z0Lf77rrt+YWHnzvpg8FxMKNKZ1u6LiiS978133fXWdz780J9+YbWZn2/I+6p1HsFM" +

  "mnTeEDLVl3WrCwYSww9fdYc9aKBJO1HqM393PjMa5phn+uMDEoBRnYjYVJmCcmxxHY1KNM6Sd0ZNKmg2tjz5nfq61zEvK0ODFfY5" +

  "gLJ97ndbwHzXHX/KwI7XOkW7lYhpYbTWP66fGcYEmWdG1IAD9w7KSxKXyszExKuC2LTNleAn1Z30q/g5y4iEwCztgvbZq4ARpq9Q" +

  "pRwWsWpEsBB8xymhkV2raZ2IduwjzpEd0xoIkO+JVJ8zn5k1TfazLqU6CSgUvHGCV+a2+51KfNsxyJgGmUoJkMlbRrBmJWk3yJTS" +

  "34+whtjMDcDsowUqtNfOU8eSQMnnzi4F8iUKsSne3EFSUbBTtVWFkQfWmlWAGRdOzeCN523FjedfgGt2nKfjwEg3+ElTtE8MVM7h" +

  "c48/jh//+CfQzs7A+ajYOBv/whqwKscGnVWIyASDsuDluKfi2HfAYyo5HLByDGKPVc/N5Tu212+Ycn/7+19z/f/3jk9+cvD2Sdpg" +

  "pQkAiCTC/54HH3z5L91114fuHI02V+w8iJymXQV00wvjkOxame8vfjcO8ZfmQBEopflf6yw+6/WJW4FcCs+OABSKzJwSglbTJiOq" +

  "34ye6vJyjKaRGiTj5SMAMB7i0uwK5W/rjlk0UneYr625DwTk2lWP4AEyYCdAQywDRIEjMTGcqyEBnXpcTRph6raZ6QL/MuBK++mj" +

  "AC4EqWrNpu/qVuj2JQlAp8+6WBizDehM60H7ByuQ7JjFvxxrJL9gC87GtwesGetHkH8SBGjG3VgRRKFlAUyml2Id0cp7locqhz0A" +

  "ID1j5gaxPx6aYyB/2IB6iUGIwCD1zel3CH8pwAnrvn/fZXs3O/dbABeE2wLV+11YB7szZt9NRYc5CaV44+evEIT1iIG11oM9Y9dg" +

  "Ctdtm8ebLtiFV247D5tnZrRMsU6uZ8UAgMZ71M7h8J134N9/4T7MTs3EOpHzCSKdd+mH4GStL/JFr2vYocMHSdJGZyMXMZyHg+eG" +

  "63bngNrXDfxf/oc3fsN7J7cIJpoAACThf+Ijn9v2zxcfueV20KVTI24JXLH6+QHRkIHISDyjclFjiLsz0697NstYAWe0OsAwLCC7" +

  "8jN8B8M0c9BQMpr1NmyIVo8CwQQmlm2wf48zrXbqi410SHy5vyWcjhQhPGy1HFsPI15+wjlTVO0kCglmzjL6SV/THecZZAifQa5k" +

  "9gBX6hhVFwwhisB8jAQwBZCD1HYDAIQJC3BI3JvTZxBzr4gn1xl/SOBg/B7SXm0HkERV1AQR3VVxPggu+nZt7+XyKqfjHnoU3AAO" +

  "yA6TM3m1ZNiauiZ8r7BKrRDK5ZM4S/PttQ1m+OIYAulOhTEkSWxUspigxLHviDslgZFsjsn3vNTz3jOhHqBhiaIkJ0oC2FNuDZIE" +

  "QlmxgGrNjBQ1H8z7IW5uzbdYbRpsGVS4btsGvHXH+bh+925sm53Tctqo6bszCP2ybjBjcTTEP3jvB/CUk6vBY58MfxAgqdsF/TPF" +

  "8j3nezp8Fw7F2qxbySIW4gNcS+zrCrun3fKNW+b2ffdrXvc/JxcIBXrRA4AFZneQyPOxezf/o49/4c8+V0+9rl0btjVVlQZORYZk" +

  "tUdCYPjkxmRTpsR+so+tVqa/U2J6SAteNlOfhr1eJLH9vt/0Lw8RUnrNpNX2BSnZcq2FI9P+IH3OGaMI/1JrIdF+9UtKmqB5VoWw" +

  "yy97ycR4hhqSBipuhv4LUoKQU+GcuSRyi0oIhBRxwqmfkVwU2MqHogRLPn0R8qXMYDPfsd0iGKzpm51q7SRHAKlP8Ma1Gdsa8rl4" +

  "U2cCQlKHjq/FYYXP3mlzEgTxEYAGHy6DWXI2eCv6Q51s1gXLdwFMpMyJ9uKffkrrL51K6F/f9u9yLZOCBSqf0z0ugKDnIiIJutRb" +

  "HtF9piAHY1kCwOV72kYJEvb6qWPDBjozg86NgoyoNDiggtNg1lHLWPENBjzCFZs24YZdu/Gm3btx6eZN+q43fOOZCgc5OvjzH/tz" +

  "vPeppzA3GGibrZNH6gHGzWGXWNMUh54mAAxjNRPEkXg1fOubqdpdVNfL37R72zd92zWvvHliCXiRBwEuLCy4gwcOgJk3/viHPvS/" +

  "75iafZ1fWW1mqKqbeAwLYzZCAATjmRWpNoJ+gallJBBgtdqMSfcI4zP7uc8g/GMvmJMJWQJ27KmD9eoN7wbNzPrApWzloRqol2vf" +

  "WfQ2pfIYpAlDwj4mW9yYdiGJZRG6IoTWmScZA+mP9JGV6QbjbvCpIiZBkaKFwRSxDInLF+KF9PPwogR4lQjJd0BfGnbrKrK6k6mH" +

  "SJMjsgr//mfBBMm4FwCLVGON2ikxHGCvsGWdFxX+BBBXMTFMjAPwrN1JWMi4IvLmZKe8bD3QeeWxwj+5Q6TP3Nvt8C2Jmm1bkIbe" +

  "fKzBkwBAPo691eBzwNAHpJJ7iYr+BZcPOR8lHMGzi/VwWjcogW5of6sWNIpjRKgc0DBjlT1W2xaDCrhkZg6v274LX3vBLlyzbRsq" +

  "V2mZnkOSnqej7Y8jjhhv2+wM0Hq4Aak1wcuRVzN/VjGQ6e07GhxM/i6fWxh+p3tD+KnEDnmgds4NW/9w6+be99SJP/3gfXd/81su" +

  "u/LIIT5U7af97Zfd6ecpvWgBADMTHT5MM9/5ne0/efPX/sfbp6dfv7q8OhoQDUYI2bKS7Yp0Q3ei6Qm9oD/lxM7qtH9Ejc4cI0QS" +

  "2mEXnFU/9PfSHN8JBLS/6U6LAYgkWmX4XrTCcdYAZp+Z2YVxpPPkqUJxs+p4yR8dv6j41ZGEZ1AgoacbxjAGp1ybkAMeYRRjYVz6" +

  "SwMg0+dZ9DESMAtto2y+CGYtiKZCjIgjw4e+rx0CNox1yIIfERzm1SQCZMxM8GA2XxHY5VNi+iZ9TyBGBKhkf4O0TRmrsfZETSuA" +

  "Dobh7SFvAXMaM4IGBrLWQ4Le8taRAaIEIAPj8XkyVppCm89cI93RNoPRt7aNwOcEcs5EyZWTzNBqtg56eQA+usbNu2n5ZuucKPrA" +

  "VSimGAZPMbIfwdVGjkBUYTjyWOMRBsS4ZG4Wrz7vfLxp93l42ZZtmHWJ5Tcc+JwjQiUA4lkiAtB6G+MSO0eyhzh7VqdpnYHW+KTI" +

  "l5nD5V05f0oKlqoEMXCQiBw1jb9rqZn7bw8/+if3PPGlV19BF98tLuBnrfPPI3pRAgBmpr0HDlT1wYPNj9z0vv9wK+p9qydXmumK" +

  "BkyAExSvvD8s2Exzj6CAlcEJ5hSfOkA+Fx6m/vBLnxYj352B4/SZ4sdF/uvfiFHGhJQkhCQ4SyL5JWSrFM45k5W+By1KNmRpoKSs" +

  "+yI0A+/Ob26P/FxdKoQQlBjkD6sc8JwzfRVOHHtQMHVpZzbgY8fUaFYy3xzrEEGggiHNgwomo81o/Rr9L/53xD551dZCO81csZGJ" +

  "Mg/2d+OXUiuTavEwz0PHz0YaWPBl+2HXkQdHQ4SFGvF7x8H9JSGw3IZMcYD2LywlWf/BmiYCP7gx2PTJBFJSvBCGI/smEx4bx9rH" +

  "sQztaUHRE87GLWD70gsCrIvKjH0nWG89Hz8lF4AkTlKgRpy9GvqSn3LopkLoD7jVcY3rOwk3RkUVQDUa77E2HAG+xZ75GbzhvAvw" +

  "hvN349ot2zBVJzYvJn5HhDqzjD17wl/bLCUzTH4IVqCTnQvQNd/PM8MzMpdxrgrDXljWxkIQgbkElzIx2MFVzO3ti6P5X/nc3Yf4" +

  "+PEbaevWEwsLC+7gwYNjAj5euPSiBAB7jxypbj54sFn4wAd+6ZYWf2d5eW00cH4QBJ8EQslCzM8JO+Ig2FVoJo1QETyC8E+LO2cu" +

  "AKIlqxAkT4Ms07JMblw5ErQYH0rgQ9soDFpeKAoQ1wQKk6v0wWiPqV1BgxONKrWvy2yJApDQBEGaNYiUIXSEK0gZdK5UpD/WHVfb" +

  "XQt0GB2hoMmXODF21UhsgeWxJNH44xllZg5n8l0+wBnQMu1KXTJrBwaEZAArH8+gIZnHyMecBt3cDmUbxGfd950KeKSgRGmi9p5g" +

  "tOhUBoHNepBcBwVwkjk1C0tOOYQlIYxdvk23apZ0Nj7mPjeCfX98PEwcDKKwf5hUqHc8CwgAk3sARcJMSamQCsL/JJNfmPkBOTRg" +

  "DFuPlXYNcB4XT0/hjbt34w27zsPLtm/FxmmJ4Ge0HII2q2fJxH9GUt4ikLPbZ7noisGZIC+WdC+lwNlYnVjOCFqm+TIdjSRCyLbK" +

  "FbdNey9mr/uJz372fzLz1+8/fHj1xQgCXnQAYOGmm+qfvvHG5tc+9pF/8b7l5h+fWmlGU2078FU60gcEJBmYZlhceiWNEWZKZtWq" +

  "8BOfcSgNVGwCCWYpt0bfBjhTgEwprPpN9iL0k7Zq5X0qLDBpL6ZZ1dNYvjZjYARe5gMtBLwwxViFE3UegkVcFEwpKJBZGAhrfQQR" +

  "xmauyIgJKwyNbBbNKwASB024E5mQGjxkgmNrrRYpiX4YCQBYRq0zxwy97Ik5Zp81IJLksVxCEGIgHXIvAZEHR8uBrberqSaAZ11K" +

  "UifHNNNqNTCTL2suWFBCUF5IAWvC1grBFRIBGrSoSyAwWnVlIH7uHNgnqw9rjoG+dZvHTgSmHnLXh3eSa0DWhQJYQxngViGRC/o+" +

  "4KyfeRHLFpAxSIMdo8XPJ0CSzh2wCh8gn+mc4vqWExjRVx4NT5BonCp+v+IJJ5ohqnaICzbM4rWbd+JNF+zCK3aeh02D6TQ/Zlyr" +

  "sHHwFSNZUMILVRln5RvJckY6d8kFyfqMuEhLi6cF+FnMB3mtWvc9ZP5jdgECHFPVLK2Mbt86/4af+uAH33F4//7vvmFhIZ7x/XKO" +

  "djy/6EUFACTq8z986Mi3vHdx5Z8+vtw0c0R1EP4pyhvZQkNcqKwCUW6tFpMoMEaLcE7Xk0Wt2WLOWtjVYqxpttRmxjG89cCCeujX" +

  "4QdJONoHReACKfgPnfZqBJdph2h+IlSlJeEZ08dOwFR/X7J6OeqqKTIv61ooPzBVifa3/bQAQ4CHBS6ZdnsGK00QDtYqlPzqOUDr" +

  "uhtDH6ImaNeSSH7PMeESoRRaWewAGeaqExbWVTqPzYEZF+MVtPXwVysalXauy4jZ/M+OjwA10zll/tY6EUZXmP0640o6QlnZoQjp" +

  "a7+Ah3l+PYDQqTM22yEHM2HF+Pw5EjBj25xQrwVewQ1nylJzUnjIg9O6dCFAsyHC6dEIzre4YHYWr9m9Ezfs2o1rd+7AfCb0RcCV" +

  "mv5XUPgX1WWYuvw6Zqt0TgBksHRkFxuhf9+VPNDGsEgdsm4Sr5H9H8DttHOD5VMro8/MVN/1Lz72wYf++Rve8k/3XXttdRh6HvcF" +

  "Ty8aACDC/xP33/+m37jni7//0Ipv5omrloStIkR4m2N92SLjaBFgaN74jjmcWYNSkslddjv17sNCrzJWBvNMj/C3P4EuM+uLEbC/" +

  "95UR3otliVmWk2Atd4QwRvXmalmFgDL/spjQXSojacSUPd81tNhBkY1tAhd7xkEHXW5Qo8QkbRuzZ7W+4qMOPitHhLKPk35M2sfg" +

  "+06Bg9JJESldIWZBaQleTM2iQYmWnGZFxzMMdSyHRUuVZ3ILFxmBlXqbeqRvKfDoB652LXPsRwLDnG0L7kWm4/hwyMRZjls5fusK" +

  "+TF7xK7bVva4tRBoy0JMjZy519wNIvRl3hUECKgu51ECB2PgYhWi5Ydtg2HTYmvt8IbzNmPvrt34mt0XYuNUEvqtj0KUJF7iKyzs" +

  "+yhu5db8CZglTIhDE1IAyz1ToiiVXRhnpVH+HIt1JJAyzoHlbYm9hD+JMOIWFdNgeZWbz0zVP/bvP/Xxtb/76tcvyC2wz+6gnJv0" +

  "ogAACwsL7uCNNzYnHzq5/Z98+uO/dV/tZqe9974qZIxqlhZZGjaq2iFBU6oiBwrKPDht+j6h2CeQRVNC+qHIts8NUAp/+3cvQ+vR" +

  "hPrMoGmfSSecaoYdoniPgfGcpeLDLzbZWuYXLuyjyThggqHiBvcUhaEykDQvElmeNcoACCIJyg8aetb8DFhJG+I4cSrNR0mWJxGS" +

  "xp/h7Loc95M+CJumnC/1unqoDxRGSwASc1VBzGGsHGQ5cfw7CQe2lSKKH6u96no09xHEn+P94dEK4AWocRoZTtOThKfP25NZBtKD" +

  "1tNv22ZBZzZcVjCME/5mXkVydABV/OliA9M4A2kZGheJ9T2HCOCiJKhxLADAFl4v4yRNIjX0HiurDTZXFV69cR5vvmAX3nje+di9" +

  "caOWk5n3x+Uh+SpSmuMkzBMPZIj1iRHS+DiiTHCXNG7NObL7ICCJ5D6LLj8BvYa3BjDsw8kV9pj2rnr0+GLzIWp/6g/uuPXe/de8" +

  "5p033XRTfeOLIEfACx4AMDPR/v3EzJt+7INH3nPfoL66Wh215HxlNUrrV1INaKxdkjvPx7ryv40GtV55yecI1ciEwXjfBRfW7wvz" +

  "2Xr+zL5nMh/3WMYeQVA0H5M5e1761brvduvL2s09KB2BGWh9iMLfjpc8zFVkqAxhIVaIkAhcijc3ehFJuVAJz8qZaGP6Zik91elM" +

  "+X3canx210KyBTRgNPdSmIX1lYMiOWnSeSotBeF12i/7F3o1rJJ0Xcg6tMDUQa04uaYdfzqKunnosw1otKdqvGlv1jYzXBp3kdl2" +

  "u3EzqZ/9ZWVlkM1MJ/ED3RK1abGfxKzZ+FwEWWHlV+VSEuRvLANAWkExmyUF3zwzsNq0WGWPWYzwkrkNeP0lF+ItF5yPK83FOz7u" +

  "0WfrrP5zSnZOC6WjA9jsGkOyDnXmvVs0FEjrn3YfsGIwT8W6EiUvorkGTHPkqvtPjNr3jk7+xscfuvvu11905UcPMVf7iV7QxwNf" +

  "2AAgCH+Hw4fbgx/84G9/rqVXt6vLTU2uZrmcghjEHs5ocbkp0TK5gmMV1PXRx6xeYxazPBteDoy5TKZjrQzqYsgr7dUcu6b9Ajyg" +

  "n/GV72ZMXrPRRcxdmFC17z1l95vmNSIhvGu/Mhpu7oENP8ghaMeC8OUz0UQ5Cn9A1NJQZvxSBQBRBFkc5stolxC9RKfI9QifYtwZ" +

  "IVUuUlBXTsXfAjIoBwR6Pj4+o3e6yzsRUDKcETJdkn7aaHwZLzW/izAXZTYDCXJsy7aFglEoA3GpbLF4GHwaXjXrW/3iBjGxdc8w" +

  "QuAt9+wfY4npmPxZxoeylZUBYXkWwTKSXZsbP89kBuunAIKh3sd5tSA/hnBGrbNSQQQKAZCOEI7tAVgG0IxGmKEWV8zP4/pdO/C6" +

  "83biZZu3YyAJehAEv6OY2fE5FfwlQH12SnIk641zQ1lcHK54QRQf+PButluE12lFPgacQve1Zh1lB1n33eBXzua3BeCJaZo97hth" +

  "9nfuvO93Hr7zk2++kOipBV5wB+mFezLgBQ0AfuA3f7P+j4cPj37xIx/+5ZtXR9+2vLjWTJGr2ypctEEk6NOZRdJlKoEp2cA3oAv7" +

  "hRFGxlAwLup9QxBwoeH45Nc2uogu8owRFIKWC8bYEfKGkXfbgmyTdRVYaVc04VESREKOUznp76KPnVrTGGlVQKojSa6ytak7po50" +

  "hQqpcOrTroWpS598OF6gRxGlgnzIGPlsko5NErQRUMhZfTtnok0bgQ/VgsxxQ/JJuMb/CSONPVNNu5xnyprYHfdsCSmmyNcV66im" +

  "lxL465QomM3UySrc7X7K8iBZIJaBnrSukjXNAHNTREfzJ/3C6NzrCDULwOW5hDMNmE1ma8+p/ICBOJ9XBJjgKK0togojbrHSrKEG" +

  "cNn8HF57/nn42vN34qXbtmPK9Z/Vr75i2v5zUI/P95GuKjOHnsx9Bj4cW82bI/sYCKcFUmIlDeoLaSeh8QBxXTElFwCbY9mSM4NB" +

  "IAdUrG2qqtVRe+98fdU7ji6+h5nfTIcPr72Qjwe+YAFADPob/duPfvT7Ptq0P3J8edRME9VBC3G6UeVSFbk7Nawvo1FkFgCgX4wH" +

  "Sub6sEBL4avJ4WCUOWEe8TOWiki0C0BspZYB9rkBwp+J6crfacMJwkHUOFPfqoi1JdGOY+SaUdF31s2c+hf6LYKY8j7Ke8rUjV5v" +

  "5KmKVRFqKgRtQ3IOrQqaEeyhDm+0NzMmqvsBKe2xAUzGDZADKYaoMR2QKIIvjoEc6VO9MQoHAmDvabfzmJvAEydM7CqND7P4P1Pg" +

  "lGVy0pZ8vGJrTMbDPCRC2hyEceY9MOMh7dX5i2Xp+XwG0tHLfuuU92zKCG0lT7ox1G+LtCbHxbR0wGwH7K1DJOMrI9D3pliVpN4w" +

  "/mloQgAfk4MnguieIMIaE4ZNg8o1uHCWcP2W7XjD+RfjFdu2YmYwpZW23gPEcOSekYk/NM2coimsl+bJ4vNigp9FEiAj1idrLUxu" +

  "JtarfylOfwD+hkdkLE42vTBSyoGX4ZWRC8e1bI4CK8Y0ypasL2orvzxqbq+3XPdzH/vwv8P+/d978NCh6lkfnHOEXpAAIPpumnd9" +

  "5jPffPixR//dw61rZtmHo7RUQc2YSLzC69ltQISBM78nVi7MP3zXR4mR54yFzC+51hZ/uriYmRKDBmCziskmylJgiiXD1N/RCpE0" +

  "FqmzNBwLghbA4WKctTdlrkuMcJIi668FEcWxHXnSRLpbPV4tHsydIz3aHnODnWrTiR8gP9IrwXhVEaPlY5/jxUDwIFQQtFS6TQTk" +

  "SV0Ah8Q+ESRoJgTyHdkUTLo9fuzCUkSRaSr4c6L1pP6xZlMM6zbEJ7SGeVoJDqTsNMIQ03rQfkEgR1wfZIBp2V6LVyhoVmq5YkCs" +

  "J6yl5tYxgLPMjnDG5G/Ag64D6YYIj2xNCvAYJ/jyPWcFUAolg2qP5XterXLm6l8jZIhrAC2cIzQeWGkbDLjFBfMVXnPBLrxxxy68" +

  "fMd2bBh7Vv/ZCOaz6zT/21on4yf684z7+hm3pk3TxoD1AVkwzkB06ZBuXAG2KbOnXbNShuF5wjconszgANZlhnQslB/EPeNI9xHH" +

  "9T+gqj5xenF026ZN3/Nbt3326A+8+pU/8v0v0JMBLzgAcOjQoWo/Ufu5u+++4lfvf/DQo34wPdu0nqsE9MsI4cD4RGLIAiuRsiWK" +

  "5qj8GQUFBd9Nb0ViWZSASfKdtFXZJwW6tTQ+QBGdDR2UYcv40udRvkJbpII2NrTQjvuYRYfl2mdUw8pggWVN+oMZIFfebWbJBMX1" +

  "PKXC2ApYO+cSnNY3dAIeCFH4+94xTvU7Mx5xbEQ5UZCCXHgZcMQoBFJfX51lctEEXVoOmM2cGoBl9NoMHEJgpU+fxCOu2aEMMu/J" +

  "oOka4DSLsncoJfoJxiWGaH2iPbOPAIG6brK+ILE+v33W99j/LHAze84CQSq+C3V68y5JpkxByqw4JgMWXo/rMkABNLZUYalt0Kyt" +

  "4ILBFL5u93a89cIL8Irt2zE/mNF6Gx98+kTPbjBfgZFQLvLuWs7BggK3Z6MtUm6bPlmHlYUnMp6BDBDrWhYrmrUG2fpMeWz+0eOV" +

  "8h2HmJoQc2IPtwbGyx6YBg+Onjw1+sD04If/0x13PPA3X/ayX3khXiH8ggIAzEx04AAz84YfPXLkv9/Z8NzAo4XjKqzvLpMBUlY5" +

  "NVUJeyMJEgKEAZM5/hfrzDZPEGJdZoP0SPwQEa3KF4mxq+ZmOTjGC+CyaP1MNgpTCjJDNNUy1IdPukVi/3VHkAqYvt2r5VuBawQg" +

  "bLd7GEx637xbmHdFG0ybPgncoDCIUE3mdQ9O7c6GnKDafqZFmuZGcGYNB91YCnNsTtpbIg7pbQ+IyOI0zGdJeNv2ckpy1AtICMmC" +

  "YpimGVYvAiyCFJY5ovilCvcWoAqsFhEBRbEdokGqYBQYwIHbU8a7VWh6FfwyOgFgyYfFqkAfW++LZ9FloyAC5qfUHyGPsSZ0QVQq" +

  "LAGe1BnVppmzDDEULUYn/QiDdhWv2jiPt128B285/0Jsn92g7Ww5OMYIDnXBG54+yZrtsxgkPvJ0ypP1HMr88kFAYltJwGYXANlo" +

  "UHnWWIXSmovRPHZvRZAmBjdCzs9bsFqjwnqjlLfF4kblGASgDWsjNDS+z5gF11988onmz1bnfuGmB+69/cY9l7/3hXZx0AsJANCB" +

  "I0eq+qd/uvmpG2/4N59HdW3Vjhoi1GLaESQKlNoF66a3fkzZUOQILOd8jRzML48xi1iVM+WEqlFkDbbAIGOaqczYqnWFf0l9QYyA" +

  "MblHYUxGALWqPdpjb1Cz8JhL7JIQUNNtXq2UFSJ6U8lk3pHfO/2I/yYbghRohbbkZYysTLROI6Q1uM4J4GLV/FI7Ak8K/bT3IlDG" +

  "OCLCg7gqOA1nlBGhYeGGRZ/NedctU45jMmM7jpHm2o7uvAhTowjiNJBPQWR8lhOYADjlrNc1LhCQEbKyiBCNdzlQAWbWWYcCDIJl" +

  "KQdzoPSMtVwEl4hPGFMG1Xa4ty5dFQYw5k1U4V1QaX3h+JLs8V7AAPFXx9M9zmFleYjXnjeH777ySrxm5/lacW7eF0HzzCjU32e+" +

  "P7eJDUYJbjUAXIFitj+CGd9i4jTgEshihFwU1AKe5X3nHLz3If6CSGoLvKtgw9Ii5UXkwv4g1prbACZpDs49vNrUf/zAI+9kXnwN" +

  "HfjFJxaY3UEiOyHPW3rBAICFm26qDt54Y/Nvb775/7iZ6PuWTq0001TVnloAOWLuCNII++PWjR8lpiVJfYx+FV9kW0Bcu7l2kTFO" +

  "Ux+B4L2PyDN5qUqhIFrqeky3JCuUQ4uSF9ZIyew5B6fCh/V4XSIXhbBqj4ZJZoI8b4gKWDMaaeRiWbJprcAHEJiEiVLTkWcJUDR9" +

  "MM94GLOuaaeYi8WiIH1X4UtB2Gnsh6YrhOYzFy0z66YKX1UadZilTWzqSjfhIWuDWDvkJEUJqKw7wcaPyO8O1qKUz4UwYHV2xTGk" +

  "bOSid5ujxmasLnYNJoacg1px31jB781A2LWiYakidC04lzosMXfXV/xc2yXo3OcxMF2XWNeaEPzNCbw7AwZkMCXhFANwFWF5dQXf" +

  "c+Wl+FvXvlwBU+v5Wbl0x7Y9tNfesZFOuVjQ2Ad0nmatWne/heHpUavrGoIMlW+E2lJ77S2HkmZdQECZRVFXbGHNscqX8t2CL+Vr" +

  "Ia5Cc2Uz2fKdgwM7N2qbOys+/+BHP/sH9cGDNxwJcpPx5Q/4V53OvTRSz4AOMVcHb7yxef8997z5luHav3v89EozharykMtf5IpZ" +

  "uzHJMF2AKUVdpzxqBMncpjOdSWgEJplpGw7EoU6KTBSmnrgDwuul8FIA0RM5ja7gORNZ83AoVd53QQtk6V8Q7y4yE7CL2xB5+yDI" +

  "O41d+DwJFal3XcsA56ZGD0msEsx34VxuHHcKZj0gCYUgnFwQ0ByyFEqSGQKDJANYJgFbSM5RNm2Tnyw3zbFpHyXQI+vFa2/FGCxB" +

  "YHFeo7k3XOqSBGwCLwUwlPFkDsegYpt9Llsj75MDgekbonCMqrI6f0QgduVq/ZREB0XNOxw5bJGCJLVpyCqSlrDlfUlzU7AqT3rK" +

  "7kbo9/VLRkATgGoYeQmeLfyWyHHYMSnAcp+wTw0M68ebd6UtPq4Ta70QoeQIODUc4psuOR/f8/KXg+GjsHOonb1S7JlTqDeP6g88" +

  "xfIpH600Hn33SzxdCvP35Zen841ilTAA8p1rfIF4XDiCVx/3PShwJgcKt6tG4OwpWSRLXiNrN34Z940wjs5y0uRORMm1q0BZ3QZU" +

  "t6trzedG/NZ/9YlP/tubDx5sFm666QVxMuB5DwAWFhbcfiLPzDv+4J67/r/7fVXPwDl2wfHYh/hELsuic0xJWMjxKgENhmEFLZd0" +

  "YXePuRnGI3UBhcDPhU9GJko3ZTlPZrJxzGzc50F5S3jabsiwrvOxKaWmF/yQ9o/oHEUDYASl1N13BIwC042bLXPDiKapR8FEOOdl" +

  "albAMrdsBC8MVv+hHZ+8ueaOXEdgR+a54AaSFjDl/Qqj2Jr5DcGF4RipiNyQy525Cv95wPn8wikXhXb4GRkdERxJQF6wBMgaJR/B" +

  "ApOuV7VMGfARAvEYQZP32mb7vAIBlXtWbUICMVaosmhLUkbSyCIyRId03cT2xMDKDriIYClOgvZHLUdjytZDixx3dlQjx4nf0jIW" +

  "1iEhxCTI3IVBlz3l407UI7EEDAFcUNX4vmuujRn68Jyc15fslOPoaeoDZ1mnw7MlFsJdKLJPw8LJwWvad77YZ6EAZM/Kfgst7PLR" +

  "3A1kgCgJ/w6fCx8XUGVKiPzSpb1NIR6hJqpPLC23H2+G/+Bdn//Ctx+88cbm0CF+3oOA5z0AwN69jpnpJ97//t94cHbL5dWQW6IQ" +

  "hheEDKvADxo5AKuZMet/4PB8QsBBk+P4nzAl1fxEcOjKFSGampcFHLHqXlkXkuaUDFDkEdF40qoYXWEm7/fGBxAjuKrkv3ispq8M" +

  "RK0/E7hRkGVwJoIJEQJFP7PqS2DC0qYcIGRxD6LZR4augTryO1OYD3jY82kazSDzCU5znhqpACYq/GrhAUW/LbeAEb4Vgj+eiNAC" +

  "GLUtlkctlkYtloZrWBkOsTxcw9qohW9bUOtRe8Y0gClmTIExQFhno1GDtWGDtvEYjYYYjoYYjUYYjkYYtg1GTYNR22LkOQqWsOYc" +

  "EMFBBAue4XTdivwNz+sSL+YlrVCzHsGJWVrNKT7d4cdmHWbaviRWEaGtBcUARjk1QAJsDbhjZ6FyasQYgVr2x84tKK25PsEg+yeP" +

  "//FIaaejeJEENgpsGYgnSBwRVpo1vO3Cndg6NRM+c6R9ei5J+EH+3zMurff9xEtEwD7TsqOWHsEhs1gwklW1+0agjJsqzg9MnJCC" +

  "tsu5tH2QEpKzCZG/RyUk3m9Cce8ngIDIDhIfIjBaNKiocY8srfn//fgTv3nLF7+4Z/9+ahcWFp7XMvR5HQNwE3N9I1Fz3sc/+uP3" +

  "Ts399ZVTy6OZigcB8ZXzEhaQ+HlCNLSIMA9RdUUMhz0vbCHXRlXzJ+szFvAQmWzcSHJe30YpIz0l2ywtZE4QITAseefpaxikizz2" +

  "I7ZPM42ZZ8t9bv1pgbnmej+pBpae79uMFuUn6yyljkpLSPoahTJFTdwIJb1iNbowBJClUxc+Mok4l1ZggUIQoDAnQfccYRclxA8A" +

  "besxBMM3DN8CA3KYq4FN0wNsnBpg23SNzbMDbJoeYMOgxsxggJlBhemqQuVCOVVsMzNjxB6n10a49/gijq3VqAhoucGwGaFtGaPW" +

  "Y9R6DJsRRt6j8S1GbYvGE1pu0TKZdSBHyRycCaZKqyb+q+sbkDvXg7yXCHyzrtT8na8H5YkFmCNZBBDmDNXYxeVj3Q+yk8yiggW8" +

  "YEBiVUJzSuCSryf2MWeDrOVCu+8FxMxmDckzcQ1la6boa8zLwTFVtGPGFVu26+g9Gyb/s6X8LP+XSeYIsqnBjIEkyXrm/WOyIJ9U" +

  "WSIKQa55DFFwr1DUlWxcQN7C+NMoV935Tt85IrQs/IaUdxGlu1ZYyyNtd2DjEiAcVnndjvh+5q3//UuPvoeZr9t/+PAaMxPlCUee" +

  "N/S8BQCHmKsbiZo/uf2utx5+8pGDjy81zQxRjPgXdGs3e2KC4e8yYj29o0yMRUOibJGlYC6M3Rsdc6P5PFgUkqbTH7TXfZ+SBH2a" +

  "JDtJyjQbr+9R363GGxZeviACQDR86WfHAkAu+NxYhHsK5Ev15QAJBIQc/JydU1dRTt1M7knLiNo+EWImHUlrFJ91qOJ6aZkx8i2a" +

  "huFAmJtinD87wAUbZnDRhg04f34eO2YG2DDlMFs7DFy8iCjwCbQc2sEANJGTEbIVebj5Kbx8x0Y8ugzceWINw7bCFHE8Vx4BTQSP" +

  "HozGezStx1rTYK1tMRyNsDZqsTIaYrUZYaVpMGoCUAg2EVYAJCZpTVBkJ7TjejG/Uz7Lfa6nDBwQwD4FVlrLjsWPqa4xmr2dQUGC" +

  "65HZx7ad6/r8tTFBjxQWIUBTNU79xfKPZFUgTvcvfCVDwQPgeYZX1cd7Fkyu5B7hb2kdIPU0yInmbhZNsLoAziT20XTAbDI/xvq9" +

  "AYaE4LLtcyWUf1v+JmAf7MDxfh9m8y6HoN/k/AOUrRlFwjE7HjbN52dmrvyVj378lw7v3/+DB266qQbwvLw58HkJAKLfn5l58w/f" +

  "/L53PrRG1YyrPdCSoDWjMmSR3dDJ9GpGYpU0UGYpi6fDIK3ezh5k9Og+kGA1fu+B7HrhsRSZmwHoY/chwUBlMkAm9pc4LHqko13k" +

  "RPt3Oh4upjJluCScjTlQjj6VaDvl3c+PqaXxCk+Jb58gYAy5lSbtuR72FsfSJwDHUWvvEqvw5Qi2pEKOzKiKWsHIt1hqAfaEudrj" +

  "/A0Vrt6wEZdv2Yo9m2awdXoKU3XIBNF6xsh7tOyxMmqwzC28kauSFMqaT7VDxBi2HNehx67pGnM7BvjM42t4Yg2YJYU7qs07cpgi" +

  "h+mKsKGejrfshSc8GC17jFrGqG2wNhphpRliaTjCytoQK02D5eEQa36EZhSzETqnAtKRikAwy21pMq7xX7t/wmQm8CzPcRSGJONe" +

  "7pV+ARLkqzp34hpMgNibchIuLMFvvs/Kevv2YqcRhGhtgvyhY5wMIwaUx49bIjy0stzp13NJz1jwA8iQ89Oud4x78WyrFmudAG+1" +

  "0JlnIp/Uo8aUX2ftFPgAeZz+GeomSscIEZePACEYQKqL2St4d3FNZwpFXKc1oTq5tNx8Ynbw9//b7Z/6s7927av/+/M1P8DzEgBg" +

  "715X/8zPND/3gQ/8+3uqqT2VH7WAr9iRnq3PhJQiPSuQU8a53PxnQUKixEws05encsYXUEhuh7C+Jr1Cd+xSDm/5whJQBjSmxYtx" +

  "kjMjH33EQcu07RGmmT8vJlLDhSGuAQIg96qG8tJFHZ3eiInVtDXvSxu/i5H4orXHRmkSEZeMyl4Zg4vy3c678UnHYioARC0aIqw0" +

  "wJAbbBhUeNnmWVy3fSuu2bIRO+crzLgagMNa9MWvro0AOXZF0fsY4xiqTCsuDOhxzQlvkZFhIqy2Hhsd4Y0XzeBTjy/jodOMmUEN" +

  "iW1gEc8xDoTjEBEQ3Jcx538Nh6lqChuqKcDNxYQnhBaMkW+wOBpieXWI08M1nF5dxWKMVWi4RUseIBfdFLJGraCwWpRLayFfINkn" +

  "do1ay1maF32tONWeC3BbTrohu0ezLy1nYzT/PvOw3BypYD8saCgUk6EwQD7EBxCmBzU+8vCj+K6rrkqaam/Nzw4lxeOZFlCA0nE0" +

  "1iUwfm+vW220aIk5PX4YqipAm+rqJG6qxNKergvUWqDKwOQ+UBjmO+Z2iG0Q/prcE/FkEgPsiAbs3SOjkf/A8VO/xcyfIKJHmdnR" +

  "8yw/wPMOAEie/9/+3G3/13tOLe8bHl9pph3qESVGYRdZrhHI14bl+OBDZrRhwUnkCgGaECYUoGUmgBA2pq2n/F3qkfXvVYtNEc4Z" +

  "0EBgiB5cMM1+Zpp2CYpSUptTGWGRO91PcoY4vEOsrUIayii4KZrIDABiDoJfNKhxWh9REVwIu53NOeYIvZmh8X1hz8Wz6aph5+Mh" +

  "oyY+GRZNg4HKhbPoa56x2jYYALhk00a8+rxtuG7nZlw4O4VpBP/7agucaoMQjnHCqFylIERM5GInTv7kHDBan7iZjcjUPJxzWGOP" +

  "uiV8ze55zNEK7j7VYHpQwTHiefRgkRFelOJMBWowwvGzFDVvaseAKmybmsWO6fk4ph4jz1hpRjg9XMPx5UWcXlvF4uoQK80IDbdx" +

  "+AlVVal2zlEAMGQ9SxyNnV8qllqK9+juQathmUEzOyWdc4e6vcYJ//Wo752M6cc1l9qYLoZKzbL7Prh65qsaX1hcxH/53Ofw3a98" +

  "JTyHGwLlIAhl/fnyqTu+zyZx3tRnEQQID0vwIyk9KoCZo5sgVq/tQMT8uQugbxhE0BOSsifgv4St1lUUP4AGHWuWUIOBRejL+0Ro" +

  "A+90c6O2ubea3fqTR478ak30bQeOHIkpLp8/9FwC12edBGHdcfTRl//KHXd96vNLDTZQVcF7MhedxXkrmYbcUS4MQLTSaLo05k2R" +

  "PMksi5xxdMyRXWbT58fM/P5IoMQGdwXdj2C9GKnM/g2YTFTQNkr52XMqJIPrwh714hjtnzSiMb5USoFBmRCH4oCcTDowAkWgLdJd" +

  "Np/c0CVtiM9HXsTcQtKUlsid0+MZsKhc6OVK06BtHc6bmcK1u+bx2p3bcMXGeWyowi1ta96j9Q5y7TA5ytIeik+YhVFKcBA4S1LE" +

  "ttG6bsogvDRfMlhEwGxV454Ta/jMUysYVINwDZFLmlDZllQmw/CxNGdWy0GqkyhcIkXO6Tw3TTjNcHptBceWl3B8dQ1La6sYtR4N" +

  "M6hyejwxQrD8WKSuk2iJIYnxMHvMLoc4LtnEdWYv/s1pz/rOWoxBrcWaBzMoC7wlo9UVfKEAAGUNgqvUesMEkEfFQFNVGC6fwvdd" +

  "cRn+5stfmc2zTSVmlYBnSl+W+f9Zo3SE9UwkF14d/MiH8YETp7FhMA3v81M7Cgwi77Pn+jmCAhHeKRMlMmUjWdXCV65niMoIoX7S" +

  "MG+ImR+QNZfWpSQfC8qFh/NAAzQ7Ns3WN0zP/J23v+51vxVvoX3exAM8bywAzEz7Dx8mZh78xEc+/Lv3j3w9x9S2xETRDSn5nDJz" +

  "pfDDnFNmjIlc8oWHD4Bsw1EueJJpN3HkcnN477PIZP0+e86WawLHWPzYWYPWG5vEWENJvRqDaG4M6gTSaI97zKl531IiEgEuspnV" +

  "1J9Ky8tXYWp7ZE2EPaCKgHAemlWj0KNs1kxMCNacKszNyaZBBY8rN2/A1+7ehVft2IotU4SmbbHSNjjWkGprRBS1EA/4GDsAE3So" +

  "nCjTDSNoiO0u1098VualbwYpjueK97h6+xzmasInnziNEc2i9qkuEWDaHut60HGzx/K6601Ymfce3Ho9RVFVDlumZ7F1fh4Xb9+B" +

  "UeuxMlzDidVVHFtexvGlRZxeW8OwbQACKheS0TgBuLFOyZwnjJlZ5oc1LzsADZwNY6p6VWymrAyxArksDaw8Kz/LIVezr7TJueyt" +

  "fOd1AXI+Nype0gsR0LTk4doWs7Ob8Ft3P4hPHzuJv3jpHly9fQd2z8+hPBxuwUXAfl8uJHgWqFfTf7YojHbYvq63noD/DY8x/zpy" +

  "2XdA4kFerRGkqjZBt1w2st3w4Nhtl/hyao39O1qpbIpxCiVqYhAitI5Rea4eXRm2Hx6u/sIH7rjtQ2+95rovLDyPUgU/bwDAgSNH" +

  "qsP79zfv+OQnf/Eerl6FVW4qR7WmaAVUOwoyPjKVbO1F9FYId/tTvxHtqdQgUPAjdIUlM+vxPzIaRgdBi6BIShtSMEz+bC/4FsEv" +

  "bVcmm4zEqQDRXClm1AqmVs33bsvpa6v5XFKjEFVR08r7bn/PilHwlQYgPG78b+FByFHArBdEyK6PDYgFFQOucmgd4fRwDTOO8brt" +

  "27D34l24essGVAystg1OrMneTUAolJ2u0JW2SIawjhU5XpE8jkj7xJCkR6HfTjkVc4hkjjZygIClUYs9m2axcWYKH/3SKSy3DtMu" +

  "WibGWWPMeHU+KcepWLjBoBLiBTwYftRq+zcMprFpegaXbNmKhoHFtVUcW1nEU6eXcWJlGUvDVQwBkKtQucoETMXLs0hZqloCrPam" +

  "O018UTG3g72MxoJ4WZtpCPIOybrxJkhUx8C8L5+Vo1VaF1IQsbGweI4xsxTvUmCwbzA7P49bTy3jlltvx8YKuHDDHF6ydRsu37wR" +

  "L926CRfObcSGqUFH5Ldesi6SpsIeT6avevRxvfVwNmTA61nQWSr/sUTDS4kRMmiED/IA4jTXKsRNtzieYCmtkR03YOT7EjNlwUA2" +

  "SrKmerUjG6BM6dGsDKew0Edk6glUNSM8Npje/r8eP/m7zPym/YcPMz9PjgaeA1D0zCQRlu++8863/dcnHn/fo0ttUwN143ITp0b6" +

  "x+XQTzqFWedFCJeIsY/KxdUVembBrgMAMlOklBy4lWo08hz1gALbdpD4XSltJGF2JJpXWM5hsyWTOkqmOUb4ax8h5bjs8/XGSqgX" +

  "QEWTmlhC5E2ZTiJSE72PbhCPmDO/quDZY3XYYq5yuO68jbjx4l24dOM80Hose6/R+qoPchtTP6dx9oIifRI6Y6kD7l33BaNhkQgS" +

  "cxMcASF3vmjJkU1uqQfwI8J7H3oSJ0cOAxczlYnG/QxJmSaiT9WJLz9fs8nNFGaOPFDVVQC0zmGtHeHkyhKeWlzG0cVFnFpdxUo7" +

  "BBzBuQoVUW6yVVTeXR+hTbmmbbWwrhuqAAXwCUPED+U4Yl/fhco1aT8HECwPhWuAmFVz1AUV10yNYEFa8S2GTYumGQEMzDjC9pkB" +

  "Lts4jyu3bMUV27Ziz6aNOH9+DnXpzmM5apv28PrE+LJyAlDKfXIWD+Pp+P9l7BY+/BF85ORpbKinENKq5dfyClhU4QvKmsNj1nwf" +

  "IFCXT2pxdB9yWjbGCmx5q/40lkygy9+FXwZ8SGBuQyZZELhFM7tprr7ejRZ+/K1v++nniyvg3AcAzIQDB4gPHJj+0Q9+8LOfGeJy" +

  "akbeiRKFtKED04mMqwRf8UEbe3+mzgdtOX/Qauq2hhIEZP7HdevQAsICNIs+16i7LU6BNC4tdnQ3SHhTAEnQgAPDjNuuB5iUn4Xg" +

  "8xKw9PSnAASdYEZjmzCwJyJuw81dYFB6NjdKFM0TDoCdw/JohI2Vw9fs3oK3XLgLl2yYRds0WGlDO6q4FhQbIv2iDosSaPHTAACd" +

  "8+I9Yx8DU/IxpZhBLpCjYPp0rsKoHeHJ5SHuOraKxRFhUNUg75GOrPVTljVtDOOMD4h476xtToUYDhivFEZwAVTOwTmH1rdYGY5w" +

  "dGUJTyyewrGlZSyNhvBEqMihklMbnHacj/Oo8RN6T0eo33s5SUWq7Y7DPjFiJO3nPsGA7pCdGQAQbIyCWDBYgDRkqVog3Ia6XaWu" +

  "7tZ7tL7BsG3QeI8BCBtrwvkzM7h800ZcvmM7XrplKy7cuBFbp6eztgRLl5TfcSooWEvWgKcJDvsAgOWZbNf007sm2AKAj51cxPxg" +

  "gJHIYeYIiMOklvEkmbBmE/Aq/NvyxKLXvXFY6cv4jrH/UvcdWav5p6w8gZGAGkCAF17GWCE0l22cqX/g4gvf/OZLr/zIIT5U7adz" +

  "+2jgOe8CWDhypPrpgwebX/yGb/qF++qpy2lpqXEONRDOc0N8j5B1E83uHWGZDFMpxljIPmsYiAoe6IIULdu+qcuhMIGn8qyAKbQT" +

  "+UXiEIr3OyZNY01I9QnoiSUa64N8nkYkXYW7XrvyRjJabyLwkRBzn/UjezXbhICnGGHP9pkkaXJhHSLdhQ0SE+oovJYbQl15fO2u" +

  "rfiGPbuxZ8M0hqMRFlfXAHKQ7KzBL42I+i3DoSToM43ANDY+x8zmApOS0XbBUxok+4UwWzuf8lgEpQ54ankFx5aHcK7CJVtm8djp" +

  "NRxfbVChQh0FcR+rzxVs1s/I1iEghCW+IXchZY02zJYcoZa2c8iS2DSBr80OauyZ2YY9W7ZirW1wfHkZT51axBNLp3CqHYVLcuCi" +

  "ByS2hBFTMTsde8n+JvnvBUSHtNzU47K2IawBR5TrLxP0xtJ1NqDcAn3EMUrbK8UsMHy6+hcOvhXPc9hx085h4AYABZ/1sPW4e2UV" +

  "n19cBD/8MGaYsG16ChfNz+PqrZtw9Y4deOn2bdg9txFhrxLGbU0JDrQZEdcnwzO4R6MfGxMwDjKd+WmmeK21zbcQn5GH5BZLPWoP" +

  "ABwDAZky5aa0zKQ6e3hYbIizlZFRZPqGTKyvnE75+CJxZsXpgrIAMlu0DEyB6MGRx3+6557/l5n3HjhyhKI/4Wmis68cnf2sfhVo" +

  "36FD1eH9+9v/ftftb33348dv/uLyajtFVAEhHacyL7vx47G0bsfIrMzemY8/ezQnAHYX2sW3bsQ8gGRozZkJev7uvDum3M7nMRnL" +

  "GVcZi6YVUbXIKpKW5hs3xbiF3Tm2jz2uD3EVpHTLyJh4Z0vobVx5PWIGZHKoibDMDUYjxiu3b8Zfecn5uGLzLNaaFqsNS3pvkJxM" +

  "zJgC9ywKWp/pEfR+puCd6Ol/yUgLwa9HAmHHPn4XgvFDzIZzOLq0jJNrLVzMMujg4SqHp043eGKV4dy4cEIBNrIHYjNkH0h7osXB" +

  "mTFOSVLGs4Kwx4zwjF3OzKcI2Qdd5VCRw5pvcGxlGU+cOoWji0s4MVpDwxwsCOTgo+B0EPNysf5U8483erIEeyaLQHomuS5sfE8O" +

  "bsrpL/YAoIoEaQw6wGihrinOAbe+IVknxYJFbfo9PiPzQGpNCLpowx6NH2E0atG0Ho48NleEr7vgIvzg9V+D6SpeFdWZHu605UzU" +

  "jaM4G3I6D2e6nEhITgEsfPjD+MjJJWyo6xgFENpqM7ICAovDzIXg0vCs8hNKx6Kt2zTx1Mgj0AVu0u8APKNAJ6MO9bgD9PdivCQ+" +

  "i5ggZz2CUpPcRCOPduumjdXXtO0//+c33vAvzvUEQefsRQYcbZHMPP3Bhx//1S+1HnU8JE7eazBmhghZtnBvibBHtMIao/x7iPUg" +

  "MQuJELcR2Na0v37wji09CaBMqzgLc3rf5/ouiYAZL5zTH6ZjIpgoaYf6d5Ij8Zc+s3YOiMp+hRoSpFdfnBZQtDde65s2dBJ2zjm0" +

  "DJwajrBrdho/8Io9+KFXXYZL56dwcnUNq97HlRwCAnU0ZGPL/8S8x8EK4n3c1Mj/075bjMWkbUwf9sydHadiPFHMRdCMPLgiPHZ6" +

  "ESdWR1H4M8AeLQhNy9g1P8DOeWDETbwmWeoRC0n0B3thjmatgXWNiObPETBY4Z807pySthX+5+OeKxksuZBmedS0WGtGIM/YPbcB" +

  "r9p9Id582eV448WX4apt24M52LdoPEOvzRYGLpduxb0YqkiR2CGon+A9TP2ElDdO3rRY3+xn7bQsdrls1kEuqNEcBHKJUc86t5NI" +

  "cLqWbdBlafkKiCVe80yEFh5tzI43cDU2TE9h29wsNk/PYjg1i8NfvA8PnTgetPveeKbQVqIKck3w2fGixAPPhiTDZYAuTy/mII6O" +

  "oGet31oSbY4gAXPKo9nOataoaMUQ6CDOIGfKsoGFrDzOxr1YKq1HyQKbQKVYqgBdHub30JEpz+7E6aX29mZ44Oa773jN/v372wXu" +

  "M7ecG3TOugAk6v+XPvrhn35kav4VOLXYUIVazKWyeHJB3H/8rY/KraJ+RsmdjrQIhNXqcuxZPONIw1IMSD/jRqXUhrHlZhpcMhOW" +

  "r+WWAhawHNuGEAzGcVNQIZel6fHI4Ljgm762JfRuntVKZVxYhaKBVFn9BOBkM8TWwRS++bKL8LYLdmCOGKdGw5DNoJIjnAwf73Zn" +

  "o3VbtYCQAoX0GlBGfrLAjq3pZz4oVviUREn4WkZnnpZ6nXPwBDx1chFLIw+4Gm3bBqZDpCt91TfYOVuhdsDjp0YA1SEmQ256jIJM" +

  "tSLtthwtjVMvc2BbWzC9PqtU3v8x6zIgrrQOAaw1jY717rkN2L1hA65qhzi2soqHT53CU0uLWB42AKJ1wwVNn72sG9EYwxTKxS25" +

  "y8LiKjs3CQToJ8YaFNx76fhvCDRN39v7MrQ05THWDpO+l6UmIDMfvxDIKsLHxQVKWi7Be4/aEZq1NfzVy6/Anm07OtryeMr73kf5" +

  "Xs2fDyd6uvkGZOzL/Xy2JAK4m/cBQZAjBvPKuJnHgvsgCXPbqNB6OcFkMpzGcrXhMOX17HM7x924KdNOTrwjpIDXUnScgLAVK+/p" +

  "YdDUHz302O8x8zX7Dx8Gn6OnAs5JALAQzlE2H3zgga/97fsf/NGnVhfbKXJVyyGZhANngirzjeNprFExDRm0JxgRWk7EvesI5fVd" +

  "ADEQzhzNSz7EVIs1w2fM40xdYHkn8bc+V0PSThKQIeR1idAwqr/qw1SM1XpxAwnJo/ssFQ8Kk4c1wAJUMZY9AN/gzbu24i9fdhHO" +

  "n5vC4mqDY8SoiFAxqbAgcnAcz37kGMIc6SPAxT61rALxTObv4AcvkdWYd2KXMkMBijUi2glVePLUIk6PGrhqEJyNukpaLYRBaBrG" +

  "timHeh54eLlBQ1XQfUxshrfCSYFX6kfKbEnZUi79q1k3i651iMd9gaxda80IBEJNhAvmNuLCDRux0jR4YnERjyyexFMrSyHtsqtC" +

  "kCFYL6VSzdMAmXGVytFWAbOMZEkS60eYdznKSnkne0B6HmuDoBWzrNsAwMJxN7lwJ7TbsVEAmGN+iXQHSRrVCF7rCqvc4JLZefz9" +

  "V74SAxcvzzoLjmbbdzZUXix05mRDMZboaWQETACUeouWdecJWZhjdr5fx57Mmpb1y+Y/w9P6joMW1la7H6NhSQ1o9h3lpfJ58a7G" +

  "tcS1GUCMd+2qbz8/j6v+5Yff/yOH9+//xf2HDlUAzjlXwDkHADgl/Jk98JEP/9ajTVtXLbyvOAbFUnfTggH2Z7FNSkomLTuhkmGM" +

  "UuhpWhDgzmJeb9tY/piYV98TKWJ6PUBRkrBC2f+yDQRodNopaXk7gNwVmbTM2ERmKhWKXzwrn+xYCvelmASGTNtCS0JbQuu1/UTh" +

  "mlwQlocjXLRpFn/1JXtw3fZNGDUex9dGYBdvcTDBBCxao5aZOqxgK3CTEPzsWFJ/FyOQQFrpq9cz/SJdIwPKLBtATF3rYLPUEaKf" +

  "MFqLHQhUER4/dRqnhw2qqk6Jozid0CANmogBZA1j82wF1A5fOr0Gj2lMUbB6gFl9/AnUFBqNsQhARp7z79Mc5tqUI4pOeANi5N0C" +

  "8Mj7Up4Dads8GEPfAp4xcA6XbN2Mi7ZsxnLT4MnTi3j05Ak8ubSEtdajqms9ORmaE8vwXvNsJBKNPdz1bhPJhF+9rv2kyXJww9gs" +

  "dyRJkkJfxwkNWJBLPlojw7OtttSciI+L3IlJ3wobEAYOWAMw3RB++M1fg82zs+pLPxMloRwSZp3d8cAENqUV+d+x/REo5MdD1ycL" +

  "WFoCNM9Dx+PMup48urEBmSLDYt7nFJfTl7+trGGMdQ8REARLWle5cc6F7IVZvxLcSGUjTS/SHhvAu1Mrjb99jQ9+7sHH/9vLLz7v" +

  "3oVzMEHQOQcAxPT/W7d95ofuRn1ls7bS1I5qUXHjvtWBTmg8bVBdytnk96sqZQCbbB4yZdgJz96FyIFiU3T826SCPfvYfGbka69W" +

  "boGHeLc0CCpdmZK1yy7o0izvmAzT7mtX1kNIN6McBdu2mL+DCc/2Bsn0aYfGoCJGYIzeEU62Q2xEhW+5/AJ8w0XnYbYinFwboYkX" +

  "1zhOcR4e4tcPbVB5yaYSyjFBppVoTIhDMrj3x2WQs+vHohl5x+REiAOhrTDWFyKCczUeP3UKp9dGcPVArRhGxsU5NwmSYt+GjceG" +

  "AbBnc41HTozQYAC4dHuZgGPSybJMl6zRBXEQu9vCCj2zRrMjVDIOMpYZJ6Z8X0VGn099uKO9HQXgPuccXrJtCy7dthXH11bw6PET" +

  "eOj4CZwYDkFVhYEzyWFLDSwKmdAiVmAZZsanMO7YVnEFpbkhQedxSGRNxD5KbztmfVZAReZR8RWrnsL2nfi5BNZSyP9ARFhdG+Ef" +

  "vPzluG77DrTeo3JP33V8ZsXBnOZRTdqldmmDTTwEGGGhuLPU/mVQXOJnOWbPW1QodIlPJeWAkPa32Gi1qxaAFub80mLZx4NhgDHZ" +

  "+jtDRxojJsHNAkogmlFYOmAiqj37R6YHs79316d+GZf8xb96x6FD51wswJnh5VeQIkLiL5588qp/edvnb/n8ajMzxd6xsDHVJHMB" +

  "leaelcmKT1tIHs+DhyzJghHfsKA7NjXYJw0iVAQoO70EALY+w6RNWRnT1XJjzWq2LZNfJmGTMSogY759Zvsy+y6VkrJHQpAxM7LU" +

  "SzH0hn0Qxo4g2fTC66TpeUOp6X3x4FVEGAFYGQ7x8u0b8O1XXITLNm7E4miEoad4y51cB+pj8hDTStIeCGtIzEwifhPwN0CGIPBJ" +

  "SqikhSYBhINE2TNUsNjASNn/+ofTbHE67o5AjlDVNZ46cRon1oZwdQ32rEJMhVkPEawFijFFwBoGePDUKtaYMEBIiETxpEBYIU4t" +

  "FDn8je2K4ygy3K4pNj9lXcjRcW2L95p3v2Si4yjj0wTTp7B/HAi1q+Bqh7W2weOnTuP+o0fx+OlFNMSoqzoIRk4Bm2TmjOBMPgTp" +

  "KyPESSRXVoKRFEsI/MKJHdeCPAEHpVCwoN7Yj62AIuU5hmfFy5U8AHaMgSOcGK7hO/Zcjr//ileEeRwDRPsprkvdn+uBgAKcyc2k" +

  "GW8E0tl/b/jG2ckvsVz8zEc+gQ8eP4HZwSAGP6I4oh2AoY1NyTmQKHkyvyKwrZM2AqnCqpL6QakqwYBIXM0e97PWV1tUZ59zbl2V" +

  "Y4Xq0gCjhUfFDiOg3VZTtf/8S//id1z3sv8tJ9vOaiC/AnROWQCOHDnimNn/i49+9Jcfpmp+qh227PQSVsPE4sKlGAtgNQIizQ4m" +

  "38nEdi8USSTINvddA/mSjM/aP9SciLQAjQk8aD5G6Gseaqk3salkhRAQY8y79lk253ktxzVCUYKNyvqYEwO0mgA08ErhB9Qobpg1" +

  "5FIbQd1FP9JHcVOqxE1tB4VNUjEAR1gaNZgZAH/zigtw455dYGYcXQ3Z5Yg8Wp0Szn5ofcKwY3nK+iMjVX5O4vPnkPM/jpOLJwgk" +

  "ph4I80QcwEEbh4MQTok4cqgcUDk5moeorTmtLwTlBT9wFZnnyqjBQydP48QwaP4JiXRWVYeSZSWM5YiBqarBpZum8NBii8URY8o5" +

  "sI+R9M7BUxvyqvvUnjRq8ivphSwJGFC25pQ5m1wIcsQzaWoiaMnMdb5uw5sS/5AAc9LiARBj5Ftg2MIRcPHmLbhky1YcX13C/UeP" +

  "4+GTJ3B6tAZHDrWrw8GMuLw8Epgg2fdRwEmXNfW1ALa4L1N0eA4OdekqyLE8RFGmHb7M0pbtcwVbYQymGHDscGzY4Bt2n4+/+/KX" +

  "B/Pz0756V/Yxivb1kfRJ3ukxywOZ0CcDhp92q6JSFgJty4RCFMz5MWlHGGeL3gxPJkYJRKwyR6ggbsjuuov8lGXH22aQLltHac/r" +

  "aBSWU42XKfppZQtxSOrlAVRMOFFN4eYn7v/XzPzy/YcPj7cwfBXo6c/qc0Txmt/2jz57xze+6/ix//3Q8kozza4Wv6mRQ1HBDn4p" +

  "ipFCwRPAurksyUJowcXn+SKSZ+0C6guQ0u0gi8IWWsgoVuQvH5C2kbWMHOCkRSfM2Gr+0O/kMxLESlHw20YkcKsaSLAsMPSeey27" +

  "DHxJm0UDqEQz4nhVpw/zkPkdieDFxMCSAz8JZY7gZkhAs7qKV26bx1+7eg8u2ziLk6trGDkKWbcZ8bztmZepjp+1pGRzKWNlRtIB" +

  "JKbNeJzL6xUiISq6IsKUIwwqh5pqEHms+Ran2ganh4yl1TWcbhosDUdYG7VYY0bjfVyzDhUFz+zmFtizbStO+xFAleY5t2NGMmew" +

  "WpLto2g+Lq4rxgAMrmo8eHqE02uMzYMpOISb/LwnoAXYE9qqDfPtTGZFHatCgBBM/SWrA4z+FOe0G9TaNZd3eyP1dRiiuGbMMa+B" +

  "c6gGNZaHq3jsxEncf+w4nlhdQkNA7QaoEQGFgGiKFzzFmyTLZDnhRGBcDyXfkMQ10kbkAXK2zVbIKCC348aseReUDxFQwYMc4yQ3" +

  "uH52E37mjW/CTF2vM16J1E2pbbBL6cyCZVxmv3DrpgjYZyb0AWMB+PDH8YHjxzFXT8UrdJNjJW9Q+CfxQOFN2jJAlAljhUh8Kvz0" +

  "8CZEJefjIjfECtHGNU5RaRDrsdRm+WhaN+mUmfDuEhCIAhfCeEnUoGbD9Gz9lkH1z370xht+fmHhpvrgwXMjTfA5YQGIgX9g5rkf" +

  "fv/7f+nRhnmKyXlqgXi8KcwTxfvSZYPmfkX1WMVJBlLq0VzQlZssfW830jgmZoOIRGuQkpNcZv0sEWUokgjq0xJzum2pOh9UeBYD" +

  "R9qMJOgL9TgqVWlsxEyoXINjFsLUB9VWpEOso5Nnl2N0GGvXVCroLW6MmPxmuRlig/P4Ky+9EHsvPA8tWhxdHsFVVQhlUiQeRZ7g" +

  "CYXv+WCI8M+AWrFxZbytICNCBJGh2Q5A7SoMBiGD25onHF9ZwxPHT+Hhkyt46PRpPLK0jKOrIyw1LVYbj9YzWrBaZiQ4qSJgWDEG" +

  "wyG+9SWXYIcLwKKLGsNgyhkW0uimfBzDJyE5sgCaESpM+RZ7tk7h3sdO4shd92N26xy211OYwhwGdYXpKcLmagrT1RSYGA04+N+j" +

  "ZmZWmllKCrfNCMtPw5zF7BkBoQiRYFZN7xpYls1JmqdsEccnkyAY+ha8Giwal27fgYu3bcdTK6dx//HjePz4aax4D6odanIgC/Uj" +

  "yGWOqWgonRWHAc4i5p1ZM7LG7SbO3GilpQNQqyMhmvhJvefCeeDAGFCFU9zg0ukK/+x110cz+dkF/eUKgLbsjO9lT3fu3gBsPgVV" +

  "FM6iPWPbCWgsRFT1IfFK1qxvWxFi5JJiEoyTGnUMikG/opxwvJeBjDW4Z3B0eQUQEN51Zv0RkGUiNJFfia8YmWMVDn1fOh2Bhcyl" +

  "8746PVzzd7D7qVu/dM+7XnPxFfdwvNr+GQ/us0TnBACQwL9f/djH/tljg5lX0OpSy44qi1QdSCdMokn1VjspyGhRnlQGy5e9dXc3" +

  "Uw4UANn0CAyDxCcdsSp33wxvm+hwGy6d8dOUB902L226ngCu1NVO10oXQqfXuhlJYwAIBPbCeMLv1m+Wvc5FvQVICs9IsE1Ew/HY" +

  "E3MwtY/gsLQ2xHU7N+Dbr7wIF87PY3ltDQ0cuA7mdjXb5jXJjkN/5FpixHp4I77Z5WE+zmPqV+U85qYGAAY4MWpwz5NL+PyTR3HP" +

  "yVN4+PQyFkceI2ZUcKCqgnOAcxWmpwZIvmVxkjMcMbyvUDcjfPurrsHVO7bi+NpaGGMRbElKdQd7HfIIrg1EQDwkoB6N8IqdW/Dw" +

  "4lG86967sG2wDRt8hdatwA0G2DS1GfMzA+yY3YSNc7OYn6kxX1eYdnW4lMV7tK1Hywlo9I9dPifp3DYZhkhpL5rvbG/HUdLcxCiP" +

  "pPE6oPWM5Rg4uH1mDuddsBGLW1dx/+kTuO/kMaysjeCcy+5ZOBtB1hl9EndAAmJ9ZWTM3wi2FIOTymcwKgBTICyCsAUeC9e9Adtn" +

  "5s9a+EPrSeM1/uKz/neB/j1U9u/LEf6BOALrmLLYfJNubqSggctx3vAtQvgm98pydVmaNlrFpw+gibYvazv4/rWVERzkFk8f7xe0" +

  "vn2RAzrXZv5TMKMwSgKFGB+qvfcPu8HsH9z14K/WRH/h8OHD50RA4Jc7w182SarEWx555GX/9o7PfeqBBvVsS651TJU9nhNJfHtq" +

  "NufWpI8M4x4Wj4+BWKSR4VZAyl3hSfvIaultq4UGmTnxTJ0sggIFpCAycVtn6BonRroOSbBKEtjdljA45SAoXBulxtzRaKzVA6KR" +

  "RT01Iu+yTNbx5+I9h6VmhGlmfPPl5+Mb95wP3zKW2hbsQn5tlSZWkMexCXonF0l7xowPITEXq9uKKZAQz5h7zFQ16noGp5sWdx8/" +

  "jdsePYq7jp7E8dU1rDFQE1ANqqhZhlMiPsYbiVYpExryDITfPTvMtA3+xtWX4YpdW3F8eS1eFMPRPRJM1LL6xKSf/PFprefm+PQ7" +

  "gfQEAIMx1QKbNwzwoXufwLs/9TA8ObjpNTQ10KBGW3vUPI3K1ahrwuygwqbZWWybncHW2RlsmpnG3NQANQdw3bYhAKzl4L+1We+k" +

  "v+qcIjvWNAai5Xf/OQFDPX3LLRA+K0Hf4MDRa0dwFWG1afDEydP44rFjOLq2GoIunUMIZJMt5/I9ky+bOJXWGiH59scoEGVr2cI5" +

  "EYDRUhiXh3cEP1rCz736a/Cq8y9Ayx7V0/b7h/JZtQwkF462LP4m4D6zjvVZAJ4dEjDzsx/6GD5w9Bjmp2cwMsGG2foGMqui0eZM" +

  "4K11E1GyUIJ1D6VdlPiz5WdWRkh9Nr1wBhZIwEKMCSrZqmfNQitkXcXyqacQKCtrfRW+3T0/U+3bsfnb9r/y+v92LqQJ/qpbAA4D" +

  "YGb3E+99/68cdVPTlR+2rQO5eFFI72Y1qM+aktICSEsCZgL7BGC/+LbMqPwqGrGM8LPfafm2nsjounmgrFZr/EmZZjieOKCdmFMd" +

  "KnwtEBDPmrSZTBvtz1BvD4CICFcsBOAopMz7pdUhi4J2gOMKp0ar2DM3wN+4+iW4YvtGLK6N0BChcmFcPEe7jk1nK2MUk/wHMdAf" +

  "tKS9VUGko67Pudj+AQiD6QreTeGRk0v41ONfwqcfO4ZHlpexCsJ05TA1PYUpAOAWnqPgj5HGCijFdwhhTOHXEVWYb0fY//IrccW2" +

  "TTi6vILKxTPayrRiHDojRNKDQcX4s49BjFHu5hYYUuHigx8Dw4rw1Ok1vO7inZjiFv/zjgewDIJrCDPVNEAViBi+chgxYXU4wrHh" +

  "Gh441mIAh+mpGpump7Fjdg475uawaW4Ws1M1BlXQZHzj4X1MB6ziMjG+uCBk4djGSot1xhhGrMvaYTbzTtB72ZOOlZnbAYAd0HgP" +

  "eKAih0u3bsOF27bg0VMncf/x43hqcTnGCVQhZoXMu4VlgLLdYrvT3YcqVOJDFPcArHYKwRLhuQEDa1MOo+Ul/LNrXoFXnX8B/DMW" +

  "/rHFRfvWU9rL+JjnTv+L+yHy79YK7vg1OeqwWRXekM/LWIfCIhT/yXz9hTC3ZYuM0NXUwwOlvLQKIxeJy1MDq42FJwXC5llFg5Uh" +

  "HYWcJqIn1kb+w48f+1fMfGT//sOn+KucIfCrCgDkzuTf/cxnvvv+6elvWD250gxqV7ddbpcELkfT4Dpr9yzlZ6/AOyPFlZDFB0id" +

  "VB6xSQK9i8tTayUGQNwRZ2N5SwzY63uyeB0V4MRsPLWcjO2eAQQmU5oNuMl0NcP4rQmeGKidw5A9locruGH3dvz1ay7BLNU4vjqM" +

  "mfxUF4gNshtWNnH8i/IlkQf32W6GQikmhiIXwAU8wdWEmelpnG49PvvkIj72pfvxhaPHsNy0qKanMDUYYErYP7dgjklC2OuRPqkn" +

  "5YiSdoY12QCYHQ3xHa+8Gpdt2YhjK0NUVQWdoDQRau0J3XZGG0aaVx2EvkVhgWOI1uaqwqmVVbx6z4XYML8Rf3TbbThBG+HqabS0" +

  "ihaMcL2sw8ARHDu4QQUQMPIeTy2t4KmlFRAdxXTlMD89jW3z89gxN4sts7PYMBigiv5W3/gQ8EgEuCrbFyTtJp3hTg/SPhXTazr2" +

  "peOse6n/XfX7xvJXmgZEwMUbt+D8zdvw5OIiHjz2FB49dQpDAqq6RgWKVg3TNkY8m59qSCbdnpGnZOUgZvUtM6DHykRL1HTdzmG0" +

  "uIK3X3kFbnzJS9B6fkZn/Z8NkrWXQNBzAQa8KiMcwZ0AljKOSg0uAKjYCzL3KmgLpUX4mf7eY8G0pYt23xfjJXfMs1pXAMtfMxKm" +

  "JO8zg+IRVc6YVfyVybm1tvnSzPyef/WRD/yjw4f3Lxw4clONwDa+KvRcQcAzEjPTAYAOAFNvf8+f3vYA5q5yw5Zbx85RnjOq4wZA" +

  "GnSbPSpFI6/frQ7yzzTwPhGdvzcOOJBZEIIw80VmyteyyK4T7WH+s9setlJItgAFdOzEhFW0U6wD/z9zfx5u23HeBcK/t9beZ5/h" +

  "jpplDdZgS7LkQY6nOM4gfwmdOAkhTmIlQJqk4aEhEBq6+WgCNEiXIYGmGxrSDoQhD/108kEkCCEMIcFO5EGW5UEeNVnzPNz53nPv" +

  "2dOq9/uj3qnWWufcK1mSveyrc87ea9Wqeusdfu9QVZ5d3QmYaLNq8EmCr5H23fZVCTKQCLMlsJLm+KFrLscfuPgCbM6XmCZgxJBt" +

  "e/UoVbJd5goJqVIAtgqEgo9GfaMS2SRRKqH2nLGSGkxWVnB4wbj7uSP43FMv4NmTp5DRYGV1jDG34LBZTEseO0iyi1mW4qMq0sRB" +

  "8RAwJ8LKYoGbr78a15y3H8e2ZkgpRH9EKRQPI1nYM+v2xEpbUC8aEGnuHob0h7ToCCAu+XwsGOtrYzw3PYnf+sqjeHY5wmjUIC8X" +

  "oKZBprJbXrL5LM8mUbBZlq9yW1IeiQiTUcLetQn2TVZxwZ5d2LuyirXRuEQVMqPNXJxfld9tjL/61wmeKureZ3JtNjnu2OfAeruL" +

  "WQo6mwZEhMOz03j06BE8f/wEZssWaTzSqfS+UXjY5qKet+g1+pkF/pzKPQlw1VVuDTU4vNjCzRedj599x7vR5rzD6Y6vzqUY23f2" +

  "Y2Ru0aRX1g+0FMAn7sQdR45hYzLB0nRz2ISMqNaJ0TUx/RKiel07YJtt+Xxp1FGUYa9vVvhHnaV7gVfV6bC2Q4G2Gncisi3G9bLC" +

  "5excXfQhedSibXkxavjSxEf/xtVvuPGaN77xmVtuvZUOHDjwDSkI/IZFAG4H0gGi9uIvfeGvHF3ddy2fPNVyQ40iamUAXRNroW1j" +

  "mno9KxAVpL/nbCtZh5VJVWJo7W/XphlE6WcOe1KbM6FokAi8o/Bv/50qJV+HrxayfOt2wYFR3aRUaasC206Rsnu2UciG6VnOLkcC" +

  "OCWcnC1w9a4RfvKGN+HyPes4Op0jp0Y3K7VIfwKVXFkSxWQxAZ1vGOrXnFwCG0BMetAWFaXSiBJe8hKr1GB9dRXPz1vc+dgL+MxT" +

  "h3Dw9BJjAiYrExAYebksQIGc7xIXgFSqj7MbJq3Or/BZUXZLEMbtDD8qxv/o1hSjVEAIRaCWGVb8q8snpZ6iCi0MUThElPRWB3KM" +

  "FuWAIWoIaAibsxYXr+7FB9/yRvybrz6MZ5eMXaNxoXPYOru8uoyyzHJZUU8AaFT2NwAYC2a8eGoLL57cxGOHDmMyWsGetVWct2sN" +

  "525sYM/aKiYohYmlfqAowAxdLVNkU/O2eWCc9v6kspuMI5j9jqH6mCpULHUWy3J0IM6drOPcSzZw8pwtPHr4CJ44dhQzMEajEdjm" +

  "e1noQKjTdcrv0fgHPqjSH6zLwJxNGko4OZvhfft343+88VvMQL6Wxl+vzLLDIAMsxt+XFb6y0QiLfLBwlipBkr9ZHSV9QL6juGdL" +

  "x8OP3n9wQsz3ogQ9Er57dT/qOjHqtdciSBUwVFlh1qOL2fbNsBRrbYCg7kwujhE1LedDk/Vzb3/uuX+Aa665+YZv4A6Brz0HQnb8" +

  "K/P1+j/7iU9++b5Ts42NzLRIkjERwy78A1uvKRcTG3J8ZQcQxdb/jrrgbNIGQxEGC4EhuSITReO58xjRqDe7GAQc5EwrLnK5Fznw" +

  "bOd57ue3AMcBw9mowr6quHsUEthNYCxSwunFFN9x/j586IarsZoIJxdtqcrWUKkqT1EAmlPPltsjxO2NIyiwfUIq5VJASqYW4LLH" +

  "/MZkgkPTFh975hA+/cQRHNqaYjJuMBqTIXQFSYVG2ZRI1Ee+GWpclsiyvLQ8mxlYWS7xQ9dejhsuOA/HptNySmFW+selQ1pYlCQ/" +

  "KKskstQUyBzpmPpgs8w1EVdjUI2VDESIcmob7GpG2FxO8Sv3fQXPzsfYnZoSJbDn9H0ljO8HH9WxoqRzQXKcMhcvinOLFWqwZ2UF" +

  "+zbWcf7e3Th/fQOro3HJg7YtuOUSYic5epdK67b0KlRgM7JsYFRmQAski9HXZWJnusrYLEUgJBzTCM2IcGzrNL703PN45vQmVkYj" +

  "eVd2PMzVY+IIutNhroG0b0Vs4jGqhzluCEeXc1y/OsHffd/7sGey6qHssxjFK3npGQpPHDuKX7jrk8hI+Fvf9V24cH0DObdIr1Ak" +

  "QAHOgY9/Ep84cgK7JqtYytJMEuCjM5h1ubQhWvO77Sp8UevTckmqIERsVHtsF6FUfau7fQBnchLjSgSxB4bAa/Cgsmv9l8/UacwC" +

  "EBomnCbky1c5/5krLnjPt73xnV+47bbb0jeiIPAbgjzuu/12AhH/489+9ueeZt49YuSlJDxzgVa1FoZ4BcYsTvudzDHjzPfUd9dC" +

  "SZQqxusWlejEdq9+ykL2MEAyg6CN6F/KNv5s7vwbeE/BFOU4zfA1WTQg9sAZsyrWsygBzJhq59RPI/DgBh7K5FleseCEdrGFD139" +

  "OvyxG69BYuBE24oVLQrTBI/hezTkQgEtNPSaGO1DIVQRXh2sKGBi5MSYUwsCY/fqBNNmjP/wyPP4O3d+Gb/5wBM40c6xsVqO0825" +

  "rTaEilXTuo5f157bamQi80TVqyl+MYMTYSVn/OA1V+JNYvzRpFIpnFto3EI3CAXk+FObFULmZIVFyG5yHW3p3fphNqPpY6ASElXQ" +

  "QQAaAo9bbPIc65MGP33jm3DlKnB6uZTNaUp/iLSyulu7oj3JBhMYsKWCiQijJmG0MkZuCIcXMzx09AjuevxxfPShh3D3U0/h8RMn" +

  "MM0ZaWWEUdMgZZbtdtkAYQExvqFXA83TRgsss0TNGSJ6KisyBiNdMTwtZcyXLfatruO733g1rtq7G8vl0lUOufNh0J8lHaJgQkFn" +

  "3PVQ54EF2DBjTAmbixavW0v46+9+N/ZMVv1I4x1G8GpcGk09uLmJv/iRj+IzR6e4e3OOAx+/E6fnsjnVWWrKM13d0WVyiUuMsr8p" +

  "sW+VDeVZDm3ITwp1MCyFskHv6kwRlboWBdtZPfOKCAo06o9Tpw4jRnpL29Yb+34wvRAjrkGvKEhPqgMpY4VzPkJro9/62qGfA8C3" +

  "D9Dxtbheaz4Elw0Q+JHZ7M1//1Of+cKDm6dpkpqUUx0QTx02SmagxSNIMIbtDqKampeEtkUld4x+bM/yPOK1+vIVCgq73yoFRVF3" +

  "b+cURbdQxcOgxSjpO4tyjsZb98ZOoqPqhVl1WkBCV9VAUTzBjkvsRhDgXNY1owE2W8ZutPjpt16DG8/fj2OzuYR/syHvqrCGHfAT" +

  "M5YoYTuS3HiWkzNjNITANX01XJtbbIxX0I4a3PXsEfzOg0/imc051iYTTFIJ5Ws1LohtB7hhSBOLwyQSEcBmlu8SMpaUMF7M8YPX" +

  "XI7rztuP47M5RtTIvTl4J9R5g0aCCEhCk6yzpykNlDkES2hW0gWWM3WalLqjDu9S6H/Jy2C1WWKRGL/+5YfxyPE51kdjtLqjJooH" +

  "VqIsGT2WrJSeR1CkhNU3fFH5zGVcmYBdoxHO370HF+/dg/PW1rDajIDcom1z2a2wwtmso/JX2zvDOR1V16K3N5AaTGqsy3tK+olw" +

  "/mQF9x56EXc+/bTswqfAp5ZSDruNirnxtIYAhxxTAmCsMOF0bnF+Q/j5b30vLt+7p+T9iXaU91fjMmcFwF/8yEdx55FNnDtZxTgD" +

  "RxZT/MHLLsDPfdt70bJuW/11vk944daPfQJ3HjuJjZVxWQZIZI5EzOB0DfDQFWmWRX5iyoIDb8ZnzPXp8AzgztBOUV03432+iN+b" +

  "5x/ACSuIRbbPyuZQjJSBBVG+uCH8kYvP+7YfvPGdd38jzgl4zWsAbr79dgKQf/1LX/rfnkZqxgnLTDkR68lnqklqQdYtcc1rFUNY" +

  "EGI/92/ezBn6UxvgvgIYfJ5g72MKlfvkIDaq/RpCUE9BxT4Ys4Z8pt7T5T91AgWLBDsjPjuRe9Ad9jfhqLsGzdUW/RtCbERgtAZC" +

  "1FtqqcHmbIZL18f4M2+/HhfvmuDwbAZKTdkHn0tOLotx0LIvAxGkGENFNWztLCMh0sp8945LEWA5FGeysYaHj83xH+9/EPe+cByj" +

  "lXXsXx1jyRlLjnRQoyj8BA5bAwudAtq3FRXaXxbvNQELSkiLBT7wxitw3bl7cWI2xYjGRlCyVtUg+5Ihu4P83VqUZUsobda0P5Ix" +

  "p5JCiiqzeJXCU9nHwNJuZkZDGdNMmIDw37/tevyHBx7FF144jvWVSalVKYhP0muBWxSo5VxwRByfzgdxUKTZADElxogIp9olTh49" +

  "jCePHsWu8Rjn796Ni/bsxrlr61gbjZA5Y9kurSYgqfyXGYrbZQWZcC+L45h7AluAjQJnrTJZTYQXp1t44IUXSwpA5ZaqJ8VISETI" +

  "Vgk43C6pA5I97gp3jYmwmRc4jxJ+4T3vwWV795S1/onqF7xGV5szRinhn95zDz557AT2r+/BjBdoAeyerOK3nn0eVz94Pz507fVo" +

  "s5wf8XUAgSpxZOLkwFTVYUKhbfBp+lf0qgMwL/YhHOO1zfxb4TbV6cvQ3MArRffaeOwbuBfUN/4m+0F3q7yklAQkssnUmJmPjleb" +

  "Tz5/9O81oJuGe/PqXq8pAJD9/vPnDx58x4e/cv+PbU6neUI0EjEOiqtcRexCLlhzb2o0goHXyewV6YVJ6BpV/exsL18lECw+ULxK" +

  "vacCITBlGBWYGpcevIhMF0GI9R/2rGEgUgp1DHy1n/c2MMidFtuutLynn4N3Hi9eYgPGkhKOzrfwnnP24U+87Q1YHSUcmbegREic" +

  "rX9d5d1D03FdLUfBjuMl2CYuAMa5xa7VVZzIhN964Gl87JHnMWPC7vU1cG6xtE2g1ML7TpLJNE6gA8F5RcEB1YoHslHPghKwnOP7" +

  "r3o9rj+vGP+UmmC8NT9M8ANKivkpdl/OWAcBnMDc6p5j5QwEKCCp6USUwFl3MGS7pyr2JFSFSBHEJACzDIy5xQdvuBob46dw51Mv" +

  "YH28hnKKfYsSBegkfETgurlPA+K+HWCxt0oDeSYRoZFNkE4tFzh56DCePHQYeyYrOGfPLrxuz16cs7GBVRDyosUiC50q2YzyXH4q" +

  "UKlWjJjzEGXGgSa4rApZgPGZJx7HybzEKMl4GYjuFwMBIJb/qudP4c2k05yAMQinlxn7EvA3v/WduGzfvnq532ts/3NmjFLCx556" +

  "Cr/60OPYv74bnNuSApKVHmuTdfzyvQ/iyr378M6LXodlu8So+fpNg2qzlku4v0ROojgZxALBC4OreWeX36E3FDltqk97xX0DT4bY" +

  "QO+5WNSpQKB8liIbAuqkWk86bYFEtdUpC5XFMXJzemvWPro6+q7bPv+pH/rRd7z3t17rzYFe0xoAyXPwv7vvoZ97oRmlUiKkeVcg" +

  "inL0EpW09h27MbAiq0jkymuulWH5mf0ZDDPI0OclV1rCsWT7ZneVVDD2YlT06NjKe+m0HvvC9i7qjImq9zBg+eTuVa8xiH0la8Hf" +

  "6/TVfrrB0u9jlCJhTg1Oz2b44csvwP/0rmuxQhkn2owRNWjCMj6GFswBRDnMU13fUAmKhklJguDqeRdJxJiAtdU13P3iCfz9O+/F" +

  "f334OaTRCBsrTdnfHoCeRZ5AtizS2rX5VMOvOV6NLgXvUv6rxUpoGrSzBT7w+kvxtov24cR8jtRI+Jgl8E9S60B68lyy8ymYi9H3" +

  "4kLpizoHVShRZjIYIS+P6YJKv4Z2KZMZRAJhAcJ0usQHrnk9vueqSzFfzpAlh6ozbBvmkAAyUlBTK1avN6xTJ5ab1X5mFqBFaEYN" +

  "eEw4spzjwYMHceejj+KTDz+M+w6+gGNYYLQyxqQZlTMPuDVeVvBnRr0nfw6wY9Frln+Mki6ZN8Ddjz2Gw/M5Rs3YvDnutSa0pHKQ" +

  "mK1aiOA9UYFOiTBmxvHcYm+zxC+851vxxv3nYZmzbTn9Wl+Zy2mVz2yexD+456tIG3ugR3o3ql8IWOGM5WiCv/fZe/Ds5iZGzWjH" +

  "k1PPdOlwlxrtktC/befO9Y2ugXa4Os6R68UUdFYNBLsF0qST2YnCRF1rnru8x2RN7vE+AJoys+9SiJxQuA/+bGJAk01zatAQcJAy" +

  "7jx05OeZubn33ntfPuFfxvWaAYAP3XZbcztR+8nnn37vs+38R09tnswJ3Nv+uhCJkbrLlFjVSRKF4x6qoTO54hwXUxMYrGg1Cwl2" +

  "r+0AgX3PbQVGPUedgpH2z7J6DR0QcqZrGMzodppSjy39SIHP9Zlso1GFaaxbj5NcTYebKyVeeL0g9BElzInRtnP81Jtfjz98w9U4" +

  "NV9iE1LEl8sWzJSp7IOdfe2tIuiaTu5JlfXSVNYJO1WBlNBSArUZe1ZGONFm/MqXH8I//8KDeHE2w+7JSrQxxfjLe7xyvewCFwGG" +

  "2nm7y8BZKURLFpUARpmxHCUsp3N87xWX4MaLz8PJ6QyNVrXDQSw6vEVMslxxBIJumCOpKziC49hHfzrwgBYTqmKKmnTnXKYgumKE" +

  "uZyxeHJrhu+86lJ837WXo11OAZa5kveUtEuhXT+DKjKZlf+cb6xHgrC03kPHptX0o9RgdbyCNGpwZDbFV55/Dp946BF85smn8PSp" +

  "E2ibsn/DSDdSYi8KJXA4IEpWzNhGMwFISdSw8BMjN4R7nngSL27NME4NKLcGbEj6WhfDVlNh4FznSjAyxkg4nTP2phY//5734g3n" +

  "nIOWS+j9tc75A6XiH8w4vVjgb9/1eRwGsAo5BS/m3EVXrBHwwjzj//jsZzBbLgDIqpyXYY6MVyQ9Ihi7p2NsRY98RiRg3W7r10tQ" +

  "53PX4+pMwOTRsXyZVA56J0KOaPhT8iijK1VNacRK//ivPw57rmcrYGNvUwZS2/B02T7drN7w4U984oMHDhzIH7rttjqk8Sper2kE" +

  "gJmbjzz25P/5HINGacTMRNspLVXGMZSPjmB2H9VcnRWKd98/3Cn77mx4XXV8jCqUqvXc64+9gtxb4m0YoveelwgYbMwEdPE08/C7" +

  "REyqgVfpEimAUzDQNA1OccZuZPy5d7wR77/sIhyeLbBICQ1W0MhmPi2KUmaNlGRTAxYNqQGArDXn8s+rsAuZM2dMmLA+WcWnnj+C" +

  "/+Pu+3D3c8exPlnDalOWtKmq0fylejdDocP4SawK1hUVDUjmqhj/RAAnwmI6xU1XXYJ3v+58nJzNwNSgrPXLrmigSieFz7SYTxVR" +

  "4AMW60iAHZzks2HPas+ZGWRAQGkXFJtFDvpXjMYAZVnSydOn8a5LL8AP3XA1qJ2WVFBKso0py7HFJn59Wp6FbTMDEIwAoYBFjUCN" +

  "moSV8QSZCE8fP4a7nngcH3vkYdz7wos4Pp+jmYwwGTXQZcLGQorimGUFBEyZK30LUGHklQZffeY5PH/yZIlCaGQkRl2g8tovNAQ8" +

  "OUJZAQawQoRTyyXO54R/8J5vw9X7z8GybV+RgrqXezHKPH74ni/jC8dPYnez4oYQAEgKqQng1AAM7Jms4q6Dx/BPvvj5spFW7uuS" +

  "l3JJnFUiYqFQUipGi871cu9uRLbr1Veevn3c758XS6s0hflV2VOPP9Isvi948mohfJny8Jvtb6prz/pAprgcDQPECSsAHV4u+YGt" +

  "zb/NzBu333sv85kOgnmFrtcEANzy+78/uv3mm9vfe+65731kmd+72Jq3Tc4NUrcAT3x18Tg8lKmeknoPmkt24w34vdU/Df8isEL4" +

  "uk9mMYDyV/dr2+muYky9U0uMghdkfYzeWuyvX713BcXkd6gbV5atcaKeFi67wkU6xDa4BkgqlPD6Cu2vkjNTwpjGOLVY4OK1hL/4" +

  "rmvx5r17cGS2MHnOzFhC0DdlcCqWMxOQEywXn5CQuLuoMNZQSDge4mW1LTbGDU4m4F/d9yD+1Zcexck2YWOyAs4ZLQgpFcNAhs6G" +

  "FVeKtFBQxL681CJFYgBKvpLRUsLWbIHvvvxSfNvrzsXJ2bSEHqEKyZeeRQNsqRR25QYuBXfqudjSVgO3lerw3HUJiNtnWdMNKjfV" +

  "kr74/lqJ6qTqEj+ihNOn5rhx/zn4obddhwYLLLOfm5BZVgSoIbW+xl9keVcw8tv98z6UQ3FU2oohLoBgPG4wakY4MVvgvuefxyce" +

  "fgh3P/E4Ht88jkUDrI4bjCmBc5aqakJOZIqWEOkNUJtBk4T7n30OTx89hpWRFmue2bgZcAljy6o3MqOhhKPtEpesMP7ed74HV+zb" +

  "j2Vu0TRpSLm8ylfhhzaXzX7+/cOP4D88/Rz2rm1ghoycGA3KPwX/CUU/5pSw4Ba7dq3h3z75NH774YcxapIYvZcKAlSeBNgGw2vz" +

  "HfSRAfAhwBRerRElplQ2D+Pauak974rj5HulkTQcnxO56faBRS45Rh066QBrv3rX8MqzGClLDKTMGGVKab5sX1xdvfZXP/+FP48D" +

  "B/Ktd9zxmkQBXnUAQABw002ZmZuPPfr4335hNudxI/vBFakv9wWGqD23YDDh6D7mrssdroSJfLLjpCrmNKVs3oQryZgPr34GY5xE" +

  "GboZS6Z4OXhslSrPanhrYdqpWKVmbB9Th7qWm1TlrGE00g/0O0gBE5FgIxEoUWylKlf7T2YgRwQcmy/xhr3r+F++5Xqcvz7BscUS" +

  "um6jRN7EADlkhhalOaBzr7wbUiYoMnfFTEzYs7aGB0+cwj+++8v4xDNHMF5fxZgYy+rAFTdEZKsf6lK2Qjr2cQNmuHXOKLTHXBQl" +

  "E7BYLPD/ufJSvPfS83FiukBOKdS9aZW65PereYohwJKHLrvnZDQsBziJIWLA+IMMAGljXjfBEm0ApZJbpj4/Df3r3mPjZYAb4MRy" +

  "hmv37cYP3PAGNGC0NCo0VDmC8ogbjciOLmPRWErIPqHsc6BgAZ4PZVXKwR7nXAS0IcZo3GBBhCePHcfnHnsCH//aQ/jy8y/gxLJE" +

  "BUYjKisUcoDHFRDISKtjPHrwIB5/8UWMxiMU6JSVGM4jpPs7UCeuImNXueLC8uPU4NRigdevJvzCt30bLtm9F21mjFJTRviS7P9L" +

  "NbL9x5nLkc5NSrj7hefwj798H1YnawBngY8JoAagBEpS80HeTyZGk4HdaTd+6Sv34/MHn0WTGrSWWzu7yzx6+cu/qCN7RVe5c2AP" +

  "hRCZl7pqik9mJobzg74pYX8FxPpaL7pmTS0H25PVIGgqsNpfw1d86GdnisqyjnrbqKvqrCSpAKBJKR08NeNPHnzmZ5h55cAdd+TX" +

  "IgrwqgOAv/H7vz86QJR/49GHPvgYNW/nrWUG54YJUvGs3Ofh15RFERq663dz+/B5XcnJMrmDeIz1e/i93Vs6bRFcUfg514wSfxTF" +

  "I1utxs1OudN+zDvpeFw4KDBoyflr8aGFfEVBUvZcaOX96LjZ86bdMZv3SuVfiWwUydRVADQa4cR8hrefN8afv/EabBBhc9FCl+Yp" +

  "QlZ41apqlTwcaw2AChsBnKgjGyZeYBBaEDZSg9FKg3//8DP45c89iCNTYN9orexNr5vywOfGFK4BiDBmfYvqOgU8IV1A5CvrNY/X" +

  "EmE2XeB7r74E33HJ+Tg1nYMbMQ45Q88F1o1z3fDrul/dzTGbMolQTFc7cK+/WkDIll8vRwUXQ1q8BwIydex/f9zdYtLqbgsJl3Dw" +

  "qekM15+3H2+6cD+2FnNfny1zHAucnG5U83D8rAp9dsC4o/RCpw6Q4NJBtLkFc8ZKM8JoNMaJ5RL3v1CiAp978mkc3JqCVkYYjUob" +

  "mRktyhHGzIxmMsaTx47ha888j5XJajmelbNsRtSlUS4RD1X4A8CJAYAyxk3CicUCr19L+Lvf+j5ctGsP2vblFvyd2aic8RKVMWoa" +

  "PHHsOH7h018EVtYwEl5qCGjAIVIGlOkVkErJlsamEeF0Svj5z3wOT54+iSalavOslzAq75xdjRj4oscyGDD+VOjFVX2AArvSqG9j" +

  "rSykhh/wKdPiwKo/Qd8WJlYwoVJTdKbqFeMLuO6uwvlxWBEAd+gQeZ7lXktXJxIknBNxzs+PRpf+0id+/2dfqyjAqwsAiCDef7rr" +

  "mef/6sHpFk+aEQG6+QMXAqiXYIStlWHc3EGNXzW5uqOUpQB88j38L15VMPbGEBGkQvfJHhZKjz6EiEMsWJQjXC3EExin205VFGJ9" +

  "V+8pgdAEkKT35sDspf8Z2yl58p2zoLk47t4CVUCmjhloUPYwPz6b4j0X78HPvO0aEC9xghkNigAXHRoMvjadkgg2oBqRStxaYHzZ" +

  "slfHbx40AU1usWeygueWC3z4s/fhPz/yDFJawbhpioeCkIcN4bS+v1aQPCF3aJ1BVHbli8eKuiEtYHEJwmK+wPe+4TK886LzcHw+" +

  "BaVGKomdRdkSz8oz0W6wGw17u3vzShffDS9ZsZzWI7hx8FUvmn4o2wHHfGMYe4e/6lRbDUR1172cgDYvsTEeFSOoPEnU5Rp5W9is" +

  "pwMCtDc295VXp+kW9mV2FpWJci3gFxDj3CI1wGhlhAUBTx49jE89+jA+++TjeGHrNLCSMB6VwlO0jNGowfObm7jv2WfRTFakQBW+" +

  "KgfRScjWD/8u0E8NRSrbCZ9czPH6XWP8/Hvfhws3Nso6/+ZsCv4UINa1Hf7dy7kkVYOE49Mp/uZdn8ERGmEthSgSSVqQSsrLI6TK" +

  "L0CDBqARWmoxGTd4IRN+4e7PYHOxMMB9tv1xWMtuqQFxNuQb4sDTVOhCugRUdXN8qxrlZPuEaN81FRAdRgeckc52M4CSCit1R035" +

  "ToSxqiGh2n00nC+rAEg7UH3fkbGuo2dTrgKfMMqcTs7BD261f4WZ9x246ab21Y4CvKoA4LacmwNE+T898sgfeqEZv30xn+cFlklz" +

  "+5QCUYYUSBQm+zUyFhA4wb8PJwTGSwkf0ZwpHDWUQTEMXdsidYaF93dSAp5qGGhL0WYEBgNN1evkYflaPSQpel4VW7IgT9XHAIiT" +

  "RBgsYIs2AUwJx+Zb+O6Lz8OffPMbMF+22AKhkfs8Xy5r7cP8IOeC41XQJfyrS/KQEkCprPbQroEwboH1tQ3cdegE/q9PfRX3HZ9i" +

  "YzIGiNCKgTUTJwKcVFnoBkKk8AsiZSnQhlCOwlU+g6N9Uw5l+VJezvH9b3w93nvRedjcmgK6wx/rNqMs42aAcpjLCEL8oxz0ULTF" +

  "pkzA6LIDQ/VIMRpFj5Pwd8233Se3SwH0WS45vYwGwj+JjKdMf1M9NpNXDqk5k6nagPaBgSvL7eSqYn8icGbVvRiNR0hNg+dOnMTn" +

  "Hn8Mdz/+OJ47fRqTFcLGaoPDp0/h3qeeRJsUNMbTB4OMdZS1kBAqQSSIj5gxooTjixnetLGGX/jW9+KC9Y2yzv+Mhj+OKEQ+AXj6" +

  "8uXpeo3EZQD/+2c+j/tnM2ys+FI+EhCXzfLYDMDAooHG8nkGsK9Zxb1HTuEXv/h5OWL8LEcozS80IgrYoV0KP3UTv36BnFwq72YL" +

  "whdgCSDUz3k9Tq50ZL1Kh6rnYlSqtF7zhcFl4XG1DrofirXTo4Eaehrc6ZA6fwlQo5Rz+9zK+Lx/+rk7/yyI+NWOAryqGwHde+ut" +

  "zMz0lz728f/lUG4wyQ1aahWQ+kUIm0IMG1lX0rJpjWtO8dmUWbjLF/580fgB3fl30Gc7z4DIfKxuIsFBnChAucvzTRwYpwtqku2s" +

  "5qa6Y0jDW3QpVUU2AzBVr/v1FICMQfpC8e7ScMlpF8O9TAknZpv4wGUX4UevfT22pgvM0wgj2dEvhtx0C1uGDrVEHYqYJBl72W42" +

  "h7kpmYYEShlLztigBrS2htsfegIfeegZNCsT7B4TOC8hGw7XyLwav9YedPw2XRZhKzRKn/S5gh+FGeXWBSXwfAs/dM0VeNuF58je" +

  "/iOU0CPM+Jb27LSAMiYnu4A5z7O7gSTjCVBne2YFs2Lo3cdJcr/yg76/D/Q83dOPMLlCDXcLWNZUEQHFU3Yqh/ZUJnoQB3oyW63M" +

  "Va7kOVZjVPq5nT2J7cSaH7BvaqTzTUSYNA0yAQdPncbBU6fxtdUJRk2Dk1tTZCoxtDYYBF0/EdUMw+dIv1CNIFkxUNPgxGyBd5yz" +

  "G3/lHe/EvskqWjl+++UZ7zhGNRIvHQjoZj+/dM+Xccfho9i3to5lLrt2pqgDDIAOgx/vlqYSW+xdW8N/fvpFXLX3fvz4NW+yAsPt" +

  "Lp2bWbvAibxAk8Yo+17ockzVQ5EP46tpm/kvA1D+K/K7s//qulX/G6Qj6rCuOQ59iOlf4zuggH4EWhrN3MHTz4bGmEP7RLBj0UdE" +

  "6dDpTb5vufbnmPnDAI7jllvSq3Vc8KsWAfjQbbc1Bw4c4P/41a++89m8fN9yOs0AN4nK8ofEqVSjFq1aG9YBVBhJWXValGslzGHS" +

  "yi3xb2esKjzF7J63THamUHkNsu9Z7lVGqp5VhRnQt4WX5RY7y16UOItXwOraAIiHZejzunWm7zmgl6YFQjZe82Tsz1thmRNVdpZx" +

  "pZoTYb61wAevej1+/NrXY2s+wyIRRpBct4KAzhQI2UqzZmRaL1mggvoJQNOW3PayARbM2DtewalE+Ed3fxW/89BTWF+dYAKWFHsJ" +

  "zZXxNdUbbT65VFwnVo81g+Ah1pr8rXlGAtNEWIEFEdrFHN//xivx1gvPxfGtKTg1RhtWA1bpLamo70WrYuGQGwhVEgV4yX2q0NSb" +

  "Zw+Pk3gabpKCgYw8Yt+Geeko92S1F9EDNR8HYqOh6ws0DZECmCCSKA55PhPyWUNdgKy9olK7QLBVHsqcQ7azK/s63iQ79vnmV2Uu" +

  "lszIuWx6kxLh2HSKQ6dOYVnxSf2PO38b8wbesGp/ENom4fh8C3/g4n249d3fWox/zmhe5ra5NZBtAhFeWlutGP/ffugR3PbkY9i1" +

  "toZW9jawVCR8DqscOFz9RQ9bf81EaJGxPlnFLz94Pz7zwjNoUipHLG9zFfZlPLO5iYOLKVZ0hS8VBUCmu4bhX+RZqyfR3jIsWpEs" +

  "/F630+Md+69EBziXPWa2IbPK4lCUuOd8oMNVZxkiiXfp2BREMnMa5dQ+Ox5f+C++8Jk/TUSMm2561ez0qxYBuP5DH2IA/ImDR//K" +

  "iTShlLfycgSMLBRUcqdatV4csWHBt0u5AIDHsAHdh1O9vC6KLDIcFR4sGuA+IxnzGrOJg8dMtvywtBeRISqZNSYgVzUpIklRrIpi" +

  "i0OoYeo4z6G/5AbIjWHdV3dp+ujVmkm1kbb3g9EwF+M/neOD116MH7j8dTg+n6LFCAmphF7teY4aw4RBCCrIOAXiiMATA0jFqKWM" +

  "lDP2TtZx7/Hj+H/ueRDPb7XYs7qGVhCSeokpzB2rUVQahObNp1QvrtyMcASJfW1sJI8viZC3tvCDb7oKN154Do5Pp6AmGY3deykq" +

  "UiMyqszq1I4Wh9bWzaIVSvvglauXk5E6Cop7zlLk76w0gNYMDEEBfX+txOriqWAcdYVFolKRrw/bg248qqvr8bDHzNTLJSrGmnNp" +

  "v3j22xu9M3qr0g9dTQCU6nyg5MWF47Ztv9uQzSOVSMEqJWwRI8+m+FNvuBI/ft2bACa0eTjN+FpemRlNItxz8BB+8b77sbqyXvY7" +

  "kFEDqJm9ftojUoh0JsTDa1pmlBWNG/g7d38B//C7NnDV3n1Y5vLuSAHl/ZQS/usTT+M0N9iVRHdQrCkBYmRVry496xSGDiXUO3EL" +

  "LsVjQCctOlQT5fUdTpLymR8Fvl1f4uWR4TNfXUBTAQu/yfgtEaFhpBenm/wlPv2zzPxPCTjOzERdtPMKXK8KsrjtttuaA0T5dx58" +

  "8Mbnuf2h2emtjCY3XsyX3aeJRrpz9SaBAXAIByUlXGFaTSpmALEcVw27/62hJJbeSJ5aPORM5PlrqZAn8dCqGoHgNaSAGkFkI2XU" +

  "hXeu7LNUw1NvaaDaSo0QgEMb6qZBK0nJjH9U/V3mL3UX2RC0hWRzCRO2SFjO5/iJ6y/H97/+YhyfzcAYY1SQClqqxxdpmSXaUOjs" +

  "u3FZ6Jq5IHYmMFosm0KvPWvr+MjTL+AffvrLODLN2DMeYSmbCSlXlHZ9y2CAgSSlh1oZzwwNySkF3BYqDPOCJ/2SueRuWwDL2RY+" +

  "8MYrcON5+7B5egpCgxahEE/WmVkFipAg51jhz6KIDJHB/YS6kJXIecF5A2gMVMDXTnciWkPzO6QaelG06m+ti7AeWaqiApAdPFEi" +

  "D74lcdUi+wxUPE1B+Qp2JFJBPTsj6p5gSFWUL9ymQHks1hRsB4Y6+kA/YwBIaDIwIcLxnLG+bPHXvuVG/Ph115caVirGr7eN6cu8" +

  "ztZzjFfmYiye2TyFv//5L2JrsoqRHOmbUirRtiZEiEIEB/D5JkTD5DSz3UZTia6tUsIpjPBXPv0pPH7iGEapGPDMjJZzOZAKQJMS" +

  "Pv3ii/idZ5/D6mhSongRhERgG8ZTSmnYdGqkSatRI9H7Bbzo97ky/oPOzwCdSQAjB7A9NJ2MvpyqsrPkbdSLMZwSwP0gIJFn1flN" +

  "XOxGS5yYuX0hrV/yq1/48k/hVawFeFUiAPd+6EPcAPjE88//zeOpaRIWLbggcfU6FNXZVSGyMwtEnOhScKaVn+YO2lUVJ5nWEiVt" +

  "ulo9Pb1B/yLzMhmwHcCs3dKZuu/Sp50YsTyrL68/B7pOUc2ZEYBQ4D29Enm7dsCG+mLicGnld6KMKQjNYo6fetMVeM8l5+LE1hRZ" +

  "DgNZCmqnlFwI2YW3ytUB4OTZXRagU5ZM6iK7FmvMoNV1/Mb9T+A/PvgoRuvrWEkoR9MaoX02QH06pahUdISkuX73qBUOEBWlSUos" +

  "LpGFJRosZ6fx/Vdfjhsv3o9js5LzJ835Y8gAuweuYC7Ok4Ihkh3WtABR+9blzWpuc1u8C6UrurPvpwjk8G28p0uZfm7evvGxVDES" +

  "xdokYHRnedSW62Iq6WqQs8rrkaJNhGcjnWuF23HPxB20HleD1de5wckM33NBvxdgmKwmRB6msvnNpEk4NJ/j6o1V/NW334gr9+0v" +

  "3vCr4PW/1EiCGv/jizn+5mc/ixeWGbtGK1hgUeSCC1CKOnXoZzhEsRNpcf3MKI7KPJeVAQcXwF/69N34H667Hu+9+ALsH0+gCOzF" +

  "6RZ+5/Encfujj2ORGowgp4AmxeGaahRAHmU6VPtrQaL97XjaprubRhjin7ru5cz0HrxXCRK6QKqfOOgE4x/vltWGhYidvqfqt1AD" +

  "VNJYOQMTUHpxOuW7Z9OfYeYPE1F7trbxpVyvODczcyIi/i8PPPKWf/PUE194btGiASemssZf7hr0/F3pBXRY/UKuC7oboMDK3Lxo" +

  "p6MYGB7yzGApAFNDUW7OAxSxCQyvLe+omdAZWP8roWruLb4r4VsCCKnqZ5dZvPFuCWJNl3glNfBk23FXyqCMvfDwnIBlu4U/ft1V" +

  "eM+F5+DEbAmkhMSEZahLsi4KitDn44jdbgtLJ6Ubg1KD3GZsNAlTWsG//OJXcc+zR7Bvso4FLVGX9NCgYhqiTemOA7aitFTR1XND" +

  "2oaOicr2vt93xcV456UX4PhsjiTV/tnjSkW/KeIf8MJd2ZgpNDCiecoczq6ALE/0Ak0yYtbeRHmdL3tU5VwmWfPTYF9K2b22V35a" +

  "MR0MAoC1lRHueOgZfOrFY1hfGcNqEwbo7+CqrhCPHBllwkVZQsIgSTfoWOv+d6BRoK3r2+7YhhVkX4Erx3Tv4gRQSjgx3cJ3nL8P" +

  "/98b34W9q6tnLH57rS41/qeWS/z1u+7GPSdOYX08AdplWVW1jdGL107fq4EGA5k04inzzRmJEpYtYda2uGCtwWW7dmH/ZB3HZ6fx" +

  "2MlNHJ4usbo2wQgAcVs2ZQKKbDDkOJBgALfpQQTA/qlfmr4g0vH42Op7unzDpi+cBHXUq+vUEEnRnoavwAKeImhSHiOoB8Dhuxhl" +

  "qWRFo0+mWthWGS0I7QVrK82P7jvvR//wjTf+hpym+4qeFPiKRwBuvv12IiB/8tkn/tqRUZNG87bVwWm+WcN5etUEV3RfiF1qBcgM" +

  "jzpRdjnQr5RMbYzdWrFYRp97NtAALlszMpEWsOstdaMQAxsUi/5CVQczmLs90/G6yibn3mEE2vmt+t6YtgiZ8J4buY7XyyKEiYAl" +

  "gGYxxx+7/iq868JzcGQ6R9OUXcxa6bLHRUI1sX7HBcDYZjKgktuV4i7iskdBAwYvW+yZTHBkvsAvffZuPHJ0C7tXN9Bya3NXX7qJ" +

  "zrBwK70MdAh9u/xhSh8IufKMRUrI0ym+9+rX4caLL8CJ6RRoGvgJL0q7iIJ8xkmXmjLL0rRoCLOFuplziVASOd0cqxQez97/Mhbd" +

  "gEdoymz7ZijXkSgg5e9MZWMt4lx5HkNXoWM/h63yZwWIApaYGCnr3Hfb7Bt//dmdV5MCIQSzK1cwsJMBL8fXltEbRoqmxHjAJT/K" +

  "p+Zt7dZwZ/mwePcLEE5vzfChKy7Dz7zlrWVPfOZvKuN/YrHA37rrbtxz/DR2r6ximRdWYKv6JEaokDs03QEckOiskpqMZ1OUDboY" +

  "QJMYu8ZjHF4s8PyhY+B8BCklTMYj7FqdFJ5nTR9AeN+Np/Z0G40WvPvtq+hdL3RqooIt6Yb8/W8Fv2Tt6TPxp/bC60K0NxFMILQh" +

  "EUhGr9/dlFRcpmj8SEDZk6AU4Y4p4VhLuOf5g//rCPiNe2+9dUg4vq7rFQUA4v3njz/11Ft/5f6v/djWYsorRA2I0ahsxko0wPYC" +

  "AGrvRD0bNzDVe3zSdH33dqQhn3Tb4tH+02kT/e9dqTuys2cI/fcGReMeojwfkG3ooOw57ymSoT4NDCwYPld23aGVnC0HQWY0nNES" +

  "IS2W+KM3XIF3nH8ujk9nSE0j/ekTsxgVAiieEEZq9gUsyLwkrdMo97ct45zJGh46McM//+w9eG62wMb6OrhtTcw950yBxvUYgdqo" +

  "9QyYfc5iyAuAVENLUlzYpgaYTvEDV1+KGy86D8fmc1DTALLCoRzlyxbBNuoKDTjk88vnAXyAg7IJCoYUNHpls821FlMJSo5ioGS0" +

  "+g0zYrrXvCi6lAr4gs+D98CvnDXnmUrelmBABkABfgLAe17NWVzxNp+1+rJUHOKc1ca516qCvar9ALq4/54KfEj7KdzkoCCjSYRT" +

  "7RKrS8Zfesub8H1XXiVHCOMVy/V/PZcZ/+Uct3z6U/jciSn2TFaxzMXLLikOv3/Ii90ufGxA1v62b8Rml1kckVRfECO3C0xGDTZG" +

  "ZIQvxrIFJ9Vlzp8uq1ETOQiuI2vZ7iuy0/0+GnrYff1oV3lfz7B37t0prB7pVtEw1lYE3afqarBF02UObSqQIv8p/m4CMjfL2Sw/" +

  "Pk7v+o0HPvftP3TdOz952223NTfffPMrFgV4RWHtzbffTgD4k0889pcPj8ZpwqltkaFbLjrRZXldxZSRewGP4VcJgfJ1NAIdlaFq" +

  "vw5Rh/v0c32HfGiGpmJUseecfW27KHMQheVIen8KY2JRpIR4l+eMoiYigIe3O2ZIoWPYbEcRcgkfhWK46k3hdymcJCI0VA63oeUC" +

  "P3n9FXjH+efg6HwKHjWgXHtzpRGX7rIdrVCYCvjitCxGVoVKZLVEDDJ4ucC+tXV84dBR/KO7Po+DC2DXyjpKqrspIfdg5Ek3KwKj" +

  "PgkvhNGCQLN3z8dvFZiK3FXZlzjFcjrF97/hMtx48bk4OZ8jwTf50Tm2inrSz33P8HJSnjSMBKDp8bgVaNpEaN+zL/eDtBfm2+YW" +

  "jCwFqDaNsdLZaFboUo4uLlTQNdf+3LBpJBEEZjmtDbUyh3lK9VWBVL2XujXd9duigSeiEq3Q3ykAILkpqgCNGuoZBLGq34vXvK9q" +

  "FHrjrcZW+JeIQU3CkcUMV6ys4O9967uL8c8F2n7jTb8b/9OLBW791J24+8QW9o/XQW2WMeh8R2PSAccWXZXvldSqY6p79TvAzjmR" +

  "/+k5DsWvI7S5wOHWwKrqRQaRbF5lvFrvgEjVC+v5qtLBAwbaZb827taCHdMtNLRVGzTMv9YmV78PRQUK/SKIV0ctyDt5353ubHS0" +

  "aBR1uazoWMolZb7GKZ8ar6a7nz3+lwHg9h4lvr7rFYsA3HLLLenAzTe3L2xuXvRzH/vkD86QuKHUJErlzHBK0XHEEEZyARVDK0pY" +

  "VWK8LxbJVaxeOStxooPXoZMqjZUpcP/CCobIpyxDXzoAWOLfxpRxonOwUMkEpfssB/7pNk9qiVBjB8h62EQEznVhlb5Sb2+YsUAG" +

  "lkv8xA1vwFsv3I8TWzM0TVNOl0tkqY0+sOJqiGQMnQwQieUvW1tzArct9q3twicefwa/9uWHkMerWB0l5JyRrD4AIG68CUi4EPUm" +

  "OUaFOO9VSLF76fyJSaQWCwDL+Sn82NVX4s0XnYtj85m3kd1rTgFYGL2DoY701XF360GG+6P3yAqQLGOM70LryqGjVAgE4gQ9zMZC" +

  "nwDAejhQ6atvvIIQMt3BnMlzhWyFzhSVHwcjHqM1RiOXKfUoI7Dh+Hf4XH5BSXPUAFQNv/IVARahGRxCCJ1wSKOkwCaZZXvuxGiQ" +

  "MAdwejrF9118IX72rTdiz2SCZc4YfROE/AFfGnZqucCtd92Jzx3dwnlrq1jkJTRSo7LaDWXHeWejoSOACLq6nq5fQjiiUIsbaBN5" +

  "QvhPa6v6l8qvp8+2uzjouhiRMPAQIxzbvAsGHhRQFN1ixYFQnSuJvm1p4PSx59RiGMv16wic41VxeuF3BdGpMx5Ukarm9OktfnLU" +

  "fN/nnnzyLe+8/PKvaqR9W+K9hOsV4/I7UDYr+PX7H/yLx9c39oAoM5USECtiEkSP4MUVA1B7sEXRUWX0ys3UY/LexcBwbL5/uXod" +

  "ACOxv9In09U9fnOEFyfTO6TPbGeoyj9bhhVzdhIFKcInBXWxv9KnHIw/DfxLAObI4MUCP3H9VXjnhftwamsObhoQl6K/0psCdLrk" +

  "9cI6sjlDZtRsyChnvAOEjN2ru/BbX3sS/+rLDwNruzBKugOWKnchnW5oY3ojGL7YOkdvgKSfOxg1iLfOhBk3oPkMN19zJd52yXk4" +

  "NpuBqBF+yW5nFecYYD2D4dTuhmWK7pV2eMF4o/A/p0a2RQ58ZZGDIA1kfhc49EcjE3rKYjTCQxGArsxodAnopIlZzaf3vRrHNu3F" +

  "93Hn78F7uv1RUdGIQAUQXDlu987qXRqtCcCGuSzxzQQkGuEYWuQ8w/98/ZvwV9/1HuyZrKD9ZjL+AuSm7RK3fvpT+MSJk9i1voG8" +

  "FANCZf9/UoNDbhDV+yy6V5dIyymIOj/Cph5pOcNFCCAWsOgAFcOeBCRUEVoBlO7lh3kKbB72yvJnpW3W+4NMdUHOEI/5IWoqR/UL" +

  "TJOQy9LOdTPyvUQ6STtuNWrebytuDbznyFd0nW1nHPsuhJB1thlMDbg9sro6+ugzT/5ZAHzTrbe+Ygx6xjk/m4vZVnru+tnf+ejD" +

  "X8s4f1SGnVyBhgy7QK8i5D74mvaO4DjtjBZfWl8Bzppbiq4XhXsCc+nfSUK8sXK6q8CkySKEw8s2Wb3sLrND9/RX/4WqblVLYbRv" +

  "7AiFMsND56VFRb+JGW1DWEzn+PEbLsf7XnceTswWkvdm6zgzl0gNS5VrkxDXr5dXyZ77UnCmwsAg+54IWFmZ4N/d9yh+79FnMF7f" +

  "qNb4kgiPImjW5X/B8Dt5OYxJR+b8FCM7jrelKC8TVgg4DYAWc9x8/ZW44bxzcWhrBho15WS4nG3PCC3mU6NKZnCohC4pGbix+dR5" +

  "lz/6AkXhztB/NVhUTavxVZ3xzsWjJVgIVkFKaSO27UrXc+Rc6gyElFYcJwKnmwllZmxMxvj4Q0/j0y8exfrKCpaczRvp5k2jkf66" +

  "FAmzBddUDlTh6yl0JfzP9r5YL9LGcSqFo4wFXiIicEo4NjuNN6+v4y/eeCOuPfe8sqXvgJH4Rl1aYLbMGX/nzjvx0eMnsWc8QQsA" +

  "1KDJXJbmdo69BXRuxPAHB0TpqhQte6pHo2wIvLp6825ef4Kvo4/PubJKsvSvHELkkaMumLNXV9tlxMhVaTPydbc/kHFVUY+oP6hI" +

  "bgrOUreQT5/NQQdXAhruq8Y64HBacaveRU5DpyfsniKHsahb7suZF6OGXt+2h37lvde9kfZdcVzAytdtFF8RJHF7gYL8z7/4lR86" +

  "NB5fkFi25kNhEouAmIZ02OlFFR3CqCel3sAO10sRWhoS8g4ZDdXa370XliFEwSC4J7bNmaDFznYrGrxfzKGaXFExnLfic+7plBvj" +

  "8Zcc7ycgN4RTsyn+4LWvw7e/7jyc1JPt2sJ9uqESkhzyQ9A4vvcvGgHhZk5J5qckSTIIYyKMVlbx//vK1/C7jz6Dydo6KPu+2Y7q" +

  "3RMgBT49wlD1TPgYpBs0dadSPH5igBrCaQKwWOCPvvlqXH/+OTg4myONku13bx4EAkBXMMN1HhDsG1jVvYxz0z3opcsL6vEX2puT" +

  "G/s/SIMKQkdt0otU9ehLSl/nL72KiRDiM3twTuSxrnOB0cM8oVfgUpynJz2ad9gBhdWY5Wfsl0MRDht5sRXzjZuEObc4cXoLP37Z" +

  "pfhH3/mduPbc87Bs22G98A26NAW34Iyf//Rd+G9HT2DXeB2phURLW+TEyNyCI33g860QOebvg61z8kbDJnzfXZYcf3fjj56+iS3p" +

  "PZauoW7fOk8oAByYA3VkjDZdT74TASDSCGbHeWAURyT0vfIBLXrislb3sQYdQzJgMqoAVQZb22rq39+hieoBRjGuaZnboxsb5/3S" +

  "Q4d/Cq/gxkCvSA3A7bffDgLw8JFDf+J0amzHdgdGim8aU/gkYEBPSuoVcYTfhwxmRH7bpgOqB9Rui+KNqlxBif4goISX1eOgovz1" +

  "JD3xFiobrI9th6lM0ZMYgG2EAICf9kZuxQErPMncEQIFSgGZMhiJM3JqcHo6xQeuvBDfffmFODafgdMYDQtgQYuy+LnOaXXTL7GQ" +

  "JUmkwfepz0hgjBOQR6v4tS/eh7ueOYw9a7u8Srny3rTVkOen4oi74NYH7RT6+BjVx+mBIjF+IxAWzGjbGX7yTVfhmnPOweGtGVIT" +

  "5i3yjbRZusJO9jDHVDNMZ/MSayj0qB5DpUxliVSMNpGOnTy1UcBg2T4ZIju2/t967G9241l7HKzKSMZqIEEBXXigHFmssuJfVzIH" +

  "VB45OvecsebAHyivRred0t1YyyDMD/UM499uNtkPWqESsWtSQsuEI1tLXLV7Bf/jjW/B+y6+tIw1M0ZNc3Y65DW4tOBvkVv873ff" +

  "jd958Rj2rq1hyS0WqZxlWXaMU+BMIPWuMQA/A+MatxJKiLorQCFsQgwXSDHaNY2cP+tL+VlrncpneuhWYfEexDUj35Pn+sZw7zBY" +

  "8PcDGg3QsIJGmVg6pnIUYokCMOB00O4ShnlaQIuKrvIp2YNOq3q8LnoO2HVC2J+isjKnIeDkMuP+zeM/zcy/SLfe+s1RA3Dbbbc1" +

  "t3/oQ/kzTz737sOZvn1+epET5cYGFEBSCfMoweWz4FH0iLuNAhm8d6eLdWpFqSiKrbiN4Fv+BeMfDKKFTkE2cdpPR53eXJZ/euAO" +

  "gQOyc8/NvU2VN+1HLMYj1fB9BIySW/c96CXPlxKmp+f4zssuwA++4RKcns+BZoSGGLp6IE4QKa1sHM4epeJff9fQYkZOGUtiTJoV" +

  "0GiCf3XPl/GpZw5iYzJBG06aQ2fO9FCjriLxs8qzKY86ZMb2s6ss9O8EwowIy2WLm6+9Gtedfw4OzmZAQ6VmIXgMypPljxAy5egH" +

  "cOCV0BcfDVgMc7caOwo06xyJJx71gkfCyH4UBZFNRREpVtNaEFRtWOFQHIJb78rzsqiHJV/J7rEdAK3PffpT7GsYbQzzxqtLlS4N" +

  "WQx3fFe2rnlOG4BFqRiqp+swcbIWgTE1OLVoMc1T/OiVF+Mff/t34H0XXyrnBJTCQ+33N/pS4z9rl/j5T30K/+X5g9i9vgZus6yb" +

  "Kv50VoNM8NoZZiva9PmXEkHVM5DDnRgQQRBZ1vmRGgEDjgDgqSO9VNcNR6CDjJv+r4Gy6TcDmGxgOHq+3egfZw5bb3tfomNQ9EW2" +

  "f1XHWeqPyMGI8k9pSwE32XdsPD4cOTbtHCq4HZjFiEl4lthKfcpPB2MEFOdALynOSYxmsZjn55Df9p/uu+99OHCAb7vttq87CvB1" +

  "A4APn38vgYh/9+lH/vSJ1cm4Ic5MCYmSOozFm6EmLH+CTMBOSG74GiRo57tYCEQKQ8k9CfcygR2X4Fl/gwQYMKhzjmq4Y2goKluD" +

  "kckZCvF7yOQzgOzpD/N+wEik57RpUU8xBCmcrcAynkTAydkM33LpXvzItZdiOl+iFWOs3lM2Du4IFAPECVphrEfFgrMJRSaU1AEv" +

  "sNEkLNMY/+yzX8bnnjuG3Wu7YC4cpDgoeIVWNCSnt1V0R7Qd2/NHlb9W2lJCAmNJwHKW8cFrXo+3nrcfh2dz2SKVK6OoRVOsoEcV" +

  "n7bfARn6XSYuyzJ3uoikdwmlHkQBD8xb6N5OAWjotCSQbD8dDO9Or7U3qLGs2+u+t1eIh8JXFjqvQGj/2e6/Mpb+E13wod2JQMGN" +

  "g33rhkOUciZJFYghIyoypdPHxFimhIYSWgJeXJzGtXvW8Q/e9R78hbfeiL0rK3aE7zfe5OvFaPPStvf965+6Ex89cgJ71naBli04" +

  "FX1qW0EpXw5FLQLgE+Urf7LPPwNJVEhioWUu+foEBriFLgyFAP9YsxQNbc1UkqqSdKTjETW4oS9yv15nsgG17qh1Z1WzVUUHaoav" +

  "gCpKeqsJnMks8iKR1qSgeDtHVBw7bVw3Y1JHksyu1BE9b6/L+2Jboj0QsNKCMeE2T9OE7n760J8EwB++996vm4W/rhQAMxOB2s1N" +

  "vugvfPqOHzzZMo+YG04sm65QkHr5SRqoEyMgFtnDmvFme49N7k6hul5oyIy4TLKCAXgI2SujaqbyXLX2W5WYTxCLtbI9AoyRPEdq" +

  "Rl3emVi7Iru36cYvzGLUnVG0GER7rNHOeLhGKVZJ/lx5C07Mp3jb+XvxR2+4Cu1igTmoRPTk+/IOFWSumdKMFwSVqmVkAwggQgvG" +

  "rtEEUyb8k898HvcdPoVda+to27akCeRZyzHrG+xdJQWgBZO60sGJzuZFGMgKdM7yfBLjmYlwOic08wV++LrX48bz9+LwbAbInvzI" +

  "fmBQ5KKYNqkcBlj2VKGjzaeJqLCOezlk+Wc1xjqPJSRJIuPBWAp56p0Wg6JQ117BQaj3GL5qxdKb36oxTyOUsRUAaS3ENXQdetlz" +

  "FRhGdV+tPNmAcn23vIPiX/KZWXYW2anlQw0hS3lkQoucCEfmC+wbJfzMm67DT1z1BoxTgzaXJYENfd1+zyt6tZnRpBEOT7dwy6fu" +

  "xOdPzbF/sg5eLpAlDJ9ZUkFVOD8paYQ7lT+dj2PkpHxQCEogSZ9oSjHUEMkhZQl2i111eqep5lhBpte3aJSpNsrOEiFlKTLCqqe7" +

  "HKIhsSCjQ2ngs7ET5QEBlCAk0XUm2yT2qOpb39ZaGoq9zfKj9FG3mydAtn0nu0/1otu20oHEQAuAUiqF3QDKWgACMjfz6RY/kdMP" +

  "PPzwwxe84Q1vOHjLLbekAwcOvOx0wNcFAG69444G78fy//3cp3/k9Nrq+Xxsc5lTGhHIj/qEelMq1DkoHVWtfUSoV2FErRoVJu2s" +

  "HFClAqA/8UVOin5R5q2+1IZcyUYvxCdNFVd8hkzYUoLl5Xoh+ghu2BnHIiIOQr1P3BUop9eQZ6rhwyYlnJjNcP3+Dfzxt70ReTHH" +

  "DOWULgPEKTK1wtYyN6zevhCt2K0Cb0t/MlR37GpGOJ0J/+SuL+Hek6exe30dPG+twNigVvTyKtr4wG1KFRANYFsSr1ShNskWurlp" +

  "sFwypssF9o0bfPCGq3Dd/g0cnc3LgTyIfOE8kOHGFyqghnWcT6JyNSCpZko9SVOUUYE18EpseSMNKxQi/Y++kw0sR3KdTa66a5C3" +

  "9WAGmiLSNIn0p3PQUbxsVLnUxJg1olqx2/OCZmMEoPbm9FNvH+TbECug9lRA4VBGUWTLRNhcEiaLFt97yUX4qWvfiMs39oCZi/Hv" +

  "HF/7jb4YsG2Gn97cxC2f/hQemWWcv7KCWV5YqL+wRtE9OWckJoxSg4YSGjHURB7OTc6J9iblZwW57mhqfUUp42VmLJkxbzNo1GCI" +

  "dbaX52z8qm+rYCeL47VN9Cyy9qCcbAMyh/7ugoPBKGLp6HBfMMTxsX+uHbpN6Fcs5m7bNkQmiglQunGwd0pDA73Ey7yc7dl1zm+/" +

  "eOhnAfwN3HRTg28UADhw003tyqjB4yenP31ymTCiRCzGXfSAXGLwEJC9XNl0btcw6ETKJ4qSOndqaMW99g4jSXgwMr79VBKr4lEl" +

  "rEY6LNnrFsWxz7/8cF+x30unA8ukF8H2yAFJm1UFbq+1oNRBvuyQZCc4AJvzGa7Zs4o//rarwXmJBTVoOPe6pSFuiALh3hu1cEYN" +

  "tC+XywDWmwYzJvzip+7Bwyfn2D9Zw2KxAKdkYyvj3E5ZhHFy5w/tRjXRouyJQVK4yESY54z5dIH9kzG+7aLz8O7XnYPdI+DEYgGQ" +

  "sHcb6h0QPA0AXO06OKBQdIYE9JQ118oUso2zmaFK3YVBxCjAcP1Kd7gpDXv5231etWUARfVCOM8AMqcVEJZec3lYl95VIdwhQMFs" +

  "/AF2RcVcDIGeVyhPgQKVzPgb+pLlXWFoloSy1JdwqW4ipTolNdicL5CxxDvP3YefvOoN+JYLLgIALHOLhpIdX/zNcjEDWQoUv3bk" +

  "EP7GZz+LZzDCnvEEi9yWFEXy1CJA4Jxx2a49uPbcC9CMx0XfJQ0QqRzruQkB8EYdIy9X+Sy3FMBPzGUpbAIeO3gQjxw5DIxGNvdD" +

  "xZ0VTatlhIaqw5jd+x/i4QpwD7B4iNt2aDkEqOuU43YgIO4BEtVfZY0G2u4YuG5Hza8DQaIAjBhl9veRqNXgMEsbZdt1kpkVWU5I" +

  "J7ZmuG/R/iQz/20iWkhY8cyewcD1sgEAy25Ev/fYYzf+yyeeevt0OcsrKLFcj4z014j2lE5PaQ5f2ZhQjJ+GsnoeRAdgBGCg3gfp" +

  "lmk5i6OrX8KsEYWoQWlYDVppI4Eq3w6AefRs4aqKYuW/1cclpGcBUfbJ1/QCNJwVQp+WcuAi9pkZDQHTtsXF6yv4H95+DSbEONVm" +

  "pKT55y7DqtHz/Q2YEmwDfFYlXf4ue88DTIzV1KBFwofvugdf29zC+uoaFm0LFo+kdFRMo4CU7RA4I0uVO2x+e+gdyb1BJDASpu0S" +

  "qW1xya5V3HDhOXjTubuxd2WMxbLFyWWZn8Sya7+AujIST4GAWML5eVAhReAa9ZmF8cPcM6ca8PYAwYDCM0XSf7NvXaotRCBRe/hD" +

  "oXZ/r/9k8sLTbj+0jUQKbBhyADT0HAIrjo2tdvrBovAY3OF1Dj/IZVG/zWy8Zr3n8lenlAssXnMmYGvRAm2Lb9m/jg9eeTXed/El" +

  "hX7S9ii9Kseof10XM6NlxiglfP7ZZ/ALn/8CTjRj7GtGWGRd1+8OBRHQMmPvZIy3X3oJJmjkxDg34KXYT+SDFVeZFq51lLTvHdJU" +

  "V1NkAhlved0l2JzP8PSpTaw0I9dDQG3b42SlVAAEqRwXvRJZk6gcd1sBgcpr67qI9bNRXMzAp/BEYLouCEDnuX6EIbyLvY3uZdGU" +

  "Doj29IO2IXzeAbbxfTYzWvzM9Rgq34iAlJHmy1k+urZx5e1f+tK3A/j924B0c8kcvOTrZQOAW++4IwHIH3/u4I9vNuPRKE+XOSGl" +

  "sM55u4DbcIjSFX75EABS2axFPEm2EJIykC6/iFXVA2gNcKY1NB2ZQNoSL8bQM3m75d7+9rQUmVcZgro5zqGr9vmcJv7+Xk0DfMc/" +

  "AgwINESYM2NX0+Kn33IdNkaEzQVjTE1RBr3XaQGPmiaCgwTYzFH17qKYV2kMJsL/fdcXce+JKXavrKJtW+Sku7vbiKBKbDiMKACG" +

  "U1z/V1OIGbr5DojRADiVM2i5xNV71/HOS87H1ft2Y0LAbLnE5ly2RyWSEnKGHibp49ahMqgt6tHnt9sHAmXJ1pGmC9hnj91cDTsD" +

  "8bjdPt+YAhpwJsxz0SSs8nZQxDt6NtZLH4utg+rwnYxUxmTlpCAWH57CEjNKAGevVGYHxvoabS/WT2jdSje9FkVW5TCpnKOktbLJ" +

  "Fcqx0gBOLBdYoSXefc55+INXXon3XngegAaZMzLjm2Y3v+7FhSUxSgm/9/gT+D+/8iXMmzWsU4OlrpqBeO1G14ScW1y8ay8mKWG6" +

  "bAvQDsZTZy1HHjaPMnqWapRyKFJjd9aIscwZYwbO37sHT506CavZ6PBaNMYElGxREsAv56qrca5TtF4Lst1lejTweteIWjSsZunQ" +

  "v2EtbDy/zfuH9gbo9m3olVkiX12wsVMfyk0iIzXytTcV0XGnZQLKJ5uUHjx64mcbot+7dxgvndX1sgAAMxMRtcy88uc+8ns/dhIJ" +

  "iZrUzYbUIXENRNahjsCaAQ1qyNoNq3nfYOSw9lefLgBBnzEtJOAgML91jkIYv67o174z2ATRvusCzYDEVcmxSUJU0K74LOxpnmIJ" +

  "RihwAgb5ORgMVcqEhjMWicDLGf77t12HS3aNcWSeMWoS2uhcRkNeHfDCgBpB1U4KsgDZPL2MY9I0SM0Y//TuL+LLx05i1+oG2raF" +

  "FgzVLnFoY2gsCjIIYG4DUHPvuhCk9G0Jwnwxx2V71vEdl16Mq/eugwjYapeYtQRKyQpKNZfJnQ5wUEIO9ORlFOdDTaAAIt21Mnr2" +

  "DFsJ4PXZOnOuYAzP6vCCQik8Wdqrtn1gRtmm1eDYNAABAABJREFUONf95xq0bp8KEJCLutaGEFMRnftje7mMeZqXaNtS2dJE0BDG" +

  "pEZAx2K5X5vEAJj0I0XwEeDquBCWM8r9TUoYj0eYZ8bWfIp9oxG+98Jz8YErLsfbzrnAxspcAMM3w+l9vYsZbRElNET4tQfuxa88" +

  "8AjGq+uY0Ajz3KKAn8JXhZ6BNUGYNCPb1ddUnBjAesR+Q10zFQpUjd9d32XlNyr0HMuBP3oNGUIfHgEkhp0BkKSBhN9yzlUbEXB7" +

  "3VFoOQLGThTU3xktdeB3ri3RUNRsR/ChkYbuLaZ3Sx9dvpwaOl/ExSVPpfJ6GwdDdYwafzbDorbOCiflfaVwHM3W9DQ/3Yy/Z3ki" +

  "X0hEL9xyC6cDB176+QAvCwDcXsqZ869/7b7vPD6ZvGG5eTqPKJWxMtvmPlEBkCD5+LcqgGjr5Uv7u0JTcGQYH+n4NB3bql6GFsJE" +

  "5esP9sOtkPmIuX0xCBqSrqIV5Wc2ZCuKvRd6QuiBr8HtwlsHLZqDLk8lLqU2BqISYT7bws3XX4XrztuLk/MFJqkc9dpfukPiWTbh" +

  "LaIQbCgyevGckwCySUpomjX8s898EXcdOop9q7uQl+HgGulwJVi9sccOwRScAh9SYysMoYI0Y2C8XOD9V1yMb3ndBRgxMGsLEKSU" +

  "yi7NWcPVNTd0ucM/5WrewF6gp3eYUgpV4zHgU/Fa7x1FiSmn2tyrZx9Ah3EYe9jfTliMLZrxT0Yf/bv0qSv/qqR0jtUoaD9CX9n7" +

  "sWhbzJczXLH/HOwdr6FpqOTRocaabfWKe3Ik5RuufF3agcrDEf7NiR28k0a1yvdEUrGfCM8eP4FHDx/DZRsb+M4rL8P3XHY5Xr97" +

  "n4ylgPRUjeeb71pyCfnPcot/8Ll78J+efh57NnZjvGzR0gINJVRmq2Jbhq04Cyt3IKkzy/KL3uRggCsAWSlZ/1QPsjL5jAhD34Vg" +

  "SBW+G++r3WL7vZYTf283dQU4/5ht8J5Bow7M3NchQPjOx1jZFq3jCk5n7ZgNXf2Uel0UzBa0NGgl3TcdomsCK9A+DALK84XmNg6t" +

  "pRPy6dwlSsicKTG3B8cru//hlz7zBwH8S9x0R8KBnUoOh6+XBwBuvx24+Wb+6ic+9ceOM2GUUmaWU6AJgbjDE++MRiEnBZsYZYaq" +

  "Ba7/3lbWg0G3kL0qqVjyrfd0H6coKKps3Wir12dARBhfkW9S7DZg/KpxAwYXKdwXLxXqONa4bQelhJPzOT5w+SX4rksuxonFFKAk" +

  "pVfJkHgg4iDltO4urqdWmWQGVlKD0WiCf37PV/Hpgyewf3U3lu3C+04I+cjyHwJDzwooyqKUdJWuybyb1HSK1FD2U+RMWBCwlhf4" +

  "4Te/EVft24XTsznmCqySGJYceMOxl1OM9fjpetyWBqESrTEvBQXkaTsatlT+rgjng5a2RAkrqucC0mx7GtkISGlb8JXXSxTl01eK" +

  "dSQpFodlDIOe6J1o+360a08Rqdwmwsn5FNft34cffdObMF20yCInWY2NygArtOheOo9BBoT8mjZxAFSN0uQsMQNoMUqEK/fvxvdc" +

  "cB6+74qrsG+yCgBoJRWWoEVU36yX5/sPT0/jb919Dz575ATOW92FxaLs7keio6DTC/+pIeVSdxSTcw7slLflxIjwZrOKA7zPpls0" +

  "4qzG3XiwHkaIXFFoNjoabN+X0DyFT/3aPnUV7g+hMwcKfTsSv+vJIaKIkkUFKXw/fHVlrr7fos1GI9d9DJRaCFa9GiJ2BtrrEbtF" +

  "UX3oNQaq0/Q+TdWMiTBtF3iBFz+zktK/OHDTTa9NDYAe+8u8efGfuOPzP3R6tuRx5oYEEhkSBYz626GtLioyZpe/eqkCAQwW3o1t" +

  "xd/YGVkbMB1pSK3OL3FQyup66var9gJR7ublmGAiVN6W53xXOPG6A0PrWI25e4owMHpvnKJyE3BqvsA7zt2HD1x7GTbnMwMriLk9" +

  "gZA7o0/pC8pZ9SzeVOISrhyvrOJXPv9VfPK5g9iztht52ZohKf8n38JAxqPjU9qR0QIwT1Wr6XXaABCyLZ/JibBcLPDfXX0Jrt6/" +

  "gWPTmXmiWmGuwlyPTeYgVKFr0WR5bc0f6kEU2CKhD7LZE7rqFkySLddxW/s2cTBXQOaPkMtGK01CszIqHrt40RA+SVxy6/P5HEtu" +

  "QTT2fnSMv82ZcY282knpoA6A77jIJVSLmAYI0Q15NrdLXHbBuWjnc2zNF2XjpwpAVdIW/tRZVrmHyXM08hE0EJVDpZTWlbkQ8NS2" +

  "wPtffwX2TVbt0J7mmzTHH69S7JcxSg2+cuQg/u5n7sFT84z9qxMs81JkSFGgKygSIJSUr9mBkV9qLOW0VVkSyzbxxYvtYkMDE2G3" +

  "U9PZ7ExT7DfZdFjRcUcfZerymUESFOejv6X39qmrGqsoEFD9aY+RgxDrbBmctd/T74Cd0bJdEWzsBYexKqU5/OWdddth7Sk4iKwc" +

  "zIjf6LRQYMeodaJFIkQnFt3MIOamnc/5+dS89a7773/TO4juv4U5HXiJxwS/9AjATTclHDiQ/9lXHv3pzdF4b9qaLTmlkebttDBD" +

  "T08rClo9NAcE4uaUsQVlCWH4ruETesCoYfp8CFxEMscJC8qyE1qyx3T2ssygGn5tTRiDAPM842vUCPa8LCu60z0gayQYe71dQaPe" +

  "M6KEk4s5rtg9wU+85SoslksspUJezR7b3cJgNsY+vTR8V3YCK8YVaDDmhJXJBv6fL96PO589jD2rG8jtEkhkxwdHQYxeRbzcswhG" +

  "NxhSVVyKrEn6tESLfStjvGn/PpyaLoohDiBTPclOsKkIpaVAKNCCQl8SmJeImyKxEKPakCcaOwWApqGcf902FgCl4yPIjmOTMQ4v" +

  "Mp48dAKntmbYmi0wazPAGQnA2qjBuesTXHnBfuwZEZZTBlJGjjURPoXWv+gVuX7UckzbmcL5ICg7j2yQjZWZsdKM0KRRoW2iTgvo" +

  "saUvkyUDxiTtOyAgMWi+R4T2MYKDvlcHLDPj5GyGC1bXZQe/vlx8s126L8eIGvz244/jH33lXixoBXvHDRY5o0lhHGpsAejRvk6H" +

  "wqsUtuwF2DbpMeoqEY15uadfyqNsUZh+enInneu8M5gutb9L2ybpL291WvU+/ZfEsy46wPm5aysGQ+7bOFTlqz4twh/9ZwJKqWvH" +

  "AvB15ASLhqus2qozz+37a2plFve+ISKr4yUAI0a7ub42+p1DR34CwC2QwvwzkLW6XjIAOPD+9y+ZOf3Fj33ijx5dLjgxJ+W7mGsx" +

  "4yPrGLXYQQfpYfGAjhTtkisSJWhpSyddDppABlFjz5nlANx4n+mK9K6KwoqRKuNi67Nedf5KQQ2KwhbnpOGyOx2gxkPCdppW6ICA" +

  "6NUZqjQhLxySmDHNjHNGI/zUW6/BWgJOtkBCOYA5iyfvg9M2hzZ0KS/w0CEVxN4AlBmra+v49a8+iN976jmsT9aAnG1FKpNvOGIA" +

  "Iowhht6KYq8nw/+OCNgNSRHeJXavJIwaYJrLgRjKNxquL7RH5/IwNazdAEwBMPwEOGYgy7JFEFkFswOoJN+z8VulEqKSoBBWJULD" +

  "AFZWcM/Bw7jr4SdxYt5KLYxl5qHHC4/aFnseexI3XfdGvHn/fixnp8s67LJzU28ea1nz9eD6fbbIk94XznYIeV+nn5rkYsByYvAC" +

  "tpeGPasBnABSlQcYLPQLqTPF9QoEfATIHTGNMpZzBjflyFtdx9/1aL8Zr5YzGkqYtUv88pe/in/32NMYr65ihRq0ucVIt8pVZ4GC" +

  "nHYMi8mF/S3fCywrFBegF5YDbudlC9xz45hc8mD62PlKayz0Go7kujyrqvbbdlDChLLKBcqL0r69vps/l5EPGPih2oChn3V3nJrx" +

  "Hd29NtyxKTYMQWZCC8agOgRGkR1hflSpnthAsH+UNHXoNT6ItMw+XwmUTizneGqx/ENjwi0H3v/+l5wGeElxtFu4xJZ/95ln3vrM" +

  "YvkmTBegcoB8GbDmkEkLzciJAwjhwoRwUSYx1GITLSEfFrRUsxHDt6rNkk/uIrfwLtAAgwjBxdhYSBuAFtoQy37jZzD+cTzaDwaB" +

  "UyNCRSJfohhlD+0YZqraFu8hrEYUcM9lP/92gT/85qtx/uoEmy1LhTajFP5omXB9EZKPL1ARABrdu5pYInYZ+9Y28B8eehj/8dEn" +

  "sXsiR/oq2g6oO6u8Dill0pmLQGRnVKZ7NBAYlDvLuVjAH/fn09uOBs9DqKwA0nGk8RozQDmVwjaLEtU/NSxblg1q7UOkRTnBkShU" +

  "7mbGaDzCAweP4o6vPoRTmbGyMsLqZITV1RFWJw3WJyOsraxgsjLCytoYm0vG737xQTx76iTGk3LeOgtwrJWq/yM9WaRLi21I3Y1s" +

  "qCHXEyXKvzpP3y0EK7/7vVCALwYpo4UZEDPa0avtl6TV0TgpblST1d1E5ZvwYsjOfpTwxOZJ/M8f+wR+/YknsL66gRUGOLdggiem" +

  "BARYXZFhSNeRwax6JAjB4IS/fWf+jrYMuquAuc7cxjAzbKpE3mI6c2DMPMCXVH+/Lb2yj8Z4Krtu7YbmDWSo57yN8R+6rN4htF1E" +

  "t1OfJTzbjRgYH6Nv/K19JiDYnKQGv2d/Ik28Psi+5QLwFKxFfZasSUJLbeLpjI809ObbvvT5d5RuDhxss8P1km6+o4QYcM+Tz//I" +

  "1spKIqKWkSovWJlFD4rQfZU5oBkO9wJkHgVDjXbXYHA1aVaEpP+hYUYw0FeFwwRQyE5yOcXpUCNZo3FtOzLKENMRUcn1QtcyFyNA" +

  "XMLAiZRWhT5DiruKKEifmCA7/RFOL6b4Q2+4GDecuwcnZh7CTlGhMwbMvQChkA82wCU3ZjAyZ+xf2Y2PPPEcfuP+J7C+tgtLzpY/" +

  "Q6CQsSUREpoqgiGLgQMYiYLcR+c2buhz5R2jlCpaqxffVyz6eTZBrb4NJ4MZZ7HzqRX2mIHybZ6IAOIEYgEJgC8plDt9LglazT9O" +

  "hJN5iU89/Dh4vIIxEZALT6DNJUWaWc40KMVikzTGaSR85smnQc1KeZ+4v248lY4+9uFLACcU4LkiK8pPI1GhToXVhPh82O9B8bLd" +

  "52C2yG4DLapskaFHJnuQLirUut8UaFruZ8XivZqfb7ZL9ypIRPhvzzyFv/CxO3Hv5hT7JxvIvLRTHBWBKosmcnCj06vRLaV3AUDo" +

  "YLqYypHGeNjgVvKTPSlkYmp8Xz/DBjhoW/oPOTBdw9j9Xv9Vct8x5vEef1Z5NdiAnr4cvrrvCz0cHs9ARIGIAmjpXLnMq6aoWIAE" +

  "SceH+L10rNtPmL2E2Ap0wa8CMiKsENrFeK25/+j8pwDg5ttvf0mC8pJSAB97//tbZh7/mY/8/o9scUJq5HB1KWZS4pVV8HECfbIi" +

  "DeIhOu59q4EMow0IqIRRAg5WJCt7A3RznD6hLLQsBroVhQhbKeDIlQSBFSHIJpi+qYWqyIEJCoyTrE1VxJDn6+1nuyMt0QT1q0r/" +

  "Rk3CidkC77/4XLz/8otwcjbHKDXF4Ml7mdVbKruklTa9lfK3VOML+oVEK0bI4EzYvzrB5158Eb/65YewsrqBJueyNWw4sMcyzIIE" +

  "HMaE4kM5mQ9q0I08fePv3+lmpg6xSYEiBS6QiEotjARfDifCFttmSG2kUdl6Xc7aEsQhWpaIkNFYOLUyTmG+mkpRKGAoczEeN3j2" +

  "0FEcm04xmazJOQawwZDsmuImNqEFIY1HeO7kFPPFEmNKWGRdnx15jaqxlnfWeL4u7ytSqd5+pXmE1wqGScb3VWFSmBkC/FRLacZA" +

  "JJdcrVZBqMw6YKhf3etLfCOze1VnUPDfiEsdmSyFflvtEr/85a/g3z75BMYrG9gFRttm21UUEGqIcld2M0BtIK9ctie8RJmGDZj0" +

  "RbyoBLIiZEMMhnj1V5H/Sm/BdY4CA2lRE88uBzFVEOel1CpUMxU9eP1JDiLr8QRjP/B8vE81hXTEoiVGy+4TA0DBZaH79vr5HkgZ" +

  "aD+OK7bVM/oD0dkKECl8cGXX75A5LAkETqe3tvAc6A8x818moilewtbAZx0BkNAC/+YDD1x3rF3ckBczgLkBauPffWsV8jN0SIGR" +

  "hLmgQY+w8ad5zKKI2FGyWQUkgJN5M5GpbEIietamzUAqEPFrSNBIBErzOGY+eCi01BVSLoIRj88MjBJNUXyhNpOIsDnLuGHfOn7k" +

  "ustxcslFW3M2e5INMJTWEqiKZxigpAw/7QqSAgGWDOwbj/HwyQX++RcfAkbjku+npuzroKCK5Chgigfc1oaWQJYDD1SuBKRQJYps" +

  "FMR4nEkoctLnyOsQKiqzCJPyVYU23WDG91nRLCntPEPdVQim7npeQuFbopoHOCUcP30KmZx+WidtcwG2o20bK5otZxzMlvMCQI1X" +

  "yfi8S7PtPRy96r0MKrp1ZLehchJZP+IgwEvkWMkbgZkp96zG23WA2LEdL4ICu6Lcc18yvmkupcMoNbj/6GH8hY99HP/2seewZ2UP" +

  "JmixIMg6dOV/2SW1I/Cmr7jDPxYB0BthJ/VV/VDAq7/rcmdVfdtFWjqfdw2yRWvk70ye8uMARLfRYPYu/afbcg/l14euM3n1ykz2" +

  "9FmAxBilZK4d0tqd6I+qigAj6ATVvUPRF/1+m77p+HXvHGYGMtumZtX4tE2mYvOK3khYLvnoGJf/+wdLGuC2l2DXzzoCcNOtpcLw" +

  "vhMn/vCptXXQ5uklAyPFXXUIpxS/ESngUaK5idJwTkRxtcFA2dxFY1+FPBDo6r8H70SvGuV1DLmiar1fQXIMNSEyZg2mOIzHQlLx" +

  "BTKOmCcF+vl+z+/ViDKaFOZSPrnILV633uAnrr8SyCQ1+mxrWh3Zw3a3s708SEetZBZ/k8sxmIkYy9xio5nguSXh//7clzBtE9ZH" +

  "YyzgdBbdHxS4f8b+GrlkQxs7EjAYDnLaVhEUHUgHTJj3qWwSvusCCiEstrtMqYaolOec4TvIaWEpBWUZnmUL9TktjCbyk1HubVnO" +

  "jKi8A3+yAcCSPihjzNZG1vGrxTBgC9S7OcLGsp0y7aZRTPOZjPooUqKysXhKKGfDO42i4iOCb6kNlP0MbO23F3VF3q+na6CvVT/1" +

  "sxqIfKOvoqPLQT5LzvjXD9yPX/3aY9hKCbvXx+C8BEpSrDygssOM7qYFff0Ej350vL8kG/9UPCyGorv7ocpNjLoG0e3AW5VfSV9B" +

  "VUdt7JIUcwft6nq0+qQ/V9vyZgDTpocDmHWZi7TioAc85UCd4r2h9EP9WncQB8VGlM5OchXH0NPh8nwd8bDGAUQ7Ee2n/z0IHIL3" +

  "2mYGJWo3xyvNg4emPwrgkx++444dOltfZwcAmOljZevf0f/0e7//wa2W0RCl2LVuKIdAINne0pakVIPvG+peUQf5vYP3nAFVdftG" +

  "IjBZNqJxph9Abvp5FXaFaUtTeho+VYNAnbKNDl2q8VTU6L6/1Nu3AFJu8aEbrsa5kxFOLFs0NIbuXKftKD1a5gCqJOKgwsU6MwxC" +

  "2SCoJcJaWsE0Nfinn/4cDk+nWJusY2GHswzkCyvjp8qHYFsK66jCg2oQwF2aKE09N13yxsneQymB2q4RYKkd8ZUvzAxqkqUGajgR" +

  "56MgEzLDywD5ZkEU+SfwmRlIpXlvNt1Ilw54IFxzejFH6kqc/VmmAgJkR0QygjqNz+gZVe3DaaPjAwQ8qkWXn7mAulK8VI5ezurB" +

  "4QweTrFwFU3UkPmd3Sf9d2uZ2bpDgzP4jb0019+khIeOHMIvfeUr+MzhE1hdW8M6JdmgyLcz7joWZxyNjb1MVM/4VIq06B41/jY/" +

  "XbCHMP/yDgWonVcHwKDCGscuTVNI3XZYgv1J76/q34FIq+rQnmddRQli1CMCGw6fwHmNvJ6Fw71dQAFS+7TNrAzYhm5fu2P3Sa5t" +

  "nNoGvSmQperb2V9stCUCzRctPT6dfjczN/QSDgY6q1DBbbffngDwnU8+eeNxwnU8n7M+GxFLFeowQ10626XxjsUq1VdJQjWqAGVC" +

  "c98D6rUDn3zNj0MV3Db3V30b4IuCTPV3a3LbMRUpLgH5s1VmDIBzC6SExaLFD19zGa7dvQubbfE6zP3q9plIDgkpBoeThutLMV4s" +

  "yNSujTIBo1X8v194AI8dn2P3aN22M7Y3hPs1DBxTM4Q4MuqMlW0JpDosVZ/jc3Jf0kMaoUvS1KuI7RLqZW0uRKU0rRh1Q+cc6xDK" +

  "c3awUgU463nICLsv6oEHAfHHdFP3othVUUgDdwmtXaBBSeZJ1x7EHumVwj+fgQiQe95QR7yKLiJvhwCL3kRyRLkO7XGcTykuY+qb" +

  "bc1tDylTbZ/kX004NXE7pTZem4vha/szGLc9cD/+/Cc/ic8dn2Hv+m6McwFmCYSG3RlglPF30zPkbCSy29Fn1HGQGGHJpBoXN6LR" +

  "+OVtdKvN+zZeJalxsi6IfGtHdYVOBdCGL9cd29QxBB7rAdVKf3d52XkmBQCh37gOgMlO39FU/daN1A6RZRhM6c+Y1iW4vdO++uoh" +

  "lwHXnE6rrv3sRYZoQAbks8Ro2umMjzWjN//mVx64EUTMZ7ka4KwiAB8+/3wCgE8+e+iDJ0djIM1aEEba8b63zR3mGFKOdWhl2Hhm" +

  "M/wOJNz6RgWs11AIqEKLcQK2QXgQlKuINW4SI46z6ygLX3ufqnGKV6zzQSrY2yk0Lu9uiHBiNsf7LjwXN73uAhyfz5GpQcNFDrOF" +

  "k+T4T1MNJN9n65oypioK4rKl8YiBtfVV/Ot7v4bPPH8Yuya70IKRyOePIEshw9gsQ0/FmFJWTyQFUYjKa3i8Q+FP/bzKfpq0sP8j" +

  "f0cRLqG17SFQzDfL80QSGUgxigQzbrZZlUy/zjEhh40VKfbKldggCCBUpdvRCyL9WCqyWUEZwyo3OENPKiyDkO18zWC7mlYl7crI" +

  "q/t3vijQUZQVh611ufTXQ6tujLmtDyoyBuspbAws4audAxC8iDfQHwFKdkPWr9XF7OF+IsKXX3gB/+KrX8U9J7ewe2UX9hDA7RJJ" +

  "Tt50XQWnbUBEFiIvCAEMKRK0bdQD/QSQMRL8EB9YYyWdWTppujAaw2ocEqlT+wl/RlcB6JHfAGz1hvOZHtntPEPV9/oihQbhKHjq" +

  "3SVPesIgWJAgg/qprpiCyyAVUK9AS8GKRy/6favVUPDCOf5t0m8PbGsnwu/63GCkQUdqOmYAmHT72uv7MELRlG6i3M421kdfOX7o" +

  "+wF8/taz3BTorFDCx+64IzMzPXH62H93ar5Ew9By69L1HmqpiXOm33uDCjXrxcgo0sp2x+BzMTwzgKC6YGW7PhgyD2+LnynbupGo" +

  "EV09ljIODuvz+6E3N7aFtxNOZ8YVG+v44Wsvwdas7IKXUDzbFi1AciiQ9UjFMWuA2/YOT0igTLKngZw2lhm7V9bw0UefxkcffRa7" +

  "1ndBl+0llsI01LRUIBE/C2ZBOp8BtB173wdl1bdihDOXmW/B8OVlokARDVykm/xtxNsGbOo9A1PuwivvDAq2KILtwNo2Qmoejpqu" +

  "UE4VPA/iUmFtkiTMZPZD3lFVG4iB1T0HDAR1DLR2ryubOwFmvRKjRNhkHO5hFe/XPXdUESUFmOjJeXwHD/xWRlse1bRVALUGdl/b" +

  "q2UP9x86fQq/+NnP4X/91N34yqkl9qxOilQzQqRGPVwYmElhPiDymowj6pUSce4sKgTVN8Wzd0eYDaAphVV+uhRHeMSvMK8EcBp4" +

  "jkP/jO9KX5g90jfknW4HPnuGNPzs/lNnaSh61MMdzODt5DREyoh9fb7jJaW508bSbzte2+iaTqTAnGIFa0Pjsed9eGcV9ZK2E5Bm" +

  "izmenZ76EWYeHbjjjrPaEfCMAOC2225rcOBAvv/I5g1TjN+2mE6ZKJZA5QEGqPGMF0AE5CMJZYYzdU0YLwqMyk0n099ZJjO2Xxdo" +

  "RVqdnRYxxRkkwnQ7FDXLO+rbAgUiLciAwmBOqdagaAmY5CV+8trLsZ4S5uLwEeQcQisLb8FooevmVVCLh6kCWtSM+vRMRbnvmqzh" +

  "sy8cwe33P4bJ+u6yNl0MqFKPUJa5xarlOFcAJF8O8Ri4973SfTCENXCffY4g/FCj4kZV/3KbS6VobWDmPQ8n6oxdGKv7ZCY7qmxb" +

  "RTAUqpQXulejxoHV4Es6iFV5Cj+jge8QWQMIINRPaN+r8L9SzL0Vi2oEJbpd33v0og4tKMjYtk8NUsg9t/CZ/QxzUP039NdAtiHP" +

  "l9SBl3ypIWUuUbjT7QK/+sD9+FO/90n826dfQFrdhd3jlbJ/A3mhIxEs48QyT2WIHtWoeKswovwqAi7gybWc94rABRibTCj42p7f" +

  "h3RN/IRkXonhZwmgJjGrqxMeJGQkZHBVIMrOsjtcfb6LcJeq+9wjJ6s/Iniar1LR7spbz3sQk/xED6jxNyBdbk9Kj2Coh9PVwNCJ" +

  "gXFE5tjYvg4oICXws7+jPJPDRkhdeg3KbFCfi+mUT2P81rsefepNOHAg33bbbU3/gfo6YwrgXgn/f+qFp75za3UyTtOtZQaNSmfc" +

  "I2dZTpZzLksaonaGG786hwwp5HICOIJSYSnC4WPX0nJtlQQhh+Kol+gu9Cc4/N1BlcVGc3iHi0xXeOId5Retjudqx+JUzDhUgU+3" +

  "tvBj116OS/et4ci8rAV30ZSDPIilIpgCrcMbNZonxlk7xMzYNR7h8ZNb+DdfehDNeBUpF9CRxDsBAgOapGiIXzfOAYgTmFoTQJ2N" +

  "fs6tViwVSh6imSpMguQzs2vWzn1mbE2gdMte/TtMQjVv3ka9zI5QF1jW4Kywr4fEVUF1vdQk3xUPkEOtotI3jFnpUYEvDnniUJCK" +

  "AFAHxtmNchko5H6hUS0mAtKkxsQKKQV46trwSjRQDERdBRLkoaJJX8a0pEL5lCgBkkvXVSy61UO3bufVuDKXlGMjOZDff+Jx/NoD" +

  "D+G+zVNYW1nHntVVZM5YIkZ1+opZvXfdw4PCngnu18sZCLphFkcaa3pT029C+IqZaz7mgd97erCaptIGC5MVtmeRh1CTIveQn5HV" +

  "M/I6z3WwRw0ZejxTP0wD+lqNrgeaK941byraAkZKDM7JNpiLZIhG1lJvlYPpNsq6xQP9BfrPRZ0yaIP6RtxVEVf3uBOB6h3x9/oJ" +

  "4SYCJcby5GQy+sQzz/5BAF9R273TdcYIwH0HDzIBePTY5h84Pp8h6bZkweDqf6Mi3u7S41CriH51RW+ReoxQGsmqBcX0d9ZgY2cg" +

  "2kV1/bCodWXnhsrDZ7ihGDCVgyE0qWtrEzJOz2Z4x4X78d2XX4zN2dLWh6pZKAIaUKNInjpaJAZH/AV5sOQZGcAkETZbwq998Ws4" +

  "kUYYN0k2fZHeEsKufyUsrg5px38wK600d5IEwkkXNP2ASIMO7XKOm4gE0FK+VQq685SKco3KQb0xQ9uhu2cDDD33qn0o700dvopp" +

  "g0gjp4UhCP+VPD885NFGz0ZDxzW3aAzINa1Hx2JEoZsLLfubb1erYHLDBC1A1BoTChrfZJLgKxODsecKhG5DbnZwoxS2KMB2u6xt" +

  "29grc2VmKfBLaBLhK4eP4Oc+/kkc+NwX8eQcOHd9F1YawtIO2i7jTmEXVO8mCc+WuXAlr4YlGJ7eEMnuJwpREEZYFaLFvD7/XeMf" +

  "5bEd0DddI63tSCfsKwNmUcapOAJ9EBA6EXRxLZcDUcBKNmreIZFZdSrsvbLleeWkQKKcHRmMVSQqF4QUNzRwHu5Tqu5qMPyUff+O" +

  "xCg7vlq0wpRWkIk6Otel/5muQfoFsE9c9uA8PV/ghfb0H2LmhLNIA+wYAWBmorL8b++f+v1Pvm8xXyAhyyohtkMTzFPRogzmqvBL" +

  "jUcU+qElPjrRQ55Jda9NfGlX90fuqggViO5VTeSAYiG3Ot4Chc/UwpylUopGgwXpezSEhDaMKTPOH49x8/VXYLZokVODxGGXupzN" +

  "KJAoGajB0v6Q7yxtO3pRQmZgRAA3a/jXn38QT5+eYTJZQeaMRI1q4oGNqqj6qWcnMDOQBMyx01QrpcshDzovpSNkM6YdrEPKNi+k" +

  "WxmTnbhoh9eAtByu9InFWyFyJRR4phuWGxyT8VfH3FZI38PtzjfO3wgeU5000HRRKke2iBZlCNBitpI+qt7p7FXXEmpKycer4f5u" +

  "FGAoH1lfIecM2B4SZTRsGy6p4ldKOr1DmyRFZEOXglR/EXRrxtLHbDsu9nvpRbuv6MVSIip6DAAeOnYU//bBh/GxZ17AnEbYWNuD" +

  "BkBuM6hJ5t0xgt4YUjzs8xxTpRpr15QQ1MgVZrBxasjdom+kb2XHEirzO1yE3rYDpXtC/h4/E4XdCENFuj2gMk1gkh1FLXLlfdOI" +

  "h9Zy1RG/4dms+ZNt2JpKoWrHzAHwZOTIYPZ4UZYvXAcnmb/oatSFexrxMnUv9LYC1aDvdMY0naI6wJS00bf7XERMblK6Y+umRc3o" +

  "R/sKcTGZ02KxwGGktx88cfDqAwcOPMTMiXY4InhHAHA7bk8A2n/3yCPv22ya87ltWyRqih9SXEpS11K9IB14DVT8VCTErxQdanmb" +

  "Ulq/co/pTFeZmGGDvu0zFeLsV3p621p9HRXe8Htq4+Z0MADEDIoIOsg0lnP8kbdfiz2jCY4vFlCVwNGgEmDVr944mDQnSbYdq6cv" +

  "yrrytckGfvO+x/GFFw9hY31Nt6+2q+kJpjM5M1s4u1Qu17QrQ2afB6u2j0pdjVFNvuglVKFq+VxPz/N3kAsDKGRpuvPHfqZ6NSQx" +

  "jgFQxWeHecGBqe+hr6bbQaIupQKX42+L19KgJAN0e92gw4Eyv4EeagQK7FDgQDUIYK+Mdm9/oNamc8UoQE0X/7zkW2UuqRSPevkl" +

  "+xhjuxXv9Glp4N+MhctTJbOka+3LGHWzqxBw743ppV6Zg+Enwv3HjuI3H3oYn3zmeZzihLW1dawTAe0SSyJQA4OdgVQAYEvRRBkG" +

  "4x8GpKBH7iHu8BzBDGgsB7JtqJNZbHt5UgATaFK1yV6k7FeQI9LudgqjIQbXIbb0uwA8qwmovG/vhTs3AmIin5kTxfCluDvo7Pg8" +

  "lUglmEx/uFHv8Lpu3w4IsIqoSedS246vY9kwW0BPtFfWb4NoboyVV8MYCb5vQmIvKK2sXxifRgrMuNs9QVk6wq/pRAUCMINGyMtT" +

  "qxvjf/PgU+8B8NCZVgPsCAA+fEfJITx4ZPMDW4kwIlW5jrB6hSZwMrsnEhht0Mh6iNwQFhw5mebTt5IXRdl7z2D8h5Q6UX2sbLyP" +

  "zDOXsJIJltzXGbM97w2FfsFQaBmOhPBYvm8abG2dwgevugw3nH8+Dm9toRklZwp9B5U9AHXCHV/UrOVMKif4ZWD/ZBWffvoQPvL4" +

  "U1hbX7cNSxC8X9ktXuYojsrnQUWia2jKPAuvMaywkQScKDiOYfD6Yv/JWgAqImnGzurCoaf3blv4q61FLRjAGABZEuj3xkhAFxyG" +

  "uwbfo4ZTbykKXesRIKUs5PxDbsxtV0PpcAmvp5KPR+y7e5Y6B90+VGFjW3Uy7JlbSFH40IhhRs37RqHjJpud9jT8an+LzLrTw+jS" +

  "thehYBjAICogKlPXkL30q/BfRkIqESoifPXwYfz7Rx7FXc89j60lYXVtA3sBtHmJTMlBLqMG7Tp3AHTzozLjwVBHZW51OvpVHQtz" +

  "rnPtWW5zIMxCE12dwfH7HvD1d3S/KzUyPrZeCkONmUUF4IDA8j4CB1l/KCjPoI6s1+ON/bCvBmYK5jxpSs6Mf6CXt8VCf0OZYTzy" +

  "XynaDrty9+THVgdAxhQNr2GXAAo64IZ1lIkkJVDuZHItvr2dcl3KCPJF9ViGrGfhkfJ9QsLpFnj8+KmbAPzqHXfcMfCEXzsCAFn+" +

  "N/rZ3//4d5xiIFGT1PB4p1TJKPN3GMvWk6L2uMywFyVskKLDLBYO0/uF1RSN1kZv+Boy/t0Cjq4islxwVD5MVSRDr66X6ZPsSq0R" +

  "DlIDpuNIiXByNsdbztuH77n2chyfzkCjwqVOTbZnlEEqgwPNk2VjNnWaW87YNR7jqZOncdu9D6JZWYUXuRnkAlFB4zlJARuLWBsg" +

  "QkdaIxO45xu9WU8NyQj6+YXQDtmyKYYCB2lbAQckXC5FkD5/Tv+UCDWmE1qrMkHxym3+E6CplH76KfZSOqRFcmAAWex656EOqOD4" +

  "OYVfhW7K4yWd5fylBsYkyML8CrY6xtPoAXVGHQxGhYwA2kRbExFa2f+hziqr4iMo4NR5MWUZ7V54jsjnR5W5qWlVWERSb+BySCls" +

  "ZmNy6hqhVv87X5rfL6dKln0qPvfi8/jPjzyKu148jOkS2Fhdwe4xoeUWS+g4Q+SKer+AiG0lkI+nAPuEctJoDLODPVLFdsKByrTP" +

  "gVOeLfJTpZTEay1psmGDgPB5JbHC99F7ri7lLy4y4UWfqiNce8H4ydO+euoRdbepDl6sA1iu1CgJXcIfJcqVhBrabzPG3diD/jfV" +

  "tSSp5s1y/HwDHVzU98nGxAF0+RDim7o1E6zgXIiTld/JaZlNHmoQ0vWLOWdA0+vwuTLON3tT6O8KFyDkNF8scGzRvp+Zx0RYMt9K" +

  "tM3hQNsCgFuY0wGi/NU/82eu3OJ0XbvY4pQToYmFST7RXY/AQzChf0KhkscNIXKOWDgoK1V+5AozWNHBqxdGRh/peV9C3ztAoPQm" +

  "aOsdriFPzPeoLvRqmW1Rnho7JsI0Z1y00uCPvvVa5LbFPJXzxIsRdDH242aFKSihLMMJylWjLRkgNMi0wAolLHLCr33xAZxEwgYI" +

  "SxFQPY1OjWNVcGhKwo1/KcSpqzdiDlnNotPP/+s1AH3wpXNlO+4hKDf1UiuwQkFw4hsZvQ0iycFRnC8P1UvuugNctOs2VlX2rJGX" +

  "gYKmSJPoNTjGCcLr/aijTtZtUy7J5jhsiBLolmyjnhz42A8Y8WnQAGfN/0rjUt+RkDmDaGQPOphHsCxcDY6TGECNWpF/Jx3qGB2P" +

  "KkRZ1chbSgksRaEWqUCnzR2ueDxvIsJmu8RdzzyD//T4k/jqoSNoU4O1lVXsXmFQK3tnEKSgmGDFjxWYj95bA1AL1d6Kx6wOggeA" +

  "kfJaty1yXWNvEpsZ9xmzhuFpsCF9V9op/c+oKzO6es7+rhwzFN1LIeRdlhzVPBDfH8dcgd5+xMflPgU5zoIhEsomWLVBNZCh7wE7" +

  "7UkMMMgIV/Sg8mMA9pzMuVPjqn3NAjBqDRcNWGm+sknyXmJJyViDZADYojTSt3q++oC2GzmJOzt27ZqLBRXeZSRezvLxycpl/+mx" +

  "r14PvOVLN99+W4NttgfePgIguYM7n336vVvjZpKmWHLKIyCVjULkpaXwLwinIpPkJr22Ckpe8s8F1boQcQW5KmUl28JqNME+Ro83" +

  "v+6rCteoMFewtQPd4qUTRQjhoNJ/ZdoFgGbZ4o+8403YPxnh2GyBcUpAZkOLzLoDHIrXEcasHo0OnrV9ADkVJLm6uo5//aWH8dDJ" +

  "KXatrbnx19oNeV6NVle92t8hNGWv7BlAAT4yx6xjhx9tylQzsY8lolrtmoIGFfYukSNwgxjC3i0ASmgM2v9o7H001f1GlxToQh3D" +

  "ZkuYuBq38jggmy6pch8ADEz1T0/1kr3T++djGAqjd8FB/4ryIqFkWb5b0kWqkPS9sNUjJsikNQIKStjmVs2YR2z6F1vRZqRjbcAI" +

  "EgEg9X3bbcGWj6f0pXj7ZPvjP7N5Ah958in8t6eexhOntjBKI6xP1tAAoLbFktToFJ3TkBtgBWzDl58/UX5RAx60kBnMsEKKuUIF" +

  "245K+J2kaTN40ePEEA9oWivMpQFv1ZkdPjZDqtlyjQIF4xkP9oKE+/U1SCgnWwYIH+hnzknoa9RtHuVBIHwnz852Q6BzHLuZYgfq" +

  "Cf5Jx87qUfRdEFBAG6HWRyyGOFLUZ9pXW5EXilKnj72p9Za6Ost0WvdvjisIdOxyZ1iz2GTOi9Hq+EtPHv0uAF+6foflgNsCgDvk" +

  "52OHTtx0ejyCHv1TtjIt7SXXDDZMm6vAQsZrXP1i88nlRCNRGmTIJ+YFLScjjNCVy2ioEJ8duGph6ed7a8PPwUBi8L7BCIOOVfsb" +

  "7ilfJcwWp/Fj11yBN523D8fnc4wasqWtNQto+G0A4giY0ONxSQr0lu0Ce9Z24xNPPotPPvU81jfWO5tMsL9Hh69crmPn8DvqmVY6" +

  "ugcBW+ccAQkRoYUrHp/7/j7+3UuNiB1rbHMQc+GBl9DxyhkoC5i736myE6Ma+MzpA48UiAeac/HAI0VIhV69VHalQkgg2fAngsXU" +

  "ObXMUgAcwILSEtEf0T0xnDsYunVvtrcOICV50pelFYDGplRI9pXIkv9N6kUB0Aps0+zhFV4spu/2z425ArCrvaL6ijIVjYUdUzBw" +

  "ld3vGA3K8rREhHlu8fkXX8B/ffJxfP75Qzi2zFgfTbB3dR3FuyyhfkoS5tZCtOium5eqhr3b1+6nbHTOLN6zE8NnsV4KVb7uFhhr" +

  "i8E+q5dJsP33enQzeslLNVvpstfdQwWma+VheY4kdeLOHRF5CQtnS9nKW+veG/gLgLjy/OsQdsekVX/VwLBzH6OSVYDhW65TRQtv" +

  "OtakSN8Qah4UTHC3n/JA3AiB0YnQ1CucIg9Vaa7Y3llew/YsfMYE4lyWAxLRdLHAi4vFB5j5F2++/fZtXzQMAMLpf3/6t//b++YA" +

  "iDkhERKTB/7VjgRkpjk8W56FMEFCLPMGtZmAdq3d8oWjJV18HPJQfdHsTHhvWE6H7VIElfKn8k5flgOb1O2M/7bpBNf/SCnh9HKJ" +

  "t+3dj++58hKcWs5ESGSYhiQ9PAZouCwypLSrXiiK0WmRsTEe44njW/itB57C6mStbD6EsmQS7MbQZs7Ame7vkESBxJB7rRSrccvT" +

  "RKWWQMGfyk+fgT3V06UjB+HxMw8kRAf2CvXBXgj9IC+Py31MqHPgx5IGYTX05U1wRcH6/+rM7m4I3QxzJA1ZhrTu5YDHS8kLUpMo" +

  "+qK3HRzUI9YIgdKSvb/6vSFs03Why/pHAGcEJHlPsoWYMQMd6nlUFPXRsHmNyXyU4yEFVg6t6MscnC9dBrUHMN3RkKy0kPc9cuIY" +

  "Pvncs/j4k8/g0c1TaFPCrmaCcyYlPNpyiYI6oAw+IwOcbOZrMxm849g/Nanx8ir67lV/UoBCuX9IW7mHHFWfV+B3+b8rk06/2DMy" +

  "oJNZq91ZURnUmSjqlsIePVLYi7D0z3ihT4XKY9XxDugM5ZXeCqvKsA07B/51rQ/DY2UWU4buuunv9PfHpYrhQ/g5NKUvupwQNmeF" +

  "lilQAQg8H+0eJIWrbdj7h4GwPwdbBdOd614EtbwFDALnNi0XUxxc5HcB2H37zTef4LKkv/eyQQBwC0AHgHzH/fdft9U0b2gXcx4x" +

  "UhZLQVKExZI/JgvBuDH3jqLqvi1vUsNeiYAoUlFYNV8EhKBGBeiA9jRIGEVf/fxJByWKodIwkJO1NSXq6LZ/uYKQEL7cDwU8pIqM" +

  "MaKM77nmIiBnLFgLCYW+pQXDx5o3LMAqyfdx4CyCnEoIFIzTINz+5QcwA2GVRsjcQoNkSpfwePhDV40wNDwMUbRdI23KUD7O5AcH" +

  "UTDwyYCNt9nNebsCIn2BKawRaU623Bf5QqMEImYyNr2XgVAsZ9wXtICGIbtRIHTahEEakgpq8t0W2TO7Dhx0vK0YSFTgUd/T5cfC" +

  "hFkz9bJfSQb0LHgpqlUQTfbOJozTx+MBHVeUKpKkfdDeyi58TAnjpilb22pkLsyVeogGfDoUhhopSrbFLAiwCnFJuHsVgNMDsS2W" +

  "zV+Y0eawx4Tc13LGo8eO4ksvHsSnXzyEe48exzHOWG1WsGuyLmMqaQHNKVsInGXViyl+mHRQpw8VnyoVnR2r785mA3blKJFq04lV" +

  "sVowbElcbyagkXfrHhKDToh1rMwDiydvximkb2qwLDxDhBVmtJJDp6w9Vdvv+qC0Wa80Mw1JavNiQWWQvexgq/Q58KjMdb/Aljvy" +

  "aSOW9kvVA8vvTposJCnpikhntQ2W4hXaZeHlZGlvEtkLwDB0jQJNzKIRUNmYeF/nuerqOmihzfg+iJ5Vp63ot4YAtLPVtf0f/sSn" +

  "3gXgozeXE317dQDDEQDJ/3/22Mn3L1YnI9pcLJloZMHPuFUqezFDRP/aMe9t1XVbBtfNtQCKomqF7KFKFWCYx7VTuN8JVbfVuQO2" +

  "ppp8K1n3qoZN/vbvjQIgzETuwS+ZcM7aGq7ct4HZYoESItJQNZsHbIqane5M6rOoBQS4lTwsMVYSgVbW8K+/+DU8dmqK9clqCV0j" +

  "AKQeoo6CV/LlynRDY9TPstRhkD3r7URD6POE+rOBSwteFF2fWiyxYGDEhHlPyUiDdhRCgnoxxTjqXggMX8muAEL7ar0PAzSzWvWN" +

  "yIGXhQstkhD5pbTXMGFlNIJ6bBGIepsDaSjpdgYwZq29EKASxuOKu64H93X6mgtXarGRzKJqEMBkLMs4tczYyBnUSFgxJQlryxxl" +

  "Xbar/rKO2EEFmEs1uLymVMxn6Vtyb1bmw3UIGY82AEAZ6ytj7F+dlGK+xQxfO3IU9zz/Aj536BAeO3UaJzKw0qxgdTzBuQDALVot" +

  "1hTwRQZiXdOQEKuwQpH/JFEjYkJOdZ69AijD7LvtVWk45sAvmncPTarOCeCwIcKp+QJpRGiWwWlSHoSCOYkE2pQqjO1s0xSjgPI+" +

  "7UMSZ+PEdCZATlfW1MBV3+edjpR1SGj3Map3crhLxxn1w6CuCmCsmseK1lo3Jek934RCPmf4Xh7h3Y76oPor7iZKnZ+9a6gzLnlI" +

  "avQDcGDsbL84/hIcCFNhXVsg8z5i8NaoaZ5pl+8H8NEXt6kDGAQA9x08yAnA0eXiD5xq23LGvA5GvcJIMPX4ADEdykY5RASC4kQQ" +

  "RJOmMBBlxtDlojiN1ytC2DOm/AcIGC5lyDoPi4D+pEuIoOPM15BZBVBlLxISxgScmi1x97PH8K6Lz8U4iZFnYRVSEAAzHOW3xteu" +

  "K1iQF7AAgM0W+O2vPIzPv3AcG6trQLsEUzKg1h+JzIt01pfIsRJreLAVEi8KTY8bdc9AycgD80DhvzBEHMHeiBKOTBe49+BhvPOy" +

  "izBeLnyDIVazBmiBP4d/dnwpQZB78iV3thhYQILMtS5BtKWI0kO21pXLhYeNZ4tCISEXgdAwMJqMcHI2M32ebA40N4pKKTJUcSdk" +

  "bsGJsDoZYdGyAwibbw6GiAzPxDo+ACX6GeYzhharWxkgavDs9DROzGc4dWiO6y85D7vWxgWcGk0IYC0+dWWv30XlbAWpRj15DxSo" +

  "eeolAreifAk5t8ggnNya4t88/BCeOnYC9x4/judPzdGiwbgZYWVlN86hFuAWzK1BkiS0FLzhyjt680L/GAVQw0sJaCytQU5bGVY0" +

  "2juFclWnmPEND7oBJcGxIZoV3gcAlBq8cPwUnt1zAhfu2Q3kbE4Fyz79zGzv0YI1V2dkOgXq7ZJGcslAQwsGUsIjhw/j2RMnMU4j" +

  "AXxcNpwnmF7nWABudFWLagSHrqAJowk6uraabPMxpDOCzt8OIFT3CSixSAhAFG1Syf8PpScG3w1PbXYrgTjQ2Yyb3yDzGowTodS+" +

  "DfJO1D5RdtgAmRMwpgIlqsSMxETzdoFNpO+dNM3/9rGbbhpcBdAbueYKmHn3z37k9x56tG0vpDZnJkpe2BMaoO7khm6Fgpfecpbg" +

  "5UYjYMowILPSXr173rYDiK8Y+swUYBToZEpf0XlPk1Zje2lXt2K3CBqB2hbnrE+wMkpoIGhTltsUI+qAhFF8Pham1bxo62wHEOH0" +

  "tMXx+QIr4yTx3/Jsg5rRejlDIj95RdfI2niDl685M/Y50jB/vFqHPwgScEZAxZA5khdkJox5iYv2rmOlGYUwZlGYmV2xZZYtvoN1" +

  "jZ6Sm2zrDBSyap4TjkqNxj6SwM/MgYfKO0rhXDm7vQFhhAYvnppiwXNbhbDtmItllP4lILe4cH2CtcmoKPjM1udCo5J/yElClaE2" +

  "p6RLdNEph8iFqkQyo6tjy1x2kjw9z5hnRptbbIwI6ysjMAclyW7wMoRnIechcIFRNoeB9qVIlas51oiURZzkPxqhWeYWRA2my4yT" +

  "8xlSk7BCCaPRWOZzKeu6y9Ixj0p2VYWHZXVjLx23zkrt6Uv6SujU59cy8WXqRS62AQDK71E+qhSQNGcAGKFvLPPHJECupLTXVkZo" +

  "mlEZl4TpJWlXcvuqG8gNjM+G/q6AtchDkvkpPNRgsZwjU5I0hUfeCi0c0pF62Slu1BUGUZArgs0t920TWdSEQIxKGM3U1myjx2oo" +

  "QaiUhbzXohdW+9Ofn9CjqsWu7op/a/oTgAYa3NYHI2961uZc6Rl5rLw3AhwdN3c83Dotq38zgJSXTUoXLNuDv/q+d19D+/cfQ8m/" +

  "ViPtRQBuLzLR/s4zT7xl2owv5OmMU2oC4JGJD4OKc002MDZlEUGhNRMHZh9RaCkIiQ6K490v77L2uO6P52RiFOFsGK1mzi4fFV5I" +

  "FZGYZNOJpsGLpxfFcBUsiqLR2JK3EQczBLiIyJqJK4uwkahshLM6HoHz0grQrICpUouBIRGjA8EzC4Po56j03r4CVETqOW2uhCFe" +

  "zGEdO0c0697XklbwyNEpfH8P56kYMhysKTD8EQyeThQbFJBUNZtShPBITQN/NcUPk/0FNeGF/yWXTqXsrKJhEGQCzAsrf2dwAp49" +

  "NUV7AmWNvfSH1EAGBrZKAAE0Nl6RPY0qgaKZ8y1SSblJdr9rhAabC8bx6UzUfdxeVQ9AIjCLF4XA//JZLdtewxCUQAX4rfhR6JPB" +

  "SMhoKGHv6gQEQpszcl7IRIg+qyIRHbCtXUY9nY3crwc0Mth2gmPVWyoR3KkhMsWv4KtW8na/8lLoQ1dvaEanqzeYGdm8Vr0nA03C" +

  "0dkcjLkDpkBHeyC8iHSWSSkU6GwGl8I4l0ipAZDDVr3ReOpj0lqS2A93xldwEjipHhs2/NWlY9XTB6kGRXZbiBSGDyMB4fLZN5hR" +

  "vSuA6p042fFah41/qfcCSu2E982NegUcskRNhNd7jlLFux1daeMKQ+zSRYrFGZzykvPmaHTe/3Xf194K4OMfuv32dHunDqAHAO69" +

  "4w4CgAeePviezQYgopYJIzdgCWTIyYtD3MhHkXNi9QjYG154Jm4yEte+DwxYjUQXFUZhRLjH7mLPTSWUHD3A4oAryEmIG8hY+92/" +

  "u+FUaK42CIEaKtPbRXmspKIcFQTYoJIkUyjZKQn28oi44P659qHlZVkSpYhaFFQW8Ke4nlV3qnDa0qXC+BpOMqBhxh5hviv5EmPm" +

  "shjTDkPefwo7XmmBW7lXCnPAYGSsjn05nQpCL5fuFhEh/h9o1tOKgR/0Vuotb/V0DPV4WcPelbErWVR5eOkGOvCxgjk16v0gKWGl" +

  "IXBisenJogClmE7mPExGKXCKSksVdzKDWvUDVHLe6hho6kkaSAloUhL/JAWZ8oNx7L1w+kghEsAIcY8ARipBlqhMF1gFnicw2tbn" +

  "W6MpWUGG6ggLNav8hnGG97H+l0uuW2GYZtCHNluC0do6GXgFxctNZFstlflV+jrvq7OQWa1lJcz+V2VM/J7MjFFTJD5rE8r7rNSC" +

  "sX6hl43M30OhbVJnwqmfeVnoVhk92ykfsULeZyuHN6oI1jwVFVgV8R2kcRmT1s7oNsjVfTJ+62O3P9suIe0cVESuJ72t7cFKdDai" +

  "5882X8pHqmQlqmRHu0MiVX2v3l8y8E5THGUMdXRBxyXzzC3PxpN0dGv+LgAfH9oPoBeXvOHgQWZmOrg1+9YFEka6HMhCYaUTukxE" +

  "VFIwJsPE6irresqEk4Pysjs0ge4UqwkUFDk7FSoEXhXvhD5o++UY2lw12s3NnBG5Vk+zdd1/uuIjdpWfIWuvkaViOdATus7Zn2Yj" +

  "FwlYKUqhDeBGFZgeAWsIHlo80jVZQYaiFw0YgEB4TvmAbLFYZ46FF3oRojA3Xbp2q32LTBSTlSmhHAAqa6xlrLrNa2YWzxDiFRSi" +

  "Kw058EekY7Z+xs/Y3mPvE8HL7OZLf2/F4HGnrSLwml/tSnJ5mdOuf6wsYCoKOcv4UPrcZpbPCr8oDQqAKt65LXVUXio3luI79nuE" +

  "89AyFzmQXdh0TFnmMQeaF9XKTmsUjydzCz3US9+v7bMZArnfhJccr0GBdCe8LqAHtSQEk2IQM/CY8kJHbgVHMhFyiryuCrqehy5o" +

  "7aXO9B8V0B/XYkBl14yb7qHfNf7ehr7zTPrGZ0HoLjrEtViMSDrAtP5TXMnRhWTaI58Lhkdi6167zDlpdNZzcACi9GkXamNeosV9" +

  "ORjSGzulEXV8w1uPl16noK/K3CGM5SwiFTImJudjacDa9K2NBTDJnCsdpTKpoz93fq9qXkLZ0rzE7hIMmGm/ACRkzpRxcLb5niYR" +

  "7jt4sNd4NwJAN998c7s6bvAnf+ej7zw9zaCUUr+wQXbiN0BW8lTbQK3tB6PNmlcXv+0YKYb9rUhIjZlmUhhnb6hNsMnbDS+q2hkE" +

  "A+YBViOScaiiineE8VBUXo6JbV96+cI+lwml8E79rSynrBk5kCoosGCIOsqn3CftcxRxfW6HvH0XTFAc7/ZXDDk66o9ebUeVKQ5h" +

  "zePv0CdSo1H+GPI0tu0D4JG/+Fznfn9VMO8UjZEAP9JoUM0/g0pNJ73bzwqnR6CnY0KYgviHRupCX1VujE4ESskMv7eBcGO3T2q+" +

  "Y18a432tQVDd4Pf0e9ilQfxsaG6iXHmJEZtS1GdalIE229BO6RHfpb5GCq/h5Omzwb0MYutSFKemV8e53RiULwgSneNI/7pv3d/t" +

  "7/LiMKbqDVaUXfhX+hhAQLyGZIQBW7GldGFZ15uY3RlF0OVnqYOrcegYpV9d56EaH3UirgoyOmBGS6h67wu8o8jF9PF2/e8yrdoc" +

  "1hQAVTdVUCmIU3S09HZS3tuBbh6p8PezGU3RiCHqDAYaUFrMFpiC3r1sc0NEbegogE4E4JZbbiEA+MjDj159IrcXcV4ycziouiI7" +

  "VYrFwlAyuOLVbF/45MrJUb9TKCAqCU1G6nuhgz5Tfm4DIHfogSBcjWzIaOoZqxW2jq+nxKwF9V7UiCm9+kFIkEcaunDB+hcAyhAy" +

  "taBIVGLmqfbBjLVtIKWDPCkoZALKFrFdbOa9zCjFRpHwFuKiGDmK7/ZxdIFV9BI1BeC+sCq9nQsJfcvkmmeG6ND1KpKG6Dr9jmOp" +

  "jHcw+j5fOoKi5Ltd7fedRYnxNrWnQTmiT1MP7Xa8mo481CRxJY5emivKX7/f6r/D+Kb8U6CoJpCYQJzEU/FObEfLQfpue9U8pn1V" +

  "LzJ6VAoGt8ew7PUHYofrlTuoQLAp464syve6U5+pLqhuUm5mAdp+KJDeWzI+yjMsBluN97CBoM54ywZHuYAxHSNFLiL4nvd1m12A" +

  "AUPeus1vljw2w7eOdm0znO4dpnmUyWh4i6FT4tX35YHnnKU7bxoA7GUkWrvB9fPYnsbbXbbahDUK6GPQ2i9/f0nbGMDROTYb0+3+" +

  "MEADlToxSsIwug2z7m8gMk2MlBdzXjTNJXc/8dy10q+q0cpC33DrrQQA9x564V3L8co6GDlpgYcJ3JAguZLWwVu4aND4BCZhNd7k" +

  "euelWHGjjrBhlwe2u5089BKZOD4V2xsyIBx+9kVJB9MVMD+eg1lCr+SgICqNCKhcIZM25D2txhIUAvvfw7009dBXtkPAZ+BSOmYE" +

  "EDBg8IfC/ta3Myr6ut87G/++4T/TxdpnBRcydwpuspG8rqmIfVHDV/UFAgrZA96D76cMwEPvlUE2knLHA4j9FqWv4rSN4ugr99hS" +

  "pFNGDV6rxqpxuvEp7aihCwSo762eGTb0bhxyrSt6XdnJ2+y0KUZ3pyt2t3LG5Z/1S+XlTHoqfG3pJPmCOnpuR/7gboh9h1dSrX9d" +

  "N3fnMwC3YGjrvg9rtp0ue2N0arbRB5Evuw6B9pq3cSJiW12wXl1dYCGfDQ1pR13R82Wp829AV3bbC/sQAE6r4niILIDCHpwG14Dt" +

  "HBi4DCmITaQ2G0hE+VSTRp996qkbAOD222/fHgDce8cdBGZ6djn9lvloDA2UxIkkWX5kYZfyhQ2EUIqi3RZUGsB/qraKyjp3ikui" +

  "/YzNiLdR8eZZ8GkM5wJlwgui9MYzqbhwAVoDz8fudF8ZQUWtyLIxRHlvjfpsusNLE2RSTWCkWIdQQpMkAsL9wZdowLAB98LGImaV" +

  "N6MKlwm6kU4/hz00agcBCXVFrYYOhyICvYhGpLFEkTQ/vC0iHvi78hC6XuGAd9L16MxrjPxJQE6wYko3CE6Fau22d8y/R/+y8wLA" +

  "gf6waADZL/oj1UojGOXh+XZaWHRIp3tAF/rGqfEz4cXcQpVdLxIRPosRCILXo1TvisAwGCwHEKJY9d7+wOw7sMsbicyojwv5rPMw" +

  "TM906Cac39F+PkarfzqDQdbisNx5l7bdqzqHgswOHwktFdxVKnXgvUM84HNqFRY2NC24hdSQmGeqfZH5tJRW0KO91OjQtc3n20Xk" +

  "6mhF9S0Go8oqg8rflV0IfEEhcpPI0jvx3dteO9iWMqep4iP9b4wKACy2MdKzHGDGKCtTGrWhcB7pyqPZWdaVM7B9HYynhE8TZ142" +

  "Yzw/n74PzHRvpxCwqgE4cNNNbUPEJ37vjnedTguklKiEEkKjUH3mCqfvKUbLHYnohNC0Qbw7NsF2n3/RZVx5qm66+rR+txWanQlO" +

  "222yhWZkHr2l40GpcBZPI2ZH42hi29zbXrd4eTRAuf6InJLqlQbPRL8rMi3HXEZTphWw3pegYXw+9L0D4alIh0qQQ2TClVixAqow" +

  "KuTfGZkbK63WKr9zx0Nx7xHo0mY7b7E28AHEDUR2BMJJ30NyR3khbOKh95E95+1EHh+6/MnurA9rHMn2lSdkvs6Ae8tzOk/lQQOp" +

  "EKBhe06EVxsIYqeI1vvHeRykd/3yM3zu4EaVOBHJ4VUKJAbkL/CPP06l2BECnAKI81xtGKRelU7o8xmzH5c9vGY8NIW4qU9oq3dj" +

  "33gqSBoGF10vsNafsa0evVj6oobH9r8oEYAYwSuGnx29ZQcN9jlnl2+dhyHwOTCKHSM3wRB0gVB3XmLhNrOORW7T+oowJn2u+hsO" +

  "rF7epe2U/2WC7epa+RqkeXoYI7ifXo9hu0tLx2O5iD7CQb2ZD02MhlKaLRc4ndt3N0R8oLMM0Deokk0Clod4z/E2XZsXSyDnZFsm" +

  "mjfo3VEhLICRtZ3tBxEGXg21sh86UagZbCgEohzCwwxl5xXoJEnXTHlqE6Sd4OAdW2dlD/7hITGrkiqKWc+EHox8aIMaCuqYvxKJ" +

  "SPW98Sd3Py8QyXLWXRUjm54oSvRGut50UOSsRle7WT0MZfU4fvWYkjEwVzSt7jWUvo2B0y2Z2SvSuznqvrD239O9ordu+UQxHQVg" +

  "SH62O9UM2NGhCo4shFcr9yEzTiyV90BvpYN+X41JXf/wL8qUpyhqOpyt+jLZizQSIxnTT6o8ffo5/LevSCMNVCcMRXssDVB3qvpA" +

  "wQmR7i9TVijI5Pl7O1EBByuq/yLo4xr1hZd6knPY8J9NKqy+pDWb0jNDtIpWwjPq4an+Exzde89QWxXQTmXFQzH6CWXlUFyxEXW4" +

  "PCPym7kVcOipAuMFIjAlsNV7nXmcdT+BDtMV/h6IgpQHwshZrR51/DmVjUifwAOdf2c0/tt9ZUij7hPp+QZUotkqBxCjbdCGu+Pr" +

  "6IGB9+maK9VT2U1J1H6iv8tJpAQitMCLi/nrl4cO7SnddHjZsza/eeyBN87HfHFeLJmICogWJKgiEz2WKpcXBmuNBl0GdubkILzM" +

  "bPu567xVZJAlTEnRj9upQJ8h5Uq25M4FvPbNvYBDjS9BC+Q4UVnmVdtp67MLmRto3XK3RpwKQLRQSvb061SHG2oNPVa6Nlk+z0DK" +

  "bP2mauojs5MxBifXHOpNxaBg6aL214lfI1TvI3fin+4Dy1PVIfJkS8aUbtUcBW9Aoy0wnnIw0RiogChHXe+qe3ozvA6lo6g07FdF" +

  "R8ra+Ehl3zjMw+SV+lBeCG+pzVk3FF/AWeHVMAH2XPk7goquNVS+1B33KIViH3mP3p1I83/hdyK4QZDytI5hHroIBJJlg90wf3Xf" +

  "QISjm2ahzr31e1xOK7Cg0JblYC0CKCVQ8o2Vyu/kf7PqoPJPd2PQe2Q9UwWCSN5VTgLs8Iw+y7DPtuPjWpdLUWEWPUIDxmyHK84p" +

  "IPyO+hTD+qr1gLahtGM9ZySVPVwSlfMdEkiOUE5Gw0SMlDz0rPnkETREnaTdEmLWqAp3lGSPPgOgvxhEPa+jM34Ov3ciU5XNCfxt" +

  "74GkMmwuCz/UcyfySVX1je25YmtirMuua6xRayP2n5GEn5Pcx5wFzKlCLrpf54bAvpdAWKVhugS0M/8oqBbVoQ5NkRmi5WLK7er4" +

  "df/++aeuC4MBEFIAt8oBQAe35t8xH60AmGcQGoYYZ2EERYq+bMGZNXrVuktF5XFEZb+DUilktFZtgPX37AYjAo5OWxw+74afaxoO" +

  "9ME81jKmsjMZ9e4pRkqpX/en9rSC109kkx2NJ5fbZGc6mUTZFTDJl9oXglRxlxcZeErMULliHQeXqtShwy166CYQz4wuqapUotZM" +

  "r6hUQQhFUqiSyPUSpG7+sAg+K4gNc1J+pg5gIorRGoJthqtzrU+mxnvJCLk/ss+1Zc2lWd+EhlDeITUytcrlAKK8f2rA67ytU0xn" +

  "3pVVPcIoXTHkWV9dBahKUQ9r0nSTvBh6fPROV9dzr74LPT/7qx6V/3eb90MMswCZKWfM5lvFCCVCI2CrQJqy1Q2RnpfA7iESwGiR" +

  "Bcy3ucXKygQrtvmNDXK41yGaUfWv+3c1Sp9vjf681IuFGVM5krGknOB0P5s2VVcjJWxxxnI5F+woyxVJdEKUbdFxRdfpAWllHBkJ" +

  "mQjrKw3GALjNSLan4va92knnbxeti78PGXltYzs9bvrUdHh3O+PwPus523jtXnZb031GZyNCd/2WBn5TXVwcnOGx25ihkd1wBoj2" +

  "vXIWao4o6WDlv+KINQktJuujI8v87QA+c2s4vrG3E+D9Lxw9J6+toUFmWwGo2lw7FTrj9lfyEx0qmQdEMetUulqH1qiSwT47BeMp" +

  "CKrYUbK2Oq92YgamsAkI95QQneZtCHq6miFxubkPQ8L7FBEOzakg2irkHw230LFUfTSYtUDLLVo9hEMAF4HA1MgyobIHQCPrrYvH" +

  "I3vQUTGGWfd+CwZbc6ROZRscLJ5k/R4SRBVCgh64oycoliGQkYEpjDHQv2LiwNzRSx+GcUXJq8D63Ba6aiEOM0BNwunMaBctMi+t" +

  "kj9WOFD4pOQ2S1+Uvo30PxGVY8VREmjqbyXpqIm4/m5D20lVM+IyJ4Uw2pZBgujtawFu53NUirG0EI2/KUqZBOO3zjWkZLdTUnX9" +

  "itBzG4XcvW+nSynGAsRAwNZigas2VvA9V1+OS9Z2Y300xkiKCpO8w9QIA7ptcfnHWOaMOWfM2hbPnT6N33nicTzbAivQA8v03ATt" +

  "Qb9TOYDXaLyKfqhz0Np/N4ze+llf8lh5r4BJBYCstRjJNxuz97keYiIgEU4tl7h+3zree9GF2N+sYoXKQVsqOpaWkQ8MBAMSQS1n" +

  "e8yY8bUjh3DHc89g1qxigoSldrdDtp0A0xBPDfGO6oOdDOXQZ4lqmtc1ETvIpJi5eH+rfUOwfvofo9EAXwc7E18XgYlyR+QrG5LX" +

  "2petlrOPpXID2G0V677WqgRBKOeSJGxlwqOHj13OzHTTHXfY4wYADtxxR04AMGm+bTqbgaghEBU9k1ohZ/JRMIzp4+CMDJUXJoVL" +

  "ypTaP8S8UQQWMAKFkVq1eyZIXl5C9wMIMyJHbzdiNL/IOwRwCW85sOLK8+5elZI18YsorbRRGawQPiLoQSxAy8ByuoULVsbYPxlh" +

  "93hcBJAILTIWucWSgXmbMc8Z89xikYFFmzEHYypnn7dUwkspNZg0I6xRKttooiiIngNIkuPurXUZFjAoGGEXCD2lr47mqdVVXqCg" +

  "sERAxOvneN9ANKYSYA4FlARkVtXn7U+nc1y4Qrjq/L3Ykxoo7skgLHNGC8KSGXNmzJct5nmJedti0WZs5SVmbcZ8scQsAwsmUENY" +

  "WRljJHabqr6FLaO5RvfdkdQ5c9JHpE0ZB3Pvwf5HSkinj7cfeF7PWVBZYPZjnLsAoddOzd+dN/euvkLuynYHYIb2e/KIQo/N5QLX" +

  "71rDz3/rt2Hf6uo2b35p13e+7nX4uU9/Gi8uMlbIt0gGiiyWox2oN+Y6fUkm5+qpgbnsuKgOhgLaHUFR/zMzODKVNWTVdCWgRsgh" +

  "sd0IECGlhOPLOd5/7rn4a+94Byaj5uum3QcuuwzfdfFF+Htf+go2U4KcE9y7oq7bzvjXunPg2kEf7HQF1V2DtR33pUFg0xro6ZdK" +

  "ZaKSii31ZQWddQK/FSKi7ucd3aDPRodGj9/WPlRLkcU+iVWFOmpePxWcKiIwclosWszHK9+aiJhDIaBHAA4c4JZ5/NMf/d3XIa3B" +

  "fD3yrpaXwyqgawHvT1ZMFReD0aMx7AQ8IaxhpICqy33SDyUKq0hQReGe4upMRnUP0GM8lpcpU6phKt9xaEoz9RKms96oQlCUpOPt" +

  "eAJ6lKd0ZEmM/bzEn33LdXjbRRdhY2UFo9QV2LIFbOaMpXg2i9xiq11iOl/g1GKBk4slji/neHE6xdObm3jw2Ak8M93CxspaYVoM" +

  "GRM3Rt7HvtDp/AO1B8kgCaDkQWGN4XQDp6pgu4ID7eDwnHUNlt9KoJyRm4TZcoofueQi/OFrr8O+1bVef4YuRgkPL9uMObfYWi5x" +

  "ejbH0dkcz26exOcOH8JnDh1FblYxojodpHnHJAO08ZAGD53TnC9Dbrkz9KGrC9psLwmq6RK9iRg6jDSslWIfNPffTX256vJzZ3za" +

  "y/j70FUZwo7HtyTGas74c295G/atrmLethilMyjxHS7dMvl1u/fgBy6/HP/kaw9jvLIGyJbTBPjOfzxMH0DVldDdNv4H1JvWofTG" +

  "17mGIi72e1enWT8UYMpHWUG3RysV0MzQYn8i/Oyb34zJqMG8bdGE6ObZXEYX7QcDN15wMX74ymP45Qcfwa7JhhwXHEB97O8O/LRT" +

  "lGnIgXs510ttR/fl53geRMfJLTYr8kWWg5t2AHXwZZ/dlAL37ufi4IYxxDbDG7TTZkPd9njriRMtuMWR2fLSzHwOER1hOfV3BAC3" +

  "MKcDRPmzTx6/jHNz7Ww5w5h0CyAGOIHId46z09tsYAlZ80mlx6Dg1VhlNYVuqydZwyMnuYINFaQkRGNBWxZv1WGaBBpxe15LR4kN" +

  "XiTnUTO7gqaI+G0mCt3F8MXPkp7PLe2pMtEXlG5lAQHlJ+ZT/Nm3vhnfefnlVXdq9UlIqYS6Y+5mPwBsDA/n2HyK3/jaA/h3jz+D" +

  "0eouUGbb2tMox25Q4tvsLyoFBYzWDZRWY4a79b4Ynu4pNkD4iaxmL6YKjI4cQeY2YAAqTGU8lEaYLZZ45649+Jm3vR1AUfrbXdp7" +

  "osKnozTCKAGrAPasAFgHrgTwLbgYP/iGa/DZgy/g73z+C5jxCCNqbKmXGQMIwIeH9hipZ9VJWFcVS6q+l8/k2+idRlpoPYMmMJDI" +

  "lr8VJbCDkic7/Dr0aVjhDH0vN1XyqXPFnbH0291eEUe5TEiY54wLV1fx+j27wUA5WXHbp898JQFFDMaV+/ZiRQCSndsmHkumEgUY" +

  "Wqffu2yzreKZcw7j7zxukGkHw2ccH3TGMCiDfWcGWnWgAJHZosXbz9mLCzbWkZmx0jThLS/jUvox4y3nXIAJPwqL7Ia5VhsQRxfx" +

  "66Du7YC/eF/V7kDvo5HPOejibjs2jIFaNHNsAionMr6oVt9Yu5qeiWBH7YboMFeTFTUUtKWO46wpbaVfd6WRipCnjWHONaC1Awh2" +

  "p6jbRbvAYrx6yZ1f/vL5AI7cqngXAO6T3YG+cvjRq+YYpSZTRrZjPKwTxWPrTBKkIE1sSqZSPZ9RQtcMrX7UNuQ/PSMsKpGdsOb1" +

  "w/CtI8cOQlZwAA73hO+7YUbtA4UJLTnFkm+pQMSQDWEuipvqz8Cycxz7qoXeo9Aq03KYwmy5xI179+A7LrsUy5wroxX7F5+v/rEf" +

  "ilMdkMMZe8cT/PE334jvveQizGZTUIcuQD2ntf5O8o/C3yRss5MnRuYtxD7L5A8Yhf5cRZLazyEwAQBtAGt5ih+4ooCoRZutGn7o" +

  "X5U77tE10pGxbDPedf6F+J7LLsV0MVX/W1iObZUL5zBuBjBUuEcF9DB3xgEMeCvK1xpxQtnEhODFjIqFicqKj1QKx7rpLwv7o6iK" +

  "7UDwGb0llV+4IapVbPd357VuHn27dxd3IyFRYysbXqmLQFhNWuIWeFHGVXRIAW+E7nzU6kCXeRYwJgCMYAq+/rdTn4Ie0p9n8Fxj" +

  "hJX1b3uu/L4HzaD6+nouIsJqGmFMqRhc7UOU3Y6M7xQJEcTSi7hU4w92WTdi6rUSnt+Jt51GdRqzzKGvlFF9oxsg2eozNzXV+IiD" +

  "o4jwLPqSoSvjBh0kv6tLpQpEqiNZ7Ig0aI567CdhBSlvcstfXZ66BnCbnwBAjwk82E6/Ja2vgTjn4iXqnnhSN8aRRaOqVAOryk+p" +

  "6d54smVnoY3kRj9OUPczp0BkCO4801cqFcqzr7zfhJrJzGipUieqkK2O1d7L9bSSKao+E8a+ZZmUzAwkoF22eO8FF0J3+ks7CL22" +

  "Xv3b1sglWcbI+J7LrkBql3boSM8L0TqAAcRSheuoFJbE4k6rH+b4N5UojQEI+SdzEdMfEdrbXFEAKEpP8r6ogLICLgCLvMRF4xW8" +

  "5fzzAQBN2pmOO9PV6dgQWY3Dey68GA01WAQjT1rpD9/BC07WMEB9pvB3Jqn9AKMlrpW5tFZ2/UsgKnUMFplU7Gn0Y+PbQiN9WVn7" +

  "De0d+6lhrJstndXFFX3s1ax1HNqFWia0LzKDg95vxEssxlf/PhPUfLnXSlIIp8xmkE6ITH6mXSfP7b3zS/XfkGE6I6BicQmqQ8Sg" +

  "b9/GmLHRS6MaagfUCaIsRcI7v/1lXX7WQB3mjmOKQKb+KvKBzrfohXC/L81OMiciB5lE5vSzYQ7pvrdyPKB0UxSlfAAbkzudYV7U" +

  "Rsj43EkVzR+ASvcahCQawTGDXu7SEzRVH3rKMNg0wOCGggpUDlXgpZwz1tbpxa3lWwG3+SMAOPBLv8QEYPPU4p2beVHazQCnFIdm" +

  "nreGGbQQKxpYRT86mFzPATpsUg3G1H0PxdWeNFPEWB1D37kcFWq//Pz5uleELEny0gcMKjQ9W7v0t6z5jLeUiaoRbRcBxyIyZsLu" +

  "hnDjhcVoncn4v5RLwQQRYX08xhgFEKiwafgJOhrOYugI3YLAiJ+iklOBNbYL7YFCwRIjeIvlnO64NMcVRh3OgrWZoRtrWJ+oLIPM" +

  "oni32iXetGcf9q6sgplfcVoWzyehIUI5hpWFjiqIBNtRr0OnLq5SB8OVp/O4rkdvKnOrYHvAIyUB/gIipD4WeiJf3IehfBplx+fl" +

  "TJfWFMTUDBlQ63ovPkaqPhvIlUpHiv5SfZKQOcta9VfehJVgpoaJyZbVlkuNUwanVO/8p/Mqc1zpJWhlPYdWfI5t7gK9SDrjhgRG" +

  "B+vowN9Vu1aM5uKXiADy3Qtf+SsURMpL4/HClXeNvk4n+z3wUBD3PmiI52N0aEAI+sptxpADljtRBrVVwdKIfWsLcLYhZYCTrXLK" +

  "ChA8Tyz81AeLNtuaDxAbClana6AigMj2f7BaM9EHViAYZKuFtqVdKn0hUJEjSnSqXWAxar49oRT9A1oEeP31zABOLPLlbfLiLOh2" +

  "pzoSt1rCbFx9obwfCWoUiBZbv4pLGNQAhNBLLDjqKg37q2PMNc8XnweHcQy1If0sa25lklgwdocZq3RIeSN6Yd5tkKfnN8ukghLm" +

  "eYnrNjZw+Z49Ffp9pa+tvESmxofH3E81kBZqlqxoVNxZh1UOOLcKVd2jQKM9+qyO1+euMIAKslW4Wh+SGX5VaBZJ0H5EXkKpuLYQ" +

  "fALS1gJvP3dfad968cpex7amyMuMcXKhEzXmJ4wZTeuwZrf4J/KFR00cVCCM3oEWha1uA0/rksVgfONzFaACg/Qs7878xGhaNxVT" +

  "5/m70tSltoK/EHIN467kmT2F48ZQ6RFY5BW+GHKSJdf7e7iJaiT0SfYvUYywaLWHdb3njPT0ls510Ek09DxER7AClQCsO1c8XMxy" +

  "wwCIM6je+fWVu0R/MIB6p8PAx9Xtw5NIIseCyGB6R9SI61sFZUKBJPVmQpsUDI/DKDcnVicA/z1FxwUqDvIJy+8xfa33ci3HBoYh" +

  "czY4RxCQoE+wqjEDAeHOCnSaXdS+995c0uy2UgDKZ2Q0IpRVZk+dOLU/9m7EUg3IzLv++H/53fNyMy7rqkjzSC1s1zjdYICiJxC7" +

  "0bV9XpkaOV0Vma43RUcZVEKRfAlbRRD7ozbsSiCdWBXdbqHFYL5IkY72s+vdDxrnUPCmb1Zm2wYIWCFeIiznC7zt/EvQpDSATr/e" +

  "S+slCI8dPYZNXmA3jWWv6hqpuQfC5sVwpAUgDOxFLipsmVHOCM+VOix0JjeE6pUCCJ6TogoHDtJzaBjGKrKNX3TOWOaI0WbC7hHj" +

  "zRL+f6WNv3b34ZPHMUPG2PC1pyPsXjUo7EJu31kBZq0k9GMC7Fn7IbqRuNrBfVCpFmpG7SERKWZwKnOaMgMh/E/UODCLchJ6WSko" +

  "01xhzB2VODQD0TjGgi1VnayrgDTVx211qtwreZWT5nyM5kWj0NkBlEQHZOdJ5VJilOxWB0Tr+Grgp9/X8xJ1FeA8XbfmBnYovaC9" +

  "lCYrXRbD2K/0peDJjjQWRjV+5Y5cUN9k2s2VHYEPNOwkxizRFZG3bPeLhmcGuK30Z+r0R6M8Q/3qwyuVDQE09rrcsVnSB0LZD4UL" +

  "P2u4vtSxBKeAZQWRrMYoaVRNadQ9YMT3uKUhkWkGzJljKqDBjT5Dj4OWltNyaw6m5oZN5tdtED17C3NKt4oMPHb0sXPR4OrFXFIA" +

  "MrllcKrsVRwAqvKHXdTjr7X+E9nnzMLUpMJHvadVFLqGG8Cg4tPPI+JR5KRHSsZrR0Ork9h5707v9ith26ZVEcv3LTE2csK3iNF6" +

  "5c2W12Dcd+QEACBn9whUuRaQwACy2lzoVpp1j4LCKg+aOUKrS4Eg8ljnoncq/vIUSflnyQAx+rY3ePSYdYkdl1D5dLnEGzc2cOne" +

  "/YMhxK/3SuKLfOXQQVDT/P/Z+++Ay66rPhj+rX3OueUp0zQjjeqod9mqtmWDC9VAHEPATkIogYTwhpA4gbwfL4bggENoCT0ESIA4" +

  "BAI2JISA7QDGxkWWJau3URlJI2mqps/T7r3n7PX9sdba5dz7TL2PC9GW7jy3nLPP3mvvvdZvlb02Ggu+QZzjuV+b45IgluBYtMV+" +

  "ZNKW5jXM3UCvKPztbAu2YJ/2C3G9hCAnqTQwLXFTUKC3kWkSYD3hTF9dGk2+PDKCrJ3Zk9hGP1ru2u6zaRUbC2LLtx9/4OS5BFkb" +

  "Ns/T/9on7Ebhy9nnGE4dgdWJzRrj1kqrr02P3J+e/z4GBqdZDPl7wPuEj8DmtF4WkFQr/qP1PpEOonSSKCm2k8zcuMHCoaYAYobz" +

  "cYdamzYmdxxRBHbWvhSgpXOfOfvoE2CWncxpawvKOxH7Guo3kNkab3FbujA6PuERk4rJychkY73BBUNQEG30UOcky8uBsURu7pNP" +

  "7Nhk9bobNBrwIzsPnrfAngsStm6MKfhwhStF/3uLwaclZSar8eGMGU7QmCfdxhOus4k35tdvIc5TKTEAzUyyq1yTPGNyOUHCDZUL" +

  "JRPqpsHF/R6u2bhJQdVpNvgkhZnhHOHoYAUPHtiHjuvIGfe279mkPYAY4U/JwvCRCXLC+JK2GuiyeWew0VZImCvGQlsTJs19jdga" +

  "uVMXeqoF5lqSoQtg1Axx2+atcOTgV0mZe6ZF5p3DrsXjePbYcXTDNthEcHken5faheBqUQ0mbHvE6oAIMHcJJ7cmoAKRwqEGx5pB" +

  "jPVYa6W5ahlQwCQZ4kIrYQFobUEykRYwsJhoIJTOpYmiK6VKLgiECHGrsAEdZbJrIfzlMXZGhbVO6B1nuQJgAyLZvSkQm9xbo5Bt" +

  "FTUXUaDQBMAlJQr/iRaeFARPAAKp1cFEwVoUYZMEymgWBToDYJ8HMAbLCMf5nPZ18rxjwA4G8xzAPSGpR69rK3qxPQj3sTHalqwx" +

  "uToeexBd4gG3JIAlDSBMMW7ytgV2Q2sRFQgOgpzQAnEG5jkqRDZHbN2F5HqttSfizM488QRwjZkZHF459kYAuOC++wr3F4cvdwDg" +

  "Ub7Bza8jkG9AXlkVIVohdEqxC8TLhXFC+IQ5MsffMgGfaul6oS2MFE3ak5FM/HYxf057UU26lpNX1haK6NECQdptPnkxA0xbyCUT" +

  "W8095Ao0dYPXnLcZVVXCe57ES86qmAB47NAB7F5egnOEJiQD4iC8xa0veornJqcbyeLz0AWo/fPe3AvS73BiGJCkGrYVM0aS+HtL" +

  "IBj4RIjypTBXYrNkhRGARhMeryfgjgu36q/TpaQx0Qdf3o8D9RAFFaGNNtftGFDmRl7wYDTR55cxN+sjwsIeMyX72A/DC+GAFtYT" +

  "HtkYg11rQh56kE9WY9TKDIViFQF7gjlPFAWNYuUk+jjHKNJHg4M2v1XoTtJiw2O9MsLQ2qkXAzwMhvcN2DcJCKLA2BuYsEvHKOV5" +

  "LTCD5Ha17BSgcDBR0H6T9ZfRIXkfvgvgG/mOBM7XTt4OmZfT5imxi6S82tZw0oYJ7UkFfNzZQNoHPwYAYl0RMFtfogUhzhEAAkbS" +

  "ejjOObnPhGJrreklDm5sTEAc20rt4GjWXTl2Um7cYSPXJi5CmMzTA5gSLkVEIQalYYRtjsKbLchZe2LuD0KgOcPkVGoBocDTZR4Q" +

  "nPcYkMfDhw45ALjvvvvggPsAAPe/uGcwrBnM4m+xTHXalziwEU6dEJ0HpKZgK50Uk0z5Y99R6GF4tYU7xw+qPSQCB+My52TahA3Q" +

  "ZJ7YWkpqLLAORjCTgp9WfwGZUI4xcowZOLz+wou0uumzOZtid7+4GzUKMHl4CKPz7OF9I/EAZs5mAOx0DigX87aNTF0+PgGGxtZJ" +

  "hLW5cijOlICGbauSUccmtq0CTwRP0cPtCbKnHQYEYqATICLCAyiIMKgbXLtuDpdv2LgGcRThybh3zz6ACtTsky2JSd+U6UunHYBC" +

  "gUrSHlV1laXofE3ntVVB6VQKzIytCqW/JwLrVj+Dn54cmArZ5sf2e6EmR9JYAiTPzOfeROqxMmNGAMtECdOjZK4nfCOKI80Nwgid" +

  "sjUcTefyj/cCrlJNcdrFtoCZtSTf2ZK3r+E4b23c7fcES6UV6FjZRr7Q4zHaZkKNcqEAIFhyjL+FQF2OtbXJY/pXANNrVJjZDmoN" +

  "8zkXvFJ8Si/Eab2alTWs8UATpTPZ6krtGi0/zAlKKlIm/mbze+w343Ha5kTpjcuVYMA1CvdcFkn0fvpwsy44XR+2rgOsCmAi/c5c" +

  "Uin9zAIeAoVBMcieGZDTMGk0rNGbmXkjAPz6xo2+/PWNGz0AzK6befOwaaxVOtlaQSSEkOygbdaYaObgQFmkoRapYAwofxI4sBEj" +

  "Q4qJ9tEyxafAIR+U1kBaw6g9RBOuS/tCqu2k9xkQMobtJwwuADNzEyAn4hWEhXqI2+bncdXGDQAw9e06DAmCWWxGePDgYfSKEvBe" +

  "TlFjO1o0mrKiGIqeSjvshpni6cEpr04FFVJZJhH9TICHh2yuoHA/AxkClv4X8PDwXgjt9QhNpWSY8GQMWLAICkdohiO88cKrQOTg" +

  "veVynxYdZb4dWF7AowcPYcZVAHykH1kL9T8FkVEDkDgaW6xEmibS+h/SSNuY6ToiBimAACgEnDl4FeqQa5Q5OZiRWQRtNHPqmkED" +

  "ZqchWwpWRPpm1i/ALB4WL4BgSTDAG9e6/sgyvmYNifMeyd9V1pxpMJHgyTycHIkyjSKCy0dhpdu4wrGs1g8De9pqp+3zPpmL2X5P" +

  "i19I5IQCAWesFcgj55MxiIAJqhkKUDG6hK12AXikK9jqtboMPE+/MCuA101QzBxjS4LFLrbQ+mXrxXqZ6XvpLzbHAk28CjQTjGq1" +

  "HZsdtKoBy8Drav1RvSZpRahRnwfoQoS5wUhdpswNinCtdToZFxiATNea3h9DS+Eojl/WBrJAxNXATmSuZOBP5bfX7cGFMF68vLx8" +

  "AQDgA7oNkJnpH/2fD1/clF3tZIRB2hxECBYDF9p+iglkhQnCto/KBLXwkGSbS3vSJOaT9ESu9vMDkTIk1GoNR4a5Wmkzw8DMEiZg" +

  "ci+DNdl6jgwyNW2adkoAMKrxhvPPDdsWp73X2TOjIMIfb38aDxw8iLmZOfiRnHxGgKY6DWIIRCmrkO88JYJKL2KwbP1zpIcmpZA5" +

  "Yd3CVeX6RGCF68ICAogYaAhEDv2ylOvJ0HgU/hZBXwB6Chlj5Ambyw5ef4FYUqa97dkzUBDw0RdexI7lRcx25lCrWbsAqZat8hYm" +

  "uJM52eq2bSsSqmrgUFhzpDsdoq8P5BMaQHutO/ltPKJUgVlnQDp++pohhy45WPKWWp+dzro49yXmIRVIkXEriE/HNVQg692b2d/A" +

  "YwL8ravtYszf5kmwZkT9d6qlkcpVsaAYaW9jE4CmCfOwiAMFYrPsG+lB4KE2ECxR30ZrmkCAie7KBEHJGBOoHUwahJG1RHlpsMRM" +

  "n3aA8UMBQoXXueNjhLyJtKDIhfYhmQDGT08glLXIscUNgAIxDbyBaeFBRvFMToR12KZDfCYpDw50BhCSC3mTMSnQs3VustDDRSwc" +

  "wgIYytf10Q7QPCzJfLI1loCP1MrWIkj4I759tX7YYFiUo80/TueqBzO5lcEKht3yWmbeTEQHSrzznQ2Yz3dFddNoMEDJ7MiVSjen" +

  "yMyHjoQQL2qzjzhomUBufZdeJ5oLrIlyD0dBm/FNRKLkKHL82WNgo1VP+Jwg1Yg889+lHQpkrA6OnxWLZjcG7QgtrMGaKpkJmzsV" +

  "Xh981tMvlqTp8OFD+LpLzsVcpy+ma31iClqM0cvRqg7kNGrWFTF/I4mAjupgRKSxTjF62hazAJRMONmisrWpE9lzAxBweHmIhw4e" +

  "BhcVSgKYYkChs5XFUSt0BCyMBviyLedgc78PwSXTpaadC3Hg0Mt4y5YNmOvOCF0cCcVsHXBwiATBysniF3IbY4YKBcREUmSjwgE0" +

  "5HMVAJwoIGCAXYw/AiAndzhQEY/IZc8YeY/lUYNnFxawZ3kZnaqHwjvd1qbtSk20FPcUh3Pik26kkDD6fxMfpQFCjtgwM1WGe/N5" +

  "nwoK1mxGIXBuVa3nzEvjPXzT6FC00wBp62xoDMwap4b8HQMmHMFajnSS2lUmc1gYrSpWaa/RNQrQXJMUxAc7yTzU42n6tANEwWi8" +

  "R6H82nPc+hrAh1lHW6UtjKVPPhl/A9PpNT6XPyyymQz0JvMngu8EFSCp2xTWFPQlfIO0PSZzxOLmA9CWobNejK/XaDGjFJu15ovd" +

  "EBeLNNVMKrE1Zm0KwoSoNRdXoWyQv5HhMoCF0WjDE088UQFqAfj4EztxdGXQLYoSRJwILRV0KWGziT1eMg2dIonY+7CnP0M/RIin" +

  "wjA4sTVTm6Kh/lzAtwOK0vftqNCxZcfxaFnL5NWu26Iwo1BPCU8BhBHSylMGa1QAyBGODWu8eet5OG9mbk20/9BSInzPl3zJ1Ote" +

  "y3LXrt34yUcfwgAFKu8w0i1vuaHBgdHAg+DqBl+xbZv+0BYrZ1+Mjv/4zjdOtd7PdTk6HOB9TzyG/7VrH2bKLlLzZFYCANe5rm9j" +

  "dkESQUeEVDs26KKsUlyFFAVXsJUFjUrqEhdDdCuKMseQJDYezOWEVmpWyFUUgVMp7DkEU4acAJwKauN98mME+RzmBLS/LbaeUAJB" +

  "C8xATBDkEVzb3E2VEWlGsPdAkz3CXGHGigPtCJqLQzJkSgvbJrEUyp1FsWRUYJAHvMaGZ2ohJ3AvWGdNOCfEUBoHwqgFzASrXGZQ" +

  "0mSGWLOMri4RyjE1sNE1CZTjGHeSadmhnghQI5CxMTeHgzB8mfc+tMksO8HKmxWpK+B//a59XdgZgMjNTO6GYMRJwDG1AqV9SqyA" +

  "8B4lwAsjj8eWl7cA2FMCwPbDu9aveJjqEIYnRVIU7BuTBWnWESMc59+ZiSgN1Er9RD7TmMYDKdKnBeai7ZwUk4DWZ2NUKb4hFIDG" +

  "+tIE4raBQHIrqFXXpGIWC0koJuyiw4yvvvjiVk1rU2yyTyo04V0bp34ui2fG6y+8AN8xWsHPP/Y4uq4PybeHJOGFCCBHwIJvcOPM" +

  "PG469zxhlGsApNrt+2IrIjQY6ztdfO+rb8WuxU/is0cW0C+78L6ebJlzDhZ05ApCzYyBt6h5CGg2UjDCtTFAU7NdmiIThGtQKTSR" +

  "iUZIBD6tQhCMgglDeAx4mIV8xa2RjJgc5kzo4jEghtNkQ0HgAAgWLNPKEmsJmWgP35mQQBAytoI6RYmCgMZH0CDC2gCUnHjIXt0c" +

  "DH2m8C6PhCapSyyhEyvBU/ckE1B4wlIzCibnSD8TLW5s7E+nMAMrTQ2PEiVLSnTvEwtcG2eQ0s3Hny2ENAWJZmlXHJDQM/J84QcO" +

  "BTl0Cwdwg3isfMqjFbCZNaIl7I0eq8ayBa08FgNe4zw7WsFil0XmWXB0Zg1J5NyY8EjHJbTZ6k0WHiz4lsK8yBRgR+E3lbmEhuvO" +

  "+vXlUVe+FsDDJQDMbt70utmGisXjx2p2rvQQ/2aqdtk+Z1ZTDWXNmFyCKWdCx2SAo5AeZ66sWnVrUCcw4cB41LoQ5t5Es1D7KZbs" +

  "yKLMcZKFoX64sTFbJUjDACMEMS42DW5YN48bN29SJL9Wubrj409voa/mkVv7wlAQcN55eN/2p7CEBhk/IX1HckBPPRrizZduQ+VK" +

  "MUeuMQBYa4CxFsUps699g9IVeMvW83H3/seATg/Mib/e2IsqAA17UOFwfDREj2tc3OmiW1QoCLqNyYpG7YcE14nZl1kZTwoqY6CY" +

  "vEc4g8NMyd6LOXngGvRXBkHWMvvAD8563TQNLimA9d1KXUeWsY1C2yzkLNDHVG5ji0TiBZILEEMzHBoA+xaXcaxm9KsOwA08JPCQ" +

  "yGHIQN2s4LyyQtc5FI5QMkAumo3bsd7Cf1WoIJr3HVzkO07FuwMWOjUu7FpOkpyPnu1OmQLA1Z0C1OvAeahLzHhuVMACMFSztQOh" +

  "dBo340iBlLkbKdCSnIuJe4hA7OUZzGg8UDNjYdhg59Iyqk4lB3cxidDLuqpWppagpZZc0MfKqBv6SKpJvBpBkqfxXaEuNpllyX6E" +

  "9iIb9OJUW0+C/jJ8EIDIOECQa11Wj03KCBDlq+Bh1A5QASyD8fjel0eAugCeObi/GLoOHOvJY3a/I1iEYvTJ5BNH+peYWPRzTlgO" +

  "QtB+EzrG67OOJJEBMSbdhEAeYRofEgXXCcV3Zo5L4gnM5AeZBKkpBpAo/WiCsSsnH/yQf6fPcwxQgWbE+PILJfVvw4zii0+mrFmx" +

  "KOmZosJc0cFSUyOQOVkgHowBAeeUBd508TYAZ8/Q/voW0v9lTW3o9VBC0/Aqg8i1b2HKriiwuLKCN2yaw7ddfQ0uX78RhXN6gCe1" +

  "VuU4T4jf5u/kr0Xej6+XkLxIwcCgbjBXVaFeq+HEqsfqxUDcbRdchPedt1WEEeXxTMZ246fkCwayEzOVfyhZ5BINat67cBz/bfsT" +

  "+It9h1EVFTwaAQcMbHTA37/hety55XxUBaFwJShoc8bcOWtX0EdFmmSaZriWIv1ZB9hCKoMfe6zEKPS88JhC5FQjv3TTBvynr3tb" +

  "2L0U7Tvx3sBWEUGAC21sXR9cKkbWE40tA8xYqUf4+O7d+LUnHsdCU6IonDgGFSiEsEudZ2OuW5hSG7+L/bV5GFMKCz0YlCV6C3aM" +

  "0GewWW90rtt60W15zMlkwuqCXh5quQUaxFWn13NKdQfwuDyasEaobjy2blj3JQD+i1gAiv6XrwwHIF0d0efEcVrYOkg09hRFpZMx" +

  "mCKC+TxBXFZ3CyTEPtviRvybwa9x4d8GBCcSBpMtCLaoOXwW5Ogls1xmWvFgdq3745aVdGjJ6iIZwgE1uLDTwVdcJLswvhg1yrUs" +

  "FlBJRJroBsG8Gf2oDq4AFlYGeNPmc3H+3CyadLG/Uk5Y6noE9rKNUZJC21z26p9kkHNYGNV4zYZ5/Js734BigrZ9MvE76bcxgN7e" +

  "ZhxaE9dot5BTF5gbZIqBaY5naAnoFAU6xQkydp5yCfp59h2BcMH8evzLO16Dlz91Fz5z6DhmSofaEbq1x7+65WbccO65U3j+as3i" +

  "4PoVHGD8rdSf1e2pVgUgAphYhblbiqx/Et/h4MpToN9pLcuU/0bez0Ejj4iCyKFTdvBV2y7D5pkefujeB1CjEuWN2481fz0nndR4" +

  "FZ9aYSe7nduyhVl2HxBRoGvQ4NmClJWX6f1yKmtMgMRBOKjcTlxHlMgRARE+k7XmLrJ7UnqlLvV0x54p6U4BxdJwdCGgK+rASj1P" +

  "6cVaAwEZY02jhdsC3R47Zvox87zdmxEy/g4lGgNgssNh0sZTenM2IMTisiD9LfWFnCyC2HBF5juBDwPYNs1IsbO7874YHdInWlMJ" +

  "hMFwiNdfsBnrut1wtOorJZZc22lQI86z6CKSrIQVGF9z2cXx3leIecISrCc2T72uPf3riVDrVwyAmwZfeck2FORQ+9waltY3rsOf" +

  "SatiMWOENM3rXn37tZ30hREyL7Zep1LS3UbtXqQqyKR1nfehJW5IhEPtGzg4fNnFF6OuRyCUGNWMS3od3HDuuUmCIR57zsle7baN" +

  "N8vED+n7ImiupuDYeS7j27gjwBKe3qI7WTbYlGe22zL50+p0lDaZqzSiF30brCx5UHrDjFu3nI/r1s1h0NS6EwG6v76lqKkIEZmd" +

  "ZCNM+22m/1SQhkZE9Y6cBiQyB3nBnlTomtbPQTaBEWSEAURQ4m4gHp9J7EQWJqIvKtcsMTbRhBdogvApBy4WHOrIYdfC8WUAKB0R" +

  "Di4tlX6mH/pniYAN5ydbLccEKmcPNaFpA2UJMzRaNtqD4oRLhKelOLQ/YbtdAoesijAULH6WwnQSjoQ4le1DacyAgZd47yQ8mPU8" +

  "/53i87WbZtmCd8AcCnzVxRedtE2vlMji0i2dDPGkLI9qvGp+Drect0X0k1ek/6mXQE9oUqB8Xcd8F4w+lOYJ2B8v06W9gXh5f/I1" +

  "TFnszuk+a/V+jVkrzqAYj5utOihQgD1h1ADryhJm1ToRZU9a/2n9litNCQedcHUOCFjTgwd36aQ6T9KCU+3h6VBCeiFzdFNZgf0S" +

  "uOAAGMJJhYDIHBXMEi/YBj0qvxJlMOwamCBTJPIfSJN6BVcMpbMnV3Kht4hbXCNaJuyVJILmPcmBllUbLeytupN1PD60Yu1omhq+" +

  "pPOYuXKN9+fM97q3DZZXgBZkEpMg5cGVBINQYw+1i9Kzm4OZm9pYK7+XIMxdNHndCkiEPO1hnLjjiD3g3dw1QfZrbHqhT3DaN9J2" +

  "hujktnsisVSMRVrqbzIWcbuIISYmMbotj2rcfs4mXLt+owYCvSK0Vi+W4lbo6HRc4AHvHJrG4yu2XYzClV+UkfmfjxLXW5yz0Fzh" +

  "Y1tnAbBnNDxt8X665cRPjyeSUiLUxvSoz2ORdhRktBaTc0lqr/ycTt1JD+MJAGv8OqLilBWqz33R+ariQZRqr1ZkBbRECEfuisYK" +

  "1kRmYzYlE6xJf8fyyRABLCGLBopUxUU0odmWxQl2K2bJkGpb7pPcKvpGrrf1l6zDEABo4KJVxjBa3nAQ2A1WVtDvdW8CsMktLu6v" +

  "lvyom+JBUIL2zDQRlbJE1Gq9eX6XAHiCycOQUmKe8Cdao8wI5zCruYmYdAuxplZN+k6I8Qom1F14kR6iQkHQh/2obPckB60oUgkm" +

  "fQUDFucwyW+fDhJpW4VCYrFoHKFDDm+/8lKpO+ger5Ss6CTzrNHjIDvlFoBDAcaAPS6emcVXXHxxpp2+Uk5c8vUN9WP6sXlokcyW" +

  "5OjzW1blZKv8ZqbrLxRBJe0oiEDeq17QoApKzFq004S62FRNe5eXD6/YPnOjxJPpWuIqqRPhGm4FnH3+itDSe5MAUjiRmmaqD+bY" +

  "tHtqETB90xJ/CU/n5DIKZqbU3x8VQoYc/sVBdlggYDpbUxniW25ks3Bnin3roIrobp6cITMFNWHTQWLBI89wrsCRYdPs2/cs3O9/" +

  "/K+aI4NlX4zlUCVIsJsLlQgwikEjZupvF0oePFFfD5BNiWhmmczsZH8VVZGBAvNbuQRUULg2M1YEwZ3Wy9nf9vcGrMKAp/cgWlVs" +

  "AlDr/syUSkCHCEu1x50bNuGWczZLjvvPO2P9wi56jl62Z9jDgwvCaDjC115yEeaqrmz7/Ly29IuvREYG2ClmQK5hBLPY51GQmqAi" +

  "coHvTLom4ZRfYMIfyNi+HrDlOSpMa10ii/OIgW751mPhkRadLoGBqXCPwr5N1y+Uladauh4eFVy3bIdjKe0JkFSJEl/mmBMlkXMw" +

  "POYaAMxtbUqet2OeyLT/JCDV5B/H+8NR0GaECFYrvSaYMEgPDYpg3SrlpL4TgeM07XSsO8rHwhGO+xH95XPPwW277tVf0uvPzjdN" +

  "46M4NQgSg/FS3wepqcWFtKSUMY5ssQYBHFCBWmEoOfFNkI8ntQyEfcMcMlplYTJ61Klp6F6jJNnZZhc94attqkcCCogmM5WQ72Ac" +

  "IIReTAQ9yXdKOg/pT4+Br798m0GpKS0dP9bGL/6iyBiaM9uZWU0OBlphwvmdPr724ksAyN7tV8rpFecsxmX8t5RhjQdIfW5LFExi" +

  "o4vr12WvCP7tvjxi/fNZUq2PSS2L8NrGtXuquUOERkIPEe65Zi+nfqZ8Mo+3CjVSkdAbq/LOz0/R8SfWnAxiy+UgbSOv55AVQ+2z" +

  "bDIuV/Di/G9RTGWOT+ciOICKcAFM2HJ2mmMQ6hzlWdxRymo5liA92TKoinER6W7rIZ37SQtFPWaCm7AvijQ4YlgP/dzs/PwFF1/+" +

  "RndgeXiOL4pCAgqDzUQQj/LX4EeBCwf3BIFveITUd29BEcHcbzkCFByEjiR1I5WpqQk9uZYTphX2yFoGrxj5L4SmUHe+ha89zKsU" +

  "Mz/TOEobS9jQrpVjTG8BwkLjcevGDXjVuefAtoNMq3zBrMEpFzmpTQ+j0fnhCBgNh/jyC8/H5n5Pt5F+vlv6xVfE0SUMPVsVCqCF" +

  "vUCsYJ9XQTpuDYxML7XF2W9fSELJShSsgAEs+pzP2zQoLYIPD6JgLNbrJt7d+vuFWqK2DyRmb4rR+KJ8yvbXaL1OUloZf58Q4xXU" +

  "31QRNBHoc6tz+reNtFmtb6LnUshwCiDsDGsrq/Io0br5BPNHmmpuHx+yW6a/gwBHxEyF23tsZb176eV99aCuEVwjagYg26KQOjF0" +

  "S0IUzJPMGK0OALCWJNb6YAWIa0TjOVvmpii807wDnGyPoICWrFC4I37IIzMJOWliSV0G7YA/wJjjOAiIvjN5SWYxB+dHePtl2+DQ" +

  "2mZ51uULfUGefjFa18wY2UFXEEvRkBnnlCX+5uWi/X/hMfsvjqKzU1wsGuzUzmFhjO0Lxb4SrQFAuj2tdRXSkwe/kIpYJJV54/MH" +

  "VIIwYYZ5VtMyid99sVgaSRXHkMGPRGlQ47zqwxziw850CERA6weOKd69+Xw5WhfGdhkkNnzm5KAroiDYcx13QsB5XmP2m60TAXku" +

  "YuXsekLJDsPaY9fhw43bc/go1dk59vbQuEfUOh63K4imz3qKxsQoyYRiUaBSwBP6hZklFHlRfnpS26+uBLEtzGycKo1QnFDGUNkJ" +

  "romdnXxdipljcE26fURQJYOx2NS4YeNG3HLuZj25apoL/wSNPMvC/Pla9IK0BzzCACMxt3k5KXCh9njjlq24aHZOdlF8Hlr3xVyC" +

  "zswMOD2+NFjs8u1PqiZ8gVlYMlg/+QpauzVxZiVqOyG4iz4fdhXT/HMaRpO+G/utHV/xhQis0iKcV88JJQMCYiWGvptkNAcShbX1" +

  "O6VjlViYTV6xyh7W2AI5vdRyyGAMBEQDuynVLZqnzwYMLk60CORX2rkOk3soYF77z+ImaDxjx8FjtTuy0uiBEZzVGYwejDHBHEFC" +

  "TkBrZPZdgozG0K9pHhwTDtk+TYsPWL3TMRgxUC+cj2pI7MQl7bWZZuyHEGHJ7WkxXsJghWd6FHBAzfibmkyl7TpYszIFwf35Mqc2" +

  "SqM9C8dxvK5BhfovwZh3Dm+/+jLEpfpKOZ1i5sVD9QiNKwBNChMO+bK1SSSpVBMe8IVRlKGvqf98uiXy0KgYEH2h5aw0/taSAV8k" +

  "pv8gVC3fDJkbi4J8kXnDCWskMduzfXK6RTD2lRGTZmUliQ2w+Im4rZbDNRklg0xMlEBzJZApxcbZXFiH2tLcFZDx95jFE3qMcKa8" +

  "Jcb7YOFT3b7xHnPdzkXl9dsufsvHjy+LgToba5u0HDukDWNFEacjIwIqAmuQgmQfK2D+ew3k43Y7kAnPNF8SpWQm+UcsFRzPGdDO" +

  "c0LIVbXbMCHi+/xD3qbwM2QbigAjAjnguB/imnWz+JKt54LBKKZoTw2BlwHhxgnG4CkkxmlrA/LXo9FtMvq8kybgPZHWlv4mC7Vy" +

  "BZabGr+z/SmUroTzDHaEpUGDt59/Aa5av37Njk8Wa4O4laxXDIS5Y3kiwrHPZ/qc5BQ5z41NW/0xRmTnT5HPkSW06UnJ+hqnOhFQ" +

  "OYeFpsaHX3wJVdUR0E9xXadPs6ClLzzWnzDoltJCgZBfeK32eoCac6KZ+lXYz1qXXCM1WqXafTr/4q6BL1S6psVcWmEmW4xQJjjj" +

  "OrIZzmpNzNYNx8RjQAsWteRHUPpo9eDxSZ8n756joHCn7Qn5gFYpRBr02FKwQ+xM6APZ/2Awtp6z+S0lFcUFstc+pULOnH24SQP9" +

  "SAPdlIkE1kTR9zHWQYaaTKDIhJKG5YRtBy/I3voYiCEdjZ0LZp+UbEGzQQwKTP5NboYJoJyolDGZMClaZp0UCHAAMA7DUY13XroN" +

  "lStWPffgzIssXNcy3ZkJNJgbz7I0nlF7j25ZwsOj8Q6DhuEcoePopOI/b+9JfiPCvqVF/OJDD+HBgwuY63bQ6PHR65nwt6+64my7" +

  "c9IWtrfCkrbLSgSiZ0NcYTrOORRUwsQtw4EpRiiPt+5En3N4kF7VgDHyNXYcW8T7tj+JJxZrdAuXiPhkVQXtSaKbT8GI9jkseWPG" +

  "zf1fgJBFGfeg8eJSgbR7yM3nxbZCQZlJLSnG0woYDYWlfXElKxt6ky2puCNl7SZ0Lapdrk1C+7K1fqJ+jweUR40gTUpGwKrCvq3N" +

  "56DMB1A+QRfO5SRREPxx7Gx8Vdk1uui4M2sgPzm8vLTky4XRYOQJGnlPCZIwTaV9PMe49pESZzXiGaIK0ZiJuSQjxoQnhCQO4RqP" +

  "sE0imah2WepS0G5HJAhkwRbWJ0ctZNdqRxpHMB4so4kfGCiJcXw0wK3r1+NLLrxoTTRW9nI05lOHD+FnH3oAhAolPBoivGHLOfh7" +

  "1994wrE4pWeAUdc1fvuBz+LP9u/E+fNbUA4LrNQrGKIBigIdV6IqShB10Pgm+MSENZtAomB+slwPhkBtaxETUDvC7oUlHBgOMNvt" +

  "oGnkONql4RBvv/B8XL5xbbR/A2dHl5fwH++5G3vZydRqPAqNbzm/18F333Y75qtqCuCKUTcev/Wp/4O7D+3BefMXoh56jKiDunBg" +

  "NChdB1Q6NLbzxek8ZyAe1ZU0QoWL/I3fe/ZomLE88ti7tIyBc+hVBdhbIN0EMaSgvkaBoyt1RiMrbQvD6ZSxdXWa90cGl95twFeP" +

  "Nj7FWABO36yBrJNj1YEDSyuoieCJ4QpgsamD7p214zTL6Tc5FzRRkUrz/SegMIkJOZt5L9W0Kzgzorfnj8gGj8PciNuVwgOzuyzG" +

  "RfjR5L6cDs8M11KklYFoWBtTmWMtaSnJqR0r2BxMYCdWiDE6JPXEwFiEfoY4PkrbJjLTe5GPi8MG5VIzJKISZlIWCWqPcWMPTfqF" +

  "dNvgyciWuCXCv44TQqVm+1W0cYtWlvnLWROzmATKB1P3F4yZdvL2tZ7Jdh+PXZNaA9LpSMzweizjt1x3lR75GwdnakUX7X995CH8" +

  "1a59mO+vA3mPuiB8ev9ubJvv40suvgIN+4knuZ3qQzqdCu+89TY8/leH8Wfbn8e6sgvyHp5K1B2HotsBoUJRlGpuk7EZSyllgMtM" +

  "W6b0IwIFENApK8wVFepG3BgjYsyD8I6rrzzDPpy8MHs4KvA/Hn8cH3hpN3r9edTMkjELAJeExeVF9MsOvveO29H4sz3CmdCpKrz1" +

  "5tvwkY/8MT74/F700AeGDZpeBT9ToECBiipwIcKeADl/JUw1r0Q0Cup2SbOsMWuQn5idnXOoihIziGdzpGwnEgPyEO/RLRw+svsF" +

  "fN2V21A6FwVACySv0kWsDjBS5qtQkE+sdYVb2YK82izChz6dmvAXlix8NqXlmZQJdJTGonIOR4cjfGTXXvSqDjwY61wHzy0tY+fx" +

  "Y9g2vy4KpcwyGTW6qDWFH0P9xtxPN/gxmvnFZWnv8/6k1+Zno5xekZS3AmCtPxR4fez7KcDKVD5C+u6cw6d278eLiyvoVV1k+/rD" +

  "JHFBy09xo827IPdaPnwen2hjZv4AjltutPB8SnqYCm1MoqYC2JC4KOttaHNaf3vsOSgJrRLknuShYAcsLq+gXBmOwFTBIx5OYUMz" +

  "Xkeq/RKIVifOuNmD27TMrQCk/tUchE68njk5L5tVs0x0H9bmczpjVplXnDw73hwZxGrTcRIYcM7h2GCEr9p6Pm7fshUNs6DSKRbR" +

  "gh0e3rcPn9x3DJes24zGj+CrCh1PWKnW4zcffQq3nX8RukXnjJUbAuA9sK7q4N+++WuwfvkT+OCOp9GZ76DfKUBVHygLlESgsgBr" +

  "xjYm8am58OQEhNmY6E/xVwlg8WjQqB+cHGMwHOFtl16Iy9avP0swM7l4ZhSuwIvHj+J/v/AitqzbBDCjgQpc71EyYf3cRnz4+Z34" +

  "+quvwIXrN56VNkQkmb62zZ+HX/mKb8UPf/Av8fjiAG7WoehW4E4B5xs45+Cd00DYyLyEJ7mguQmtVdMwIO44WF2iFtKAnZl5x9vE" +

  "3sNWv/eM+arEA8eW8e/uvRfffuNN2NjvyhkaqUskqY1b342zdxU4gRGxnJbngd4pHssr60xBT4pbNN0tlBqnUBMa9hh6D3JOCKeW" +

  "D6kvXql6soVYJTXYX1n7qU1FDqEhvHBsAb/52ON4dtRgvipRc4OKCMd8hZ948EH8kxuvx7UbNgHEIXGL1/vZLD0kdgQKB9sYfxWh" +

  "5s7Y0pcCL3uy9cyAWTtVbXI3p9kFV3kCe3g/wqD26JYdeDQYkbS9SHrsQbn5XJl6dFloKvdEN2UAQ3h8Ztdu/NqjT4KLSnLxtK4J" +

  "XQpAy1i88n1bNC1+3l4/ACbKr9Scf8LdcBMqiAqtAQ1SudWqJ1U0OSq4VueJ5G7YuZBRRHjwStOgXBzW8L1J2xbGJ1V4qHB6hIlC" +

  "yA7RSU3k7W0QAXWNmWl0f6Y9WzvJLPs5DaWP3Ue54M8OLmr3O0h0mwh5PutJZv0TBW0YemcdlBEYM1WNb73mqvC4M1YsJpTUZ/W+" +

  "x7djyRWouJGMg0wYgjFHJbYvH8ef7tiOb7rm1QpC6IzaQU4YZa8Evu+rX4/FDx3AJ/a9iKpYhy71ACrBLmX9cbcIQ1C+JOHQ5FFG" +

  "EI0hsXVHmqrUUUTvAwAXFRW++eqrU31tTcp/efgRHKYCMwwMFYRyIwvTA+gycMgBv//44/j+O9+gLAs4053yjgiNb7B5rot3ffkd" +

  "eM+ffhA7uYt+UVpsfhBo7AF2BgBsvhlFDNNzOMPCB4AV4VURmJTMd+fytZSte5Z1WHODfqfAn778Mj79V3+FLf0uiqJAQc5O4wDD" +

  "ThP2sAN4maOgTLC0BMJ5BthhxB4j8hgtHse/e/2X4qpztpyWeycL6FKBcqoT3Pp6aOE4fviTH8PhzgyISI49Zj0gxlmedskdVwEo" +

  "vVLci/80sBmNgeJkPFitCodXatQoUFUFhlyjADBij6os8PTSCD/8mfuwpdcBCgrH2I7AaNjLeRgA4BuAHcCNPIUKcZl5xlWuxI98" +

  "6ZeicqcejRNpxy0B7lrXADJHUgumxXZZHR6T1wCH5zTe4Sfv/j+4e+kYtqCHvnegXhdEfbCT3Ai1JzBFy07Yt6/fEYDCKWQIZnPC" +

  "svfYfXQRRVWhdCypwYOIsvlsVydyCKTH/iYZfJDkf9HPKZRIt3q3ffjtHXGrAbJUDJkiENsYJF9ypf5MClBVdmW73hOwEr42mcVR" +

  "ZqTgwzHcaDjClrm5G0pP1PfeA+wpJtuIiyuQh5IGZkI2ffS4wEwnE1Ekol40CVZl3Q9+FkYyCFZf1u1Ik4SUeqV85labwhwZByPt" +

  "Mmmw06cSEY4PVvDtV1yGS9YoWt17RuEcPrzjWXzm0GFs6M5ixCMQHBw3IFdgyCN0Oj383tMv4iu3XY35bj8KiNMsBKAgh8Y3mOsU" +

  "ePdXfx3+vz/+Qzw0WEZntgQ3DbwjlEQIOMC0PrJDLyiori5oHS4MW8pPZIuU+P5HK0N84zVX4Nz+zJr5/h0RPvXCC/jInn2Y7c2i" +

  "8V6ThFDQDhoHrMCj2+/hz/fsxzuOHsbF6zei8QznzhzfOXIY1iNcd84WfN9b3oIf+8u7cNQVKF0H4AZcSF52OxQrMpUkujlhNh7W" +

  "bgcyYJogY9Z7orKTMIRUgwjMUUDabNXDYuNxfGEY9DVvIk9lQ9CodF16TR7DSmf2PowzeclBcGhliG+55jJcec4WPR/j5GAqrr34" +

  "NyoUp5i3QC8qywovDzz2DlfAcHo4Gcl7AJ48iqZBh4HSM0qWbb7sCOwKcFEIXyKvokNsBMYfnXMoigIdcvC+0ePKhV5oGvTJYYQK" +

  "O5ZGKDyjIYAbL27EcKCMgopG9pjD6/kIYBxfWsG3vPZ2dKpKBJ87tZlIZMLMrC4pCDTXgGn3DuMphFPBuOpTAMiBXp2qwjfffAf+" +

  "z5/9CfYMu9jsHbgYgCsPcpBjkp0FmgvoZnCYDzYrZNh0bhtQcA7dygGowT5awyxTrcmBEEOWFnYANeGjRd4HrS2RDUTtbYTWplwh" +

  "nfR+YuD4RAom2/Taa4GVEnHxIhCH5WvfqpR1PRovTr93BKqHI/T7sxe5+W7n2tFwCGpt9R9bTEpQifOKC7xFEQlYopwYEvDAkUfo" +

  "X06IbP+Nl0h4m7xjV6gKTuGg30T4K4SU2qeb0CIFRStgXFRV+NtXXh2AyjQLswj//UuL+PVHnkDRnQG8HpVLJCeOAWAizKHES7XH" +

  "Hz79GFwYizPvt3ME7z029Hp491vfjis2bMVRYnCp+fhl5QXeQE6zcDGrMIqL0dxMjuQsCTixNJBTiwEVGNbA1XOz+LorLz8hoj7T" +

  "wgrYjg6H+M+Pb0e36gNehL1LpDo5J4zVEfpwWChL/Pcntif60JkXIqAsStRNjdddfAm+53V3wNEIddmgrhrUpQgbR0ozDjgKpICr" +

  "IBfGP52LNufjw/RPoh2tureYdDzIwTEB3qMkoFuW6BQVemUP/bJCr6zQq0r0ywr9okKv7KBXVeiWBfplKa+iwGxZYa5TYaaqMFOV" +

  "mOkW8I7wmo3r8c9efYsyqVPWX9EWRqb9n+4UKQqHbtVFv6gwUxaYrQr0C4fZqsRMVaFXOayrCOucwyyV6LoS/aJCn0rMoECfHHpU" +

  "oocSPSpQFYROSeiUBTqlQ1VIILVXzT0eda4BaWpdmHEFumWBWVdgriox0ynRr4Res0rHmU6F2aqLuaqL+W4F7xy+6uIL8LZrrhUf" +

  "9CkKfyltawkhB5g52ExpnBYDCKsV0kyotW9w7frz8ZO3fSU2DAlcFqgcoe8qzFAHvcKhVxTolSW6Nq/KTnjfrSp0ywqdspI5WJXo" +

  "lAW6nQJV5cB6pHUQ0rrBn8hkTB6vFa3T+ZwPwj+bSCkfz9fM5D7TmMBvK44i5CfJMQGxk7LFhN0MJtGtn6262sHprdQGoa6GxRo7" +

  "rEdwVVGdW9c11NAeb05NBolhwhuxQlO9ojJBfWELXxsdmWYIwBcCEhxbIyPzOrGYsgGQwxdC0gMigEQ34dYAGVF06SkRkywQVvMJ" +

  "Bnf1QWdlmAWWByt4x1VXYH23G/yG0yymk/3ygw9jHxg9AtiJ6ZII8C5q2t57zHY6+N8792DfsaNwRDibvccEh8KVaDzjknVz+P47" +

  "70CnU6PulnBgDF2DumB4x4DzcTcABUwIp0zQdpuYRSYGBmlqmgIY+hH+7lVXYKasEHaxTLF4L3P3vz70IHYsLaNbVPAkpnJleTof" +

  "FNuQAzxhXdnFx/YewpMHDqJwud/y9Iuc2iV09fgb11yBd151Po7xEoqOA3mGd152JKSKr6W9VqANQrBapEw8BQZMsT9tYqZgwCwf" +

  "tuIdkWpUls42ZjrTs9DEqg8k30QgLz5OH9C+h7h2+k2Nf3nHrehXVQBjp0QxzWaXCqh4vO3pjYUj6dMIHsRerSkOS8MGPceYrRos" +

  "rgxwbHEFnlfQYAVNI0G+4iIwLkRoVMvkRJKwznWn1AzxVVkz7T6AyUfNVdsTeKyZTxwwohI95/Bdt96c1HL6K2T8ON9U6KenBeoT" +

  "bMdOsB6d/JlEDgWJu+stl2/DN155EY4cPYIRCDXXGMKjJoQYAE9ADY8GjIZlrnn2YhGBzj1SGcQUwA+Z9mrWu3A4nQ/2ihjs5wNf" +

  "CuAHIj8AU3Ctj3bNpKA643GRDmENrKKoprWOfy93g4D28cw+XU+CIKT93qTqhBkwQQ7qnYEmA+/hlkYjNmFNyYWpeYNVsIfKTKNI" +

  "OEqMZg0kRUJpRNN+a7sdI5gsra62uaTdiYkEZENfk9PYMtuasudw6/fJg5bRYcz8Lwt7sRnh5tl5vO0y0VjPPhFPXsxc/eHnd+Kj" +

  "e/ZjvtNFo8gXLHaPsAUGQOOAPgj7a48PPP3U1DTowhFGvsEtm8/DD155M3hlBJQeHYiAJxPwTCB2AEkCSsc2H9rSXMfbskoRYWlY" +

  "49ZzNuDNF12ARsxVUy1eLSkPvbwfH3xpD+arPhrYGRfKqLUtpsUQHLwjFAQMqgLv2/44PDcnf9gpFAFI4mb53mtvx9ds3IyVlRp9" +

  "KgBuRLtB1PwDsGIjp0T5uwBxx7XhuE5pdQ4E+ZnYTgBVcBZZaNBeRBapp5bib+n6d05+C38JcIXDyqDGP7j2Oly35Vwd39MdYNM8" +

  "qfXd6dVjwIiZQc5hhRk8bPAPr7gEv/2m1+N3v/RNeO/rbsMdWzfDjzwaHsG5Bq6RoDwPD8eNWsB0vgTGiKBPxZ1TKqgQx840RdJx" +

  "iSIn0k3mpCaiKhyWmhrfduVVuGr9prXZYsyW0IwTXmpgwRQvVtfAyYv12/sG3/Ham3HnxRdgkUvUrgQTi+JABFhchYmMcH4MhaHN" +

  "4tNITryD8hydvNr+qOBJ0LGCPOsjoiyIMTVtmTkBLae/mkuoZeleTY60aTL2HdqzWAGgzZtgtNArLWkY5XVklobWM83yYRB/VI/g" +

  "hr4JWCj1L2RmDNOM1JwbAo5sW84Ju5uYLvQZCmIE8ToCChePSkw6YddndbU+p5MimN4nLYpU+BhShPnuVkFLLfOKaVH2PUMixstm" +

  "iP/nxuvQLcopOhik2CLfu7iIX9/+FDr9WVAj/SwgZi85y1rOuJY0rgQ0HvOdHj60ZzeeOvSyWgHaqP/0S0kFRuzx1isvw1dt3YzD" +

  "dY0+ShSaIIhMFOnCNX1QFncEXpQiWeV+nggleXzn1VeJKZ4nL5YzLQZyh02D33joUYzKUtwQiIzYgGvbJGrBR/NVgbsPHcJdL+2f" +

  "Gk2F6TmgAP7lrbfg/Ao4hgZ9JhSeRelH1GSsnbbVD0DI8S35vic9JAERQo3sRYhBuE6PE+Vw+phTgCf++yJca/fHXByT3AoMcSMd" +

  "q2u8/txz8E03XKe7Ok5/bMdvObFZdtXCIuwKR1hqGOeWDj/1upvxXTdeh/N6M9jSmcNXXngpfubNb8Q/uPUGbKwchvUyqgJw3KCE" +

  "AzUkNGEOtItgK+UbKS+RtSqvxEVG6u5RwQ9d9xJfQygcYcF73LZ+Ht98/bVnJfxPbMY2K0t65LKYodIAwklK1GrFkZi213d6+MEv" +

  "fQ02zA6w1IckwuICjebRj0qg2TvzPIWpTo7gWrTFEfmKtdgh+rUFNBsINuGKADLGIvjByfyeoFDat4l1LcqIVCpzfNm9J5Bp7fdB" +

  "/pBRJFC11Z4EMOm9dqAQVFalQ0YE1GC4ptHFG6w6ibnB3nszdsmEBbPsk9aJH69vdSq8kgcrTUAGLOK2QrSYSPZ+lbkWnmOBSyl2" +

  "aJEoIMPERMOtAbZBbPueU3RnTLgiYGEwxN+84BK86rzzJTBsmgJL2+PB+KWHHsLBQY0KhMZZUJ/5huW9U2YBdmicgyuA43D4vSee" +

  "AlSXnBxnceqFCCjJwTPjn912K26cn8VBX6PjStGKXTLhWcxtbN8BAljCoR02JsLgjo8G+KoLt+KGzZtVU5+idsMc9uy+f/t2PHL8" +

  "ONa5TkghWliOdtPSdCGb6VYaD3BDKKo+fveZpzDyEqh3tjQFLBDPY2Ovjx+49Wa4egXsRNe0ff2ORDhTOICrxWiQrBdlBg4SLyDA" +

  "wBLlRACWLk6C+XttncYo6ajdKx0IQaCZcMhdCQgM1jnCkAnnVQX+xa23RlqfZUnPqD/9mwGiEkdHI1w518d/+JIvxWu3ni/+UQhF" +

  "GpacD3/76uvwI6/7EtywaR6L9TKoIpSu0DgXr64Sl1YdrF6BlyRAK5bIt8b7JqJNjmlmDB0w4xq86+ZXo3LFWc45OkW6xTlmQYKT" +

  "DxA6eR2FK9Bwg0vWzePdt74GbgQsdQp4inMvtk3dbrqnLwJfKaq8Z48PJnOty6wqQSFMAWs0n7VK/C2OyonjuQyMrAYS0rNwJpXV" +

  "FVpbp5y4BNQqA4a5LNKA+omGB5OpKivCTjKWTK+u0QlsYCHcF5CtCn6gJQDlhlOJoD9RsYOGAqoj89UgvCzQA5g0aJqC0QabGbLj" +

  "yIYvsjdBbGkd4wNHySWTgytsSxtjyXtc1u/hW2+8PlofpljMXP0HT+/Ax/cfxXy3D/KNCimK5zFoEJ0xjQI63xqPubKPjx06hM/u" +

  "eRElSRaosy3Wzdmygx+85TbMU4MBGB2DmBT958IXDWozxgdQ7hmwx1ZX4duuviZzJ02reAgtnzp4EL//zPPo9eZgCfFyM62DoyIP" +

  "rqNgG4AnjxlX4PHFo/joC8+LFWBKyd0dEWrf4I7zzse3XH4ZjoxWUFIplh4ABppi/g2GZOxUwW5ChmTBu2SqB01IrgBDjg11bKGz" +

  "OQMJLDCYT9M+mtYqNU7S+kkRABGhKBya4Qq+99rrcfHcPGrfnPX4ns7Wv1VqwP76KG7btB4/94Y7ceHsrCZ5inpooQimbmrcdO5W" +

  "/NCb3oQvu+hCrDQrWOk28FUDKlzgL5HZyvx15DJXTQosgRhj0aaFCEDxiTfEcEWJ4coA/+Sq63Dlhk2SP2HK6+NkJdL7zJ8rri6P" +

  "t1x0Mb7z0ouxtDKCKwuorA75XMAFJNeF7QSw2Z+0x3RLMjdZVBRjDEpiR9DhcawvEKKWnxYDarpKVKZkikBCiVSUpMp+cPckQmHi" +

  "LgFnPCZRTBPwHJ6jYEDWtobMkw+vSUCFnd0fd0Iohw60cY0xhnD85zixY68TDSFF+20SjgnfVQqbCQwBRWWWg9AQYzAAJhER4o4w" +

  "Q4IhuDRIK7xjB3ibzE4+J/mjAWj0epwsQfsxbYghW1fqGt95zdVY3+2Cgalq/40XE+ljhw7jfdufwrqqA25qsCPZkpRYM1KvqMhb" +

  "23blUDYMX1b47SeeQd34qYEUR5Ij4IoNG/G9N1yPJT+CK4pssRI5ibdUVA+OFhYr9tvicAXffN3l2DIzIxvNpsjfTCtYrkf4pYce" +

  "wrIr0PWMYWl577UtRAJ6W/cLkFGmDYC8R7/s4w92vITFeghzD5x9EU2JmfHt112PG9f1cZxrVNDtkTb/yLQkQ/bR9x+/M8GTMkAJ" +

  "6XPsUahgj2vewASSAMPotw60ZM6WZ2h5wgvCe89AQTg6HOFrL9qKr7zsUtGqXTGRb3wuy0rd4Ku3no+fe/3rsanTXdXi5Eh2azTM" +

  "2Nzp4vtefwe+/aYrMcIIxzQRlqMGQAOCh1NTtsyJxOKo45e7FVMtU8BAoYCMFZSVBBwfDfHG8zfjbVdeEZSCzyf9wnbB05z0EttA" +

  "aDzjH9x0Hd60ZQZHBkMURRktGioPZC42mtPKgiOjxcmeT1zAfOEmKJn0hI1gBk/bngA1z7k+mHcytpookzVjKsykscjkWuu69HqT" +

  "v2YlsPWra5JbbbFb2i63MUWWCElaFQVW+TV1Ey34rcYbwpqgHVtl47ecUgBEqMfngYUyMC69AuxTk74NRG6J0JvH2mFtbW/7YEWI" +

  "45sOI3HH4mNNKChdnHNYHtZ40+YteNMl08/3b307Nhri5x94AAMiMQWRDhjZnl07OrLdYPN9CeOZpQL3LyzgIzufUb/1dMRVoa6A" +

  "t152Od56wbk4NBqgdIroFYiBKPFf5YBRFqzD8VGNWzduxNdcuk0Cw6aZPZERjgp938MP46GjxzFTVRhRnPzpGQWyDdCQNkKbSbUG" +

  "2TBO6LkCTy8v4MPPPzt2jsTZFIOi3bLEu151C8p6iAaEgm27m7YqIlpYHFpeS/IpRG+PP8vqQPKeWNx7omFR2PkzznRWL8yMyhEG" +

  "3uPKmS6++1W3yDoZa93nttiz13U6+ME7vhTzZUc0oZP0qSBCw0DlG3zLZdfiZ159O7aUjEPUoAuHkoAi0faj+jPBL5w0hnWNADYP" +

  "WddOgYKAxgNbqy6+91W3BAVn2taxMylnGvtibS+I8CN33IHrZ7tYaGp0SGAPKN+Jk+0omTDHOaKohOJmUWjNcP3BTOGcfm91Jr6F" +

  "IFoTWbPa3E8VYnFr2+6UCdeybt9GDihS2Zr2K3ye8DdvU1Jbe72b6540NweJkukAVW404jOl8yS/vurp4+aMxGx7MmaYWgjM3GFx" +

  "AO1tfJOQTdaeBAwEYT+BIcdnplsAOZ5QmNYfNIFkAatW5UgydW0kwnfecB2mzc7MyOGI8MsPPoRnFpcxRx00up9YtrYwLII1tJuj" +

  "6T/SyEmELTOqboXffeZZLA5r0BRBgFaP737Vq3DJbIVFrlESIy5de44hWp1BJAu0cYwKNb7ruqtRGgCcpiWF5eCku3btxu+/tAvz" +

  "/VlJuBJUBoB1EqYLyZGD/Ufs1N3iQAWhIcmUN9Pt4o927MLh4SjTEs62SKZAjxvP2YJvu+pKLI5WgMLFVAuneEyfzNsWcMAkYZSz" +

  "IuuHI0jiHs55QtuK0y6sN684h5kG+MFbbsW6buek952spED+bAqDUVIhumQQ2Ce/qyBJAlT7Brefuxm//JrX4LoZwkE/0t0jUEvg" +

  "uOBfbYdRy76CWsfBEcO7Ek1T412vug5ben0FUJ9/4Q8QXjx8EMNmdEZ3OxVCG3t9/Phrb8dWKrDEjIJdIl8Ay+0CJBq4Rd+bzIhS" +

  "ekylS5Nfwa4NoAuS1ImpdZ+KYdbfWsnjTjSHw7pJ1tOk2TpJhoZHh/cRDkg3TpW/BJU/bydZnVArlde5CoLlGjZmblDTtO28kx5t" +

  "FGIP8rZ/NWh8rXvbJg1KBhsQk+REZDMu7NuvjIarEGrcT29DEfvd9vfHlkfmuTQa4FuuuwIXrVsnKGpKAouZ0TQisP7k2Wfx4Zf2" +

  "YLbqYoga5vcNDIO8gAHKhZcEe6mmFYMrMMsFnlts8KGdz4GA6QEACJjYUHXxvTe8Ct43qCGmf4YqzIr0bEHK9isPLgiHV1bwDdsu" +

  "wXWbN4fI8GmxOFbLzL7FBfz8/fejKHugRhL+GDUB8fkzxcx5FkAkgXesCyZq53bqXg+EXcMR/viZZ6ZKU3mE0PWd11yDG+b6GDS1" +

  "moaB1aKKw/pAvnbiGlEXHjmwbTPTqG/rOcK97XUwrgxM+iXcC4IfjPD9N12PqzdtCqbrsyura1WnU6K7hHDqSzeur1KP+L5wbj3+" +

  "/Z1vxJvOnceh0TJKIpS6TU6sKBaUS2MMPLVehlgAIjmbAIArCAdHS/g7l27DnVsvUNfJFC1jZ1hsjj+xey+eObA/++5UiwTXSpKg" +

  "S+bX44dvvwnUDNCQxfQTENYjB2FmFqmwTp1q2uTVQpXnLxifl1KyzHgGBgxcUnJ4kQNsh0twHZiFInlAZpEOMjG+ArDObM8qb+1z" +

  "0PhzuZl+shglhCrbIMKP3R/6j6TtEPbhuYFrX5xqCKstjrGtCoipSJlMizeNI3YksNDUpBL2cE4IxzgFS8LJ3A4n2nIxVtKJYW2m" +

  "mAjFOeDYaIg3bjwHb79MTts7lRSmp1o8M8rC4cnDR/BrTzyNfrcP9rVGykZKRr3ORJi1eLw7rMyYPaPb6+CPnn0axweLwXw/jSLB" +

  "ax6vOW8r3nbxRTg+qsWUjphABinjZkLpHBbrIa6b7eHvXavbmqZp+oeOIQG/cP9D2O0JfRC885pwIweXqTnKcgEYgPEkiZY8mdYm" +

  "9fqG0e/28Ccv7sT+xQW4KdKUSBLn9MoSf//6a+HqAZhc0C7G/O2IbQuMzJnfOVADzI2sPx9nzvh6zy0C2XecPz9nN2IlK6oSy4Mh" +

  "vvvKK/HmSy5B45upgGSJQj+1g4PWuhhAm606eM/td+LrLzoPh0cDOFeazUWvpExrD2biBEDBlFONRaKiwPFhjTes24hvvf7aM8yX" +

  "sDbFxnqJPP7y6afkuzOc8wU5jBqPW889F99/w9VYGi4C5NT9JC5iSy2VtcGex5KjI5wAlMiVcAk0cVAgH8dAQFarKdu4xPonWbrS" +

  "FZGa6NMxTVtq8TLRGmTAJJePUVwat6ax1ZeWaDmyvrYV1vb3+q3RJGF/zoXpags6O8pjzNwRCWUMhKKPPHmQsgmpKWhW6cJA5sdU" +

  "FTzkA1jNZDbellX8a6vUYd/nVoxIwLQuDz2YQwdu5BucWzp8z6tv0q1Mp6NBnLiI2d/h2HCAn77/PhwHo4IIAafy30ES/hgdbZ9r" +

  "uhVQNG0KO0/SYJIeCC+s1PjQjpcC+pxGMW2KGfjWa6/BRTMdDJombAAImn9oCWPgCnRGI3zfLa/CbNUJ9UyjMDhYZn778cfxiYOH" +

  "sbnswnMDZvGnh6USkLrlJZbDYCxuYWxuRaMKagI65PHywON/7NgxTc8FAMiuDWbcfsEFuO2cczBoRjrCPmNOcR2YgIwaPyjuM0ew" +

  "YwFx+14aQZwC+/HOBA0MZhrNr/HsQQXh4NIyvvb8zfim666SYFY3LaE9PQIz81llxwRszks8zr+45Q6849KLcHSwJCmkg24nUepg" +

  "JGMASLa6CXXCY4U91jnCv7j5JpSuOKEw+FwXa8fc7Bw++cKu4GI7E15CRCgLmeN/44or8fevvBwLwwFc4SBH+2lWPUShHOmYyBWO" +

  "sxoc46JEIMcMfymfj1p5wnc4rqf4N1dMDWS35Q6bApF8YeMtzY4ZMdN7xrxaiVLbBhOhDSFwPZV/9tnUQZHyaRtAifVcr3GmTcYO" +

  "5l6mttnKfPUp2uBwrXQmNePH+IBY10R/hiK+AB5aBD6dAKR2SQV+262QXJUDA5tcFvHqCMOhx/9z7Q04b34etn1yGsUEIxPjlx56" +

  "GM8srWDOlWjQqHRywYUVTaAtVExRW7URofQBJCafTtXBHzz/DI4Mjkuyl6n0wJJ9MDZ0uvjGyy7DwDO8bXFhsVswZGuTrxwWVpbw" +

  "7Vdehms2bZ66hmOHJt2zdy/+25PPYl2nixFYjtYFBcLkW5tImY3BeoCcE00hWTRmGSAnYKH2HnO9Lj68axd2LRwNmvs0C4Hw1Zds" +

  "g2vULEn5ekj9o0hAaUD5QfYToMKYgp8a8qPtooExjMiZvIE3J57DzFUCFaYAKudwfDjCHevX4Z/dfKuA2i8As/WkwhC6nO38t3nr" +

  "mfGPb3w1/t62i3B8eQEggoMdFKTrm20HBQPkwviwokrZ9+9QD0f4FzfdhPPn5lF7f0Y8b63Lhl4Pzy0t4ZHde0E4862wZnFu2OMf" +

  "3ngDvuGS83BwsICKRLEknyuXaWRRjOtSQMpOpzLpzph21sgcStlaTq0Fk2ht87xtFRjTsFUx5vgheTKlj06uj8+P2lLyY9LWtP3j" +

  "9eX9cmF+mcYidVvmXePIzjLHKUBAJIUxiHGBycnvSG6JE3o8aU7sRLtT44QcN+2Pm/lXNzsFFJI9J5hHV7kvXBO6FpN2FOSwOFjB" +

  "37hkK9586SUaPTlFgaVg4r8+tR3/Z+8+rKt6qLnJcKoxEWlcCgJ0nNheKeBJ0hh7se10QHihafBHTz+v5uFpQQAo0gXeeOEF2NLr" +

  "YMS5PYnFVICl0QhvmJvHN117fej7dAoHX/PuxUX89IMPgHp9EJO6IYCCdLubCnsmaPZE20ufC6x49oX8GtZEAig7RDgycvjjZ54/" +

  "4Rw7k2Jr5PrN52Bjp4+GI2Rvg+LcchaZiXkGScGhzI+UoRBsZ3Sa/jfEDVjtmnvccZyFrNoXATjODba5Dt5z+23olSVs3p5p4dbf" +

  "aRSr6/kjh7BncSFTTM60GMU8e3zHq27Gd151ORYHy2Aq1IwtW/tS5QYEsG1DJocGMg8XRgN8x+WX4Y0XnB+zJZ5h86Zl4ZtUSkdo" +

  "OhX+fMdz8sVZDHRKv39+86vx9gvPw5HhAIUrg7VtTGlMFDWx1tksNZkVj2xuN41CFZyBafkyPeSIcxGXWY1bddpaofhegotd0PQn" +

  "zzNT/2JsQQZuMlkYeT8nbUvdDHlb1SqYyd/4nTlQpEpL/Ri0AGoxidBTcDg20r6TVL6SaQ0JEVpdbRFwzGySEdM+cGhCZo1A2+yU" +

  "BAki32JogVEIv481LBI967Jcucwel/V6+I7rr1fNYXr7cBvfoCCHP39hJ973+FOY6c7CNw2S9CJpM4X+q6zrNkbM/NHGSJgxU3Tw" +

  "P198CfuXj4vGOiWBJSCSMV9VmO+WqJtGAAmJO8XASa9q8F23vQqFngc+LfHfqBayVI/wb++9B4dGjA4TRiS+PiLNZ8mWSzuewx4X" +

  "og+zKvoaDZUDHk7OhEccG98w5ntdfHjPHry0eGyqNLWW9UqHbkfXGNp2Oy3kIS5yo2oU5AKA9Tw6KuBcgbiwEqgZBoPD+lTsJDAh" +

  "WT8MaB53wogZM3WD/+/OW7FpZiZkXTzT4lnOQLjnxRfw1BkGm00qNqbHRgP86oOfida3sxSW5oLxzPi719+I777mSiwNFtE4QmGg" +

  "HJpNn6PrhQGQ96iIcLCp8eXnnou/d901moXQAjXPqKcgEJ49fBj1FAIn28URodfv4+MHD+ClY8fOOv7FqfwpyOEHbrsDX3P+FhwZ" +

  "rqB0DuAGnFgYopA3wpCyt5ZGrv/YnM5EqAmqtBarklmtCbIl2FBGJm1Muc0GJ5VrCiM4N7+n7Yjyr+XznwA0KGlrdA+ojLAjAZLr" +

  "ha/ZvI7gyREDJIfmFURwMRgPICa4sD8/opdARXLw5FRLENNKjGlsIStE1JZaA8bN7ieZnHxihSoOOoVWTPJPtn0qgT227DBxcAis" +

  "2bh4WONbr7wK890uxncSnHkRbbXAwwf24ecffhSdzgzcaISG7DAW5Ag0gKzVG7A6rZTVEaMPYG8zxAeeejKxLJx9MRR7rB7iyHAZ" +

  "HTg4H5E5CoflQY1vvGAbLlu3AXXjMS3vsPXBEeEX7rsf9x1bwkw1g0ajemWWSc47O8I4I28KCjhPABUfQmPfMSRbG1GDw77G/3zy" +

  "makBGsAEPvDyygqODkcKmtJpkT6NJNaSBNaz9n1MAzI8YwwsYZChXwbmkfAHZbKSmRMAMypmNJ7gR0P88O0349oNG+C9nAtxpkV1" +

  "Fyz7Gv/tgXvP0o4wuazv9fGxPfvwlztfEOE1hWyOxk9q7/GN11yLf3LNNRguL8I7CxDLNVhmoAGDHGGx9riuO4N/+qqbztoiIfOD" +

  "8PLSIv78ySdQTDFQORaHDpfYN6rxv55+ciojJFYAAS4/cMft+PKtm3B0MEDHFQCahDnH+ZnRimLsEycKHIDguooWg9Q6aUF8BDvk" +

  "KDWxZ5l8W7x3LCCeYyOjmM5U9SB7OH2lmv4qynP6u8nr4PcF8gUMJNb3BOCH2SHuOUdBA4IsbE04AyD6X5hByngkU1rQfVTbtixN" +

  "q2unOYFojHjjRI0CPfyXAIigtNk9SbrHqAOPC/rVTEmxHvtOJuLAM7bN9PHaCy9Q5Ll6/06nWJDa88eO4cfufRBDdNGFBf0l+diR" +

  "TmMEn/rqRRBra6dY/JUFAa9zXfzZzn146big92kwncY3ICL8+c6d2LO4DFeUqKEuDgAjbnBOt8TbLt0mc8kyzp3Nc3VOeQ8UzuF3" +

  "H38CH9y1H5u6sxj5EbygXAGz6byjdEkIsRSoh5kH2IKLwFLmACfXQCUjY33Zw0d37cWLC2dvWZFARtl7XjPjdx9/CotZ8KIxBAPQ" +

  "tkYQP5sWo/OhTbMw1zmdLHHui2/fdk1wWCoCAho548E5HB8s4v999Q24c+sFqL0/K+EPMLz6vf/kuR147NAhnNPta4+mV5rGo1PN" +

  "4Te2P4HDw5Vgej3bQtCkQd7j7Vdfje++9mosDhblkB9Gwr+Evo1jLDnCRufw7ltuwrpOFwDO6kRRs3L+8dOP47H9e4JgnWYh51Az" +

  "UHUqfOilfTiwtDxBwTv9Yu7AEg7vvuMOvPn8zTi8MpRgyJayKLIwWa1BjulnAhi67l0BJDE/aicOoD/kAnGFJr9ipHkAIhrIBT4Q" +

  "25AGpZNm5wq6tAljW3tt3SJ5P2nkw04DAHFvhIF0VlHZduVbGz3IWRSWhJKDgaoo4QqnKStDghwV6BA1iPWwFjbTY5Y4wYRq2o0T" +

  "T4AsEjZ8nlRSm8K4VcHqmGxAHo8ZSKvNJmr7+clzCMCQG2xdNyNnl/N0DNbmp35x8Tj+1Sc/hUMNo++A2qwk2t+AWtN7MS4025Z+" +

  "IAIH02bD73pDh4CDaPB7O84OvYvgl/lSugJ/tXs33vfEU1jXmQc3DTx5eMlPi5WmwaXzM9gyMwvA8mufHT1N4yoc4c9eeB6/9tRT" +

  "mJ/to2lGkt4aCOAxsxra/Am59SMIkCXDtqZkrkh05ZjPEdDfmdBhhyMA/vjZp864VwzVgliOX14YjfCTd9+Fv9p/AP2qgNkybAtU" +

  "2AbFpO0nRD9m2mED6eamo2TiCJBIA//iGldeEKwfBE+ELoDKE15eWcA/fdV1eOu2y3Qczk7b9Jq18dhgBb+9/XH0Z9dnQcXTKkTA" +

  "TNHBS6MG/3X749PN5kiEwjk07PEN11yDrzr/PBwbrCiy5CAEKhbGPVwZ4V2vvh6XbFh/1sHFxjUX6xq/9/R2VL2ZqfRp/DkS5Nsr" +

  "CuweDfH+px5LgMbZgwAmoCKHd99+G77kgs04tLwiWUZNbxetLvFeUSJo2yWqUhxeyfcJk82mgNUri3KiQtUODIxFxlkEMgXwF/iz" +

  "/YbUEkdB1k6sk2OkAxKexWn0PKAB4dza7hwgj35idKoSriBnbc3Fd/iO4mEDnDKGtF3t72InVrvO0NvkRZd3vG1maf9mDDiN+GzX" +

  "3Q5gDJb/Cafj6HiDGehQgb0LyxjoASYNm8cw/Q+n/LKI931LS/hXn7gbLzTAjCsxDPv9U21sHBmSfsnJq/XrBCtFPhYWtTtTdfBn" +

  "L+7G80ePnLLGagKqsUkKEVRHRyP82mPb8VP3Pghf9aKwYQJ5oWcXBXYvD3F0MAQpLUwTPbVX8p/O19p7VEWB+/ftw88++Ah6/XWS" +

  "QlrlUIFU0EXxRqG+vG+yaWt8ngofiMzbaJpapEbk0euV+IuX9mDf4tIp0XQSPR0RGgAfeeEFvOujH8NHDxxBv9eDr8UMGlsdty5K" +

  "UpQIXo2vQX1+ZhJK9VwBmxwYp/kLDVbHFRVjaIzxNlTi6GgZ//SG6/B3rrgKoynt9Wft/+8++RSeWxqiKLtnXedqxfsG6zt9/Onz" +

  "u/DU4UNTTZNthRn4W1ddjYqEd3jInPXkMXAFFgZDvOu6q3Dn1q2om7OnoQGo/7VjB55YqNEv1gYANOzlSBUQZjsV/teO57Hr2DE4" +

  "N51cGLI+Pbrk8K9vvw1fc9F5ODhcgXOFWKlVs02FluArnsQAJ8qj7HkKXCkw/6Qh+pelImEniaKmXyMFGvHFgV+LTDKlN2ljysi1" +

  "/avJLyBpmlmD7QtugviIobu6ptlB7LAm7xzKooTrVaUE3FCs3M7/MwYStWXtRAyVb5MRQCsRkAU+BELlDLRdUu0+1JoEW6y2k8Ce" +

  "HvqghAy1Je85vVAlRTtGACoI+lTgmYUl/NrDDwmyp8QlEf6bPPSTXgUR9i4u4oc//insGA4xX1QYeQ85mEgznal2N0n4m4Y6Rjcv" +

  "EfCN9j0VbmngI7NlbAQ6DeN4Q/idp58GIJp8JpDZhJNH7RsxzUIYdKFjsm8wwAeefgb/+GOfxPueeRbc7aMLRkMNGqMViwLdoQI7" +

  "lwf4tcceBRDrOHX6pe4g+a50Dg8fOIAfv/ez8FUfReNl8xUlaYXSOWLmOXZBWzYwMbGEACDTkCOWTn3oyo5QMeGgL/AHmh2w9h6N" +

  "92i8mPRr74V52tG8LXruWV7EHz7zNP7JR/8SP3bfA3hhyOh3Z+Ab3Use+k8q2CVFNHsJ8rO5i3CC38TZAmguAUYc8wz9JxoJqXWh" +

  "IQaxR8kOB+tFfMe1V+LvXXk1au/1eNyzs+ewWsZ2HDuCP3zmGcx1Z+D9RH5+1kXMsARXe6wUBf7z9kfDATLTsgQYGQ8vL2Pga3hy" +

  "4QTKgoFjK0v4R1dfjm+44nI0zCiLAmdDQYYoF4cHS/i9xx5DvzeHZmpRNq1nqXupYaBDDgdB+J0nzZo4nQFzVIABVK7Au++4Hd90" +

  "6YU4PFpBgUIyjepJtaI1+9a4pZr+BLmhfAlEYdyh6wGtvAaBl7IEEAeef9KJaYAc5iVMltjkOWagIlfYDIbrZ47zdFxqqSLBia3D" +

  "LBmIwADMkrmyAo0AquxLdkYYRRJhUZvoodAYSzASG9v+G/s5actfGiSYXnOqhVqM3eo/0Q6E1IeeCcikH6mbwTc1Zjt9fGDnbuxd" +

  "WsDfvOIqXDQ3g25ZoqISRppgzE40QvsrCYUYDMJzR47gVx54BM8uDzHfqcSyoLwcIHFTeWFOlOy2iJDLhzaGw2w4dkihVaSL/mMT" +

  "y1Aoa5s2dLr4810v4G0XX4BXnXdhOLAl7Ze+AQAs1CPsPH4Mjx9awEMHDuCRw0fx8qDBfFngnG6Jmj08O5AGUJpkYRCG3GCmKvHB" +

  "Pftx/DP34usvvxQXzM2gX1SoTKIjZtRilgA7zwB7r345+X7EDYgKPLr3Zfynxx/HkaJElxwaTeEp0eqrzCfVYs2kxrF72R1GRZ9+" +

  "kZjpBGlzYDRMHoUnbKx6+OCunfiyC87DdVvOm/BwrZc9Dg+GeGnxGLYfOoyHDhzAE0eP4cDAoyoqzM5uQDUaoa5HYEdwVCRALp5p" +

  "Ib7A9CAtBrJdAi1AzdYnryQ3cEzhX3lGBP4MhnMM8oTjK0v4nuuvxrdefY1m+XOBI5xNsVb++gP34TA7zKCQOIM1AACAjHsDxvqy" +

  "g7sPHMGfPf883nrpZboDYRp9kf3tv/fkU/BUgn0jFHcOx5YH+I4rr8C3X3MNavZTCdST/BeE3378Cbw4AOaKDqhcozwMDNgpVA0z" +

  "Znp9fPClnXjHVZfhsg2bp3ZAmlnRGIx//uqbsa4s8dvPPI+ZsosSwIC9ebXjejUrgD7e4lnazU+HOLp3ufUd9KhsDjwjrT6F2ASs" +

  "IksS/mJyCunzolDO2pjwa7ksKrWr08vaCRA7fU7OyxzJ325VoTy4uPBAt9t/jR+NPEDOJQ5mMt8ItfTOMLAx6M98ijbxkYADUoQG" +

  "tAL5WgKXk/erlZBVjuOT0ue0iR+bbGAjBQG2RWMVdwGLQPY8wnyvj08dXMRdL9+LvhNUWurYeUWTMgG8Cv0CqakaDFBRYmE0BDvC" +

  "bKeUyGMHyRdu0drey8KCBKGkdLfJGDQVnThsYE0aHScqoh870iBWxiAQ1yDq4Gfuvw/fd7vDDeeci4KAQe2xMKqxf2kR+xYW8fzi" +

  "Ap4+chTPLy7j4PIQo1EDXxbolSU2dcxKAMj+eqe50BvNzUFiVoOD8x59V+AT+w7i0/sOYLZw6DpCGfoiAYkNR+uDh1g4jBwEByYG" +

  "uRJLjUdRleg6p0GrpOh3MvOJUbRxDmZ8iiO92OZbWOYWXKl0DcjB0h071MQAagyLDn70gfvx9ssvxyUz60DwGHmPo3WN/StL2LW0" +

  "gJeWlnBgeYTjwxrDugEVFbplB+v7BcqmwbAZodFDgBxIjry2xQ0SzYDyeRAQDThpX7p4ZPDNmhFAEIDGLHdjVjgSpkEOxwdL+J4b" +

  "rsE7r7o6SYV99oy+0fiBj7z4HD625zDm+vNYQQMPt+pYnlVh3ZpaFqBmhF7Zx/ueehp3nL8Vm7q9sNvmzJ7MIRnVbz38GO45eAS9" +

  "fh9NU6NwDgcHA7xj20X4rhuvk0BPd7ZZRWL+i2eOHMYfPL0Ts7MzOLYyQHVWAZmrFw8PdgwqCGgIXVfgEEq8//Fn8AOv3xwsLNN4" +

  "urhmhB985w03Yuu6efzKw09iwA5VAXgvVj/nhHdQzHylSlEigYNSGy3R7b33QaYg3hNlIOsSSRSzltKZgwC5z7KyttXDyNPSkjTW" +

  "1G9Sfb4FMLJ7wvMcWO348VdzbXLgAwQeloN6dLDszmIUHXwRpQQEhYA8iJAE5RCCfhSIp5pVQqTQhLCoSHcuJIEVpzBTTPhbQpKo" +

  "3sYBSC0BcWCSwaBo8gch7HhogwD5yoHlwAR4NJipOgCXqBkYsoftT/XQ7G9hb6+0wbEMuZmjuWlQVhUK8mDvQVSgAMNOzolbV+IE" +

  "aWukGZlMU7Z+aH892pit3TcDAgIyukWJXaMG/+9d92DrbB89Iqw0HkuDBgt1jSUv2nxBDlVRoCgdZjoV2IvGPQpCEgJ7xJGmNFDh" +

  "ApJFyuIj7FYyZRaZcbzRkDuf4mIOJjomBqGQHSiEcDIf0KDTEezvPVAk7WiXE2+d5ChMKa8hGgMTTUov8BS1/2gnEzdMx5U46D1+" +

  "5fGn7DwzyajnCVxIZLJzJECy6mK2lCN4wUDdiLXDRJ/OHtVk8rVp5gsB2HadNFKwQgJsW4vNNJyYVko1X1WPiGJUgEeBxeVj+J4b" +

  "r8E7r7gatW9UcJ09i7f8IceHI/zGQ0+g6M/I+NPEbAdTKdYzWT8OfXLYOxzgvzz2BL7/1lslCU/gMadXs7lE/tf2J/G+Hc+g2+/D" +

  "+xooHI6Marz5nM34F696FZhlu+TZUtCsYgzGLz94H5YKh3kQ4FgD56ZfWPkVaXbNpvHY1J3BRw4cwDsOH8DlG+1wr+mMoFkTamZ8" +

  "7cXbcF6vh3/zwEM4MgLWuQJ1ajY3EG/aV4IHvMmvhOhRUMfPwTUZWDEjBNy1Srq/H9l7FwGCNSHjQ/nunPR7wKx6yg+TNo8HCSrQ" +

  "0UBdsxJHKRKeZuPmu72eO3Bs4T7XL8vCEiPEfMn5i0OKVFYNNw+cC8ZHorBwDUhM0siDiEw6T6q5caqCtWjCQNTyrHOJmTK7nAiS" +

  "Fz0eh5oey5Huf7Z6xp/aAHBBeHmWqHZHDQpilI7QLQpUBdApGFVJqIoSnaJAxzHKAihKoCgYrvAonAckwa/SNAliOZG5LJhoQwxs" +

  "UqJ2yuTgWSdt0p9VLSr6TA9G5QpQ0cULS0M8szjES4MaR8nBVRXmez2s63Ux261QVjLGQ8+o0USN05RHnS9ehanpqhZtb/PDAxr0" +

  "KHERFTmURYHSEYqCUBUFysLJixwKPfM+jJv+8d6j0f561i1rJ2WpbJWFeeVVi5IloA8Yg1/yV04fEw0nncgcVoYEWXZAWN+bQa/X" +

  "R68zh35nBjO9HmaqCjNlhb4rUcDD8wgNNxokpoAQCCANPO6bphDc52GZDeUkSErakq/Tdo9Cy7XfZsg3Jscg2e7lCMsrC/iBm27C" +

  "O6+4Fg2L2f+s93BaG1gSwfz+k09gx+IAPVfqlLKMh1N5TFYkGQ/Ba4KXxjNmqh7+dNce3L3/RZRnGMzWsJwW+OGnn8YvPrYdrjcH" +

  "33iQK7BUN3j1TB8/cseturd9GrYTCcgrnMOHdjyHj798DLO9PryGfK3Z8cFMul1ZAbATt98iEX7r0cf1ouk/uwBh5D1u23IefuG1" +

  "r8G2foXjNaPjCOAGIqM4uA18KmEZidvU2mcv46P2e7qmWc/AmFyytRnQWPxs25Cj+d4k+SoVUiIXOOHfyg9y2UXhcRrPP6bs5Oue" +

  "4JnZFQ7s6Yib63U0CXihWrAFD9nDEEyqZNkClVVYdHD6UEcEO+jihAE1kwRuYoJMA/+s88G9oVmViCMyDIFR9mksW5+zMYAxcSNN" +

  "St9wKEx4ySiQ0gLswLC6Y9RwMnVUDJhZSbQzM9kLPQE751r6ZXu1wyk0YQIZgzaapfEWjAD9QzsBTkzgwTs9Tn9N78Yi/SABNQ16" +

  "zskLhIobMHs0voZvPGovpk0KbTIoZxEQTkz4EObNcGiI0CgQCIcDBcOuS8aZItBh8Rh4kAQmai/gCgmkgoCHRv0epEmbmAwBI0/6" +

  "QcmpftqW2HkDi5rzHw6taYd0hEN/nfnmUqGsQlNTbTZg1GolapSWXv9KnL8PR8bGQB+pz4PRkEcNOU6GA31ky257R420zYOpAdQv" +

  "Sj5vnxCfsnus4U7dIkVQF8S8O2SPerCIH775RnzNZZfLPn8qTvMo3cmFYVtiCU8eOIDff3IHZmbm0HjjJ07PLpi+IBEh0QRL5YiE" +

  "J7hOF7/68HYcXRnIWQGnCAIYMW/Dnz65HT/z6BPA7AyoaeDKAktNg8vKEj925x1Y1+mK+2EKyMYzo6QCuxcX8KuPPYaZTh/cNAqQ" +

  "3ZqdxcDKkIMIJZnr/arER48cwSd27URBya6K08dSEwuRnDnhvccl6zfgZ1//ety8aQbH6pEoMUDgTQAyDXvMwpvxTSs+e8WQ6Gas" +

  "E0H3TMfRFIvkeRxkVNqOuNbbpKFQJyULNcq2EK+QZijSjIXBEp6smaASqaWNiMHeY7ZbOrehO1NQcmF4ZhBIMZFINJXEO9q+j1jT" +

  "mY14e0mk9TuzLBgRWmb/WNRSkURCB+9LC+CE3ykHEOnfkAyJAdtOJQKJwHaWQnC0Ry01jRI3Fi/pFlLaGBjxyf7yFESRbknM0amJ" +

  "3/CXGeS9mty5ZSnI6WP3hGxBqplbvTWL4KkJGBGjIRG4IeI2EIW0/eNPyXuo1gm1ELH69KIfXq/h1GqjdTqn6DnJf2/fQa81bdHm" +

  "a0YbIHXvUGyUzaQAYZIfVMO2AU3ygxOpa8ieksw/BajWeUcOTjMPWs4DB6cnOqodSwVdcGmZ+0Tfs5NkMUyW2c+uGQfYaQROBNgp" +

  "wNXxztatgWAdF+0zlwWO1yOs9w1+4o7b8GWXXIZat/pNTxx7gBkD7/FLDzyAJVfqsKrVyNGaabDC4oTWzjmB4wzMocDOpQa/+cTD" +

  "CuhOsS4NwPvAY4/j321/CpiZBTUMKhgrNeMCV+HH7nwNts7OTy1ALjyfgP943/3YV9foJGuR6FRaf4bPBIKwk7M0WOjIjKqs8MuP" +

  "PoGjg0Hg1dMeRuccGu+xqdfFT9z5Wnz5hVtxSJMRFRSTLjFpzBTacUHcej8us2J80CR55gIfmAgSzfqd8J5gZU5lZqsF8rigxrTq" +

  "nEyLTIkyOUfI5GLWW+W9G3uz5Gar6li4UQWQTc7UEuoT5pFWl3U+Q8yK4BHR0Mm22Kwq0CcJ5xOYZJxqNI4QXgDD++aEz5V2pgsn" +

  "9tXcDpRc71lN3YkgCFH21j5FVR6SQEVAW4oY9aLkmWZGz2md9F8BRdiqKQMHYgrYVfrCqk1H2tt7sDAt2EIxUeg5ab8JfM7abe+l" +

  "v9b7nJ6mVZsvzWudIrIZrihEk3ROjS2qhTsCFWJ6ds7pX8ld7wrLZR8FBDknDMjZZ9PACxQmeEniFwqWcbS849LWQq8lcTWQ04TB" +

  "9ko+t8Co1Q/9zTnJti/4RK0ierqms/5oRsJ4/LCBmMTCRoX8der+YJ1zgcyU0Tn9NoLDqBwANuY2DwQcx10mpokoQy8KHB2t4KZ+" +

  "B//+ztfh9nMvkCA9yq0jZ1u8F7q8f/t2PHhkCRs7c2LVU3ol7GfqxSu4DmuZZI027LGh18OHdu/HXXt2awDa6unKbV055/A7jz2G" +

  "X97xPKqZ9SANgF1mh3Ocx3tfcwuu3LBhqqeIWk6RP9nxHP7s5Zcx2+2H1NFmLqU1sgBYiVOMwu6SPkq8OKjxnx8VEDWFLMsTiyNx" +

  "f3TJ4d233Izvuv5qrAyWMOQGjlitbXUQ/zGgNzlQ5yQll2fpi4FMmZygpOlYZIHv8mP6gFB7/E6VAYiLT0154WeztwZtI7gcfFz/" +

  "JpcohzfMbIcmYmO/OyqfP3Dgo2V37htHRibSQyx1L6CgIDX1e9KUgnnJov0zbZCDryUzqyZETd9NAgeG4iKxDOHo4m2bdYIGbagz" +

  "6kWntu7MNcChbxLcLpxJY+0S5qvCm21wHVyh1ziJxLb3cpGafIPCSXEgFaumSJW0B9YvYfL6rVpk5JP8LSKMFAsOAQ0h7lKgKPBF" +

  "eW7tjiBGAcA7wJI+k4t58gEyZTyAjwZxq0sWPRsEi5xzLvPHYVAzlpsh4OW0M/L6u13NgKcYXxA1ZVbtmSwSEMS1RqIL/cxKwxY6" +

  "5/RI1ojGlGYOIC+7FVS42nQKJExdOUoLWVxJEGUYn9hj25VhbXZGW4irwpl1R1I/yHM9NIGR0Kl2Ht4zaibMVh304dCg1saNT2RS" +

  "cJMuzjQUKN2lI2TN100DgiMx7x8ZLuFrzj0H77r5FswWVYgwn2ZptM6HDu7Hf3vyKczPzmPQeD2CWVrpALiiTATm9KCAAaJQIwEW" +

  "NUGeQWUfv/rEE7hh8yasK3t6amVOA69z3hHh1x96AL/zwi5UMzNAPYQDYYUI58PjvXe8BtdtPkfoOKWgOKmL8MKxY/jNRx5H1ZvF" +

  "AIyq0LMsILP8bFIKn6gESxB58asxiYWKZYfAuk4P//vFXXjN1vPxpRdeNNWAQCtEYrkxJedbr7ka129ch5978GG8OKqxoeoAXua2" +

  "8WhbkyKvXKLljxf5bXIQpaxzsbgi0b7HthsGNyOC1TN9XAAHKZCn8XosIBcw3iLzVVpS6LMsn0wCNrK+RCDiQHj56NHPlFXZWTAt" +

  "RuWTMgplqESAN19tkH7jndQ9h5wy2ew6Shqc9Sx8RSacMmUn7nfPTCerzmurLL6Pht42WVp3TnArMDMKiGnUg4OWudwwRn4kE17d" +

  "A4Y0jdFKkEwjGgIDYjaK++wTBU3pkyPD8S5GoGGZ9jjMLBu7eL+Djgnlu7SbsAUsfinbyyjgERMVDBY3h8ESR6BG+gKSlKezRaUA" +

  "Lqch65wCASUTaudw0A9wXX8Gd55zPs6bm8X6ToWucygNXWmTQlBeNoVY9fGkM2QAAQgn4ch+A/2eNWAtO+cPtmDNDZHqeIw00NRM" +

  "/w0s0U5E09aE6OtMwZihdDFwuACQJJmU7ZQxIWIQBvCNx4AbDBqPXQsL+NALz+OF5RXMVh2gadHE1mPAyHFbE7LLWgyFkc03GWLC" +

  "0mAZf//SS/Ed110LaL+maa4GDBACx4ZD/MJ9j2BQzmHWAygiaA0grwmUnHobhLeIZY4CUCswAmEeDi8MRnjf40/in7365rGAwEYF" +

  "8MgzfuH+B/FHu/agPzODZlTDuRIDbrCVGe99zR245pyN4fppltp7/PsHHsJ+KrCeCyy6OghEZ/x6jYpZ4RzLTimmnMMWjUdVzeCX" +

  "H3kU12zaiHP7sxkPmnZxkHih287dip9943r81N334MGlIWbLjlhjgoBuVKgnakpLOK7uWs75W+DZiZAfLyZHzBItH+K29PheFK1c" +

  "hmbyzCx4kK9NxLEiguianNQM3alGEufniHDw2PGd5cUb17tdCwNd6AjJf4JGmHUcsD3qGRcKUcOxw3aPaD32hV1vKEX1NO1ndrCJ" +

  "goHVMGNw0SKiqGgRaKEwjH+X1ZUQKbvPBDOJwHUgjIiwMlzBpd0+zutvwIxzMTsgAYAXi01AhT6ag/UcBROUTTAhmZk8QX7aD4Id" +

  "ZmNt1esTC4do7pKQA1B3hSFTXZgmgIS7OrmGJALfNMewSLxOVpcE1Bn4INksVntgAODA0gqeOHoMXFUolHGPCRsAI9fBsFnBt198" +

  "Ab796msx1+mtOh6vlLx89SUX4xcfvA+f2H8Ys1Vfkkq5PA5GwIOAgYyBtAR9sEQgrk1SgDsareBd116Nv3H5FbCYkKkL/8Rk/h8e" +

  "fhjPrHjMlyVqbkL8CgWeYS6dMPmnWoiE5xlulCNUBfp5brCx08Wf7NqNLz3/PNxy7vlo9JAi7xll4XBkMMBPPfggPrn/GNb3Z1CP" +

  "RigKh6WmxkWO8G9eczsu37Qx5DiYRjE3XuEc/tvj2/GZQ4cx3+tj6D06rMpH4BdtJWx6hcgEmioHKqBEYRTtdAYOu4cNfu7+R/Dj" +

  "r39taNu055RVV5C4cM7t9fHeN7we/+9dd2P74gpmSoc0paTlpOHUopyZ5dM1k2TJVclrriMzKoTbMnAwDrpT6Zxq/ea2YZ1fcoGZ" +

  "m219R2U2w/+T8nCMi2a5jsXRy65AQQUump8vyis2by4fWNktAEBP/LNAoCC3bf0lps+o43B2TfSrRSRj3Q7JWcUmLsgxJAiyfc6q" +

  "lfGJ13uIU+BI6GwAonqWEX4VOsUBIQoDYSBEuINEn1ejEf7x1Vfia7ddjl7VOUEL/+8pf/78s/jpx7aDO11QE1G0RauWIBzlGm89" +

  "9zz8kxtvBpgDWFkrjeCvS2FmrO/08C9vfQ1e/OhH8VLdoHK206JtcdF/E+YksZoxECvgxsQK5F2B4WgF33vtNfgbl14etNW1kB0m" +

  "vP7omWfwoZf2Y76naY5N6zK+QplhY+rFNFhTMiJkkvibkWOUnlFVHfzy49vx7zZswMaOnEroCsIjBw/gZx98CE8vDzHf7cLXNZwj" +

  "LI+A8zuE996mwn/K7hOj32f37MVvPrMD6/ozQFNbBoco+KWTa0bAoCUzQKbQqcJkx2+vwGN9p4u/evkAfu/pJ/HNV1+LZq1yO2sp" +

  "yElmwqrCd990PX7w7vs01b1ovsFtG1ZQJgXk30TxBniC+DD5pp+oXU9aOHuXKq126uVERTazAsR65KcYu2NtzV0NDEvCpLboBIww" +

  "Gu/RKxyu2byxKNd3iufqwUpDYsOfILQTXzvHLggOsGQjxohi4y2iXZeZoioof0q1FF6FyJHYURCnBF/9O9OIObRZe8JADGRsPaV9" +

  "f0J8ggQJ1aMB/uW11+Gtl18GQDUu6XwyaXJtJZ0q1BrMSX09cVndihGRIkCJRaZdI4d/9ImT8NGkZlLry+S3r7z0cry4sIDfeu5F" +

  "zHX6iKYqkTYjR5hpGF9/+SVgSDKPao2Dk/7aFCLUjUe/rPCVF16EX93xLDqdGVVbAahlSd5G61G0KyGuOVuvZtlS0H9sNMBXbd6M" +

  "t196eUjwsxbFhNdjhw7hV598SrLj+QYhwdeY5ajNDKdbggoTFByoliSKTgOPrivx0kqNH7//HnzfzbdhVDP+5MUX8MfP78SAKqzr" +

  "dFD7EcqiwmLjsbXw+PFbbscVmzai9pIrZFrFswi4lxcX8ZP3PwSUHZD3aIhRsFl/AGLJO+CmlKhpUgmWSUSrZaFQyutQFiCgabCx" +

  "08NvPPE0btx0Dl61ecuauJXSYoc6bZ2bRa8ssOj9mHWSMn6mZnEnLlOP1PJsAbvG781kb3LJj2n+dl+wACPKS7Rkl9077naI8z61" +

  "2gmAbyX6UbkW8mboj4zEvWBRVkRgD8Jo5LeunzlQ7t770IP1ijteVDMbuBkxuWjYQXgAByFuP1r0d9jjmPibUh++pU2VHyzBiUWP" +

  "J4sv7VGrGMMKCC0ZxLb/JhuCjNjJAokX5GaZ9v1BcDOGtcfN69fhrZdfKsffEqJp/qQmykmT40zKCe6jVT+ceXMmfp/31atJ8qu2" +

  "XYb/8eIuDCkmlBFmQFjmBpd3Orhqfh0IcoDPK+XUi1NXzFWbzkFvx3NhQQvYSxmH7VtGMFGalSBa6HQtJPjbe48bt5yTxDFMnzmb" +

  "GfzgyjJ+8r77UVMHHc+oEbfZanMA0p0UbH7ltZgvSS+Z4Ix/WW4JfW7DjH5Z4vFjQ7zrrnsxqBscG40w251B5WXve6cssTRscEHB" +

  "eO9r78CVG0Tzn5bwZ4hbjklyQvzEvZ/FnrrGvB5RXsBcOdKvqJVhLHBxWiW4bhUExF0qIqwciSXXg1GA4YoKP/vA/fjlt7wZM0VX" +

  "dzBMf64xZD4XzuGu3ftwaDDETLcL+CbT2GW6qfUZUP+59kVdbJQAZXYCtLNYAbYAwqCGA5nmHSWKI8txkiut6c64MRCh2hqnVpZE" +

  "ZEWFGrA1km93TuSinJ4EZrArO26wMjiKAwc+5b75trdV5/Rnqroe5ebzNqphgu25Tnqgj0oS53DqHrBtb4jB7tp0I0+yFX2ivyo7" +

  "rz37nib+TYmQXw+w+nNoErHTaxEZp9kxam5w8cyc9sliwl8ptuVyS6+Hc7oVRsyBzra4mIEN3Q46xfSyn/3fVghA1xGKBFCb+TAy" +

  "EgC2eZENiHMUCMhBcbCQEfDU4SMhV8G0i2gikl/i5+5/GM+uNOhSGYJnrX8RmKdtZeQhmtMpEvRn6ZfsgC2lHifZTSFaXpcqDLyD" +

  "dyU29vroqHArC4eVEXBpt8RPv+61uHLDxhChP7XCCDsIfvXBR/HJw4exsSrg0UhqW2tr2m7VKnma7UiLCW9BoQDiKDkdV69gxIMx" +

  "V1R4ZqHBf3jgQYRU/WtQTPg/d+wYfufJZ9AtSnDDmaCVkpk35RtzR2cyLSqdZh0wi5XFycRqaHLNlATl6ri0rdr2DLlEd9s5Efyp" +

  "jDPX3iTrrl2TVIhgg9dkY8QA+xrznQ5/6VW3OAfgGHu3s+hUqZUeAMk+8aThorETQG6ikIX+7lNhngpmTZ4AclkSo4BaW50Ie+qz" +

  "Zqwe2LIaCHAtC0E7Kj76H+N3tocTkC1xkhTY9AKaTP3/i0vlCDOuBHxKb10QXlL9ZgvhlXLaJWTsIouUl5LvVQYMYIsrQLeHgmJy" +

  "lOCvlRMJZ4sKH3lpNx7ZfwCFc5p9Ueo5m2K7gryXnRi/8egT+Oi+I9hQdSUzIqLAkoQtUIBuSaeAVZKln3VJQVQ0auluAH1fmCWL" +

  "AE+SvZHQYOQbDCFm5YH3uLhD+DevvQ0Xr1+Pxk9vn78VzwI0/vczz+C/79iJzd0ZOUjMjL4Ut/21fcprZWqPwh/RtE3GW00tFWoy" +

  "5OyUDf0+/vTFXfizZ59B4Uj7ML1iLqbDgwHe++l7cGA4hHOAnM4hhZmD7z39LpMPqshmcqfd1FZuiKyOltCy38KaZI4kW2V4ggu1" +

  "lfXzRKXdjxgUnwATcmD2WF8VBeYAR0SLg+Hyk91uB2DmaDJA0jrBPmn62Mmb1CSAJmQz04qCYYFUOwTr3u+IhrJGJ39P1sn0+9Wu" +

  "NTeBJRcBt1qfmU0M1FIYIWLoiX2vSP1VCwk7Sg9XCjm0X7GYTKeoNDJ9y1Mznu+foqZiGqFZs0yemtWSoEyzYTRFhZ/47L3YvXBc" +

  "mbMH81mOGSOcdvdHO3bgd3bsxLpeB75pAIr7r6Vd0S9M0j0xbybJxKZZJOmRMVkO2hWAJLkXm4U78nSG5GaBxAXNAPjnN9+IC+bW" +

  "TT3gD0A4VfCul17Ezz38MPpzXTA8GidWHhGzhW6fJDX764vFfbQWJT2lOc3HErcdU8iUKunBGexHmOutwy88vB2PHhSweSbnLUwq" +

  "jc7vlbrGez/5aTw9WEG/W6JhywMYy5jL2Fn6NJMtXk3rBgLi77FMtkiboOeJV7WtzzJ6bVkXgYQZ6GLdZkFI617VhZC1VV6emave" +

  "DEa+fhTAIQcAF62b7aWIJj4g4Ra5kS4z5wsz8rqo1WQf0F2KYFqpFVcd/FQUT9b6J6GdScEY4d4Ela1qQbAFHh8SwAKtkSnyr1Px" +

  "yUILpi9VNtcy6Of/lhIYK6lZvX0BeU1OFjP2qQ4xIU4w3ejE6LkSu9jh3Xd9GvtXllBoQNTZFPGDO3zsxd34D48+jdluD857PZGN" +

  "kgRJ2jZIYiYLViSIIFuLqeOzhZ7kGtESWGaLR1nOCSKHlabBhetm8apzNk/f7A/ozizC44cO4d8+8CBcbwaVl3kguS51XxWn2r7Z" +

  "e1xQzteiuLYRlBCyl4rrQRoW0p5r2yowRkUHP/GZ+7F/cTEE7J1NMXDLAH7y03fj7oUjmO310dQAkZ5xQyewZ4WUt0AU9JZK3q+q" +

  "dEq3xv34E13ZiDwxbXcuG2n8WQRJA24Aa0JbTr7VU8cFYgDoFB0UDe8lopEDgM39ziGZRe0DdBI5HnPqIm57iIPrVPF3xmmcC67H" +

  "SUSZTChpKJsooQlobbUutk0fSAZH27haoGAAPC6xVgSTjZMT1tjiOV8pq5UQaOYsGtnmeyKs1ogh/d9Q5BAkYwKmHbCcJWEniAEQ" +

  "TUbeBa2fo1kxjbexZEnDZoj5qoNnBx7v+eSncWQ4gAPOgDkLg5IjcR3u3bcPP3P/g6CqArFHE1ZR6p82q2EULGbKdhlznl6R47vj" +

  "2vdq8YyHRSVlEoP1Hl1HeOnYcXxy50twRKh9c9agKVSvFpHdC8fxbz59N467ChWX4pqwcZfGqWxVbdKyd5oytEYsixBdoqEdsDM6" +

  "zCJAWU4CQIT9TFlil/f48bs/hePDIegsQAAj0uo/3HcfPrL/IDZ059TKFNcKYPyJWqAoU1km91XBlWOGYw/HuSSY5E5oyzcDkybh" +

  "TBkW3dQSmCV1hYPhTIh6ySarinY7PfBqbYldFOWB9MjAi9av7wLqgtt78OW/7BGBfDNWo6G5FA1H00P7jd4z9j4VyCdCLJZSNibO" +

  "aXeq1biJnU/R0qTfVyuRsaYIjMP2wWmZq/66FgKNnT7GbPP1FdqdfYnrL9Ocg4/RwMAp0FoWdKiTCGiaGuuqDh47voIf+/S9GOip" +

  "gqcz7VmZfOkcnjh0CD9+92cxrEqUeoSyyAcF9wBCopXEf+rCZ1MCTv35p1qCVSTwf0qSUa/e4cBbSOi+3DB+/onH8fSRgyhdMRW/" +

  "tgm0o4MBfvTTd2MPM9ZRAaCGV3eaA4IdXjK0ikAgGL+CKFJryLNIBWxq3aPwW4sPENA4oC4IAx5hturi/uND/NSnPxXiJk4XPJlM" +

  "KpzDbzz8MP77iy9hbnYe8MForkLWQKS4I8c9W6Lxt+fZpO3mJyqZMjnJapCY/m2rqchDl90jwM3ngpRJh5iQHmjnE1k32TqQPJc9" +

  "vK/ZETBYGdwFKAC48cILXa8oJ0aMBi+ZohcfbRna8Cik7fM4vawBLY1e1ZNJMQAnKhEYjW+hiOs5AQ+J+T/UkRAr/6v9SJGUTk72" +

  "r7gAVitxjiR01X/9OCJ8pZxBYTGSK3PPfgh/Qhx/kKfjYDiH8fE3YsD7Gut6PXzm4BH8zGfuGVtnJysWhb3zyBG85+57sFh00GUX" +

  "BCOFyPu8TjkoKbrrZNuxVxk3/UnDrKm9EeljmuykQshp6L3Aha4rcIyBH7nrHuw4ejgEUZ5pMeG/Utd4z6fvwvaVEeaKHhpuRBPV" +

  "Flt8tx12FeIpjKdaT9YIANhYuWAVbil+1h4ENh9txgSgHmJTp4+PHV7AT3/6k5D99KcubBkyBo4Iv//Ek/itZ3di3ew6MBo0pAl2" +

  "XGFUikqlWrkZGBP4qQs5cymb6601NzIQPuH9mJVbXRVIfPltC3cu/1azTkTl2CSwWc3a7eME6EtMg0flAE/8ot2PwbHlu1eOHq/J" +

  "FQUxmJLGIRAqGRifnjnXWqABCCAhmQ+dn2QdOBnyG/P3MykjydEWM4dgomhFSMwxCTOcRPz4vPy9BF8A9Svb11ctBNIs0ZwpoKLd" +

  "JWP8iiHgjIsFpskBSfYd5HwGGMNHth0MmGAJQ2LRS5ieBcF4rrGh38Of7dqHX7z3PvHTnrRxHPb6711YwI/cfQ8ONIyOK9AgzVaY" +

  "BuYimpJ9Pm9sHrlijeJHSM4AkFPeo4ISSUVx7RtAStoW2wn0qMTLDeFffeouPHHgAApHGDX+tOe6Xe59g5+56y7cd2QB67o9NFyr" +

  "S5WSwL/YFrOqijCwcyzXHmuH7WxmjnY5X5U26H+EAOaIHTw5DNFgXX8Wf7LvEH7+3s9oPMCpkY01OPL9T27HLz/5JOb6c6C6BiA5" +

  "9W0rrDomotUkEeWrAY4MBER7N9KWnYqiCiChQ1q/1XfyusQdbmZ/s5xpj9jSV3MANav1RTpLAArMkMNNW7d0AOUTN1+48eBsQY51" +

  "pMa3Eow3MizgljbS0sN1X61uBok2D1mANiGMEySUsjZ4cCv2ICI332on6Y82VDn4sujU5HOqFQWtVe9OrRQguCaesrT2hSFpkj9H" +

  "j5tSsRiQ9oS3+BC56PPQsL8mReSzrR2Dz0jib5KdyyeYO4Eppaqj/QaNNfA11s/M4H/sfB6/+cgjKOjEftqGgcI5vLi4gPfc/Rm8" +

  "MGzQrSrU3ITBj1qjk2OfTbtKQYj2yRCMnLZ2OlQ6teJC3Qm4CUoPKchyQZjFmCAkIkGsWw0YM50K+32JH/jER/Hwwb2oCqdnfZxa" +

  "CeyGgJ+/5178+ZEj2DAzg2Y0AlS4u4QlCSunuJMqqGFhN77kgjiNNpx2CVr++DxKFUjvTPOPZgG2UIF6hE0zc/jDF/bhPz5wDwpn" +

  "gcOT5xojBkf+zx078CtPPo2ZmTkBIWZFCs2LFp6swYkCeKJdZyldKfnulEiT1qtzarXo/6wtiSIr8t42Uq72oMSCzjl6ytwCJpiJ" +

  "isGxI41bXrwHUAvCbduuW+kVtE9En0h2izImz+FwGUNSMTmBLezwSDDrEatqsNQNhCqQhRgUGh7TG65KwMS+IPwvHuKQGUvUfB8F" +

  "O2eTLkNCk+hoAzUmqaQHniBxF5+TQpAz4T9XzzvzYtRqLCWmqaBe5kLIJUGtG14pp1/UnMeI6UiZIWBAgapFNEvisHF1asxUyA7E" +

  "kp9DlgaFqjx7zM/O4bee2o7/uX07HJHkcm+Vhj0KR3hh8Th+5BN3YfvyEP2qA/aa7c2EKrg1p/OARAtuCu1mVutGZhrANCZRoQw3" +

  "xnxL3T5sG5NvOZXMQIgTIKUdK4uu2aNXEI735vBDd92Fz+7dhcI51P7kfngTeMyMX7j3XvzR/gOY7czAN3Ww7hj/JCI7fTdYcUQ5" +

  "jO0i3Wo9ZpefYslPbI2WHKLodw87JthaJrPLq+xgCBCofY11c3P4r8++iP/04GfhSLY/TiKbmf0/9Oxz+MVHHsNMfx26DYJiaaAt" +

  "awdF2hUoxsz1cjrg6tvxJgXWUes16b7svSy83LrQ8t+3Q3cIkvqZQMlvrILIdijobgVuRN5SgzT2wxR1Q68NM3WZceG68mUAcHj/" +

  "+x0RHcZo9GTV6cAL544mktAYNTVkHR03ocTIw6jxT9rJK4TjEGGfvdLr0iOX+MSL/2RswSwEY76S9G/IUBSjWUnzF6zV2dp/HQqz" +

  "JdjQhatAL0z4z4M5oz2t1ur1uSpJ3HcAsiqmDK5HLTUIVhXYJBHZIYZnosaTfk1oSLStuZkN+IWHH8WfPP20+LiZ1VTLcnYAOexb" +

  "WsJ777oXO0ce61wJj1rlj2k7UrcwrAa2p4YUdJMz9UP7aIRt7Tc7HT/xiYpnzZVABAv5kfZk4j9onO2YIQNfQm5RcmowZlFipViH" +

  "H/rkPfjYzmdRuhNbAtKgwp+7/1584MU9mO11Qd7rMcU6GmQqHJK1BcujPEHA2APOmlSrNDx0IJih8x/lszkkTAbZ9kDor54ln0LD" +

  "DTbMrcNv7tiJ//jAZyWfAuVWXsuz8PGXXsTPP/Iwev1ZkG8wcpIlMbVopfOY9ATbOB/jb/EVnxM18sldP5kVwMzxk7alp/dPrMfG" +

  "2f623U9a2rkN8msi/VMLltU/V1bHb9t2nR7q/gH5/tz+/DEJmbBALkSFIn1w259IE1wGp1gM+UYrSUtbBMYacLIAZ2MqAZm1Fu+k" +

  "PuQjbdsQvUaMChGICKOmCde8UvLSMGOIJiBZprhNCMRrDgBMYUyHpo3S1+oV2/A56GPywUS+S44NBVrTeYKlLh8KHuMuwSUH6VPZ" +

  "ePRn1+NnH3kUH3rmaTlCWplp6QrsW1zEj959L54ZjNCvStTkJTENKKm7vT1KwQnpYSlMsJ3tpEKCiOF8vr3RtLmzLaO6xiIaHBmt" +

  "4MhgEUcGyzg+GqHxQAkXdiKE4GeOGqlXBp+fYSAG59oz+gSgP4v3fvZefGrPSyhdkVhOIvG9+W4J+NnP3os/enE3NszMADWD3eRk" +

  "ZWbscWouJosHYc6sAFFxW5tiB6GZQJ0o6ELTY7sc20vcGkXKq2uPLf0N+J3nduNnH/hM0PbtvJGCCHfv2YOffPBBcH9eM2N6uMRI" +

  "LnUnKabJouZttdgcjEGn0nSbl6m6Gld422VwsuJWoUmQRUn7wm9ofdfCKiFmZwKbEUCaq9ptueeZfa/Xxcpg+QEi2o/3v78o/9FX" +

  "HHa//gE0hxaW/7y3fvZvDlfAZH4YnaAejaa/NXMcw1B9uxNpg4FEYCdAIUQnUn6qERK/Zn4k46kW1pZFAoTmUNqn1l3pdWCQM9eE" +

  "V/MLoUCJg8MRxOwSF+IrReg39B7LdY3CdVD4Rn3UBDl6KkkRtAZEC2NOUQifqaYeXU6mVSfAsf2OkxPRAFTh+jWcGUE4kgArEMSh" +

  "ai0W7TTXgLRdOiacchANLpKtYylCCIsbTQEUYBT9efz0I4/iuWPH8HVXX4VNvT4ePXAQv/Hoo3huUKNXSZY/MalaVZHhitbvwnON" +

  "0jGy3Whumrjoj7nWeOa0jZH+wLHBCvzgKL7lmptxxfw67B8cx+OHj+HZw0t4eTgAUYGZokLlxMpRgzUvApR+Dj49kVEnIJOshYKA" +

  "ZmYDfvTue/Fjdzq8busFGDVy0qIj1WYJGLHHz917D/54917M9meApgk8JwxRcD9oP5BaeGyd6Y+exW2gCtU0wNJEWob5oQ1KswKQ" +

  "CCQPZMmeIv93Kpy8CGLlD+wIQ/bYODuLP3xhL/Yc/xj+4U0345qNmwAAf/788/ilhx9B0+ujgpcxCefcB2K1Zki6Xz4Fn0i+N5ng" +

  "knWTg+bx/seyGoWNNGENWIWcz+bJ4Ik1u6Pc72GKLYE8aVhcE9uiYCiscTQicw37MABicDPC1rkZWYQf+ADK2267DQBw88VbOx9b" +

  "XJCJxfFIRSjSj36cHGG0TScphQI/kYvDTyEXc8aokuHQSROYuSHl5G9a2ts3TlRMgxgPdIxmKQ7o1o63ZHRLhyePHcfOo8ewbf0G" +

  "jBrxe6btDvVN+O5USkD2a1g8T9ZT220+1VbYnu8nDx/BoZpRVJp5WzLPwLELwSxrUWzs9y8u4ic+8XEcJwK5Ap4pBH2a/kF6mJUk" +

  "SYmLnShupwKEuQUlODG1pwBAPFOyAB0RRoMhvvXaq/GmbZeu7XGnnL/PDGRt0A3pW9grnIACJGumbWYMzMlZ4CujAcmpbv15/N5L" +

  "e/Gne1/Guk4XRwcjDIsCHVeAfSMnF9qWv0lak/IU6Dw0xugTV4VBmQLA8XqExdEQnaIEo0FBBc70dECWBwEE/N6D9+D7r3s1vum6" +

  "m7Jr9i8t4bMv78Vde/fikUPHcGQEuKLAbOHA8PC6W8H88EYf4khnp6f2dZgwKGbxnk9/Bu99/evwmvPOD/QuiLDY1PiZez6Dj+w9" +

  "gPlOD97M/pwoJUoPGhsdm5oRrKWxFiFYdI2yl3qv8T0ZluQg4ELGSW37JAusfO9195DCaAeMfI31/Vl89ugKnvjU3Xj1uedhWA/x" +

  "4OEjoP4sut4BqMMJfakyRirAJil/42WcpqdTgnl9lVrT9+l3nArH9HuTb63rAQn4zLZXB5DOYf3IelJLFTsw+Qi2VKpVrsDS4tJf" +

  "AsCbrr+eyo3PPusBoEvDe+uFY0ygwqJNLbUkA5q+M0WUtmAxYXJS/nEC4eRvgiSRKiDjA5j+Xa2+QEQgi/gnOBXoLC7+dDYQZAuS" +

  "9craFBa3INkSjGV2+I+PPI4feO1t2Fh1J3fubItqGG0ce/bVcqKxTq84Iry4sIBffeJJoOii8IzaEchHa4ycRLlGAEAZzO6l47jn" +

  "6HG4/iyoaSCOXTnxLQaU2kt0zhAoZeI9AAIzKdr+3zg/2PZYs6wHBkCOcGRlGfcdOIQ3bbt0TfqJ0ANbVranOP3daK4WLLtAtVPb" +

  "i+1TEEyrrt7kO6f/ioYxX/VQg3BwMELpHCoWmjnELWlZqxmIW5nGGbK3zDWwZScBjh0H7B8O8ac7XsS33XgdGu8FcgVNMm9lu/WR" +

  "RUaAUziHX/30J3D1xg34putehTocDCP2hnNnZvC12y7H1267HM8dPYRP7NuLT+59Gc8fO4YBV5gpnbhA1CzdwANkSgOHvplffM4R" +

  "lmgW/+rTn8F333A93nrp5ZipCjx75DB+6aGHce/R41jfnwP5GjDTMEUa2nim/ZTgOhk7ixiPk1cJQ0h6Pf0yaGoAUVF0tlIyK6/t" +

  "PZ+g4VKcqzZFQx4aFeBznQ4aED617wCcI/Q6PQANaoiVxIWjEOMoh0yOlLgg9XlSOCizpvdZjEC0+FnWPPt9XAmdVFIDWgYCsuuj" +

  "Rc7WX/u6IqzzKAeisj1ZvbQoCxH2upY4uZcksLJTFbho48wRAPjmt72Nysfe8Q4GgOvnN73wsd0H6BARiBLWYKZzQM/M5gkPjgQw" +

  "dBK+ZwaCJhELK1IzOZsSN7yf2NWEeZ2oJBMRSLInBWAdiZNlOgyoWnpnWgp7sQLce+w4/n+f/DTeeMH5mO+UELOLmClNuw6ZuIhC" +

  "jI4NZ9DGALAXXObBGIxqXDu/HndefBFa82IqhQAMfYO/eOZJLDGjU5TKaByCP8zoEsxVcX2Z+cmO8mQiNMzYvTLAX7ywC3sbjxki" +

  "SPIWRaWSLk3nzdpuoRgxo9PpoV920FScxUYJASimqQZQaHCpgD0Pi1iGal9ifZN0nOI3VCavKXfDliyWM9cHnRJNPVrTPqZrKDJ3" +

  "BmVpgA0a8Dizas2p6GuMa3UMBFB0LwgtAEaDEk4PeQnsMlvi49bAFkhPP+edBNQH7xiYK3v47089g4vne3jLtssm9uPkQi7Ae/zK" +

  "PZ/CM/t24Wfe9k40asVLzcLGB4gIl63fhMvWb8LfubLG/S/vwV+8tB/37T+AAytDlGUHPUcoQWg8S2S7Sgyb7UxyfmDhGMOyj3//" +

  "2JP4g+dfwqaZPp4/dgwLnrCu14evm8A8LSDRhEikU660eGloEPaBrqawKShYi6glBjDwI9Tk0QmLxsOjkIO/2Ac3lPy1ueiSseeM" +

  "7mAfBRfEgicnsDLmu6XAdT1BMmQZZLWW6PwjcEjpTGOgI/ms+UoY4u6N59UzwoEwiZyYmKoX6e/K00N+Dk7+PX0IZjIxwD+iYDXn" +

  "xO1kO0dSsNjSBwL4VZ7tRguLfN7WLY8AwMZnn/Xlvwb4RwG69bLLjtGTT+8synIb6poDZmoxHcoeGhETUuSRTVYKmpJUlwcCGZpN" +

  "I2xTomXTPzGLtc2X8VlytQnu8MwEJI+3Qz47Z76p1qDpF+wbzBQOO5eH+E/bnwGxBzQAxQbGTG5sdikVMuylj17b55kThss4MljG" +

  "t1x6mQKA6SIAQ9oNN/j1Rx7G8yte/LVk+4gFKzuV9hYERrp4DczEEXOAK0AO8M6hW1aYcUIDCeWS9eSScfdrtB/Z5pzXnRvGwD1E" +

  "+zetgmD530UracIYGxBoLXr7TTWVsJlVh8bOsvdE8CRBo/Va7rlOezxhjRDsiG6NA8A4sxqH7+NlHHSrmRb5MyVI1j7F48HTZ04K" +

  "Vsp+TzQ3ZN+a1dHDUYNRr4ufeugx/OlLu3BOr4eicPAkh7il1gQPhmcBej5oQwBY0qo+sPslbBwM8Evf8LfgCjmOdoyhJ220wL+O" +

  "K/G68y7G6867GPsXF/DxXS/ho7v24rHjixg4YLbqwPmm5WqxHRkNCECXCf1OH/sGI7ywMkSvIvQLoGkaFJa8gYSyam5FyleD0OSc" +

  "YrI8IyUtOM/BoQfCi0vHwney6yHt6ekUrYMZJRGePXpMfPyIazDOnOiiEaEv6ZZyF64pfAhCPceqqjDp+HEqL5CsXaIw32UVpGB4" +

  "AnhSmoZeKR+Ol9mTk+3mpgS3rdJsnDVoRfGpp5CO+0Tu6hi9rxgvUZCtzUyiqKT01E5lXVIFl2s0bo47uOW8bc8CwGPveAeXRMR4" +

  "z3scER1+10c+tqd0blvT6FRutc9wlvTdtnxZwIl2miMwXbVjiHOd0Tqbefyxel/eIG7/GAbSJko0sQRrBOV1p0wrJ7hMRq+Ru2Y6" +

  "BYSXdJ1Dt9dRogcHlrxURRYDB2WLQ/4rAF+j0TnjWG7pdXrY0OunnZ16KQqHzfObsNhhdAqHxjLI6WCTDUpKswAfrF3i326YUDoC" +

  "c40GdThMUgQwwr2OlYmtkWwMIsiR+KydBMmQK8YzEqpmEA6b0r7nC1G9ZeG7yFyNKVA4GlpHV/9p6Mx806daYiCl+tkJiEE/UNBm" +

  "neKo1UQWJXPdt9Izn6AQPJJOthpk/V9t1Voltsbb19jmRVJ/urJy5S/mu+w4B3Rm8eChJQz90aAwBKWAJRkPMzTwjBQEesCLgN1f" +

  "j/DauU34ha//WvTLTjg7/kTFJaZ04xXnzs7hm66+Fn/rqqtx/569+ODO5/Cxg4cwohI9JjTJpCOWGBgz1TM8+kTolE7zDQBwDPYR" +

  "XOsgRQEHSszXCqzDyHBI/JQ7f0RQ96oCjx85ir966QW85aJtJ0d/JyxCi5IIexYX8eEXdmGm0wM30Mx7DMDrmrPc9taHRLgH5pCA" +

  "GlCYj3Geyr1ZAJ2C3xRCCqO1QFEEBRAwIa182JQbnc9jAelKWzKBzgxyEVhMBNUtEMBqSTRRQFpfHv/gsargp/xUyhgsaZ+TutJm" +

  "cJTNtn4AVUbNBcrMrtulZnnlyevP33gAAP1rgEsAeMcNN9D7menHP3XXCzuHzesa7RIoYqvY4fg29qrVoADrku9alwYrQoKsVmcj" +

  "FtiQvCcgPXAiojD7EYHpECAn1Jlq30JyObLLnwEVENZmQ9P2LILXs6i1z16ChWQcSC0BBKAJ2r8xTvZyQAbg0TRNsCKc1To9YRFz" +

  "JXuGp0YmjfmJAMBpzobEfBamN2mAMTjEKDReRI/o/AbuIo2zYLo1LwQzV9vcNBdhBsaJgCQGIIj5TDPVoYSJ1kTzCEwFgf+wrhW3" +

  "xj2VNhnjUlBijC/QniSxT3IPh7uQzf1JZZJljZJ/AbHmpFHNlKwVgBGnDyFkz5qwuANmDvUTLGrbeGsRnt5gpiL0UYGo0Cx3nM03" +

  "2dsPBDM8e5TEWBky3tTfgH//ZW/AbNXRCPxTHytK6QJG4+X+2y+4ALdfcAG+Zu9u/OKDD2HPkFE4aHphDjzU0FlDHjXibBJWQwnt" +

  "IO7SQKAgSsJXTuuynRxNYMjSuigqhYeVRQ8///DDWK5XcOf5F6NTFDL7Sa62fA7Qv4IbI2D0ANgzavZYaTz2LC/hfY8/if0jj5mS" +

  "1IpoWxonACprvrHnhJfGhsc+yrbrRhUxytclx7EIPnGKECgdURPiJvhtWxmHLbOUMwaX9ji2nZI35uYKPnwISEz97qAwFFk/2/ED" +

  "JpmiDdjGO+W9ydiGptrvPoghIGbM9AqCpXsUwCsD7OCwud87TESLqvT7EgCu37KFiIh/5jOfvn+WOu8cLC+zc0W7PTDTQjYolqjH" +

  "xoMiIZL2ZU03JmR+/mByTYBA6Hf6QQePNAAmDHqbqVEkaGCUYQZau62BLX9kxvhkgHy8KTJDTpGeJjVxMulsAMA+CEBmp6Y+E/Iy" +

  "Ob1neM3hyuEMhdWh0FkXcoDzymciyIvTUjVdJb4FDRKpSV/jOYigWRmlN9FEyUp/qzNevyYlgEFpPxFavZFxoYCkLfgvLswWgWTM" +

  "TMAjEa6ITCjM7xjuvOZFeH+ELWSoTMdKIIjsrRfzLIX/OBnXNNwpLZOCbeN6iFeHQNIWeLZKU/kfWajqKC2Akfm4lZeYeTUxrioj" +

  "sznHaFQAMHPYdaDGprgGASx5j1kGfvj1t2FTvy8nz51E8z9RIajlS4EAg3HH1gvwQ3d08a5PfRqeSpVLsu1R3A+xP4JxGIXCRdne" +

  "ldRvykFiHjfyBFGXWVxM+OVBnaZsdNlj4Lr4qYcexZann0bXlXDeEjlJCmcDLF7bxKkFkCWAugGj9oxBw3BlgZmqlOBpUktpOo6I" +

  "a29C/B/SeAC7x1g6a50hsFIhogjMRG60NNBMcw60sQmRkMvmqP1kcgXJTA1zMLnRgBIsPi26BmDb9WL3s2dnMooCEoq8C8KfvEPS" +

  "KLkz8pfIY0Mvg0IbHydtiIDHHs0kOwBmmB4hAN90ww30AQAlADz+5pcZALb2Zx/1+w8zHDkK0y0OQUiu0CKM+Yyx6gDlzMaYaiqQ" +

  "J1039o1OTA68ggLiMj+IzuAwqO2YAoRna+2U/5YdMEQYY1hJLQmji7TKgGXrXra7SCezmXz081qnGg5BL9pm8oDsFeYw1037N0DD" +

  "HLohiJwjs7FIZ3aUj6+ZxYy2RBPGdbqFiEBO2uYC8wgyJUwN0i/TRa4WstBmI4CBCoD1WNwESFpfrU4gCzJci+Ihi9mYtDEF65cE" +

  "A3JYF8FEjzhbpZsy73yrH+E9t9ZOW9C3fpMv0okfrw3PV2vcpODdSXNDRZEIIwOVgWuzmsVbPIaj/9cRowZhtML4/tfeiis2bgyH" +

  "FU2jEAiFEx7kmXHh3BzWd0vsqz0qV4Sr2EAxcnebCT2JOxJbU1xfCOPqkzE8GeXSIDEzRdcqHNd112Nx0OA4ezQ6300wMZGu0eju" +

  "If3XwaOwtoEwWxUKfkzo+7DbhEldAWzAJrWxKY+TniembLGSuvhLmKOZ/XkMMI7TIGT808tJtyLnUQIWPBfv51C/LXpO5ncqQ1oa" +

  "O/QZiRIQpmiriTamJvKCq0sqTrIpJvTKwPU4bzHrg9xqljYO/A0s48Eku1XmHGFD4e5liNIPKAB4P97BBODqTVuf/sSBw3SYHYUI" +

  "fZtK6YAhCgoT/KZdrdZYSu5PBTYlxM5otgqjMEKaCShUy+0jE6z1k+szARYDvuwZOoqtkcwCCscG2UzpjMnJN+Q5ISdD6LtsIdK0" +

  "URPR8rSLaGF20opYU8gidimDNQmQyy0/ZnoO7TWQoL42x9G6caJAlyl1SP4E86OZpvWfOAECgyQQCpNXwSTHqgUhnCYZmKRem/po" +

  "x03ka1888vFJSzta2b7LW8fZx9RlwcgBQbjGuRAL035e/gUjToRYa9AllT+4CbRb7dmBV4T7sx+zdjBkNwazjaHD8soK/tH1V+Mt" +

  "F1+EeorCPy22Rl5cOI4jKw06ZZFYmoxP+tBRIhf66lW4uDB3o/uEOMkUiAheU/GTjjm3hAegkS4KKtjXcAWhYN2umUJZvc0bzyTh" +

  "Z2VcXEGQ1gGA5f0XoNOASZw2iUoUWxQAN0EC+5SHmDUg8BuTMfLsVBBOUi6jMsnCT+GzaRjjzCIfiyA3qYeVtyVtz/z3LWDLBp5M" +

  "wGfAIqnFxj78QuK6iUTUb+2eOKfztk6CyghAP9zJ1lYOAJKYS7eyjPnZ+c8AAN78Zg/EcE0GQK+5cMueyo+eK8sKHp5t8hjzs4UY" +

  "ttTpoQTRVGMd1IA3jsI9Q3KpBp68ArtKJr7ZXFm4RF4n6eCTmkpIDfYk2efILppQotUCye6PNgNLrg1904EgH4Q9pQOdpJKMOwoo" +

  "/gxFjbBrVQBnS2atRAqpaRIIdm7ShWkZuxMQkAlVin2wsWH2oalOZ4hZCCIw5iw151oVIsRkPsxZHEPUunw4v5yBLBAuSw2qnbIs" +

  "f3K9/hcEHYd+xwW+xp3kdDrbvJcWNsaMnBr9NaCOSfbZe7Wx2ti0CyHZ2qh0sF0xgS4nBHO5iTJaJpLPhpyJJIlL+vy0fgWQjQIy" +

  "OxCnINKYgHGoT8n7yjkcHQ7xDRddhL9//XUh4G/aq0rWgDDYD+54Foveo2QXtsGKmZg1SA7Sb2hGQRjgti5H4ZFy0yaMYSoaIn8Z" +

  "A3hWl9Zt/JtBqL1kzwvCSv+DCV9WwMIIO7civ9WkQulWcE7+MgGa9CuKn9gmYoSjjA0oEmLQm4dYEr1KMFKN1iXobywmAMl+A2Xd" +

  "7YOriShaKhPh367HGpnOozg2+Xc2lqFfiIcNW2lDTSYkO1M4rAUySyrs2It8lqbCv93/1Ipigj+CMUCCbz2IPTM5zFbl4t+9/dVH" +

  "x9pJKpEc0fE5V+11JQFEnJr5vJrXQoNPwNE5SPR0oibCPiCZvI7sUzBRyctREmSVCm6kk4ph/DgukpxY5m8JwIYTkb2K8G/HBcTf" +

  "gHjWobyI1O8fmKY1lJN2Qvf7WiCamTTXttCkNwGgBJalsiVnLNZOIDI9cwulVwbGzwDBIc1V/rkpHDULKAO08bE+KWik9DNin9IS" +

  "wA7FlzeXCRAZJxGKNd4FIM/T8bJYkgwUOEgKVgLDaTKsCCpDMq+kbxMfwTl4T7+3YgLZDnsxulH4ztaAy5+Tzg/VnqRbkddYxwJI" +

  "V15iz7fDZVLtX9J3O1SuxLHREG/YsBHvuuXVQYuetvAHAFarwv379uBDL7woW2u5STSyKERDv7XFjhA1/5ZWHepvfcGRXNl344Us" +

  "CEBAI2wLoIjHmqMgyu7iGDcCkM4tCvcHQIBQdSxOAgLN6sBxksE4rPFEAzT2kstcuC4KkFwham/DM+UvWveSe5L1LVaGRIlp8fTJ" +

  "0giJVWL897jlDhPXis9WXnouSgQ+Yd0w591t9xH5Wh37TjGcVCVvTAEHAE+OXaeLubLace7MzE4A9KNEmQUA7/noRwvPTOz5k91O" +

  "F5zsFOJkMcokSBDrhIQLhkLGGAgmFB7/yEqo8AKyCZtO3BShZmmftbLMFGQLLYpi6ROl6JojsMgWrRLc5cQ3YR9N/+MDlTZIBH+c" +

  "AGaStzS1n5MS5D3BjsI0tLV6EyIMjh7C5FebeGHWq3vBaj2h9jiFwnHeqCdRGfE4uIpwJ9dKA6pHi/205gFz/GS/fS7gTTRQxaCr" +

  "FMSkDEeWq44tp0eKJoyxDcpCVdEKMvberAOgAO6MxYez6SlSuFV1IJRr/eCQzCdKV2jO9AFz0QiYcSQxH8SMjgOO8whX97t49x23" +

  "olOW+bOnWCyQbWEwxM9+9j4MigrgBiNCCFS065K7kGZTlaPTV2mfrccJ4EXmbfKFoImY5dQqbQlSDsqGfhPkjoCnwN/DKwLBMQGX" +

  "KHFmUxAeaN/GOkitBpb7JPZ5lZEhAhQQtEFQWqxduUDU9yZUEedNel+k5QRtvb0ugkUnaaJ9nsDj5fkJj9E70zi6vJjlEjGcgMfn" +

  "fdpnAx4mkOPaj9wo7uhirsoC8ygf8ADe8f73hy5nfScivmLLxj0V+yyqklsTKZJATe4BUeo3iWkqnzwx4CJMMBqfXIEpB66uV6vr" +

  "YTzLk9Vt19krF9Kpv9+wC6dEh6aOZYNUGGOaAEIUcbYGXUxCk9MtDmAARcnzQgAN4vdrJSpFMHAQ4pngYqCdjCNMZgABxSfMJ4xl" +

  "NlmTPoQxHNc21qyYdYIZFhWymvEhArtWFfpbakmwxetYtqa12bJnC/Zaw2J8Nn12MpYGZlPQbOejQ7emekwO6POU52rMeqd1Jse9" +

  "xJ0uVgfshLjIJxyMSbFEd0/QukL1YaoYLy7GSo0AAQAASURBVKFkAFhP4QncUQAHA+Qj8BgwYzM7vOf212LjzMyancng2aPRHT7/" +

  "7p67sH1hCd2iEP+48ZOWcA8AuQ2+lDb2XcZLKd5LnsPcDjwOE+5TIe4Dn0nN/NC/rfGHcXKbA4nbIZlTyu3jWlYlkJU3S7KzdAwZ" +

  "YNlqCAd4NfGHsZ1YCJJhkoL1Qb5tFbPstIQjYAoZRTqlArNdDSIfS58xaY1M9MEb0EtAlX1Ge6y1I2MRNYRA1yR4f9W22D3hbzJP" +

  "DI6F9UgyOv2y5K0z1WMewPVb3hG6Wtqbf/3mN/sfBbC52/1kb3QMh7wvCirClhNLYMBADJZQxJkGqkwqbQQW8oqR7cdeHfGMUSNc" +

  "gzDZJj1PtCWNbG1d0iD3AcliS4AFScpbBoJPSvpnkyq20drOLL4gTkL5zdTU9jlxa7KFa+MFE5DltEoEI1Hl038YAZBY76g1IcN4" +

  "axvbGko+jhaVezL/8dmX4M9cpRDStaLbuKyfNK6vShKXVh06r5IeJmMV2edaFUtvrHsSAmMnnDiAVMYKMJdTm0zBL6rjb4LLdj4A" +

  "ucZmNEOy9lOhQmFve/R1xn1eExoYroFtZMwYaxqs2a5A5p/HcgF0lhq8+45bcfGGdWt6IBN7oCwK/I9HH8f/fmEX1q/bCG48yqKI" +

  "EfNUCgANS4x0DKRThVN6F2nfENYVSHeVMDRYlxA0PTY3bBx3W802F8ibQNH7wiMoXB3Fhf3icoCZrm0WKZ6u/XifiFFRjJJVZgCC" +

  "TW7EU+2SmzPJOUH+JUA9tsto1TaNZ9Yt60uiIU8S7BP96vY5eX77d7P8Zi1OZGEaq+ZafLNdwm56jvyybanwyefUBSHTTHiBATiL" +

  "M/EM1MxFZzSirZvn7gYAvDkyqgAArBd/65prnv2Ll/a+XFTFFjSeiYjCrtrQgLjVKuiREwal/d4eE6aID4/NdhGZgBRk3DbxWF0n" +

  "QJC6cHIhN2HgoQsGiRYVfke2aFIsmo6fABmbZOmAuTCYZiUB0kWq2pkhWfsROKHZ62xLGisfWmtSnm1LTkqr4PnXfifgSidzBojI" +

  "3ABCDwukW/MQB5UxAri8JlQhDSYiRcLW7xi5bCwnXcbKo+PcZgWCjLF9/3beAzGhWes+avFhe1PUPCJbHy8yNgWgKX2jqTiaJEkp" +

  "Iyc5mjaPZI0j0o1ZgvEy/EhJLA30+vib0T0Ep8Gy9kkD8kNbI8gJzJs4YggTKMRgJ6lpRytL+Kc3XY+bzz8PDfs1i8dgZhSFwyef" +

  "fRo/9OmPgtZtAS8tAK6AGxVwTtYPIY2DkPmXhAfL2lewbbtnAtVaoCoz+TPD9sjH+WujH5xfMO3cJ7fZPA8COmWP5GIAXgAXwfmD" +

  "eDdFQNaacJ7ksDF7puwGcuiUJXqFg22HlKNqQ6QIYmP0PICW4Is8Rfhq2DkWgGMM7MsEer5Ux8YxBwsUrVX2bKsm4XeT4gcouZjj" +

  "DfqjzPygDJ1AYUo73bYe+9aziSjsznEUQz7iM4X+HsxlWVBVjw78nesve+LvAvjXAP+oXh4AAOnG2pLo4A984hPP7h7QlroZqh29" +

  "LfEsGxjiT2GhRkJN0voMAXPYHpMGKo09ZoxIJoTS/bEnujkNDhlrj2EXu8eIpwOQxgLI9FzlcdaWZHDlmEt9to8LKESWmzCZ1IkT" +

  "4Zspl0gT1RyYshnV9rEZso73Gr3iekwHIACkNe5PcK9Aj84MbnLTWmT0GkoBXAR/2TfajzAvKT4jXsUG7YSRJdu71qwk89eTuSIS" +

  "bBum1oS5DoBIQIBHoxplPC7WAsQAGz0bs1hPAM2raPIGSGxNuYRxJ8srrDexsqUiJvctGyxJ6RqCGB3g2KNAgSPLy/hHV16Or7vs" +

  "SjR+DY9ihvR9VNfYvvslfNstr8b6ag4FORRlgZKcpg/WuASy2Ajtd5ALsvUvxD3YmjJNnZEJf0BcpYYSGBKUzcRJ0F5QpeTfZA+8" +

  "gQSzchJSh14i6BCpHkBI0hxPCNkWA5+DWjmBVmpiWR2HV0Z47PAhPLOwhE7VUaFE+TwNPEXqSremjc3n8FlJ1FIOhZwt/rPKONpf" +

  "a79ZrJKaIogwbb5lMbBtrZlQl6xu4RPDgDRgi7QtI1NwkbuR7WClyMNCe1LFk4Fk8shzFGFSUdA5RbGzonUHtM/hAakFAO/56EeL" +

  "H33zm5vZez/1mT5Xrz0+WPFMyeZZIwbZOQAZRa1lk+iddM6YACuSl4mWbvdIq2wjwogE084aYbWOhCMGi0sbHQJIj0u0IMdc+soz" +

  "0ojOsX5Z3xISRdQamRibYEFkopnAWMU0NM2S2ShazB3J9wwAjuSwFRf70RqdFiI1OkItMPK97XVOpOjagAHmsFOlbSBK3VSW4TAG" +

  "73EAPnEKT7JcSZ+zYaKoDX0uohwETEEFbEJP+93WBsU+mN893Au5l9M6kDA4ZSZtbcoA7qk1UgeA0/3gHAxNWcOTLwPg1tv//+y9" +

  "d6Bd11Un/Fv7nNte01OXZVmyZMtN7nZsJ05iOYQylBAYJMKUbxgIEyAwwECAIQOyydDrAMOQoTPMADJDnYF024kT995tuanY6u3V" +

  "e+85e31/7L32XvvceyXZeld2+L5tP713zz1nn13X+q26LRwIFyIVzU7spJ8sx/HZOWw9dw2+9ZJLYS3DmLivh1XyLMMH33nzUN/x" +

  "T6l0yy4+u2sX/uvTz2DeNFAjUiBCALd3UJRLgT6pNZgSr7DOteDlrrtP4QS9SnuqfMBfDL/77+OUqPQzJci7E0wja5mBTL2ySl8G" +

  "m0jT+wSoAOixPjBFKi2wwzJsq9E0TeJ7usx0yx13ZLfefHMhz/TqyYh4RbN1f84unYLObsYeOjppqzI8CrkMcpgIjngsCAggf3ys" +

  "nmjpd+8+dkiWEkoiCLdfYcCf1NZv0sP4Va8rKm+Tdgwm8YTelijhOvwKTEg+C8jUMzEs+sUmLOMkVAdqQeq59RuMgegk5p+zlM53" +

  "dWxEVW58/4YplQGyGdy8WYooWxxjvGUtzFFYox5kSpw1g4JHtetuGsZmVPx6dQUOGwCQypMPtcfErt9DBCuq1JArH6KgTnVazD6m" +

  "OTB9ip06AbBPQLUAXA/EJT9HwCuVzzJP8f0EwfxBElQDXRLQJZfP4cjcLL567Up81+VXorTsImxAw9s/qs+WXTa8kvmUf6z6KdXv" +

  "f+o/tayGrzl3Az527TUY4447UZA9bWaXulqzaTYRIBiJBvCHKsGv9YTHqLUp10U9PohRV38r8THMcWXWoWlKKKIpTer3prYAhE0A" +

  "tKhI8f00F7F+z3ADhUliZQLdlT0lKfJDG5nAhigrCiyv1x+mPrHmCQC4xWcHunTV+ffWu8U8A4YDi4qbNDZOEIEoulInkEFFAwFd" +

  "wueEM/ay1r52k5OUqrOIvEfH1ur4VIZPngKojDHUU9egEpaViDTiUcZuMYdzq0V6ZNY0cUFL0lp2izIk5aiMiyOgblmEsaDK8345" +

  "iCq436IUVsC+3mFHyItqNdCElB1C7HvgdL6jxCpr23XY3Rq1VhGJy/vcZxf94fKoDzuTY2DqrMOtolNq2CWcgtjeOuS6KJBjnHZ1" +

  "6QXCqDUBfYpERjrAZAIMgFeJV+vraZP/zbK+BJARUBoOSVQIJWowOD7fxlevXokfuPIaDB969RZDhMwYl5zoFH+M+snU73/qPwyg" +

  "W5a4cvlK/OCmS1B222BjQi6I1ASn/KE0gJWFHaKYsp61FGz58QH/LIXve5yx1Xc9daEq2PZfC4ERq/u074y7SPGgngHvqV53qa39" +

  "j3cyDgfGMSshmdQz6b5nZhorulibjTwKAJsOHEhe1BMGCAA3LJ/YMWKLV0yt7uS8MAicZJaKBj9Ra4d6+nYq7Rw8fejjKyBfBtG5" +

  "P9kJtpsB75LEFv1ygKWAIAKBFAl61OUH+aT90j/M/jxxpRwmigllOPomuO9MT2z0QhXd2hAiHL6sRGEExtJ/7C1RCM+J/gCK8QoC" +

  "52g6CVhO1b9QRcbWwAQnQGGS+khZzyph4JzGcj/pXQa61vU2AyCtJmXGkH5pzZOMl7UutbAcjT3MotcSC/ByCCuuMV/6abukjoQI" +

  "+n+J9eqVStBXS6RLmGeOKbHCvQmQRwCEgUj7jkS1ZfrOqOKUA7YYNTI42p7DV65cjo9cfY139nN5+auhmf9/eWsUAlDLMpTW4qZz" +

  "1uErV6zAdNl20j3HNRk0dOwiIHrXm3ajtEG4CO/RIFXRVu0Dlvo0DaLlGnj0tiMBB8L4WX/HFbIp3MQooYJ76qv+TUQ+i6f77ML6" +

  "egXhKKQg0HIigmHLORkzwbzvW6677FkA2LJ1a4JBenIg3LTt9twYwyN5/d6RRgPWQZAgObjtGl093FNCAAWhcOhA2lgPFghwaYQZ" +

  "PYYMoIeQDrKTuEVTnWjE+kQqpLSeHrQ14EMIIaF0QsX5LbTBM0Xd3rhw9PX0Nc6ZJ3rmnopm4fQKJ42QDddvC4StNADskAcz0CDM" +

  "o0BW86Fo+FAKJX9Q2AACPoRpG5MBJkPbEo4XFlNFBxmXWN6oYVWzicIW6LKXK0TKOIF0IPOric4J3FIXrK8hs6Hf9O69/U1yVavS" +

  "ABjt9wipu9xPX6mk2iaZ7zhscjOCBiCFoImmxRFl/QyHDJ2iODPsTpTMKcfh+XncvHIZPvK2tyGjmKp4wZHlGS1D2hxvsSIapm86" +

  "fz1aZeFs1qSBG8n/PbNJHvBGEM76KQB+Xw7UDveuD31rCiT66ytJlrNoo+KFSr2eVwYBxAqEDcAl3ttPyFDv9NuoVGIMFP0Je0lr" +

  "OfzvElTm9TrqJd9jiKa2MUt0eyiJEyAAbN4M3HkrY3Wzcf+uTuf/Yfan3PrmywTJ36ykH42o+jFreUzJCUrE0AitZ0wrgyUsMwoY" +

  "UX0oKEkIU2QK0PdVC3k1dYXI9bcFCXqMAz64rRXHMdV+eHBC3uZ8JgCA8UyayB1I4ZKopC2TEwohjnGDkLKXPskvbxs0AiZd2GCA" +

  "y+F1C4DnEb5N7sefzoxOwZjHHJpZjrObdVy6bDEuX7oMF4yNY1mrhZwMHjuwH7/51DM4agk12XAVwFZdG5JsRRRhxgx3/oQhCjEU" +

  "BQAAUOi4K/2aQsxJljoAEPuk2A49fUPMbDmoMc4B0nLcY5KdIHiRh4UvnvlpKFWi7vefKewVCtctAJMZHJqfw+ZVy/Afr7kOGZme" +

  "o3S/HEtIbkYi3abz+E+piB/QuZOLcO7YOHbMF2gQAGSIpxj6QuSSH8WP6m/3wYhM6WmsO9ZYQPJgWKX5SOQkCLSMgwa6B+72BcX9" +

  "irXshFxPHAJvM8qsSMo3qiKcps7qCG0i384efmar64bBZJGjxNLR/HEGgDvu6HH86QEAYiNYNzZ29wP793ZBlAljDehLGkviBa0n" +

  "Ku1QdYeyuq6/GciY1XdVeZUr9STvjrAwtIEqv4GYo5kBnzxEEaAQJUChzrhAwksToqYuq/4KMwnUzq8LL4OzBOUMu0iSFSCEpVAv" +

  "yWEDwAqgi6FCAqTC9iGRPhUw43SMpf+2/9QuSJ8AgK1157MTw1CGDpeYLi0mM2DjZBNXLF2Kd6xciY0Ti9DKepY9rl+1Gq1aHT/1" +

  "yMMobQ0So6G2HTT7l3A1howJYegTSHGdaqU/MZwDHHvTBbFa1f5BVLRUhFRa8szXUaW4x0/QFABRfS/Jf+I6j9ISiMJ4hWsM52xZ" +

  "UXnCE2+r6qgR4XBnHu88exl+4srrkPvjp7Mvc+6vtaVuHORYYOCfKghgZtRMjmW1Fp6dPQZTy1DaEtLvwEqERiJeE+lXGGqo0//W" +

  "XgECPqsnKqqWBNbAHhh7yhVqjKJdVciLnv4DehkbTTriCIGPieOu1bxT/eF4SjzeWLRdSYfVq7Qvm4AOyzD1Elg80fwC0Gv/B/oA" +

  "gK1btlgAeP9lFz35D5/afcgYs8pYay0Z45wSUoQSBHjJ+84YMOBh6JyzHRwzlUQ4g5i/Hh1Ra+qJ6X9vfyTdQ2wgqSdifLtViFIy" +

  "HgbpnDm+O2Yl6anbfY5qJEK044QkGlTFn5T8NayiaYuHJk5yUy8VyUpHGIeFSxQARByN/i1mZsBkYNW3hS6y0dlaWC5RGMJsp411" +

  "rTG895yVePeqVdiwaAzRw4KD2cUBG9euwlpcvnQZvnPjefiNJ57FRK2Frjt+MszSYIAqSU2G7OooUjLFJCDCSykssKoU4XoqERzx" +

  "gUH98YRRZ+bqaQYr6Tsms4LS3oXQVyvrxu1bCdWUe3r2sCfaQpANGRzrzOOrzjoLP3LVVaj544mHcbTvmS1VWnQmTgN984vsu/E8" +

  "8wTIRO1V5GCBzgiABNwqdpRE3euZ36ARC3uAKKZc9nWEUHaqhMsC6Alzh6bx4u8TRQRWe7Ofz4AWJKzPqhs0aEgpvwDx4GMVGxUE" +

  "OIqbCB4xI3AUAtiCQZlpdbtT37jx3Kc/DODJJ5/s2dA9u4jI8DbHvTorm83na3nNmTMCIjG+cf7NMjmWkgEbuIQDgYgTG1SFZMAS" +

  "dkXpM/7rIPXrFRCRtJbRKmgQ6JmYfpIdmJzTJVES/x98CQhw4U3R/kJBWxDbJc4bTHBHnwrgIB0b71tN5O8JjRg0eqdZFOMLSy4u" +

  "uhihJVKIAjcesDjmGYPJmOMcKj906KQV4qkxjCJzmpNBrV5Du+zim9euwG+/81p8x4UX4PxFEyCYELLFjMQLW1qcE6Fki29YuwGb" +

  "VyzHlO2ilqyhasic9vpVNsFhFhEA2EZpyOfkACJDTbVPXvoOaYA9ufXzFXKW+59Tmacg0QiBRtwfmpwJ1oieyhzWut4DvrGJSJU5" +

  "+oUjnVm8b+1Z+LFrr0bdg5ZsyKaW4RYGc1mR/v2cVn5OqbaTCU5v0UISRuzppqaHQOQlMXRXZ1LUFQkz9OOpaH3iWxDxstqnyk8r" +

  "IFehX/3aTMlvAN7RXOTBEzmKe1+AIMW7tmZMyJhiDgx1f9hA/pPoJJms31OuTiu8Sb0Jhhh5jsW52XP+inW7AODWW245OQBgMHDH" +

  "HYaI7GSj9tl6bmCt8/W1EKamYqNDRyWELDa4ZwD97SGSQKnng8pHVduDprh3omLNg0s17FBPUpwQk4b7SSBqIF4AtFrYeimJvd0z" +

  "ODO6e+UwGopz2DcaAUjY5gn7cfrFbyUSCT4syyTczy1oFoAeDMq9reNwNUwHK8cU+IU97Pg4OBVZ2e3inZOT+OErrsFks4WCbbAG" +

  "ScjWICbtQhXddviuSy7EIsOY823XFqU4CGqrEgZndVzgEu30fq35xRPhb+8al9kOHsq+H2Jzd3Qm7j8C0HMQQrUdiPtZcAD5+Qaz" +

  "UuErX4CqZERqBfnvxdPZsMH83Dz+zfnn4geuuBrE7jvxJfhyLBzCuXQhSK4JLWCdKpjUQP3LqbRLB0oldiRqlGWdUEy7fQJgGlaD" +

  "8AsljUezVrih/8rh+B6pp+cW+P1CcU85QVCgB4f3Bq0kqkBACVThio7sGTyPgVongqNOoS1inYdDzLZRzzHZrN09VxR00+235zhZ" +

  "HgApmzZvZgBY1xq/a4IsSmetUy93cMAqGZlJ8jj3JA50zQvoKX42nlhERh872cP4dUKiQHVcp40RQBIZVXXYE7DhP3NYeJHxS4Kc" +

  "lGdFkHOiEmoJoCb9nvvcm/bJ9Hts4Ysfu542VD5rSVLU//EM6wjS3D1qlEL3HVPsd+LjghcCSlsE57eSGXkI4TzFKsip5FaMjOPb" +

  "NpyP2c58CC90GjbNxFx/wgbsw+AWusg6ZgiYjIOuQxQBJHuItO8vlZCogbDvyK8G9Yyez75toT6nxfm2WaTELJjPxCu6QsR0ycHo" +

  "5IyZch7fffEF+PaLL0NpU3D95VmEtgnD10wfCAScqEKTTlIr96qq36qF4bRvHVvi1fkZ5Mi9RrF/X0VgIr/i+4bZJoS+l3cQREpX" +

  "9K4yYPF25QRIWjDTr1B7TDveKeGC4AVApSEMvxXNrFLgYIruU4j1+oj5dmQtBWDvAXwJ0AiAlXnrdiLizX1rHQAAtnh69y2XX/JA" +

  "Y669Pze5IRCHQSQfDkjGx4QTxIYV7VkVtK9sHZIWRi92q9Ur2iaj7Ir+glPdVpm5EEL1o58hEVdUW/RNAmmQ/FShRPTgtMSwKD3w" +

  "6QM6SNCsG41MnOk8SGLK/CLzDnI+bKSnYQtdgkeNBxxecCXLwcMcHGAdCDYe6wpBrMLv1EYjiRjw48GyoN3YDo83ekZclqjlOe49" +

  "fASvTk0ho0qq5VMshgglM963YR2umBjBVNFFDgKsV70FBubWefB4FyY61BIlJq+P82FyAHGJ3kOkhHAanwNe+z74OzTIc6IDhJic" +

  "qDdCtsVsZNl65h9lmugAG3MFVEvI/OdSKaFDgGm38ZHLN+H9GzeisC7rnyTQ+fItBKIsEO+4hk5eTgSeq5kq38pF+vHq9BR2zU6j" +

  "bgguOijuVLF/k1adesasBVhZd6LCCmNAmg6na1nU9AB6+Ie7R2hbxUFdfirjPOizgGCroQ1LZEKMfpF9YsNm629GFEuJps+U9NO9" +

  "r6SojSjZmlFw+fYNqx8HYpK/aukLAIiIt2zfnhmiYxNUu6fRagCUpfnwlI0lEp4TO/MFRtlnvYYJshzqD971aeNCOs2qlK/f0fPu" +

  "yuSnNiJGPDfdLwXWtWm7XGpr6ttPT0wJFGCEpchUQ9pGOMsWkRDnCJKGVnTTEyktosqenmlmL/OhpJQUCMT63GItYWB8Ss+FL9LW" +

  "khk1ZNg/18Hndu/0371B0YiBnDJ8+JJLMcIFOhQZmTBVQCTgM0l83btM8NIktWLcmtWgR0wXmvClGgMhpHHPxbecpHDYGUEPWFbs" +

  "1i59tDMvlUAIQRT1rGEGWwZZoGYIc5Yx0mXcetXV+Iq161FYd6rflwd7e33l9TDtLxcGf6rl6UOHMVP4xFvG+GOP/UqOasdwP3lz" +

  "alIIIZLKCTJyQTNv2Rcxgq1/xFZVIEXYX0GVr+7VfCLR2HAED2L6DEDF98PxGveO1Hav3hXM0p5jeFNDUG9yCqarzocMsvVGi0a6" +

  "9tkrzz73CTBX8UIoA6nyJcuXEwNYt6hxe8sA1pZs5ax71g4ZXm1NQj9OTHR7pEY3MkGe8gAw6ZxeDOKRH+z6vmdUmSj1xiDysKrT" +

  "VatiMitPRnucqYABVW9SdBrkqNoLazS5t/edIY5+yCWqdmWB+/cLkzuJ3S3awXTet/idMB3AEXwyTsswbDJuGSgtI69luHP3PpRs" +

  "37DEmBk3FxcsW4pvWrcGs52O8zrn6phECeNMlBBLTwIw4eZQEb4YmOeKY8Di6REoEZgLVD2PQi0VINyj2QgJfKp7JpWqmJ12SyQs" +

  "rQUEXK6FkgDkhCPdEsvqFj97w7W4dvXZKL2n/z8t1vf/FwB4YN8BGNNEBgCsI1R6tR2pSUS4hHcWH7g6FHOHXquBSaWMXkSzClON" +

  "dfQHxSkwU342LKAlBQQAuQyH3vzscA+Hp7WWrGqyJr+XBJRoAVa3w0V0kW01mljRqn+SiIqb7rgjQx/7v7t/QBGVwaVLmp9qtbsl" +

  "EWXaaziEYgTp0P8QQBQlgcTRDn0EZzEnuPHxCV36tLU6A/oeiihIiL56I7RtJTJjpVIip96VnMtRdRmddqKEXG2G7p9MSozrF6Kq" +

  "wQqYVKpZG7piJc9zb+8XpLAobsUeG3USnpdFtS5YNBRpqS76/u8hD4gFvEXUu9AlaqGAkoGxWh1PHj2OZw8cdBqYNwSq/HyB8c8v" +

  "uABr6nW0rRiuPODlOE7CJIel5QitCkK877UfW2eOAmK2sVgcoPNzXZVwPINPmDz5bSDmIZlHaGJ1ah7qumi7fwlG6Td8g4DD3Xlc" +

  "Nt7Ar7393di4bBlK5sj8h4wA+E37iXTvTfnh+PeZKKU33e6emsIjh4+ilmcolI5UM9kYUaSd6iSe3q1nfaiOVtmT+heIa1euChAd" +

  "FLUTvkO69NJ7e03QSVECZz9eFsadtcYDqSaOpKesR0ZpDZRAK8/4YgxhHMZuGBv9LABs7mlBLAMpFhFZMNO7Nl71/FjZfTZv1AmW" +

  "AhkMDYn65DBx0VmjX1iEZs1yT7SLkdoUQQ2TPiYNrLa38p7ewmrVRx4XWLQbdJa+2NCn8J96Zd94T8BJvYkGQy0q9gMeVK0ZyPtO" +

  "WDH0DLGI3Ti8xY+H8YtPj3tijgm3y9hSz/i7x2RRygaLr4mVLGSPYn2ij8jZYM4YfGbPrtOqluC0AIsaDfzrC89DpzsLUOYYPkQL" +

  "Ine63wNA9oKVCC2dSt0RAeNXZ+mZfSTr1LMWWRE4Ixivl1iJiWoABx4E5jQYPhFxZTbIYZHD4GBnFl+xbCl+/h3vwvLRUVjmM5bg" +

  "xypC//+5H4p/n5Hi18Vdr76KI90SNWIUHni6aKkSLs7fwgTBDDCIQpk7OdB/xSkLDKTcfx7UL3EINPB5AQZqHEITIl0bsKZ7rkHC" +

  "wDmEfeuf9KwLBVCUVjtq7gjMBhyESg12CBQoQgAPzGTy0W772L+65povAsAtmzcPTMPamxJNlZtuuSWjW2/t3nLHHV/abfJL5jod" +

  "C2aviawMBrkmeDYMZn9SWt94VpbRC1MoTn9kpdPsGFHlSR22pF7t3qnVO33UObLgWd5NUC1W7+hjI3IMTTFA/5M4pvh6dTEUpdDY" +

  "ZguQ8fyXwmYMrLmi/lmw4kMWY1w2Qq5pAFFdBb+cVGhjdaEbK4BHI1QZA/eXZdk8jEFJZRagSwCc9qQ0jJItWvUcX3htPz64qY2R" +

  "egNpC0+9GD/vX7FuLT75yk48ND2P0YxQggA2MHAOgyxH6w4v3SEAv67JrSM3ztrxNqxsyKpmZhg2YDmTmbyjqa/HQDlK+ukOkpFQ" +

  "VAVyZG6dtsyv6X4EsAIERP3KZABrkWeM0gLt9hy+47z1+PZLLwVgfCbOM8X8LQyZcGQtqd3pVLkynhz2Tehfn/pI76lwT6BMXpCQ" +

  "SAlO6/ELVDNklzpETmuM5IBV/XrGewqHf0Kdwm+CCdRn4Btt1ABSCXkWuDCcVDpbFLh9z16YWg2WSxhlVpO8AETkHG7BPdJpqr1K" +

  "1x6Z6EElHlWJUMjsHdZdH8UvJizvikYgzk0cw+paHyxsqnYxkoyXgTd500OYR8U/g/8jO9f7yKcIDAtJ3x2WKFyOHrdabVlvjOQr" +

  "8vx+AMe2bN+eEdEbAwCbN2/GnbfeijWt+qd2tMsPTgNU81MTNgsrAkRwTj1EMP3SfCb3x+txs8UShkdd7j/gFaKn7+NIw5JN4G/s" +

  "N6moMH9L4uut28KAEFL/7riQ3G9WMC9pk/ROg5iwWYUYD4sIUtgeAEL62ECo/MKMKrjQOGl1AE8GSBQWrn8mqoytn5EzRNCLsvRA" +

  "i1DLMrw0N4979+7DzWvXvmGp0oEyl2Pg2y++EI/f8wAoawFsYYnjkcqiLRoyAIitUgsYbv9QRF5+/bk/HbOGz6wXnWodMDcpkTQU" +

  "QUDP/KculUQuG2E/zRsrUQBe8+UcAoFGZjDd7WAMJX70mitw05q1Pl0rzhjzF/+Cz+98Cb/zzKOw+RgyZlgjEhWDKAPYOs2YZEWU" +

  "vS1zrcBRSKgU2I884k50g+NBzifC7/WokQzEyI2bO5QEWWaQwcCQRJm49/U4R6s/5L3E0c+IvZnR+lcZyygN4WhnHtePTOBj73k3" +

  "yAslw5gB9sDu3ldfw4tTM6i1GrBKu1jVVLmLJwYj4gcT36EQkqsAmvKzfw8syzTBEnx4XaR7SrVX7URaT0XT1UPfQzsRGL7eUW7r" +

  "pgKu25GSgsZnhvTj4NpqY/OkEpIV595jiTBaM1iW1/6GiHjb7befcEpPCABu2by5vBXAV69edvcDz+6aPURmROn5w2BEdIPKxEXG" +

  "XvVUTIsiHrIZoFl6WuI7OWTQDFJRP0nTM2S3OdLNE9olb0oImR9c1iol90L5LtyrhCb4doQN3tOY2OfAdNF/3S1s4ZQ5BCKBIIHI" +

  "uIoUKLMZSIPLMZlkd4u1c6UT7mnV3aEV8UBn45xsunmGz+xxAOB0iJpocC5bsRI3rVyFT+0/hPFaji4sSk/YMzh1YmFfv2389RTF" +

  "Y+QfJRXJPylhtZ536UyVHNCv2jdIaWcIVQrAQs2zVYQQFeLn/xZvBGmWIQtDOQ6353DteAM/cNUNOHdyCUpbwlDv2e7DKYzCMnJj" +

  "cOeuV/Bzjz2GTj4CdBz4QTcyIuLSC2n+QBdP1yIOcBsp+kMIgxA2Hd/ptrj2IfLaxDCsXmKFPx7XCebgrpyY2oc2CKfX7+Lo4wNw" +

  "EHRkX5KnrcRAaQBud7Hl+ouQmcw5zS7IGPcWggM+//jSKyizDDUPRoLw4dX70Yem0q9+JSEzoaNqiFM9i9AziZkHhNmmNCtJCcy9" +

  "oFfq9hd6+FoaZUCBYcs2OrGVN64muS2cahpodoXPhHcahw1BWXNu3t64centgPPlu/UEbzwhACAixvbt2Zo1G/dMvrzv/r25uakz" +

  "P2/BnAl6qTr4MRlkXEVEuqGBgiEQI+PPVfePyKliAWSgl3+Q2OttZMeBsAFwqqUopfstoStIQEAVgoqHppMCo6TjA/eSe0sv8ZCu" +

  "L7SRHeKOu1QxSn1eQFQzDo8Y+jMJSFwVA9d3n4jBViQxljucmj8QKoWoGanZRaqSxRp6y9XhXdA+AYTSUlDxWWa0GjU8ePgADszO" +

  "YPnI6IKol7desAF37d+Pggwy60w2olKF9SeADbHI3gkMiOAkeaNWnyfwOszP3epdzmSpe4rkfAF82kvmyOtC8bOoVKFaHV3lTBE4" +

  "Rj+JOhl0bYnpcgr//Kw1+J6rrkAjr3lnv2wYQ9W3FNYiNxk+v2snfvaxx0GtcYyySxMNIkQfTjcIbhcYl4LcU245YVJui38krCL8" +

  "ZkaoNwo3bgJIa0mVJi4yMk5qFNlL6Ap7IOHmgcLcRyODosMMGDgTWZYTpmbb+JfnrsdVK8/yGrJ+7F/U8m8cGrgxN3h43z48cvQ4" +

  "Wo0GSusPXWMGyIb+Bv5QHYY+JQqScW2G54KQ128/ihkMIEswBtGfsPqyfiZoIGiEyN8j75Si2xP3DQXZj7yDa39n9+D+qNYcQw6M" +

  "Ex4XnvSgxtfFtVrdjKP75DXnXvgitm0zpD3y+5STzuy25cuJiHh1a/wTTXeAQ+Cy/UI2AmpSTJASJlFhtIgLO1zTg0kqQy/H73tU" +

  "LqJqF8d9oXwB4FWACvsviEJuclcHR299In/oSYLnvbe+ihBQ/Ygahag5SMBqVeSOo9AzNgtfPOGJjQlj4DQWCEQ7wc9xxkMdTrUZ" +

  "Wy/1MStnQtUjSvq68KUU6QcMNkCDDA52C9yz+zUApxdiSeTOCdi4eDE2L1+M+XaBnI07rjRIDOwYyRCLDrwMKmcjkEDyUwD6yN8g" +

  "efg7LHkpSMwGYe8xyKRqyuhUKIw/OkOF+a0sWT33hglZluFY0UGDC3z00svxg2+7FvUsd2r4M6TyB9z85ybDp195BR97/HHYhjPl" +

  "tLkM+QpKlcYoJFwBvDnLkRRrvWRNwma1gAGVZttrB4z6O3HS9E5t8jk8Z31yMavq4RjmbnwSKO+kaVULLNvQh1go1FECIEOYLUps" +

  "GG3hX1y+ye/5wfNwejkIIuj+2+dfQNcYGOtEjwTveFAUhaxePnGCVyTtDFkpqcp73H0uwMXXr4izvFmiM5LK9esS9BfbqEPTqzxP" +

  "zNAR13Gi+Q21JeaH6PCnI2iqLWJVA8Paej3H6tbonUTUuWnz5pPy95Pe8JQ/QvCq5Yv/vjU/xyU446A7rjg3+N8uN4PmDgaEDGmG" +

  "QM8oOcY0JyYCjkw1dvQERJz1lAgjRpRIWbM+tWn9JRJeCArJG4h9OkeWRUFKOvKMkFXqFYVAAa8pkHOuq02n2OZwKczGcJikHsJI" +

  "UCgSvIRbe5QbpoMqlag2hkGmsOABm6jTtOZgwfsEhbSNy+lvSiDLavj83r0An97RsRo2bbngAoxYoE1Ow2TBsJaTPA7DZGtOQlJv" +

  "cJMISdIsCyv1ZI4aApEeSaQT7/EvcwbPqIgqcwx4hhgZlttnURhI9oEByjzD0dk5vG3RCH7r3Tfiq9ZvCKGuZ+pAH2b2Dn+Ev3nx" +

  "BfzMk0/D1McxUjqqnDA4UmNJMTqJjEhfCOZCj4TcpvWnQRqTqWcp3EuECkPo33cy8s6YKhhwztTyLAuj9D9CrzI4U1RO6Uoggs+i" +

  "6NeBIXS7Xfybiy7CeKPpTqYbOHqvgxH3KZbdu585eAgPHjyCRl5Dhxhyqh9XEuVI4T5LL7QoCJGUPMdeewW4cUzqAsGGXBm9RhqQ" +

  "91HxtJ6SxELpuyN9k5edaPRSfqPf5xBf6tFfBQW9YlScU+kc+cVIxOga0IhlrB0f+b8A8OE+x/9Wy0kBwG1bt1ps22beuXbt8xPg" +

  "p2p5TQANNKEJjFrbUJQ6J5L/eJJcL32pqnOUPZORDHZVC+CS+lBkNlyJ/ReErQGKic4T4Sx1eZ9qY1xy8SdoEfxnU1nIsd7KIvJ9" +

  "8fAhCG5+2/dOwIIWjmOAyMaDr7GMcVjgDA3AetCnZvAcXhEYi050MTRQo0w8GflEG+QiEJr1DI8eO46dU8eVXe6NFePr3LBkCd6x" +

  "bBFmuvO+fyXEyWnoToDCSDS4pXRlVumREKwkTZWflyidVClufwocvPkTUM2xXX6V5IbQKQjz87P40MZz8fPvvAmrxyddWt8k4+Zw" +

  "i8y3IcKfPPU4fvXp59BstGC4RJv83rQGQBa0ImG1B/oe101IPWNF6FHvIsfWeIC6XNuG+2lOHbnzYoYC3pr561GLc0lBMyO0RdpJ" +

  "gE+24xprMmB6vsA/W70am889F9ZyqH8oxXfz7557AVPQ7a8AZTG3sFDv6JcVbgHCPQEDkx8fT7NCRBfrJ9zf4l8QwupIh+TFA5ii" +

  "6UBeomig7BkT13oCfAf0v9qLEGEbQKSAS8UX1AAlJhiSfe7AYhylkmFMNjo/f/hfXn75lwBgy5YtJ1VJnsrs802bNxsi6ixrNP9m" +

  "fLTFJThmr9E3sjuaNCTQkaMtYQGKDi0U1Gd9NoKWXNihWepDWKuOF4KC4mdA7GIi6bO6V0wV5PTdYS563gMC2MJ4kKB6699pkoRq" +

  "2lfA3aWkAb85DVE8bI0ULh0y/9CMWrZjWMCEdOxfR70BkMJtiypASu9aYMLPapzhDobyQjFyNjjKjM/v2R3ad5ovAwC87/wNaBSS" +

  "vd6AQU4LMOT5s+wYjRHJT7i5X0Nh+gZIJUakJqV/rdouE+lUTESyZ0iFtHqJqwRgiVAQQCYHshyH2/M4bxT49euvx7/adCkA56SZ" +

  "KYFg2MX6vpSw+OVHHsTvv/QaxlpjyKxW3Rt37LA/48FJyMoEWC2++foY6UAH4PY89aGLgKIL/VTFHBleVVvQr55++zTQQnVRvjPk" +

  "zJwdAs7KCP/u0ks9vB9escwwhrDj6FHcte8gmvVGDDllNXLkR48YZNxuMiSMSfVfNB5aCKTe/moNgTBKEHpSxwMiRPr7IJlfZYzF" +

  "NJap7zy9tLLfeucp1SgBUR/jNOAEpzFy/eHQdgEmbmxEk+Tv7VEEcDRhy2cyZave4BWt5meJ6NiWLdszOoXEJKcE/z68eTMDwJVn" +

  "nfWletkly1YOhOsjifuhDyd4wTPbPoAB6YYAKkyD+hClQYViOwQRW9/GiLaQSOluw8IhMCNbQoiea7cFBx8Bm6xHz2WE4fm/nDpO" +

  "1FPeSYfFhkdJfvTYMAETMi5DopIEiNWQlYpLJHVOCD4gjiduImTxpptSbywdZhbeJ/erxbvwfXJ9EHujJgFZrYYv7N7nwo5OZR2d" +

  "oBgvHVy2cjmuXDKJ2W4Jw4Cci1mehobhVIr1m4tJbKjC0L08wkgkxbS/6b4iSvdttaTfRcBAHt2xZ/o2cxq1WpZjynbRbk/jX65f" +

  "i//yzs24fMXywIizM3hojWSdm+q08bG778ffvHYQI60WqOiGA1rIULAXG8qQUYbMEHIQMgYMy6FWmnI52zt78BADsRkxO51kDh3A" +

  "FPp8R0rKT+5DCjYSLZbjh4lRtdffKtaTEaE738W3X3oJlo+NOcc/5fOxkCU6OQN//tQzmCLnbW6AmO0Ogl1F+yi0SHob+UfgDZbd" +

  "j6dVTm1uhdWr6xai42TIO9iFxMq72TN9vS0iqkMAEBB+rYAH1NRLZlD5kWtCNuVeMEDi36GELnkT+QsmCk9u7fmD1HxGTzmXxq1F" +

  "1x7DBLaWxrKMNixd9H8A4JLvXX5KU3tKAGCr5xpfPzl+V21mah/lNWPBVi88UQ9CpFmRjiIGSEYvqFs4TuigUvUziF9UpP0+y9kN" +

  "dP/NyEzxSFM/IwGVeoYdzAR92+SddYjhYoYtwCWYS+mo+88wyHotgtQf2gOEI4OGnknOH+XrF5VmEkmWQ78hq4SKtQoB6WjL8kw8" +

  "YIUYGZfzcBhFSJhNUhtTGOO6ITzbnseOI8dcz0+TSTuGZvD+88+F6bb9IDhCZDEw38aClHgkMYLkGAgNpdgMPerm1OGoulcC2R04" +

  "Pt7+T+SZICODQT3LYBk4Mj+LaybG8VvveAe++9LL0cjyEHlxZti+K6V1OR9em5nBj919Nz4zNYWJegsoO7BEKgyYQRlhzgDTnS66" +

  "RRsz3TamOl10UTptCXnHQHEOro5Nn75FNbQSRvqMqVY3J2ayqnYg1Buf07U5IYd6TI2A80HKyCAzhLmixA3Ll+Kr169HaYd5Oqdj" +

  "1MYY3LPnNXxu7140G03HtMR0JYw9Lt8T18feT8zfHMaGEP0zRFCkhPJCUSb/vWPEAmr7geTURCUar3iX0w6w8OuwD5P3e4QgSbpD" +

  "YGxlLTDHkwMZpTefxjVHJMm60vWXakKsRZZlozMzR/7Zpev+EThx9j9dThgGqHu8Zfv2jJYtO37LnXd++gDn/7I9W1gmNsYzhpRZ" +

  "RCRnyEOaigTSOxAyQVQZ7fho7wYMD3uMlzL8OI1pSEiSAU1mDOwz1/m2W88oIRMpTekFIelVvXB8q3SiI/bv96F1MagrOmoNs4iy" +

  "S6ImkmUuzAwczyrwN/QjYj3MtKIJCs+C4klWC1ykFwp3hCVUgpEZxnEAX3xtFy5YOnna+gfjK79u1UpcOD6KZ+YLtDIfhjNc/Oa3" +

  "UQRs1LPq+jMa942KtInTCpM0W8Jvk7eGZcB+nAlAnQBLBgfn5nFWI8cHL9qIbz5vIzIiFGyDqetMFL8FUbILOXv+8GH89EOP4OUC" +

  "mKjVXYgxTAD2hhg1Ihwtuzi3luFfbjoPq8dGsXd6Hk8cPoxHDh/Cq/PzsMgxkucwbJ2mi+JuScEUAjNHZfwGCS8SEiiCnwNfoTf+" +

  "Hg3Qw0ZUAM5ZYmOSIKdpNOwDqf3kFkQYB+G7L9vkfFmQrp2FLEJ/Z8sCf/zUM0DeBNgGr3wxd4RjoEmon+tvDEGu1CuMf8B7ibzn" +

  "v8ra6HyBbKBFiaYagI9jTl8CPbtQ6MSPmoA267O5gn3GW471QuYtah19nH5v3wKv4vC3psou2ZZLvCfAJK41p8+yIM4bTSwuurev" +

  "pokD2L7lhNn/dDllD5AtW7YAzLRuYuLPR8BUepJuk0GSEpFXcugMp7/7qskqTEWmvJ/6MBJdFdPvEaY4ugESZaCUZWJz8/pTPe5C" +

  "5Ji8U15l0WjnUAEYMojRLBB/M3sLv0raQYBH7M5+7HDP8I7MjR2IizQQemsQPLmlH4JeFZoGiR8HEslS/63tkFxZy8NW/1rZ5EA0" +

  "64BgLKFeq+POvfvRLgt3BOlpaAEIzhmwkWe4+eyzUXQLiPodQ54/CyBoLbU6U0ioRz99bciJNOl2leFUmgwyk5dwjJ5nAEwWhkog" +

  "MzheWHTn5/DN56zAb994I7acf4FjSczIyZwx5g8AbJ0NPzcGd+7eiR++9168ZBljWYayLMK8EJzPH2WEqXYX75ocw69dfwO+Zu25" +

  "uHzJcnzV2nPwH668Ar9949vx41dehmuXLkKn28Zs4fIVOGlPIiWcmlnLigpFh6I1nT3XIzVQ1xSNoD7XUzVPqsGT76gMkrbNgen5" +

  "Ofyb89bj3IlFQ0+3LA6xf//8C3hyahqtWh2wZfguEmo/dk5cduMptLvPWMnz/WmPgClKfTC8+YaNyxFCmtALMyZ7YtrEBtr8Kdpt" +

  "Y4zzVZDD60R4BRAjaOJsilpfQcYA+JyQWNHWsVoJwcGdgyyt+8lgjJHBmpHmPwCgbcu/95Qn+NQBgNMb87evWfP5kW7nNcpzQwxr" +

  "2SbHGAJQZmQ3KM7ZVk5Ri/dZFTftwnU4eGeGgxOAwIhcZ2Pp6yQDeC2P9SF8boAMEBz54iJLnXDcPERExtIZxI0c2qvbSNSruFBo" +

  "TVWTNDRqmmThDBz+hS1hbhxR16+1Ih5WJRb/Izb/iEh7i3QpRCATUBtywpcua9urd80jp9VpEuOF2Tk8se+g38SnV6TbN69djcms" +

  "RJcZmScGQy2eiFACOwGdIYAsD7YkaWEnsPvel7jQLNkH5KVPx2A71mK6M42rJ5v4lXdchx+5/BqsbI04tfLQ5MrBpfTqZjLAHz39" +

  "LG599GlMZ02MgNBB6cPfnB8PEaNmMky32/jKFUtw69XXYVlrBIW1KNmiYIuSGWONFt67+hz84vXX45euuxrXLx3FbGcWc2CYrAai" +

  "qLaNkfz9Ha51eGrcRf32DvX5GUDjlJQsmlND4m5GjmGxQQ0GM50OrpucxDdcsPGMMH8iwt65WWzf8RzqjQYKWwbmKCpyAIAxgSka" +

  "ij5TQi8G1d/3b/mxach1ZKf9ZNTe8SUCyERBZ/D7NQAJXw5Q0XsBU0ABcXI9ZHwgvXtUmG4Un8P3ibKRGZZN1pqf6XzLhWs/BYDh" +

  "T/I9lXJqJgDXIWcGWL586qfuuffOA+3yA0Uxa4nJGLHHeLWW7kzAyF6FRhWJMXX6izHpcSig6oplkF0t6oLJL67wRETUQJIxi5RT" +

  "lfF5ThmIWfP8vf18EMQFJMpJgnb9N6TmHNaxprCBXe9OlyGdclHvZUvqswM+IYoCguD6LehY+plxgvTvQYaoiepZbeH7o0qhxtj4" +

  "BSTNyxloZxk+8+oeXLN61Wm/S9bt6okJXLVsEW4/OAPjXD9Pu+6TvNmrA1kBASA6AKRMIXkyEYz6rziq/O1POEAGoCDgeHsGF4+N" +

  "41+dvwnvWnMOAPJx5AZZQD9nBgIws1f5ZzgyP4dffvgRfOrgUYw3mqhZl7knRxb8czIilMagMzeDbz1nNT50yWUgMj5BUIrcGA44" +

  "GgBXLF+JK5avxH37X8UfP/MMHj02jZF6C02Cz//gs8oFBubpnSJg7Nurw3xPTQsVBZX4XErbZZ7lZENNzzoENA3w4SsvR27Mafu/" +

  "nKzImRt//PhT2F8YTOYGhRFnPfbisgqnDFpfDFw2WvpP/bf60GO/5xMNbeAplNDwFEDIKYMEtgPCOAmhH8Rwfn76/ZzyqThPCmBI" +

  "Vym+n5LvEs4O56gbnvI8ir0vC4HYojRU5vWmWWI7X1i3dM0ubNtmbj1J9j9dXpfMImaASyfG/2DEFraI/qtORSHhDQPWGasBq6qy" +

  "3PfolTxJTShHVcnJGFK8p48k6+uUzaIl9bRF8UNfZ55TpXVc+cCIYYCI2oUzQTotszdLwHvVxvwJoYW2Vw13MkfNtLhxdxDCvauZ" +

  "OQ3AsEhQpxKbnSYZyZDnOe45tB9H2/Pem//0iuywd685BwYMzmpDN3MIX6EAzmLiHoZNgfNJ5qqq0QrCCSNoyZxRFpixjHph8UPn" +

  "n4/ffNe78K41a2E5nqh3BrX9rqm+b7nJ8PCBA/jw5+/C5/Yfw5JaHQyLwu8xN04WWQ50mJG12/jBC8/H9156ZfDl6CcRE8iHLBIK" +

  "6xI9XbdiNX7lHe/Ej15yAZaji6l2GzUiNJjcyZhyOBCrgXSVwXlsD1pzwjS8SeEkY3myNeZMNyUoA6bb8/jgxgtx7qLJkH53WMWy" +

  "O2Dpof378MndezCRN1H6VOws7RbTa+VZWWtVppj0S9FfTf/l7+DR1FfcR0LDOcyRfCcLPzLxvsU/lkRNqfqF4BClGgCt2ieO/kos" +

  "aIXT/SomBDERxO+cSZ2snMbpDuQazYnWjo787xLAtlPI/qfL67p5K1EJIv62Sy759KKi+5xp1A0RWebSqU0IPvHdgIQXHClUnAjj" +

  "wpqIYKyOoxV7i7+fvBMOGRBJVsEYWpTYy3rAhcq5X/nOTYLtZXhVYb9KUBlI/ArQ737/Y3ybPUAid7oA/Kr0xGH4AEApR9yGEY9Y" +

  "b89kuUlpTU5cX6pGTu6WDWrdohUAsPDFvWe+LESt44c1EuCCS9QNcKhb4vH9B0O7TqcI47h6xQpMkEGX+zmCLmxxUl4f6R5c2S2n" +

  "WCp2xGD+kWIIRclY18zxq+98O77pok2oZzWv7sfwfVaqzQV7D3ZH6P/o6afwA3ffi5e7wHijAVuWyEvyce8AqECWEaa7XawwBX72" +

  "8ivwvg0XhFMjT5bjngDkhsKBUM28jveddyH+602bsfXc1eh0ZzBdFs4ebLw6V/SzAgaiTqA3v4AHB647JmgKpAKKN8UxCBoBJcly" +

  "lC7ZZMiIcKyYx3uWLsE3bzjfHXdMeCMr5KQldBOEri3xe088DqrXnfnNS9UpZWPv4e7pjvgWUZyPJJoo6Xfv7wAMegfW/RXwWH8B" +

  "xsX0exu/l7AH9BIYANB66xUgI3FXDvxU7yJvOtY5BVx91fucRiEsjZjvhi1gxmbnZ7922bL/A5y697+U172Db9q2LbcA1o2O/t9m" +

  "IwMAqxX+AHyAYNX5hRJgHDoHhHTA8H0zZIKq3IU/ss/Hrd6kUOBAX4B+cJCjjVMpbGI9/TQLfcbB7d041r2PiQK1csITiaZEnEsE" +

  "BAx608IWho0pa0lFToABa4NcqU8v6zNt8bqganAAcg61+jgLIpS2xGh9OCYAkavmvTMeUMIbF0MbDRhZSWDO8PndexfovU4FvHJ0" +

  "DBdOjmKu6CAPqHE488gsp5fFg7McvA2Hh8b2VTRWiV8NuQiJUq1ZYVDxPDYGiGBLi++/5DJsWLQonHaYmTMX0y9FGE1mDHbOTOGH" +

  "77wDv/3sDjSyGiaIYG0BGEJGjJzdAVxEOWbnOrhhfBS/ct3bccXqVSFHgBDfUyoUAV/JjMlmC99z2VX45Xe8HVcsHsXR9gw6JSMH" +

  "I4N14JL1zlLhzlqj6f9l/SL1EzJ0JgxIhwjqfrj7rbE4TsA5po7vu+ZqsAcwQwvH9KYYQ4S/fvpZPHF0BqOmAYaEgPq2s6bHMVlx" +

  "zGMR0++KKVGY9iBtVuJ570FheA4RcAW+mYydL8RgmS6pU4GAOF8+yR1UCOUg/hOmnqMvDcWoGAee/XywSPvcU5cAwvhOkmq9oGZt" +

  "rdGg5SP5Fy7cuHHXNnf4z+siPq8bANxxyy2WAVy3ZPJPFs23ubTIjEwzs0dyugtxomyYoNgJa+MJdY5AMUovnUrcvGbjrOrrvzAi" +

  "4DhZcR74GWIQYX8pdtDn6MnbD7Xpe2OkZwz/EWnLDcqZoKfBi9SXMq76uOn8vyVbd/CJkvITj3COzjosoEYVIVBsDDICFjXqQ+sX" +

  "AMx1Ch9y6tC2kJmwbtiimeV4eOoIDrVnYRbAJipx/zesWALudpGZU197b+x97BU0Ympjdb5M7OtgYMxhAwapVFa8zJcaEmaLPDMY" +

  "b9aH7kB2oiL2bUOEf9z1Mj78udtx7+FpTDZbHvg4DZbxbSbjEt+0u3P41rVn4WevfwdWjY270wdPsw+Z1wYUtsTFS1bgl258F/7j" +

  "ZRdjMutiulsiLzM/rj50UJlTPI9KUsGSMME+pQT66BiVdEuRBkkiLGLAcAf/4ZorsbTZ8iGQwyuWgdwY7DhyFH+642WMNEZ87gRP" +

  "14TxS98BxW2lH5UeGkmk07/lgbGTiFisNBGRaXvWmjD9vprp8F3cFT3vlK0jQikpoFItESEAJuYgEKE1Aeek5zMF7ZqNRsrCXh5m" +

  "tIkwToQLRsf/u2UmvE71P/AGAAARWWzbZv7ZJZseW0K4pz7SIAaVgZ8FJONBComHvGcenslbcp65IAZJymCWbjvUIwRPjwgnYRsx" +

  "lCLtUkTFA3rh42VFUhTiF00QbiMxDHu8yjHfPykkb8XfYoDKSja8SMvhXsl/LS3mfstuYYtmhuz7lmA1ciFusqWsV+Nx2F2xkXLY" +

  "kwAat7gZcpgJ2ITrNZNhslZL2rDQfZqanfNz7jeZn0t3yXWibgz2zc3joVdf810+vREXFfj1Z6/BRI1QhE09pJmUU3spAklJGJJI" +

  "LYOkJvaGM+UfIeMXwJCAdLhDldoMfOKlV7wa3A7dkUw31rJFaUuX1a/bxS8/cB9+9p4HME0NLGq0kHXL4IUfBAUDlGxQlAV+6OLz" +

  "8T2XXRHA3kKdPmiIkJsMJVuACV+z/gL81rtuxruXL8axYh4Mp9A3zICYSwBk1v0kraDqvtcyq4gNqRiUSL5eeGACuoYw27X4gQs3" +

  "4YrlK5y2Y4iGfxn3wpb4+EOP4Lgh1CgLUnSg08L0gPQ6HB2RJDjizwJOHSbDX0Qh6koYvA1aW29a0OPJkfH27IkQhm286SuOubMf" +

  "Cb3zdndS+mSKtKXf6EZQHdvtfmmaSWFcwm+l1dbtddljpXVB18eWMjPRnd/7wauv/kcQ8a033/y6M5G9ISPets2bTdeWWD8x+ccj" +

  "mXF5voO6uCqdcwACAWGRs3tbQP0GUBnSaKemoGoOqk81qI6PR6e/JDyjb1GMWL2t6qZDkrFQnmAJI5Qn1I/vh04XLO0g/zvOO4U8" +

  "imGNsPYCGB6RDRIHuwNQHRgoVSinW/ThcCLr5kCOhtWSDQCXUjUAKOWo4xmxZaDGw9MAyJhNFV3P0OIcEbECbATAAiYPZoDTVYoK" +

  "ADh30STWj9bRLTvui6Hxfy9NQNYjeSLYgz97iyw+AECqBg3Hy/rbJKEtM9AyOf569y58eucu5CYLp/kNu5SeCWQmw4P79+G7P/NJ" +

  "3PbyHoyNTaCJAh1bwBIlBMyBaYOZYh5bzjsH37D+gnBE8zC0F5l3gCyZsXxkDLfc8A5898UXoiynMF+yzwBPLjRTtzJMlggwg8wA" +

  "6VKS9RrmzoPAkoEaEY63u/jA2nPwdevXh4yIw/QsYg8w/vH5F/Hg8WmMZg10ULrzlUTkBwI4JfWc64fx8KYSIoiUtgp/iGcJKFNI" +

  "n/urmsqB5ir1EPt3xLwKnubpa/rRADx6i5Y9GeiZAR2tdiJn6xju6+lrAAIEC5StRp3WjY7+nSGa2759e1Zp4imVN+bFc8cdFgC+" +

  "/8Lz/mqy3Z4hMhlZFqGk0iGt2vCMWRIrcEysIPH3ugYSxh/QY9wWzDpWEoH5y98n3e8soCMyjRjGGBectt0BgJXDHNRGDXYiNelS" +

  "s2uWbg+BrUqM13fKhrlpEdRZkZE7EwjZEmRtCNWUMRcTQWkI1hBM5hZ/QQZzTGgTQBmBfYpN+W2tAwv1zGCs2RhOz8g5H83CIiOT" +

  "MEL2u1oIRcEWI7UcTx49hn3TM85Z7DQlWseogMsmFqPdnnPvPa0aBxdxKkqvIUgTSPZC79PStrC2w39CB9Wc+3sMl2jWGvj1x57A" +

  "fXv3Osl3iKceOaGZkZHBPDN+59GH8JE7voDdBWFxawTd0qJA5nMuqHZ41WyHLcYzg69de0509htaa10Rs0BpGVsvuBC/dMM7sKZh" +

  "MF2WIJOpuHQOjCOyxNTXxo1BZXwVqK5+z3BHKx8rXGKjD158sTfXDKmzvohJaM/UMfzRM88h96p/QtQwBUFY9qAHJEnsfUXoiwzY" +

  "CeKRtqo6TkLcq/cN3uO9UrybI6AqjPa8A9V9loqPKYzr38akJRqgh9/ub3EidO1zre6CzKKitJuWTPzh6ezGNwQAbr31VruN2dQX" +

  "Tx44p1H/fK2WAxJ7SEDMriSzlzqviC08hG/0jFIKBlxMJXsZXVKhiW1FOySJGlrqiWk60pf4wyJMloQm+iogp6aRf1LUdOyxl6j2" +

  "XD8EwDjOSpZThGoRAYQwHBInF/ePOMydLjM6WWG2KMGwZEPu/OCXwJEYOSmQYbmECy9zdtWcXFjU0U4HM7bABCw2tupYmRHmOl3I" +

  "crI2huUUXKJhcozVvQZgASUxGa3Zbhcz3TZykwUTTlAhkkhcDAODGghHuiXu2/tqUscbbgO7eZtsNjFfzJ9mbSd5l3VrJW4Zv66D" +

  "+l4RPC21yFpm9vPqHNXEQTWAc8SMlVKlJSC3QGlyfOyRh3H/3r3IDKEoy5NrHV5P3wB/YBNgDOHB/Xvx/Z/9FP7o+ZeQjUygCQNb" +

  "FjCwLgObU/FEzY4n3ETulMZu6aX+YZljKsUQITPuVMjLlp2FX37nTXjbklEc6cygZjLkjJh7JAgKikuqcRikthYAIHTTgFCDwXHu" +

  "4pw8x0euuQZZ1v9goYUs0i5rGb/90OM4ZAxqEP8UaamXnk30DwsRDJ5HhIQ7FfNV0O72mbpEukcUYgYBg3C9+p2KRHAfHbV37ZQD" +

  "d3r1MpXGBKTCIBD3YadqH/bOdp/+wScG8n1l72ck+xcgkGFL9ZpZCjz9zRdffh+YaespHP3br7zhOJ5NAHVLi9XN1m8uznIUIkGj" +

  "sviEPnHslL6HPFNNnReFkA14OSFh+imE474PRnCl0ac/wKe6CRN1qRzCgggK/PduwVuQLaN/QBV1qoWZLCAX3qDfOjzRUfrBLowq" +

  "SP6SXhJuoVmUsLDezuY6m5GBNYSpssSR7hwW1zN88+qz8XNXXo7ffdeN+J0bb8R/f+eNeN+KxWi3ux5aOWV1CYvCWoxlOcaG4QPg" +

  "x2u66GKmtAnhcCYVcVwTX2SPn+sGD3g/gNMhlJYl4yDhwQP7YWm42Q4NJEKmF9L2LB4hjBwWbfxKa9XU41TZOo7AAgUYTTLoFBk+" +

  "ev89+NJrryHPvA18AYplZ6oxhnCwPY9fe+Rh/PAXv4jnZrpYMjIGoADgTu1zx4NHWQPwYIDdKs5thvmC8T+eeg4l/PodMrDWxRhC" +

  "UVosbbbwn294F7513dk4Pj8DC4MaGedY2zODvfRHrgjzSnUZwkgJM7BY1LX4qWuvxuJW64w4azIYmTH42xd24K5DhzFab6IU8Ci0" +

  "EYrhqeYwswi20sPkhsQGfoI2CEVNzb4pkIC0wfOEan1RtV96Rtv7xtctlKkMmr4CL8WrW3S7VFvc2Pij4kllwkU0LRtmsC3tZL2G" +

  "ta3m/yIiu+2OOzK8Tu9/KW8YAGzx3Os73nbVnWPt2Z1cNxmBg5nGeSWbKEFLBzWDVCsk5KMPDNkkTFsybQW0z2qJ9WP4SEECs3hf" +

  "hm8BK6p/9ZwwbEGV/m72fSih/BEQEb1878BCdD6RRRXeISodK9KWzwgQ+ldVJi1gYQkjQ0iqBI94S2s92wYy73cxby2OdeaQW4ub" +

  "li/BT11+Kf77je/AD191BW5ctRpLWiPIsgwTjSa+7+prsK6Vo12WYMCrickBgHqOWp4tuIZDtvSRmTnMliUohFbKj8yjsw0TM9gy" +

  "ankNTxw9hv3TMwpZn3oRIGWIYIzB/3jmaTy4bz/G8haABQY5qpgsixomROk+/kr7IfdoE5a7jSt/UjALSS3aI9mCUcCiYRjImrj1" +

  "gQdw795XkRuDwvbm0DjVYtmZiQw5566/f2kHvudzt+MvXtqFem0MI7UGuLTIWA6P8SpkH4ZIRMjYxY8TDDJ29GMsy/Dpgwfw43ff" +

  "jf1zztRTnmbeh9dT8ixmGPzw5dfi+y67AN3uDObZmQucTwAF4UdoWKpQrkqNFGQdZne6vCUCuh189NqrcP7ipWFNDq9IyJ/BjiOH" +

  "8QdPP49mcwxlUcI5NVPIh91PImfy2e1wMh+tiqDWp08BPsm67XdPRRjsL8ErgdTTQlLPk9xXeXecF3eFEJ0Q3RW1IyuMfqDQIcDJ" +

  "T34wHXmtn2z4EiYbbc/PftNF5/wJAOB1pP6tljcMAIiIt91+e05Es+e0an8+njfgjL8+p793JXJ9jdmgAvolp4oOSSFgIXb9WJRD" +

  "hJf6g/WMqtulKmGT/uUmSIEGqa9alyBJTQBdRADCRIb55Mi8VTIp/9Loo8Dh+4r3KMd3Sn3DLjqXfyHOf/DpUE2GOTCOdbrottu4" +

  "cKSG77lgLX77nTfiP197A756zQZMNpyUIfUAQGEt6lmOq5ctxVy37Rey+6+wFktrNQwR1uDQ7Bw6VqRjmcuK0s5vzgLusJoDRRdP" +

  "7nPOgOUpMjCx8zp1r8GB+Vn89N1fwscffhKt1ijy/JQza7+hIjZtIK7TVK6pgGwtealnwjVWgJsQ5kzvO/g3FrDoAqjBgLMmPnr/" +

  "/fjSq3uQG4OSX5/zMQMhHt8Ygwf378MPfu6z+NkHH8X+AljSaCKDUzGzIadGFuahxMeg2SU4CyQx2FiUxBjNDO45fAQ/+Pkv4uH9" +

  "+5H5SIBhrcFqkVNSS8v4xg0X4Za3XYMaFWgzow4D0dDomLY+ykg/YAxw9JU3HgjNzc3jP1y2CdeuPMs5Yg/1MAoO5GmuLPDLDz6M" +

  "o17EYx+eEn28q0xOQiAJEpwbaa/QY+pLj5MWqLUt9UrdUojidV0SjbF6vDrcpAizFg7ifqs+IKiMfHpeQqIFqGjbBkXoBMavx6/S" +

  "VwbDEhe1ZovOzpufv2TFut1btm/Pbn0dqX+r5fQolkceNy5Z8ls79hz6wRlDNSH9BBfeQdDSMhS3dEViKsPAswnYSTvz2aBGSReH" +

  "hJeEqwnzpvhFiLMLLUnrcZX5KnrVSVEzoE5hI1JVCapXcjzLwqPYV3+v/kvbfYZZSmZ0LXv1PCPLnIPSPIDj3TZqVGL9yCiuP+ds" +

  "vGvl2bh86TJkPoOfHKtpBpz0xgAWN0edlsEfEEXEKMoSK5pNX8fCngos43VwvoOyBEKcXJJ6qZK4gxlkLWxew0OH9+Pm885TqtX+" +

  "77Ds8uHLmRf752bxNy8+j7/f8SL2d0osHhvD8dkZGBPTHQ9DDmNmsI2n0EX7omSyiMQqNCS0piLF+I8ub7wmeIJfKzoFX421FnWT" +

  "oUsj+OmHH8GtxuD6VWehtKfCgNjH4htkRHjl+FH84dNP447X9qJr6pgcGQfYwtoSYOPOdIC0U35XZoviWBDDaQE8ZV+S1XGoa/Hj" +

  "DzyAf3veBnzgwosA4IyoyaWtgNMWXbfqbPxco4mPPfAQDnctRkyGgmTXUyAOYfx9CVIoxInOAsbg2Ow8/t3F5+Gr165zHv9DP4mK" +

  "UMIiJ4PfevBhPDk1h9Fmy6v+DeJZIr3j6uixO9a2uhb7Ye+qmXhQCZJ/XMw+E6PQ/Vi5+Jfo8XXrJN031VC9k5oIA9dWe07JICEi" +

  "qdru0D8xJUe+CZZDppTfhAc6HWKzvChw4aLRXyqsxZYtW3DbiVt4wnJaAOBWIrtt2zbz7ksv3f3pA3fedYBrN9tOt2QX7prKYmFg" +

  "3RX3ybrcyP6T8aKyJLbQSyXMZ4WWpaEHETVpECDqHUHlEY4oyT82rqcE+0ylbh16KLVEUwMFAhDaGXsS6/bqWSeNVe/p/8wbLa7H" +

  "zhmuZMZUp4DhLs4ebeDyFSvwVeeswdVLV7ojPH0RL3cTzrPuLTICrTzzjmpe+mEAlrBiVFTjC8sapaaDnXmfl8CHV7AJ0+vMAn4d" +

  "ePDGABp5jqeOTmGu7KKV1ZKWaWk5MybEjz925CA+89JLuHPPa9g308FYo4ml9TpKlD7j2nB9AERKYK+BkWxirnveIdVvFA1FUwYf" +

  "N1HUiMU50fQ00S3IHvKSdN3kaFMD2x5+GLdcDdyw8ix0yxJ5nyyBDAccZCwPz8/hL597Gn/70ss4zBnG6qNowCWfMoDLAKpCx5J2" +

  "VMYk7E0hA4HKuxMiG7lBN2vgN555FnuOH8f3XXUVGnktaHKGiQMC3SNnCrt48VL83A3X49b77sHuosQYMhTsDW+eebok4V6aBPsE" +

  "W1G0yJHhcHsOH9h4Dj6w8UKn9h8684c/eMngky+9hL/dvQsTI4tgS38ofDjxjGOSHMUTAbc3hK4Hm+mJBNcKzXWXBPBKrYzqcWz+" +

  "0Si5AwrMKnqvBMQgpOp3JY3x9AMRHIR7q+ltqffpnjWrahXGzuy0zMwxhbKxDhK4+wwsSlvPG2ZpYZ/5t9df//lXtm0z30r0umP/" +

  "dTl9neXmzYaIit9/4N5f2zPbfc/+dpcNCCXZMLAaZSWgQLwmNdWxEiPnp9d6BKWknb4ocxB70SDAvzgSTbmlf6xo1UlDt1VLYNWW" +

  "xNsq2oie+/pJaun7F9Kbl0A4WrRxqFtgbXMU7166GO9etwbXr1yJRY2RcF/p+2eITjF5irun4VXgAgIsCDUQzhkdW7A+9CuH5udA" +

  "xif0kG0q/3AK94SRNUyGnZ0OXjp8DBctW5poJyRVLIhwtDOPL722F5/d+QoeO3gIMyVhpNHAkrEa2LIfK8dIhu98FYvzixFzUvwv" +

  "Er6UucfUwZLBTINLTiQjEklKv88DZ4YDgl0qkDHBoo5tDz6IW952Hd6+fEWwQ8tIWD8+mTGYL0t88oXn8L92PIedbYuR+ggWg1Cw" +

  "BWCEByo8HzZoX0ZQ3YOJwMAEaxgdMPLSYunIBP7m1f043L4PH7nuWkzWG05rcYbOM8g8CFg3PoFbrr8O//Hu+3GksKiT+A25jucw" +

  "IE/zIGAPhMxYZDA40pnHt61bhw9dvEkdwTwsnZMr1mttXjx2FL/x2BNojI7DllHQ1ho2C+efgHBJ5qp/+7TE3cOA1ecYNQa4lehA" +

  "PnO8LwGAUjezA5RQoCBoDBCl7sp7VAuToY0amROV6ns8HVJsbuBTqvLYfgOwhSWyi2pNc34r+w0iKm66/facb731tOzGpw0Afvrm" +

  "m4tt27aZ77jmutsf+OSnnkO9dQG6XUvwWTICQQoJg91nTahY0BWFsBF4RG/JxZUGNTwMGFG/UF1YCZE0FMSmQPAEEMB/12eR6fZV" +

  "i2Yi/d4pWoAgb+v7KPZL/CVDRAEIZVIjeZXZCVbMwNKPILjMZG9rNnDlJRvxnjXrcdbYovCtiwxwPjyvO2Oavz3PDCRdjQs3KzBq" +

  "CGePj7vbFphGuex0wP65NjJygJLUnoN1LEs0Mey1NUTumOIOG3x+925csnxZYpqYK7p44uBB3LlnD+4/cAh7p+eAPEOzPoKlAMrS" +

  "hVFCzE8eLAxX/gfYR3BI3wQku2NDI0EO/QcFdbiTyKKTUVQ2uX3g7tfgofJuArwrnrPHeyfdGggdco6BP3XVVXjHqrMAIJgE3MmL" +

  "jNt3voL/8fRTeOb4HJqtUSytGxRsvX+/OMR53UVloeiPaYRRL1vRjMN4+7o1BCo7WNxq4e6jM/iRu+7CR6+9BusnJr36POpMhlUI" +

  "hNw4Z8S1Y5P4yWuuxkfvvR9tzkEgWG+iDJSNnHtwBoCNBZkMR9tz+MDaNfjQZZtgvQZjqCoMRJo41W7jP997H47nIxgtDErjwIdB" +

  "da4EcMZQ8B4hqI/DutC6eEBTnzXI/nsWAVF4CdzRKmK67UPDe+m54gcDVP2+lkSLkIKQCihlDyhI033jDhwSbbA8krQnbtxgzGPh" +

  "DXLeLpizLB+fmzn4w1/z3j/7EWa6A8lxHm+onDYAYABeCzDzK1/44p8dZNo23e1YMJmgkvR8zPq5Id9hh3gI/kgmx6jZJ5SR7ytM" +

  "VHR9csiCq0JJCqptYhcNTiqJ7S8S0KQ/J4Jous/JguHK35oBe7WzBpJ6cilcqEhl6PN3tRXVNshYWZBSR7tXMMbqdfzSP/v6sKis" +

  "R1qOIdLgV520uHdnBpBDlgyAbslY2qgpE8DCSVvS+5lOBwdm55Blxvso6HWhYaJG/QawjNF8FJ96bT8aI0/hsmUrcXB2Ds8c2o/H" +

  "Dh7FnuOzaIORNxsYGxkDWYuCS8ewiDycdSpxIQrZkGLOpVbLyoM6ECKvNiZI0kyFuyVOnp1EDE+guLd+pTupvDX9SwC7jLNlRoMI" +

  "XTTwMw89hO+8YCO+9twNaOY5irLE3Xtfw/9+9hk8fPgoUB/FxMgEwCW6tgSCPwkHDUMQBFztbub6Mfqw5fsxE6UJIb8DiWC5xGgt" +

  "x/NzbfzYXXfjluuvwyVLl/oTBtGXCSxY8VVnxqAoLS5ashTfev4GfPzpHRhtNDzt8kAAQg4JJRNyZJiZnce3nHcOPrTpMpfffwDT" +

  "Wuhivej2K/c/hKdnSky06rC26wma32CMClMX3y+AyPrfnpEpMZd8KviwNRVtrlK3Hie+EHIY6ZvUXF0RAgoHrxUb/hYgHNaXarPk" +

  "jCH/ukGRNUkJAp++1NvCYDqBRTjKnIwHhi7z31hrJF+b8f8koqM33X57TjffXPR/6amXBXFbvmXz5vJWAF+1auL3n3rxtR87hqyR" +

  "M9iSJXh7sCQHkiFkKG94WRwUJf2eQSKKx0tWVPMysXLGt3wbbJ/G9Fft+HohyLFPnf3Kqanmo1pVCKwX+d3XxoQvnEnMqqRE/ST4" +

  "ahu82pTiZ6JsoJqJQYDJnHQuIWwiapxmkRoMJP+/61NhGWePjGC00UhMLgtS/OAe7czjeFkiy2th8xsKX6uNJwQzKkwJJeazGv5k" +

  "xy7Un9/jDkACkOUZamOjGC8trC3coT8euJKNkoAXriGWumE7YlXXpGR8Iwgu9uBAAQTL3rYI70HPlZ0loJmjqa0aKUDGI3hPCIWY" +

  "uzF2Gq+MgDJr4Deeehb/uGcv1i6awN6jx/HU0WOweQ1jE0thiy4s+3hrIgXWKBJy6Q8QiHYiaUFTj7ioEqafCAyyxZ1d3XKBRXkd" +

  "B8oCP3H33fjotVfjbatWuzDBM8BQY1uB965Zi796ZSeOdksX1gcHkqX9ORjIMhyba+Pbzl2DD226NESCDFtjASA4bP7hk0/jUweO" +

  "YWKkBVsU7nhz6Qfito400YRxB9uEVsoaDDQ+CMVx7rStv9pHv7Qjbffc1flcxWf4ZPp2VU5EyweJYlETMLjOdB2K/4MNgmn1RQS3" +

  "Vy3YRTQxO3pDjDYhWzU3X37Feef+/scAbN682d55Sr07cVkQikVEvGX79uyKCy7ftXZ87BNjI00KQSMkISCRGQrCCqpLT1gsIfhv" +

  "hbqtcr4LP7HZ2kM/hmmoqaoStOQnvuz1IOqTeqcmi9NUVw7YZAF0hAWL6AzJ3LvsmcuAVDlEIvg6GInE7+4pwRyTW4iEIyFskiBn" +

  "IYoMb815cEFE0bKwOG9iEgB8RMjCFZnRV6emMMMFsoDnInGUNefm1iTaCRgXVGW4xKJaDa2awWi9gfFGAw2ygC1QEIONcQzPV2aN" +

  "W6clUis7B0A1xKJtl8IYWZh/nE+HMx3DN2zBlLsf75fh3Trh0xj5A6CkDoR3+AEN5wLIRmbPwN0+MF4jy8gYGGuN4uWZNj65ay+e" +

  "nO2g1RrDaFZDWcRkPm79+ZYSfNIp91PVTjhfB4TDuAzi/ksOs0Kv5AeEapFZDpJcaQu0coPZrIZb774Pd+58BZkxKH1Og4XOV5EU" +

  "xdVGaznqmUHBACQ1updqYYAcOY515vDPz1+ND11+KaxnpsYMf60VtkRGhM++vBO/v+MFjLaaQFFAxN+o6vdzhMwRbyLEjPURLIr5" +

  "15nkONyTFuqh9bo4IUrNjzItaFAA6OWbMmoBDNXao4lC7aPg4CchmxwBdIUHVHsS7jHkIz1jfxOHxV7dltMuMuA0xBkYVLZGRmlp" +

  "js+95/zzH8dphv7psmAiyxY4ieSqJUt+drws2Zogz8Pv8iBtRNuNR/59GWpE9vJJRxAOYsJVT/rqZk6lBI+mK7O3EAQg1s8hBwBD" +

  "hsHnPyDrFgZ5X8+B8dSyKBk6RWVgbBT7yjxoXcSltuC0Q5gvPAjzyWpqAC5cPLnQbwMQN9xLx46jZPIH8yg2SOQ9qJ1fQpLbmXyU" +

  "hnFiSsEuF1jBXRS2Cxcn4RLLkE/HpSNAxOtaTkQMWbqG0tO0OAnRjYAzbtlACIXxu+LWXoeA47aN6bJABwRrDIwRP4hoRiBkDhCw" +

  "D9XyqaEDMDbGH8pifMIrjgeiGPHNcalw68Zgsl5DywBsy5TgefVQSNbE5HPH+x8DpzbWWTLJq19lvKWHiriL9kL8iSIpd5nVyDMm" +

  "JsCSAVlg1BKoNopfePhxfOKF50OugGEWJoB9SNpjhw9hz8wcat48wSg9jWQAGQ51O/jX6zfg+y+5zGcQHL7UD8AnMcrw1MGD+MXH" +

  "HkW90QJsiTKjRFAirwGC+nGgTIf7+fFkozTAMhhQUnqMrDp50WIeJYeThWr9j1X0Pvok6LNc/NsrGqS0HZTsfwEhfQFKj2ZA98/D" +

  "IrXe3edkCP174u+CCYsYuHrZkt+zzNi2fPmCLYMFo1lbt24tt2zfnr3voovun7Dtv89bDSJQ6aL6LTS0DyDMf1LLRE9J+MtbPv1l" +

  "Siar6rTnbLJemhgILuS6DuVz73RZxegNc8l+5gGHHn0/PDBgwB+JLJ9iwMdJ3hDa6gCpaAUEVVfb88b68bqKf4chQkmMkh1THDMZ" +

  "Nk6M+dYubJGxevHoNIzJvV1UbWtK75Zr5BUUxpD3I3ESPpMwOz//QmRMlHShJGcxW7k6o0p0mEW897UmLemlrDPHY9HuMibJ4Mrx" +

  "UVwy0sRSA6DTxdR8B8c6BaZLi5IMyIMC4yUzTV41qEi9tL2JgRTB5LiKS/eA26+gGBkQ/knr0kSWecBY+n7Fjzo/R7WNAmIIkqtd" +

  "zqg3/iUdd1wfuN7ErzzxJD7zyktOExDCRRdu80hN1jLyzODg3Bx+/dFH0eUMKN0ZHU5rw7BEmO3M44MXb8AHL7nIS/7pEbnDKpad" +

  "eXDv9DS2PfAgZmtN1NggamfEPu4l+UDMow7TfS9HvLNHZww58j31BZI+VTS5AwS3XsfCyIgTP4GTmmmrgiKCFiHVBqeCaGgXy5Kr" +

  "0AY5xciv6SgIIiYKUus/7DKShFyeP0Q+YbmeZctt97V/ddmV/wcA3bJ582mF/umyoKnLLvHI5MazV/3JkWOz79s7M0+5VxcCEWWd" +

  "eGJkcpXzXCVZg64rjclUjNzdDbDE/6fhhK5oG7pqH6Luon8Le1U+4buqySF4i1dxoUPLAMAmc1JomcgzlZorxL6HkPaT/HtjsodR" +

  "gko2qK4Y3cJifaOJNZMTyT0LURhuTru2xK7ZWadShss7wIoGOBznnZE895BUpOJ0FiUUyS9PcYJJMyMHMCyLGjMSAGG8wxpqTeDC" +

  "mg/XyZ9JIE12a3+qKHDZ+Dh+6tprsWSkBbDF8W4H+4/P4qWZ43j2yBRenprGztkZHOkWaJcMymqoZzlqmQWsN89B+sVqLGRsBSp4" +

  "L36vGfCNhWj8wliRMGUheN7pyor91ibnaQCSN04VdipV7zPeKwgkmgMgTgwHUg0PUMEESxY1MKg5iv/y2FMYrTfw9rNWx7S6CzWn" +

  "DHRtiVqWYf/MDH7i7i/hxdk2xkwNHbZhDCwAO1/i+6+4GN987nrfDjO0taWLMP8j7Q4++sB92N8ljOUZCq9lMrIhIN74kSYJOInx" +

  "/2ojkgJT5ECOrIOYPMj9rnruJ8KeUr/bKh/hOPPOcRRJXXoAtaSfSv4pgNTmqH5RBNFXTQmnci+LtiQChurzPvAfotvhAFxkqAiF" +

  "sTzRbGFDq/57RDS7nTmj04z912VBAcAtzhmQvvWiS//vFz/72WcP5OYCUxaW4U4wEftWP4kCUGOkB5sDflL/ppMXUVmvI1PqG5As" +

  "ywFF8hc6TUJ1sQAIYVR99ySJhEbR6mO8M5Z/PxlCaQnztkTbdoHuPCa7JdY0mj3VRZW/flsat532THp3Zph/UsjZlwkG3aLEhcvH" +

  "0cprC555TTbq/plZvNaZR5ZnTqUPoT5qswsIIAlEFeYt68MEaYGgmDqla0zxPS/wiJ7AOWMacqrsoRbF6JljSlhZzdZLEGQMuG3x" +

  "reefhyUjLRRcIiODiXoTE8uaOH/ZEnzlOvfE0XYbr01NYcehI3jyyFE8fvw4Xm23QaaGVpajTMaz/771F+PvOJDq67h/mWJUjgBG" +

  "0Qw4Jk0uwxwG7DGpSbCEqERCE+Jnt08pAEGRq0TCMtYdo54To8zr+MVHH8fPNuu4ePEyFyK4QFNaskUty/DysWP46N334Lm5LkZr" +

  "dXTK0p20CcIcE+pd4Eevvhxfdc5qd54G9a7pYRQXIWUwUxTYds89eGaqi/FaA7YsnLKL495xD0SnSRPZV0SMLKBFZU7VL1Te/4Df" +

  "h/LoAMar+QNVb+yzJhNhTH4n0n1sWXotgpF+2tzEDKJ7Fl7Ra1buKzZy2r8AljgYe7i0MEs77c7XX3zB7/4QgCdPxLreQFlQAEDx" +

  "fID5/3LfPb+3t1P80vSxojTExoLDQRFA7IUgJm0fCniQjY85Vs5BivP189ynyvVA6HVD1X7SxD2ZcIYTEzzFD0CC4OzCSqanhDsI" +

  "gbYgY5B5OYkNocOMTsGw7S6aOXB2o4nrl6/E1cuW4qJFS7B0dAwMJN7kMRdAFQCkwEBUYz0dPANFMGxp/dkClKEo2rho2dLQmoV+" +

  "I0DYeXwKU90umnktHsKk+q1NKk71ZhWfkvtsGqKp0DirUCNXvdcKkULrEMkthgkNo7fut4y0gbOTx/YCXipmp6WoZ4QVzaZbT0Ki" +

  "WepwxZDBZKOFyUYLFy9bgW8AMNWex0P7XsNfvPAKnptuo1HPXZ0+Q2e/ZSUgizxAsQKg9L5VvXErVZn+CDGs0nNtkb7Z36tVupl/" +

  "xs2oVMIBDGg1LSJr8vVJDAEF4cISAeTS3E7ZDD//wCP4hRtvwKqRsdMDr+wAomUgNwaP79uL/3Tv3djFOcaohqLTATJCjYHjRYkV" +

  "tRp+8vqrcf3KFS5ToRH2svA7SDfSWgcaO7bET993L+6bnsHSWgsdWwCZ8VEkkqGA0vaQaMX8t4EOKclYP8lh1pI2RBW8uqxBI5Aw" +

  "8UC3hdT1MOsKwyXVasXEI82PTB8e6BhjKgy6D85gICpDhFCQui8abphUX/36C8JIDzawsETlyMhIfn6e/9WFS5fu8nn/F0z6BxYY" +

  "AABRC/CBdSv/9NHHdvzElMkmXdaK1G/VjQUHRBYkK32DgF9/XyKFJ9JZZILJdcW4w+T2UeuliBNObdNPmiNh/KL+8cQvMB5Jm+ts" +

  "yR1mzFpGWRTICZis13DesglctWgxLls6iY2Tk2jljYFjqR1X/BXohS2hf3JQSHRuke9OLEMtVLEMZATMFaU/Hc5ihEtc7B0AF7oF" +

  "Ypx5cXoaJeU+W6Tfib4QEGyWgAZSvSUhG4GYwBPwXpCZ3BwAJg8/CgCR2YLhnOIkU6b009+Xl0DNZAkZJHlW1wdE8xiA8UYTN61d" +

  "j6tWrsaPfPEu7Jgv0cxydycLR64ATIprleAYtNOCRkKYOOcSRVU/RxAuoU+g6KAYSHOi7o1NCcKABwkZe4YetH4VAl7FxuRcKcEu" +

  "Sc8YEfbPM37h/ofwsXdcj9G88YbhtIWzeWfG4LMvv4ifuf8hTNebGAWhzR0Y4xIpHe0wLl00io+97RqcO7nIax6qzGw4hZnA/iC2" +

  "X7j/Adx56AgWNUbRtmXitxEYludageZVorQE9ESmrqG1B4XSK5b5oKBVBWRdcO+4V2g/fH2ijfNfBiB+IodCVr8DdeUIctLnUz6S" +

  "rEWK3/vUbpU9ZoJEr2mLpHyO7UnpCjGjy6VZybZ4z9qzf8EC2L5ly4LrGBccABAR37RtW75y5fq9P/bpz/7u4Vb9Rzsz8wWD86qN" +

  "RW9ODaBIzY70OE5S1UnDFZ0cQxMb9kKch6dJHf0Zgr9ZfZ2+yXiv7+iQJRJCaYEuGEW3AIgwViOsa2a44ax1uHzJcpw3MY7JZiup" +

  "zZ2kFh2lKmOZtCuCG8fQnApV54KIY3sm1P8Ml/Gt5o+F/ZvnX0TdNNEpLNa2RrBx0YS0ZkHfK2z+uaNHQVkGBnsJtWozriK7HrlA" +

  "yTSRgUoyFpCopP0a4ki+9OFNwad9yCYAIkraqsGHpy1hH1HJqJ9CmltCL5EuyhITjQa+a9Mm/Pi9jwC585pnT5iq00k9o+qv8wnu" +

  "IZHE/Xdq38oMCgRIAZpoXyKpTvPO+5M7Qf0P2JLDg5idVshXIPo0y4x6jfDw8Wn8ygMP4KdueDtcZMTJfJfSYv2xuSDgj594BL/9" +

  "1A5wcwRZaVGg63d8hiOdeXzlyhXYdv0NWNSo+8yEZwJJcgBRmcnwG489gn949QCWt8bRKTrhyGV/K4iU+h/KIVGNp6CFAEYr6ypx" +

  "BPfz6Pl/UoSWB8EP6ZIL7EHWi2wHNUcn4P1Rm5vUq+z1oArz18/2VBa0E9T3BtE6cljNooGqChSyQ5gNCthydGQiOze3n7xhzZpH" +

  "tm3bZmiBQv90Gcr5pZtvucXeecst9P4XXvi9j+/Y8R9ehclqbFAaQXdeQu+z0B2zFgdA9uqnwdJ/7/N9CJEQjR5G1H88owOgT19M" +

  "cKFt5KYvMwaiKO6WJbqlk3qbmcGakRouX7ISly9eiosWT+Ks0bGEsQuREcKbnfIBMsruRD60rdKneOLW8IscEpQbgwNzs/iF+x/C" +

  "fQePYVGjhSPteVy+bDlG6g2fTGThCJpIgzPdAq9MzyM3zuM8WsO9nby6DoIk6mtJ5qRCsCp2Q/HfEIlfMsuRaLAAVOwIQylCQMij" +

  "kmA699KvMMKSGbWMUfcnOfYSpcGF4OaUAZzdGkWL3KE6ckane5VI9s5PRhhu1WZK1TFWB8BIhrmqhkBrbcKX6qCGEO2jAUNoWq+y" +

  "XEuT1c8cHwzSawFGVjImGg3ccfAwVj/6OL7ryiv6SOX9CyMefDTVnccv33s//s/u15CNjsJY6z36DQoAZXce37nxPPz7K6+AgQtB" +

  "PCPMH97Z0LpjwP/gicfwZy++jMnWInTLrlP7a9ZYseNEAS09SjqAPIrOcKIpjVEE6frQPlxak+v/6JlPbdMPkFJlTxSpsdftWtXh" +

  "f2u6HECHrzV+FX1VFCaJlLdKZzhdu4FPBcEVEH+KpO/SMAIysugy0SLL3XevXPUzDNCmTZuGsjCGAgBuJbJbtm/Pbty69fmf+tzn" +

  "th+l/F+Us+2CLXL2KBHUR0UUCIhmYjZBVtopTxetEoqDHJk5k7AIKKJDfvO7GfU1q59UlUX+QJN20QWXwFiNsLo5ggsXLcKlSxbh" +

  "4sWLsG5sDPUsDiuDQyxqUJGeJkPU9v8T5c5e6CLjKYcElWD844sv4Q+eeBq7Oh1M1FsoUaBGJW48Z5Vva8psT7sNfo28dPwoXpuf" +

  "Ra1WU/MW74kmkPS5oEJXfQLgiVgfHh5tAeoaYDx2FDDQk5VmmMUvT7HJa40WG0dwGiDUT8ODjeAIZM1adOEZeMjXLu1wMpxFGthV" +

  "3aOJAyAQmEJVmSDRFrqb0sdA7KUeLTkpiU7fQ3C8wfrfwqj8QwnxNUwBlMAA1C2xKBvDX7z0MtYvGcV7155/Un8A2R+ZMXjuyGH8" +

  "zN0P4NHZWYy3FqEoOygIqNUM5roW45nFj193Lb523bnuqG0a/mFSSVvZMf+/fPZ5/OGOnRhvjqEsO7Am83kT4r0aGEdzbRztHrCt" +

  "9nz4pqIdGyS8BYbp30OV74QLJwy4RxjkZNv2OPOp9ZmCDkasMuVPPVPTj67R4Cg3Lbz2K+FESAcOyubIiFlt6PPvOf/8L27bts1s" +

  "3bp1QW3/UoYCAACXGOg2AF9z7rm/uPPlnVt3kjUtZCgAsJfZgD6TgzAO7ntyIYFVR6CecBFQQPRVwsJQkgWJp7qsJQ6UXxyY5II2" +

  "P8wwQN02zmmO4oIlE7hi6RJcuHgC54xMoJmlUnypCIs2ESxUqXqmx1YOpzCzl06cWtAycOeunfiz53fg4cNTqOV1TOQtWC5hAZxd" +

  "a+LqlSsBnD7YGVQeP3AEc9Zikg2KAAG4jwzoi4xZEPdcCSlLGD0q4+AEJOpqhRCip2+V7Sx8kVrFxEVE0TcGrg0a2DCApiHUTnPs" +

  "NbQkxDUXzXAVXKSJqTBcv7+cI3m0/2bo/6xe1EEeUxo8o9qB8H6u5GWHlzF8exS4ZyYYoRe6T4ht8y4BALpoNEfxm488iw3jS7Bh" +

  "8RJYLvse+xyOZybCJ156Ab/42JOYQhOL6iPowMIgR2aAo50OrpwYwS3XXIULlizzRyAvtJFsQGERSJxfwj/seB6/8cyzaNSbQAmU" +

  "hpAxe+GMIlMMIXtxPMOMBOYbped+jLDfruwHuBMHTkbU0qjvAgCsaJtSnoBwb8/F2FL1vBcIQ3G5MVKQYCL4GLC3evyuOK6rqFnW" +

  "G8f9YRg+cRljjhnrazl9zdqzP/7zzIQ77jA4zVP/BpWhAYCtW7eW27dvz96xYcOjP3XXnX9/KBv9pmJ6riBDuR6gKhEIg+T1mcFr" +

  "mSJh6WsCCGkbISiqp173nVCHOOGuWjlM1id18IShMBk63S4uatWx5aILcd3yVRir1ZO+2oBIHVEcFtNTne1daEMoVoi3cRL/fGlx" +

  "+86X8Nc7XsITh4+jaNQx3mgAZYnSS9ydbomrz1qJ5SMjPRqehShiznn04CHklLlZC9IBAPVZtBWBwwP9RPxUskT0s6iGICVybCBG" +

  "yt/iTFFxKV4aEkk3hDgCaGYGuQemb7RZDH+2I8OZO0xqC5exMtz7bIDRonljlR4W3omM0jGOT/q/ElwlEoGSpuRfRjgAIjB7zUdM" +

  "fI9T1KTSP1XoBcjr/ohhYDGdGfzMAw/g1256N8Zr9YQpMOS4XMJc0cFvPPYo/vLlPag1RlCHQdsWyAB0kKHdbuNfrF+Nf3/Z5Zio" +

  "N7y9/8yY7Fxb3fHVuTH4+x078EuPP+2YP5ewBGQc05aT30vJSFf6LdfcA+oqh5l541uC4bW2A+j4Ca5V2yrNS3UElfb3a0JF4GTV" +

  "L3AfgCPXEnNgwuEcOLLC3uIaFJLCxGW9UTery+Lem84++y8ZAC3AoT+DytAAAABgyxZYgL5m3YZbdz//ytftMpTn1h16Y/yWs4hO" +

  "HtoJI105jtnFUJQICuLidPeQJxaRkHOfRSMTrxZqWEjel5MMDFnM2wKXjrXwC9dfh9Gmi9O3YQbdc2dSdRfLwhMOmQcxWQjzPDw/" +

  "j0+//Ar+8YVX8MzMNKhew+hIE7CM0nYRxDHDyLmLm9es9PVVPWJPs30e9O+bmcOz08dQyw1KMRGJDOcBXtisfkMSqhoTWT4coz0D" +

  "s4rRFwMJhFJFDlI6LHwh9W9cv8ExFF7CA2MkryPLTu+A4tJalBy6GhwAtcc/Saz6oBZz3LnS9uBXo4BaQi8Fs4lAqQc4nEskYxHt" +

  "qXFs3F9WJX0yauyCQAExHaQCRXBOY8cwR5Dj5eNd/JdHHsNHr7sO5DViFkBODhw/ceQgfumhR/Ho8TmMNyYALlCgRJblmOl2MU4F" +

  "fuLyi/FNF5wPACisRX6Gmb/1zP8vnnsW//XxZ9FoNZFZi9Kv+zCNg6Rbtb/CNRk3lueUv8VJpOUTFg/aU8e+XjDQr+5+/mJxHJQG" +

  "oVJPv/qq+z9l9DHigNR3GvrEa44OVclJEFT8E21mrK3X6bo1S28hIt7OnAEYivofGDIA2EpUbtm+PXv7Oec8essdX/jbQ63mlvnZ" +

  "2YLBuajaw2SQxIjqg2M0U4cK+qVIdJW6UauNNMrXZdBSrHpjAhYlDGq2i++67CKMNpvo+k0r3r3/lAp7YmcIPq8+8MKRI/jEjhfw" +

  "mT17sLuwaNabWNQcQckFbGmRkRBWp4JtW8a6sRFcu9rZ/xda+rdskZHBQwf24Uini5Fm04Ex9zYYGwm4fr+W7xzTVyyUxBNdLjig" +

  "UIaQoHRtSDChPyLAb15TpYtDKcKYOEi6qTbCMTaCLUqMNGruIJLTaFbpswFaMHICuBK6JLH7fQmnknCENxjh6LK7iVwYmXoudSLk" +

  "IP07EsF+nMXJLPTa3a/4kIAKOQBKxsl9b/xH7nmne5sHgR6JlLbEaLOGT7y6H8sffxzffdllILi10C5L/NmO5/CHz+zAlGlgsjGK" +

  "whZupAxhar6NixY18BOXX4krly8LGQbPKPNnv3dMhv/x5JP4b888g5HWhHNKJOplkKx2ixqaqnktSv+kFLCkJkLqFCHNgPqp9Psy" +

  "X0ZP+nhE4aRah66r1xyg9m/lXf2AQu96ACI1QHI/Ve7zrfTdN+obSp51lx0oEz8VJi7zWj1bbcu7vvn8TZ/Yxmy+1ZihMX9g2BoA" +

  "BF8Aeu+6lT+3+5W93/QKjMnZoiS/EYFAwNzf8GDAfUgWh497TkrU5QCg4PDTzwc0oDaF4MJ3UpVHdQxGm0usqjVw/vhiMBza/yfG" +

  "9yMTI0LuF/7j+/fj73Y8jzv378dUAYzWR7CsCRS2cBIh4niRB1uGCLOdLjavXYvResMdObzARE725f37DoCRIS8JXc8gELKmIUjD" +

  "roNaMvRXkxM3KKTylfXmiI8CmWqs9G+tClccaXjFiCMrJe/T+Ff6MlavQzQYrxeISX2FLX20B4U0sYbj4Udi+9XVh32ECMTTogiu" +

  "OsI1SZ7iKa6W/kTqFwdCCxkGChpXjrcCXvJXcELkevdJM70+Y+R8XXxNhtDlAhONFv7n8y/CGsI3rD8Xjx04hL986WU8cmwGrdoY" +

  "xrhEt+wiMwZtZpQz8/i2tavw/VddgbF6HWVpw0FMZ6owIvP/+GOP4Y+f24GR1jgy73ioAWIyDgT4SVA3CLiqjKEX4CiMvHso+ikp" +

  "BlilzQOYbtIHBcaq1+XZqrZ3kGlAjwtV6kjeJ5K5Sgak/Q4YvesmiUxREinBOPKUPGNTzRcRuihpZZbj8hWLfrBTlnjqttvoRH1Y" +

  "iDJ0AOAOCeLsnevp4Z/83J1/f2Ck+U3zs3MF2OYurzc5hi9SG/ym9s+nA+Ac/TQDD4NeAY9JCYJSRG0y+IlkCMgKB8gd+9ItSpRl" +

  "CarVelDgl21hcXhz530TEdpFF3e/+hr+7sUX8OjR4+iUhFZzBJM1g9J2UTJHQssSlWW8tsap3xeTwXvXnuPescBEjuE0E4c7bTx7" +

  "5DiauXP+ExZDinvERE7yt3wj/yqWyQgJa1iBy2ogkVSpJRAhONE5asgAAIJxIivTHvCAJ0LWYrReO+13daxPMAWEKBomT3ADhoo7" +

  "KB4WI/s36IcgrSZNtMOT6N2//mIYUQkDVM8wM9jEBE96/DncFKsd5DdTZRYBW/m+GTYAclBRYLTRwl+8sAt/9fJuHC0sMqphvN6E" +

  "LUuXvjjLcKzTwaoa4Ufetglfee4GAM6cYrIYiTT84rQlDOfw97tPPIY/eP4FTIyOAaVkv+xNjhVopL9sgHB6IaBV2B78qefgbgna" +

  "sBBKKABBp1aHEsiUGn1gb8KkhJXfl8SczNv+RD4EPVoDIlhr03urz/UBHM4UGf7y7IQA7ycVOV0ci5K4zButbJ0xn/5Xl1714DZm" +

  "c+sCZ/3rV4YOAABgC27DbQDetWbZx3btPvC+XZZNjSgk1HHIMoZ/aEabbk5Bi95JLyxICuhUE24NUCUONQw5xV9CaAKqAwDrNs5M" +

  "t4sjc3OYaPbm6f9yK04acAxbjs/dOzeLz738Mj6zazdenJ6FNTka9RZGiUGF9aFRBgwL07PYOWhFprodvHv5YmxYujjEOi9o2z1h" +

  "emz/AbzWnsdIo4FuyM3gVNPEFKI4yIuEDFFV96YflTUDz9w5xGD3Sg8hIkQIjI3xIpEKDpu4e+fEsHZdhAy8ZBwXMWG04RxV++e/" +

  "OLXSZSdpZwEEuOvGS++O2Hsph7KeEMv4/tD80Pio3SUkDrzhRkCIfGTIfm8H8BEPH2KvqQjav4AqYoRAGs4uToipJBfAlH/eaVQs" +

  "rD8GmZnRzHMUzJio1wBmFGUXhnLMM9Cdb+Mrz1qGH7j0YpwzPh4OrTmTzn6Ai0TK/Lr4tQfvw/aX92BxawxFUTow5Zm88eNFILDG" +

  "A4FEai2sHruKxgRx/YUDfjzdFd+cANQ9na8KXyfSVvUw9DCp8VwJqDmsPhfrHQBc1D2pczkFX4ZB8F73KYAUpSlwAylgOmQqEUrl" +

  "qBMDK5nKm1et/ch/Lktsuu22M4IUzwgAkKOCv+qCTQ//xJ13/cOhlvmG9vxsyUBGyFLwr+xK8lnUso6YG5+jXT0UJHwAasEK8oon" +

  "TvUrvZKFbwlyGEzZLvbNTmPd4sVnxM47jMLs2F9G5CMUCI8dPoTPvPwK7np1Hw50O8jyHCPNFoid6tdpZgwIVg6tctJWSLvrBqJk" +

  "BmcGeVFgy4bzQEQLeoiKFNmy9716AOzOmASMl1aqqhklWsrsRgLQq8eRVLDu7/hvBJz9bIrChSmss0EEYqGKqDpTz+j0ntIATBaL" +

  "6h6wnsaaLcAoySB3yHiAxCaSmHuRluwIFukhTfCaBAj+khrQj6m4OhSx9IKCAI9grgnvRPzMgD1Biowwh1SFLGmR8GKGBZNPh+Sz" +

  "/FlbogCBsgamum0syyw+fMVF+MbzROo/c4l9dHFRCU54+eUHHsRn9h3AxMg4qLS+Pcp51TMn+H3kvk0P5hnoZS83wVeWdNV7cokP" +

  "hvHaMxuBRPo8ElAg70wdrAnhJZ4HCM13WCMy6uSpsD779KGPqj+VHBGAH8maU9pn3VbpD8k1IoRDlHybZf2IpsQSoyQuW63R7Fzg" +

  "r9974TmPbtm+PRtW3H+1nBEAAIQ8xvTOdStv2fP8K1+/ixk1GOagOVREVQiJ/Ks0ACFntFa7inra35aCBn/Mq6iEPVFyFz1BU+gR" +

  "ECDrQoC6bLF7ZhbXARB56MuhVKX9DMCsLXDfnj34xMu78NChI5gFoZnnGKs33FizhRWCbQkha5uD7hVNjFvMmSHMFh1csWwRrlyz" +

  "GsxOc7KQZE+kkGPteTxyaD/yWuaTw3mJz4gTnp+5AATlXHeN+atOQrLmIiPR8cBBJVoFAQiLzWe05CCNDquYwOO0HdkxyGjSctcn" +

  "mm/cBCBbsWCA/FG01lMs4yU7TZc5aU8kiAznLMtEXntEcZ+q/RrFJAFV7jIJo5dbIGptbzpU4y0MXRIhke+IN1zI7KpeRhAjsllw" +

  "WlQEPUQEBInOrw8GckNoM2GmmMNXLFuCH7riIpw9uihoEd4M5i/RBftnpvGx++/Dg0dnsaQ5iqLsooRnqMwhBz8gobKxrVo2r0q3" +

  "mgECmta6Epiv7EF/KmmYR/L1xh3kaDCAKgDs1Qb00p9EalftAjlTmL6/Wvo5/WmNWXibAjsMANam7wrdqESTaNCsWxJMIQYZmOeM" +

  "oVXdzuz7zjv3o7cCdMmWLcOWJUI5YwCAiOxN27blX3vuxod+6jOf+b2jo2Pf1ZmZL0vmTOyLxC44sBr/GYsn5SLhQ5gDKuq98Naw" +

  "IoMNSRP3EEKGsMidsOPvswzkGV6ampZOLNh4DKNI2xmptL976jg+t3MXPvvqLrw83QZlNYzWGlgEdse9cmQcIYRVPK6BQEwDnVbX" +

  "QAbULbBl40YnFQmTWMh++b1939592Ncu0Gq2YK1PABzmxJMU8nHrSgUXtn9lg8ZR0yUlFoNshNX2ubU4lFwdoRgil6LCkAgR0kp4" +

  "1gQwIbMWi/M8tP91F/9Il1MCeqpUKQDxIKylz2pimBSG0u7J3Iri1NPcAS2JTCYFa9bTBwaCCUvfH5I/Jd+50YzmBQ+o/ffGAEwG" +

  "x+YLrGrU8JHLLsI3nrsegGPAmTFDCNI9eSl9at/nDh/Ef77vfrxcEiabLZSlS5XlcarfT4zgH6O1IH20MMnv6t8VebvCwv3tSt0t" +

  "YFmp5quzGapX2iao++P6UIy20q4UmFR9GOIKjEzbJt2p+vMkYMD0cV6vvDfSjJj0Tt/je4CCbTnWGs3PLos/uGb9+qeHceLficoZ" +

  "AwAAwhkBX7djz8d273h26y6DccPwWgAOogGJFEda2uiPOBPbjvpTfy/2q54p1YmAvCYhfIab7Doy7JmeidLPW7BYZi95R4Y43Wnj" +

  "gX37cMfu3Xho/2EcLSyatRommi0wO9U9QUkCnsvqhW9EvU1xaCXKwoKRmQzT3QKXLlqEG88+Jx6AspBFTeudO18FmwyZhXf+csW1" +

  "2cJZ+02yXpzyQomUiN8BffdwP3CvvouMRkuK6pVDK8aQP+lGE0M5l90faGMIDWRYMtI6UVWnVDrqdLQgAVVAYY+pLmjyKqC8Inz3" +

  "lcsV9pLxFNzuP4ZAIO1uUfX8roKeRE3s72cvFAjzqDIuFk6pJAhjCIQMs0WJzBR4/7nL8G83XoyVoyOBoeVvgtQvMf6ZMfjSa3vw" +

  "C48+gqNcw5jJUNrS7fOwOBnJyZgB8Pu5EzqgmNgg0FzVlvUWHRfQ60hY1cQp4T2+JmmPrLNBrxuwcb203Q9opG2Que4FrBqoOCEn" +

  "XXf6/fFcAdev+L643t2qs9zJMrNqpnPsGzed9ws/t22bOZPSP3CGAcCtRHbb7bfn1918865f/dKXfnMa5j8dOXK8MEBuPQBI5y86" +

  "b+k5r0YGqC/cFdLIToei9D4XrlTVWiCADTIC9s7OYrboYqRWr+DdN68wKg59BMyWBR4/sA+ff3UPHtl7EHtm2yhrNYzlORbVM3BZ" +

  "ovTqKxmTsNdEHRZSNKkwKo+4jSKczjPanWb4zy/aiDzLUFi74EfiWjgV5Y6jR/Hw4UOoNUbQtTYwGq0CNMa7rCkikc6XfBrUSAZz" +

  "r49AVb3tapHBEbFq0NFSC1fqmQkpgGVnGPLHzpLMB2O0UcOSUQ8A3sB8SA87Zem9/jkQXxeKl54B75gK9UjfUptSs8WrmlHLvrPx" +

  "3gAOvLQqpNNJ4xyItxT9d0qAo0QfwC3FOAqtng5ChryfhFDXUUOJWQt0ijaunpzAt19yAa5avty9j098RsAwi4x1Rgb/+9mn8d+e" +

  "3wHKGhgFUMD6Q6zgwT38WFuAYjLmsCs0A5Ux8f3SNvJ4Ein132eJfagMzqE2jHPadv9Q1OxyupMC5faSWcJ4Oe2DMGupX/qlQxPl" +

  "2Z5DjsLajc9Lf1i1XWu0qu9K+iQAWQFlF+/vDMklc7lodCS/iPk3bzjnnN3bmbOtZ1D6B84wAACAWzZvLrFtm/mht1/2m99/+0Pf" +

  "cTAzZ+WW2VJGMRN/dBSq0IigFpQS8WNcAGES4lo+ofZeEyNJsGL9OsgIONgpsG96FusX109e2ZCLztInKv7njh3BF3fuxOdffRUv" +

  "Ts+gMDla9RbGRkY99mYUtgBT5lR/lTqrhDgCJhkPJS3IgjaE6W4XV05O4qY154R0qAtdZH4//cormCLCOCRzX6r+J8oghyTJGtEE" +

  "LHSgQvhPqQ0KGPo/wjpzhMl5iFseLgQYyzI0QMhh0CZxsvKAhQiARcElltYbmKg3wT52//UWsdF3faIYVypJXPxQBsYRpOZQi7+h" +

  "P2SOxF7tvSogCAgj1stEPUQ+tKkikQUhwP/Nilmg8rxfFRBpldm9qw7GNHVxtN3F+SMt/ItLLsbXrFsLMgaldYz/zWL+AjzaZYn/" +

  "9tjD+Ovdr6FZbzkNGVsYn6/MsvKG9ONJojELe6XC7IykQ+8Psk5oWlJSvUjuvftQ6olC34lMbO5xG+uLFSRSvzBhB0hDr9WXmof4" +

  "voe16G5KAFG1jp62qTXVZy0mwMCPK7sEQFwaytbMtY/82PXX/OaPb9tmtgxfhugpZxwAEBFvu/32jGh8//965plfOnps6tf2HTha" +

  "5BlyF4bN/sAPgpw1LYcBaXcgAMkEW9iAcgnwSS5iuNHgxaVCgIDwFqcJcg4102WJXceOYv3iyTOuARDiZdkipywQm0Pzs/jSnj24" +

  "Y/cePHroMGYLRrPZxFhrAoYtSlug9KF+jj9I3jaETaP77W4KeVb9AIihWTaZf84j/5ILfOCC81AzxmcRXNiRYTigc7jdwR2vvoZ6" +

  "reZOTuNeAuQ+awdNibmu2v2j13oiqDB8/xGO+a2uGa1ZsqKaRJSjilMEFK+3SDNXjY5hLCfMkEWjBAoqIydGCcozzE+18Z6Lz0dm" +

  "jAvHPI3VOt3phPn3WxNklPnDO9xFoM4RGCRAXeUtqODnHgcsJTRpPb+DN4AO+5PnE+ZeYVrxeYrVcWXfs7xdAAihRcA0Mw4WXaxu" +

  "5Hj/hevxTRvOw2ijCWac0aN7dQm+T+xU/vtmpvGLD96He4/MYLzVApU2Ho/tsywaUV97QMWMoFkRoMxhPWtTjnpvpR09QoT+TWI6" +

  "dPMiZkEvwIe7q1pIYcjswWbqqOu+s5X51Xfoz1U1vPOPUZpBBhygML28gb3vgV8XpNo6qAz6JgghShtgGOgQyiVjo/nVI6M/R+Pj" +

  "+7czZyRey2ewnHEAAAA//Z73FNu2bTPfduGF//2JL97zwSPN1qayMxdOFdUSvFK4+gUkkZNpIfKewZwsMVSXblXy6/EihUJt5DOf" +

  "weDl41N4d09twyuMaGtyUkaGti3x6L69+PSu3bhv334cmi9AJsNorYXFdaf+LWzXbX5j3OKO+pTQ37hJo4c72CRjK+PppCHn6R6Y" +

  "AAHT3QLXL12OG88+e3jSvwcVn975CvbMF5gYaaG01k3TCd/nN3oiuacMI44HIAQmISJqw55IW2CtRZY5+2I5JA2AvH9xq4WvW7sW" +

  "v7PjGYzVx3xIrPN8sLCYmZnF25cuxTeev8HP7Rv0x/ADcbzdDvkOQjATiz1XdpgQbYFcUcrsU6UrYV/3L0HbF5g9Tmjz9x/6SqxR" +

  "C6DeR9KG2DDrGVZmDErrzr+YAOH968/B1gs3YllrFED0sj8dYHU6RTSAmTF48uB+/Nz99zlnv9YI0Om6E/2CvZvgInncJ0dcZWn3" +

  "AugoHPR/t34iNbEKQ9esPAWASR2k6/CRIoE5SxhddEDt9RWw4ZqElYrzslw3RgktqinC8BPfsUq/4pgoHOTXbI/KP+yD3lIVFsVk" +

  "kjHZvJHlq8v5p7/9yrf/+stvkvQPvEkAgJnx1KZNRESzf3r/wx/a2Tn2+f1gZKwYe5h0qmgCwqWwmiRMIxIfBPSmC1UnqzqZCXgI" +

  "jUWWGzw3fQzAcM/sdl7JCKhdmOqOY0dxx+6d+Pxre7Hz6Ay6ZDBSq2OimcN5kpYofCiW8aFXspF71HYUNwaJBBPGLw6sRspi/5Ox" +

  "L4xB1iV8x0WXICMTjj9e0LHw7Z0pS3xy5y608jq4dHicCMGuqJm8638k9rpVIpCmATmR8IT+Jo1IgWKqLk6BKsAo7PDMd6J1+NcX" +

  "X4rxPMOde3biSLtAuyyAnDFuMly3fi0+cNEmtPL8tDRVwtzmSxsy8GnCnRB8BTRSk6pjPkEjBwStnET9BC4cbhACSy7fhModIMVY" +

  "Bhvyjq+9hLwHqPWZN6gnmF1/M+OA/rFOF3W08Z7Vy/Cvz78E65cuAeDAHcG8KVK/FHH0A4C/fu4Z/N6zz6M0dSzJMswXJYwxATSR" +

  "+oeUZgZAAP3JuFD0EejnTKmZq9Shf4OosrPctepoRZNML21K7fME63MGBCfuoLWINnkRZuJx74D4koW3c4oFAFT6ofe5D6tNG91X" +

  "sySCQtVHqEcDFUCq00jPGWApUXnj+LIfJKLu9u3b3xTpH3iTAAAA3OaPC976tqu++AOf/uz/PdpqfkN3bq50hmrAOaoAkUj4JCjs" +

  "BpH9iXyBYACJ6jZZxIIuFQNIFpy74KUbxGtwE1rLCC9PTWGu20WrVjst4lotTr3vaswMBSX2vtkZ3LP3NXxx9x48cvAopooS9Vod" +

  "I40WRtmC2bpjJeVwIiCcKx4kpirBdi+MSF/3XXrODDLVDeI2k2V3HsLRzjy+cf05uGzFEicBDyHLmdR7x65deHZqGhOj4+CuhVEH" +

  "yUvbtc1PZJ1g+pFQT3bqJRvWRlUKimuhH5wJOgQiFweMSDidRDLEI7t8EfD5/gsuwfs3XoSZdhvdogAMoVWro1GT7H+ntz5FGzbV" +

  "LhQxZ426hc7GdRSXjwdiSAYyjKuXxk24nyG5DBKJnfRTuiItlsFZqQxculofAZKq9yvSZ+SCMF7DVFCG6U4XuZ3DO5dN4ts2XoXL" +

  "VrgDraynHVnQppx5AMBglNYiNxmOtOfw3x56BJ/aux/1Zgt1GBS28BKvM/lx+FeKQYZIG4EKeGJRh6RgOnWg7qUJVenfWus0j0A8" +

  "YTPc7zRIVRV+fKe6IgJKyBDpHA6F8UudAYQ7iSkslX7amdjVXok/8IIQt9oLFPs9m/SjokFOvxfaQrAGZX2knp3N3Tu2XnXZp7Yx" +

  "mzPt+KfLmwYAAOA2AGCmb3nhtVv/cPeOr9vFhBwIaueQNQxaOvcTXXFKEtZenfpI6NlPbD8tQ/8Jl78zEA53utg/M4N1k5P9Ud7r" +

  "KOz7I6haJP3X5mbw6N79uOvVPXjs4GEcaHdhag2M5E0szi0sW3cSH4QZeJ8H6YcMjajxwuY1CqHHTUWJuk9zVfQSUHIOkbMMrM9G" +

  "8O8uuthJYfLoAtJFhjg3Ffi7HS9ipNYElwzOKGbjAioEiMOzpNBPas+MAKmvZHISTYY2mST3+rkYsg9gKM7/wGC02eq5rp2f3miR" +

  "52eKEmQyZ3cnCvb7kMylOlx9HEyrZZDTVPJdzzxoD/LK5Im0J0wmaGWirZxM3B/geL8lwkzRBbiN6xcvwdbzN+CaVSsBkDM1wYde" +

  "vglMX4r0JzcZHt6/D7/58IN4vl1ibGQcWdFFQQ4AxpMWjTrkJ27MoE1FFfhG5liBSKhu7KpvQATS8bMIGeJ3EGmM46oRWIjtvZeW" +

  "Rr8OF3pZBQep75JuK6JAULnfdT+aQ/ubQHr3f1Uz0cvcoyBA7P3XSJ0Z4n8bcm6XbQLOLtnevHzVj/0qMz11hlL+DipvLgDwKYJv" +

  "2rr1wZ/90l1/cQStb2vPzBfEyMXTW0+KLC5RLbmxFaqrUKvcT54heJUjsywIqU15gIYHeuvJjcHxtsWOI0c9AMDroglSvyTJ0SeC" +

  "vTZ9HPfs3YcvvbYXTxw7ikPzXWQwaNZqmGzVAS5RootC2kfGnx0tqDVdkJb8bYn6jiqjGENgYprkfgtdedIzwxqg6HTwvVdfhcWN" +

  "puvPEKR/Znjb/048MzODieY4ulxG9aZInt5n0Uj2NyFAnvjoWF1AMS5I/nCr+hvfHduRrg9Zf8GnQHClnwedNmeYRYhrZKZuPhfK" +

  "PCXMdLpTgCgDyVkQsicrdJJY/hFuICpYD8tlbKVuKyDUF46f+9mWo9TqGbfaf3JIUyIZMgLlcP7tbgcYRjh87Fi3jRYI71y+BO/f" +

  "sBbXLD87vIshDn5vKm1G6bVgJVv8xTNP40+eewFF1sCieg3douPWOLvcFwHgUARKvQxrEMBNxR+X7VFxdldBnD9VfLBAfFoLVF5Q" +

  "c2DP77m+79YmR03TUlAo4Dt89q/QR0mIK6cGmMEMFbKcpaUfg4/gpVfgYO6jQQk8xq22npwxbs0WI61WfgHx333jpZfet2X79uy2" +

  "M5Tyd1B5UwEAAFyyZQvfxkzfP3voI7vvefLrnjYYa5TsxTinENdLN1WrxIWSzCyRmpS4QKv00X1XjS2IRd5gGOAswzNHjuAr1p97" +

  "yn0T9T6RO8lOCPSBuVk8uPc1fG7Pbjx+6AiOdBk5ZWjUckw26yBYsC1RcOmBswntjWomRKle+lll/GGBQqnEEbJxxVFA7zPwp3mR" +

  "SwlbywyOdTp4/zlrcOPZZwfitNBFNt7xTht/8fwO5M0GCi5iuzySzgAlgVIPYRKGoaWOuGnJ8yrPJgjhxLOKwiC8EyxsRJiR8oYn" +

  "509RDv0woFj0WtD/nm6R8Z8tCxzudt259X6tWc9cTN/NIgyTwTobo0q2JePWu2pUhZoIWyHGcY9aZgXkJOM8pfWQOh3aU/8aZbDW" +

  "4ninxBgZfN3qlfjG9etx0eJl7kkP8swCaFBOt0gYYmYMdk9P4bcefhh3HzmCkdoIGgBs6VXtAoxQelqQOvwCvQw7XB/0bj8/eilr" +

  "CV9OxzPqFEZ5rmoLdw9Fvy3HlBHmOBXwdJhmdYFFEKD7pOWwxAwobakKd7r/RInGrAoCqtoO/d4EKKjfDoPF3ehoij/0zjJ3M2M2" +

  "lPb4v7j+su//SWa6ZDAiO2PlTQcAtxLZ7bw9Gx3duue3vvSFHz3UaP7OgaMzZQOUlR7VRjrvPiR2vTCxsiAjt+9dlIA3cLuzyk8y" +

  "/HFyLTLK8PiRgyi5hKGsr9ZbpDIXyOJibEW9v29mGg8c2I+7X9uLJw4exb5OB5TX0MqaWGQcoSrAsFwCcKEzAbQH1ZoCQ5T+neKf" +

  "FLGG6xCml4KDCKQqkpd/qkmEaQYuHp/ABy/d5IjEAkmb1SJ1/+8XnsXO+Q4mGqPookyQuPHrAEqVKJIfAO88Jr4M6ZjIBTEvhXGt" +

  "jJ8w9vR5jozNVyUk2BKhK06AQxqbM1mOtedwvGgjM7UwZibZjCcofnNwhfkD/RlPON8j3KOkuzjs4XmR7mQPVrUFcU84YNYtGMfL" +

  "Gaxo5Hj/6rPw9WvXY8PkJAAfucGOob0Z6XurpWQXUUME/OPOl/D7TzyLQ6XFRG0UlksPWMknhCRHxwBPD1Lw32//n7wQFOFJBC72" +

  "46SoLzjJQyG3EuTE1iCZazAtn7V27oT2syiwVAFNP5W8jMMgU62mgdoU26NlOEGLdF3J3+zSS2veYplRGi4nGrX8EjLbzhtZsnML" +

  "c3brm2j7l/KmAwAA2IItdsv27dmH3/7OP3j59js+dLRRv6rsFNYQGUbqUFLCS2oJBwTEFNBXAkaUbCAmgBBxQBDlbT9gIWl2R/Mc" +

  "L0/P4qUjR3H+kqUhHIgBWK/SjKl43bMvTR3Fg6++hvv37cNTh6ewvyiAvIaRWg3jzRGPGkuU/shMl9FPbNjSjjhOzv9BiKo/Ateo" +

  "b/ugXKmDPbGQgQwHuDh0Cjn4J9r1nC3LWKDICNyexQ9cdQUW5bWhZT4TbcnemRn8/cuvotEccTn//Xwb6FgZEfHCcTiOqbOCgoFZ" +

  "+5mO3Y/+C0FV2su3w+EwSOP9Be0DSL7p2jfFkXdBixDB/bPzmLcFsjyHU0RFibPnmUTylJmCj9Rgz8DV2gt3ur2d2vzZZ5rkMIdp" +

  "kagfJWkBiBlDyR1fTISZooQtS2wcb+I9Z1+Id60+C6tGJ0I/Gd65703Ha+xTczuB4cDcDD7+xFP43O7XUKs3MZZnsFy6HrLIQR7A" +

  "htOVRKJOJVUkKzfKCpoBSiGPJCxSXxL3PpV6W7Xc2byrAyhAsQ/zDb9dK0q/f92suZDFQJsYiI6n8lvtsQRA+HbauC76gnoggHs3" +

  "ZqLhsgivBPpoISr9oD6+QBXtVATOsDarZWus3fHvb77pt+7avj3b7s9Ye7PLWwIAEBFv374dRNT9+yee+O7D+w/cvRvG1phMUdE3" +

  "9ldp6YUw2EEvqPs5vQYjwCAix+r7cgaOU44/eOIxfOzdm4NqlAjBXlhwiRePHcMDr+7Fffv24+ljx3CkWyDP62jUGlhca4K5dOp9" +

  "z7CDVKv7qLZJ7BsjOrE4xM3qXglfqSL/ABqqO0KNlWP2pAbG1czWoqxlmJqZwfdccB42rVgWJJRhFNGc3Pb8DhwuLMYMoQsoG170" +

  "EE+tiak+JjCYqkpSNEgIfueBAWngE4sff7Z9mJF/pycauTGYK0pYa4fiF3Gmy0tHp9EuGWOAT3DEgCSWqoQs9wn2UlPixk6i0ZO9" +

  "hf6Olxpg6eKcH/3a9Bo869tj/BrvGsbxbgetrsWmiQl8/YYNeMdZq9CqNQDAO/dJXv+3RnF7yq2Zz+7ahY8/8zRenSuwqDUOsm2U" +

  "HCOgZN8LPdAsNWgK5bPWiPri+HIqIVfV2VqbJkSuOlZhO1H1urSrqvEZvL84rBC5JvfE3BOyPyPM0dUI7aLwZ/T1Uu1SYxDSQjMn" +

  "ACaCAxNojgxGleFX/RMEi4XWe5pcgHlZXjNvX7b0B4io2OLC/k5FwTD08pYAAACwdevWcjtz9j6i+372zi/8ztRY7XuPz8wWGZvc" +

  "AIDpzSVN0HaofqogxMUREkMgSCREFEPeKNqJdZFtVMBiPK/h7oPH8LEvfh7/9oqrsHpsAjPdDl44cgR3v/oqHtl/CC/OTGO2y8jy" +

  "HCO1JpZmbrEVXLiNDMCSS+cqseysNkuQcwNCRegXC89hQhT93ZYQZ6jqGAiTcpKY1wIE0OCeZyBh/rLF6pnBgfY83rt8Cb7tgouH" +

  "ku0PfnzZuhjnpw4dxD/s3o2xWgulLWIWM92vRBIlgH0ykUQS1ZtegTvh6aGvGjAA+iwARvwyJSDKs9i3ISODuRKY65YYbZgKJPny" +

  "KdLmp44fBZscpS2BEF9ue0wqgR0JEZQx7cmzDjXuQCT8vcQ3aPgQPC4Cx7FwKZddgizARQEYzBQFCtvFshrh5rOW4avXrMXlK1aH" +

  "EFl3TgV509pbgvb6TI0GGRnsmZnGx596DHfsPoR6vYnFeQ1d23V5PRKGp/Zun0UWmA9HTkT6S7G39JNgw94WJ2G/xn1deq/omoOj" +

  "Z0XjkBYO9Ma1j4KWwU2HFr5Ux9Sxl72KBhJUqdoav5OEQdVS9Qlynx3dDSQmAHxKaHSlpp52RVrqLpZki9ZIKz+n2/79D1y+6R+2" +

  "b9+ebX2THf90ecsAAADYAtit27dn33PFup+89cFnvvaZWr7WdEprCYZtTPQatF6JMrE/4w7f2CpBigZiqjCZHocQX2HBJRqtEdy+" +

  "7yge+vSdWDk+ipmiwIHpOczBwuQ5GnkdE3UCLIO4QCE7x7UcPlUPQN650FdOJM5V5PJFs+qDJ4hkSK0tAzJaFc3JSozaDMfQKMka" +

  "JyOEeLCFPOsPZDEApgvgsvoIfvjat4ENwUB1ZQELe9VZly1+9/En0UGOBspopydKNqTjJFHKjuG7g1uXaEW8ulXAUL85d/X1c0dS" +

  "IENpTWpkcLRb4ODcDEYbkyfURL2VCxFhrijw3MHDaGTifMrhTIhAw1llYfPSFjM7LMZOKgcnSz+k8VVvE10TZB4AL8H55+VC9PS3" +

  "aJABw2DeliiKAjkxNk628J6Va3HT2edi1dhYeIM4euUm1bG9mYXhzIaZMSjB+Mvnn8OfPvssDlh3fC9ZiyJQiqoU75izmAESu7W2" +

  "YyUyQNpfDaTTr+KHkOnCOAYYGHWgV75dXqqPmjQtmFTr5f60NYyKbG8O3/mPnqH7eoUwsqPjLBk4mADqp0mI/RbgH9db/7XguikE" +

  "2vU3VfcbJOEHsYfx1bbkrsnM+tIe+rn3vvc//vy2bebJJ598a6BPX95SAIDcOQE0Obn28PbHHvtPx48c/9M9nbkiQzzUytEeORsA" +

  "cXGHxdlrC6u8w93updl+KsiqE10U9BhkLcabLbSZsWN6DiYj5M0GJsAo/QInK+lnPJP27RTQ4shjxZchQZPRPOC6FBG2IHMhxAZG" +

  "ybGD+5KMizOy+g1FYdxkQxEYJQPjtsCPX3s1xmv1oZ54xuyI4W1PP4OHjxzHeGsUHXbxzcTaKxdIzieo9nXg1krDjKIEEPQfob64" +

  "HgasDQ+k/M2BGNVMjmM8jSeP7Me6yck39YS4N1qkzU8dPox97S5q9Sa6XCaxOAGY+jUjY0h678lejPioL/OXIlJTECIBWHWHHACU" +

  "ZQZdZhwuO8jLLtaMNvGONefgXavPwsXLliIn19LS54F/Mw/qGVRkjDNDeObYEfzOY4/joQNH0Kq3sCwndKxFBlFA+/3rHV0NmUAK" +

  "tCYm0IiBfVU0g+RIb/YZPqP/U6AVfVT+WiMDintNz3fYo/4b96sqeMW9B453OhNkNC1pAU6HnpK+QfZoQKX9lCIMeDu/e6XQVhmy" +

  "OM6SbCg+xwAF2JvwGvKDkGACfw+zA8xdonLVyGh+6Wj+o0R0YNvtt+e33nxzgbdQeUsBAAC49eabi23btuUfuOKK//nTn739Ww6P" +

  "Nt4/P9cpCchkrJ0Uy2GhxmxvCAmvlbmwZxHKgg0ew0B/Yl8BCLItSnZJcVr1HOL1b0EBDRNEuvfSIkfbvfYpsBIi4yoHqdO5kmUs" +

  "CxZ9Ql2YvJqcYxv9ZiQldUX1NkJiFFFjS7w8C2UnwkxnHj9x1VVYN7kkODwOo0h605eOHsP/fOZZNBojKMsyaDuqMrh2/lIiYiRC" +

  "ldFLCE74HAmavictXLle8ToI9r841nlWwwN7DuBr118wmBa/RQszggr+ky+9iBkAY8yIHvlRxS9jQRwZi5VjppXqGUBwKKvy/zhz" +

  "LqNnSF7DrnZHTBk1uJMWZ0uL9nwbSwzjvUsX46ZzzsJ1q87GaL0Z6iy91DiM8NTTLdYNMIxxmos/f/45/NmzL2Cec0w0Rx1Fs0Du" +

  "+H0kUnB7PK5nH/kiJ6cO0DTF1Q1Pl+K9hLjmq7nxtRZGpk3HtIsmSO8x8egnSF5/v0IoNkCzVUCEIQsWZ2xvPK8sn7DahGEHAabS" +

  "W4ao+/t8JxoqBWJdX/URxxS0F3rPx44aXaVvh3gSyYjI1wSAy3x0JD+nLP7h+655xx9s2b49e6sxf+AtCAB8sZaZvv2Cy/79a089" +

  "+J4XyIwZa5l98npmkWW9/Vs9SN7IG1RJUFKwh6/imVyVm/s5AQIImoKYSML6ZCRhW/Y8Q5KaErK43H1SGIDxEgu8Nkl7rPuGuGM5" +

  "w1uEFJvYB/JENLTf26zkqFI4Ilz1Vo395LgJXaMwNTuP77tkI96xZjUKa4ee/7xblvj1+x/AVFZDyxiUtgSxidpM0YYE1Tyh9+yM" +

  "XuwPxD6G2Wa/ZSneXZ27vqFFSprV3wWAAYtW3sSDR4/jtakprBofO7FQ9hYrLvmNwYvHjuH+A4fRqjVdSKpiHCwUGBz2GVM0KDnJ" +

  "lEP2toEncQoARxwgFgZJzkGvYEbbAsfLeYxYwrkjo7hpw1psXrUCaxcvDVWVXhuoz854K5UwJuSA9X379+OPnn4Gjxw6itHmCCa4" +

  "RGkLx5zIUzOOa6unBGbrJNATmZkSBz9pD3OgTVUAwT10AWHfafAQ6KU6EzoB5CeYhqqvSFCtM8FJ6jZ1LAxIRGh6zEsBIPiayLiR" +

  "qO3JJo9rwSr206J6YFbc+y57KmzUXSXjSVD7W2i9u0CWuZvVaF23mHnP+uXf83MAXfIWU/1LeUsCgFtvvdVuu/32fM2apbt+/4tf" +

  "/Mgs08dfOzZdZOBcM3RZ2k5y8cfABCavpMcw9KIGE6Kt1mofKbAHSwYcoTxRKxsw1FFB5lFu8jWTQ7/kTxbru2c0A/KVMCknKZLW" +

  "yB0ceh2lCKQOgmE4ZCw4HLqRG4Op+Vn82wvX4Z9vvACllQNGFp6wMsQOSvijJ57GA8dmsGhsFLYsHTLvw6ADkFIEKQ5V1K5QMo+p" +

  "w56edRmH8E2ok4I0or/v2w9PBZiBjCyOWIu/2vECPnzVlShhkXmNylu1sCaKRPizZ57BUSY0yYWdGaZwH8ERfbcHRVQTQqzWliRV" +

  "gvu+qsWJvgSyd90ZEyCDbmkx0y1QJ8bZoyO4eukybF61BpcuW4Za5shViN0n486/eMuNr/drtwihwS9NHcMfP7cDd+3eD1CGZU3n" +

  "5FoEyfJku8zNU9AEVjRSfQFw0BJGI2EiY8ichf3l6kk0X6LlCRoD7xMQGCEp0dy3Q8sa8kdg4mq/6RYLsFR9CcIZ6z0sHJ1D26BA" +

  "Ewe6qAB66GNFwAL3BQGujVYnmU3qROWjW8Im9L80tlwyNppfZfIf/8rzLt35VlT9S3mr7RxdaMv27Wb7li30o5/5zGefyurv5vl2" +

  "CaJMVEwxHCyGYISHKb0Qs+lx2AnV0BD3Ry+hF/WdqtzfyhoGJgu6n0kh6ZzSHsgGi9fjDg22Nt1eIrUAteqLQ3M0fWZEZyjDwnwJ" +

  "hlxCJLDLlHaomMYHzjkb33351SjZ+qxow1kiZVkiyzLcu/tV/Njd96I52gKVABtnBmGlddBjQ14t3fOdqjshdr7E6VBz3kd9yhWC" +

  "F8OCokTUf27dOLIx4PY8fvn667Fp5XJ0S4taJvPz1ivMjMIyapnBZ155Gb/40BPImw2fcc/AiCgfxj5TpNnEfWcIBAtmRubRkw50" +

  "jrTUhgkylAFs0S5LtIsCDcqwYqyGq5cvx7tXnIVNS5dgJK/FOlikxrfmWAJuVEprPaAhHGzP4893vIhPvbQbR4suxmp1yFoSgpHs" +

  "fQbIpAzXqbcjUBukqRxUNNP1VyrfV/oQhG53v47ETvabb6MNEC/2w1jhyTHMjjWtZO6hlVrTVHXM1a0PTB/i4OyJnLbX9/RP0cbw" +

  "DkBU+9qBMWoN3Z4Opo3wdk8PfKPCG4nBlq0ZaZmNbD//K5vftXnrbbeZNzvd74nKW1ID4Atf8uSTTFu3lp985JFv33/owMOvZjRe" +

  "71rmDGTJOGaWqHjVw2GCK5XKvxzvO5GEJgs1TL5ClNWFKVKN3KfrCNeCVCkLjpL7g9oNvfVIIcTFCp8HnLyk6e7WyTJkI4pN3b3R" +

  "kAtHJABZbnBsfhbvX7EC3335VSFkaljMn5mRZQYH5+fxqw89iKxRd/Y0l/YJDvgQqJpxsZItbCAj8NJGxEsp8k/pppJIlAZAgy0G" +

  "J6FK4bFkDRnAOKfM+VoDv/DwA/jVm27CstaI96F4azKtkh3zf+bwYfz6E0+CvV+LW38lSvhTJqWv8HNUAdywnviSD93zQlkYa7/P" +

  "cspQMmPOlmjbDmrcxfqRUbxt+RrcsGoVLlwyiVHF9Atb+tC9t55DX7WIg19uDGbKAp946WVsf+kVvDrdxWijjskao8uMoBSiuMPI" +

  "q0wCbYEsMZ+gxqvbjTEhHe9gMNpbqvQwUWf30KzBYFc+WzX/gVIIfbOROYpvR1UjKntUl2qbNAhP97p+Lo5UUpdcIwkHPBFwIlSX" +

  "lqOv3hVVlrwRa78Ag9gcJiCzlqfq4PWlnfuWlWd9JxHxtlOdoDepvLV3FABRn/zKl+78zvuK7PeOHJ8pMuLcZh4AKOwZHMS8uijG" +

  "+/rNA3EeVFJiAHo6JMkVhtinYnuizVezDvX9iTrDpJJOiOqpV9LV75EEJ6LB8nTjhG/SgX5u7TqAIIjcC/1OkZgB050O3r54BB+7" +

  "4caQ5tic5B1vpDhC4EwfMISf/PyduPPQUUzWW+haBmXxjQR4/4dKVrlKqwY5QAViQtFpMmlH+BBD2Pq2V03yoK3siJwHLXDpUqc7" +

  "HWwaqeOWt1+PZa0RWG9LNKbnmJAzXlj2DTuG8uyRQ9j2xXtxgAxqJHvBS/ye+YoaGX5fGQKsz0cR+2NVzin3TEaEkoECjHZZoigL" +

  "jNYMzm21cNXKpbhu+QpcsngZ6lmURcSZz/HEN3u0TlIYUVtGjr58budO/NlzO/Dc8Tk0a3U0jDvbno1jHoTUrNazhhUwAEXGHVTw" +

  "WjuF/oxaS9JJY3vGk3vuD/XCaXX0RvB6niS1b1gXvnpngo9qe0sSxkXxlDwFAJK9OWiTVcYotlM0AOxcCFhtWNEHaGFM9USijAaN" +

  "DQvdtB7wkjrOmD098kSWAbAti5HFo/kNVPulH3n79T+6nTl7M4/6PZXyFt9dAOBMAX+1dWv5Q5/53P99ytS+ludmSkucAfHUJSdx" +

  "RA98IKLsQLxEHaXRJwPELpe7f8rfrzw7eQDSlnr665r7luq3hvLEPl+9WfhwD8EI61VBUZUWNKmGOfEDENhEIBQgLM0tfvXt78CK" +

  "kdEhh68xitIizzL83iOP4PdfeBGLm6MqUoGS3w6ZGzCXgfANInbJZ3VdpI84XOxPTPRz16NSdTvaCfUUPJyjo1JvsX6S5EhWBiE3" +

  "NUwXbaw2XXz3ZZfjnWevifer9lcJ1MIWDsRJF1ISz2defhm/9cijmMqbqGU5SttxKvwIkRPJMBzzCgGlRn1vA3AsyaAoS7TLAhkD" +

  "E7UcF0xO4Nqlk7hixVKcP740cS6VMRFHsy+HIm2WMblzzx785XPP4smj08jzBkayHF1beEc1MZ1YEDIvCCTsKP5OGJb1RxKnpUc9" +

  "PsgsBZFmezViSVQASC1vFVXEnGp6qm9QtEdSjRsQyEqeiIBe3D7p095+WoZ+6v8TOjwCgR4nvjyilRKwYUw808JQ0re+JkGfObJn" +

  "6zOCZsGxDLZca5hL6/njv/iuG6/fetttne1btlh6q2SdGlDeyiYAKXzJli1827Zt5iM3XPedH73n3ideMbQkK9kyycmVvdEA7kl4" +

  "Bu0/sv4C4aJI/uy/ivugjx1Kq4YDiPCSZgVB90OVlP6DJLlKvwXu7+UAsf3lhCgwQmKcqjME/IYkuHQZ/ntiRkYZpjvz+Op1G7Bi" +

  "ZBRFWSI3GRa6iNNSaRl5luETL72MP3nuFSwaH3PoGgMkeT8wMbWuxOrq7/u9L0ZuKPHJKfQC/ou+BNZqguHeI1oW8qpt+VpbIfpZ" +

  "jxju1Lwud9HKMrzKhG0PPoTrX9mJr9uwFteuOAuNIYxx/0Lyf1JKWDx58BD+cscO3LX3IEyjhQYbp26HBlne6cx72su4caid5LBX" +

  "MAy6DHSKAgWXyA1jWauGiycm8Y5Va3DlkmVYNdIKbWAwSjX3b3X1vhSGHOuN0OZ79+7Fnz7/Ah49eBh53sBoYwRgi661iAZEC4Ms" +

  "mhDJ/aPBarWQANUA13vBXFTtK9pQoVvxoB0l7fooIarSRDKBBoY2kmiMescjITVK9tC2+EgzEbVyFS2GPC/hpqFFJzRz+HoEzFgE" +

  "U4qoIiTbaiADftfrDKN63JL2+nfoNe9rDkoRBmDYcEFkV9dM8a6zlnw7Ec1tYzZvdeYPfHkAAH9iIGcrifb+xWMPf+/fHjr2F/un" +

  "58s62BQIOC9w+B60yAjhIgIWEqro0wxJVrwwuRy9bZl9nLMXHKPkKDkHOEpFoUSiGVrpUWdA2F407/XqBVwoSzUVaNUhBYoMS39T" +

  "EMBE3mwr9ivvUWucyjZXG06Y9UIWZqBkBy4e2rsPv/rQo2iMtYCSE2TdMy++VWKPdH9Hr91+DFhKSBstAE9JN6L1CdJXpMJ+Dlnu" +

  "jONqVRuktf5B4wkZkzBc7xxFjAYB1BjFF44cx5fuexAXjE7g6hVLsHHRJM5aNIGJWo5GliMzWZCeHZNB0EHJvDipA16o0cSTfDoo" +

  "rekgWFgUpcU8M6aLLvZNTeOl4zN46vARPHPsKGYIGG22QJbdKZe+rqp/i+u1PwaWspAYqFtazJUFLBiGGMsadaxfPIFLJpfgisVL" +

  "sGHpJCbyhprJOC+SDOfLpTBctExGMdzw/v178b+fewH3HTqK0tQw3hpxScAkdIzgVcwupFXWXBA0lGalp5ANbN953bt5sCadH4Lb" +

  "6iVkHVeZf5VDqzUU3hUTL4VoDyCYWMUK2kcIVherfjIpHan6gwil1jRUC0bSfv27t8Q9YPzeS9YuSa/cHMCPFTxo8KdWR20g0HMu" +

  "QJT+414LGktPtQvYcmJyUX51Lfv592285KFtt9+e30r0lvT6r5Yvnx0I4N99/OO1//6hD3Vv/cznfvHhPPvIzNRMYQzlQEyGM8i2" +

  "FhSXWtADnMOKTryR6OOVKioR9lN7GWXk6gnKAVL3enQK4xeeFI2R+4TaGQRmp2CIu1f3iz3DQWWjJ+BTJFl/VCUMGIyMgQ4RVtaA" +

  "X3n79Vg6MobS2gVPpGLZwpDBC0eP4Yc/fxeOU4aGMS4XuhGELvKkDSmLXct7AR1VCMWg0u8OR3yF/ChP5BPAnsAE1ZxzspACOUvA" +

  "Y/iKLTKTw8KgXXTRLbtgdNE0Bi1kyI1BRiJROg2CaDrcnPVKU+zBkKPeHCVxiqvJZeRldAG0GehY59mfZ7lP88vhBEaSkwyVCl6Y" +

  "dU6Ekghty+iyBZddtAxhZauJc0bGsGnJYlwwOYGNE5NYPDKSjF2pzo//siI2vjisH81iHba459VX8Tcv7sRjBw+hm9WwKK+D2aLw" +

  "ezQwa4qg1ngw4HQBNtifNYWKf/p6KkweSI+Qc9TAfZceaqVE8ROUsE6A4Lth/XV4GUJ76/cr0h7dRneBElqjIUTq7R+BQXC41kBc" +

  "afAGoX1CL9gJ4J0i80/a7PsXTMjypW9bjPwKIxTu07QATCUaWbapTl/6xXfe9J7Nd9xR3rF5c/nlIP0DX2YAgJlp6223me1btuQ/" +

  "8Onb734GuNJ0uxZgL5SQksyrAACxt4pui228GqsMQb1utgNij16q6saoX0reG9Wo4Qt47hDbReJwVZH0e9rqVX3KttV3iYWVz1F1" +

  "F/oTUQzDbwAymO8ClyzKse2Gt2GyPuJPtKsipddXZLtYdied7ZuewY/c+QW8VJYY+3/be/N4y6/iPvBb53fvW3uR1NothISQEAJk" +

  "kASWCaAWhsQxdryE7rE9tjMe23hsPE68YzvO63acOE7ixBuxw2SxM5PB6R5nnJh4bIPpFmBWIQRCMhIIgYTWXtTr2+79nZo/TlWd" +

  "Ouf3u69bgEDduqWP+r137+939lP1reXUGQ7AdlbcHYFUmEMu93MlmHuPB1V/18MhXc6t0ijI/AWKI0BOCLIrpwsA9BlnFlcNo2BI" +

  "BNhd7iH52KMkPeExIpNkM2dEufM1IBQX6pRmUdUmix6aOTStOQW9jV2ck9ayJFrhBkxRMliq4Mqajfa8pYCV8RpmAFw0M4OrztmC" +

  "F2zbipeeex6eu+UcbHaZ+AC9ZllccqStO6PYDMA5eZaC4eXxGPse/Dz++LOfw6ePrYCaARaGQ+ENaawiIPk3AHU9qmspUAooywF0" +

  "NeAMSCop23CpIAacAtIBAGmufKplXesbnRLI7EUVpyzmCuChFT0FssfF1K/8yIvTmBsK1b8s3qZoKLm38h4s9kMfSHG8oZQDAVFv" +

  "fxXtPu/rZM2Daxu0XTJGsbCuMq8NKF41Mxi/5bKrr7/qqsvu42T6P2PuBT8jXABKeqyCiNb+9L4HfuDI5++//RFiHrDp2ub7raNg" +

  "lf/rgvaLEehq0eo740iog2gyPJY/hSv7+s3ZrM87BJy3lpq+WDa/W6gMJ0QMbaIAHL3kbs9yICEfZXObjZI/eHYm4M7jq/jF978f" +

  "Sy//Oly4uPnLcHSNEdt03O/w6ip+8bb34nPjETbPzCK2OVhMu0LMFtdgbk9lgFwKe7+hewN3ep7JrVJNjHMdlYZSaBtcMtKM/GHa" +

  "s3cHpb6UeQol+sDWYMpe11o9weZL/ymznWn71EqRoqqrPuszpt1ozodWtLFsnUg1tACr86he++nBiAZxtIrXX3gOvul5V+Laredj" +

  "01wp8FmEZcKmZFaMM5GS3M4uChDh0Ooy/uxzD+LPH3wInzu+gjCcxfz8PEJkMLe2VFi1ZvnpBSkAMOfkVkn+OGsg6QxwMXQG5oxJ" +

  "OX+315Llwp5TnQyw6oiSxVKAZFA13BSMclA2Atg9pUOFJYCC5wTrZXHTQ7p/zPPp3jKVN8g6d2OAitd3+lp0J7sqSNx2Cpw7LSj0" +

  "MR2DNHdNYKwwtefOzQ+u3zr/o1ddddl9e5gbeoZH/dd0Ru5UPRr4q+/Z9xMfjcN/dez48XETaKBnUztR4W6BeJba13kufq8Mwx1/" +

  "WqkFAhnXO3bq/pLNYcJFTbXqry7T/rK96rQ6z1Sq/rLdui5bpoTSjiFw1lopHXOhEHB81OKqOcI/vOnluPKcc9FKpr4vhvTdJ1dW" +

  "8Zb3vA93r42wMBiCYyuXtEirspJT+p2dFUfPQBOhw9T6LAJVrwWQhWxi1J/VHNYgY3LwkbK47vdq9YkdxgPROsR0TxCUEABWnuEA" +

  "ojXN1+HLZKsrtTsaawUl4U/USC9julmOCNBYlm7D87gzg5oGJ9dW8ANXXoHvu/56e0yz8Fn0+GkJhWc2Rem7TyX8qScP4c8e/AI+" +

  "+MjjeGhlDbODIWaHQ6Btc5ZKBWluCELBExJ5uZpEGYMRLI3yJCL0AD33Z7Y2dfdFGYjcU7YoAY0CB+tGutlPterTddz0x41015m6" +

  "IYGUZTJbX7X2DhwHI7hTTPqt68sEpa+fPJhIP819gmwFy74NRTBp30TRnmJAGxbmmuvbtbf/89e+/rtfs2/f4LZnaLa/jejM3L3M" +

  "tGPv3vDH3/md7d//y3e+4x4avKE9sdyC0KgvuRYWG4ECFJvFI3NdDFDoV7xbUoQ/i9C37WoBYy2yqyXtSVj0rWqZkDZk9d7anPZr" +

  "ynXI6j90ykSfQFNhESRYLLGkBqsjxnmzEb9004148bbz010AzuR2KmJmREQ01ODJ1VX8w/e+D3eeXMGm2Tm0ovkTie8SJNqL6w5R" +

  "sfn7I3P7x1T/zr/rxvaaWDnXG1HH6qBWAPTPbzd6OLr2ZMDgXQMkecvZMqa48ghQr2x/mzUOIJi7h/0q7BH0/YGWKNoYiLDOERcP" +

  "gf/wum/AgJKP+0z149ekmn5yT+W1fWy0jvc//Aje/bkHcefx4zg5DpgbDDHXBHAcJzcN5XBdP5ZdH3T6LnMEjeRIVpdWwTvy+y0c" +

  "X/D7F0iZMTnv6zTPYpnsLp1iD6S/fe8BqvZFrCZW+/OlJQLvvqltZXWdeL4if3PP286mAG9fm+QGPBWA98+UVn2pQhuqd11wVq8a" +

  "IK41w/DCAR79zddefy3tfffJpbvv5t27d58xpn+lZ961WadDRHzdjh08alv6mZe/+AcvbNceHjchNHY0N26AiMu/N0LKJIvAFqya" +

  "i5wfKgtGFWQZOVZ5fmwTUg9jzqnT3LaXBcgUwSnNpBQSQfa/CHzKkbVaRx6uvs2gbRctEoSWWyw0hIOjAX7hQ+/D3YcOYBAC2lNs" +

  "JNcJYaoNjqyt4Rff+z58ZHkFm2ZdXAG5M7Uhtze3qtr4E7T7wg/YYxVIJTvA48yj6e/+zzs98kzJMSc1EU9qU7LuNMLTNKERdZ9z" +

  "/VazDaXoJPsmY0MqGFxdlmpshP41RpW2WvQx/SbvESIDC8NZNAhIiX++3GdDvvLESAzCZ+wjInzq8CG89c6P4Qf/ch9+5Y678MGj" +

  "K6BmAefMzWEmMMYxoiWxwPlzoBUWL3hCmgQ33sFtcSrnScBl4CRvLIhQtGW2vPcJ4NvpEHeVr/Io/d/zpbzucmtPNZunEp5fCmX8" +

  "W+1fD96RhH4Kbw32iac+njCJ+r4zPs7OCmE82KOClDVVMB2vg+KFA8IrLzjn+4jOP7YD6f6a0x+BZw6d0XtaMy394V23/613HDzy" +

  "Z48sr48WEIZ6NBCkB5uEenrrUbb/3ZNflB2hoyZT8lpU+uGRbD6/7gO0tALR9quWZGtC8pkFM+l6oeifd8FooCKoy+CB12LNFJ6v" +

  "DVZQvsaMTRjhl7/uFbh+24Voo2qAXc2ZxX8YOZlRD60u4xfe+37ctTbGljBAy2OQBL8xANLjjYTC/xiULVI6OVAyMe6AgVMyKYIc" +

  "l+v7Mo9U6rMbR2mSt/oUVgmFXXoxjoxgUXIEUJ2myNHZTlPkAEbXbVi4J8qzkjDTM5JgSH9mi4N/DJjMKEtAlIVGIGANwGIEfvfV" +

  "r8SlWzZ3lLUzhZh1badgVKWjayv4wKOP4k+/8AXc8+RxrI2A2Zk5zDY5kBG6nwkoFhHDxatsMCjqJjFeUZrVVfOso921zNbAPZDX" +

  "QgIBPoK9hTazawLvs/4RARTd3JNfkVUXrOZJkGES1/Tf5Sd8auD6u/yWt7EQVPdOJ6IEhNXWOevbafIGfTY1xuqz9ghPUB4ZOSCA" +

  "sc7teOvWTYPrVk7+5C+//m/962fyRT+nQ2fgli5Jjwb+yw/c9paPovnVJw8eGzehGUTJvsWB8mUWtnC0213QpkJeUbUnXQzQZ5AF" +

  "A1l5zh9VGbGKWvzCZXJlllf7QgPWxORHIft+VWObRHKHizEG7UPdJyD7wfSzIQesMWEY1vHLN96Al110MUYxYthzRJCZ0TJjEAIe" +

  "OXkCv/je9+DecYstgwVw26Zz4iG4S0W03XI+mvx2RwGebLyQ+0106g2u3wc6tSkwtUjq5ZTmlqUReb7TAwXIK2wuSMK4w3BJNJvc" +

  "kxIs+BgA1x5xeibh0BgUhK4qColJpX/KdlAGf/r5ablwPH4NAcdXV/GzL7oO33L1VU/L8dCni1Q7TsFaud+r7RgfO3gQ+x/9Aj56" +

  "4DAeWxmjQcD8cJD8/22LVvadxo5k5cEJB7HO9QkeYlgoTxLSAdEu85Gz9W59255wwqicKzXxS/kxijsgG4nUfM+ceVcvCNCHipHK" +

  "RA5o2gkUAx8pLbk/NdAV/qSjI3+VbajdDJ4KEOShNgHJogv7Pq35Oj+K68dTUBACy9HjTnv0tyjHNRtERttsnm2uaJf/6Pe+4Rvf" +

  "+Mpf+qXBbbt3n7HCHzhTXQCO3vbDPzzesWdP81M3v+bXrhyt/peZxbkBg1tlmJbMAsmMk5lD102gtJG/uc90q4Fd5WtkAsE/iXrr" +

  "OK221sjYtNfMiKIhd8bp8PS6PxubyfIv68SYCYRVHuIf3vEh3HXgCQxDwJi7oEmF/2ePHsXP/tVf4f4xYctwHuO4DiZGoCDmyozk" +

  "0/+lVqkBQppitc88n/hk6YI5VfTvaQeqcebDG5/iTYJYNXpKje0wXtP2ObtsVPhnq5ImmNJ+yKAYKCz97ukRknL0xEdeU6XGSVa2" +

  "H4uJplP3MTGjGQxx2yOPYVI62mcSMZLm3sbkaw8U0ATCcjvGhw8+gd+46y68af978XMfugPvePAInhw1OGc4j00zM5a8J5KL4VFE" +

  "SAGgkk2GKheHCSaksUypcNMn5YFR2HP5VZl76LFY7Y0To3KiI4iAJ/bfQ9L1Jn+9xgzVe752HXVb4uutrB25JaiJiUrvpXSCQwom" +

  "LLyafVRZ9bJV0/MA//nGVMYATeYLqv2ba9eak60u6TN13bRxbYaby9bXPvtb21//plGMtL1PgzzD6Iw6BjiB9NZAMPP3/8hf/vnL" +

  "PjczuGa41kYOHKIm02GW8zfRCZ2MFDMTzILbFpNDpixSoquhArpA9Ux52qx1kp6yPl3Y9REgUq2R2FA3IDnxGXpbT7XYXf2cA8LS" +

  "c0DvHjIzt6guAjhAwJgjZomwEmfxSx9+P/7ZzX8D1267AGNhshHAAMmXeufBx/FPP3oHHhsTFgdDjEfjdJmPCCuy4SmZmw9y7AT0" +

  "aPvEHKt90YQqub89HEbCmq07rmw/BLXOAdXQ3DHPZEHJ9VUD2GEi3dJ73vJCufhcPiEg+yLzkwo2gGDWDdYrodkxWz+GVYtM0d9A" +

  "U2IG5pshPnH8CO47dBAv2Hbh03xPxFMnZp3PdF6fBPCcaMe45+AhfODRx/DhJw7ioeVlrFPAwmAGmwZD0x5bHqV9IcGNGdBRuSCq" +

  "UUyfUJ4iOMCoADIveDBFBJCd67dz96qtqyvJwF2X1MUDV7d9V1ukHCvR1teAoHfOCwCYwXCqI9j3DHWbubwTILlTJT0TnGhsK95W" +

  "dcz1o16L0UAFi66awoZa9O/Fsn+T/P7+Z75AiPJpLEo5OiA9i4F5OSI+fzjAG86b20lEh8+Ei35Oh545u/lLJJ2QP/nkR17xRweP" +

  "vP/hky3PMTVtA2I1XSl67khCtzn0E7eAGGQMdmPQ57X96lN2vlr3hGoNOaYgbbZs+u/myvcAoI/qzWiR8JzO2tdxAFax5Otk0vPG" +

  "6XRAgwbrDGzmk3jLDS/DKy693OqKYPz3+z+Dt/31vVgLQ8wSYWSeFmVVSfPX3OOqkXjw4jetgS4PlPy46sUjqK0u5SioHze7Wjxs" +

  "yONvxDoMnMcZp2YmVpaskcha+6mOE7K0s2qPBy+o5r23q1+aImIrgDIgYyYMKeDQaB1/95IL8ZMvv+kZAQCYc1aF4DTzlXaEuw8c" +

  "wgcefRQfevwgHlpZwRgBM80As8MZNBgn3z7ly5vAAQ3geEL/nOatqetHAwLRwQckGrFP1MSQo69O4dBcDq7E02DGk4WeGbH1uKvx" +

  "ri6VgrYLcFI/5FsHngFI1sG+A37Cy6TIXK86Nct6OvtC+E4vEcHfUfDlVLzVFZl4oQZVe5jMWAOPL9123uBVgX/kTTe+/PfOdL+/" +

  "p7MGAADAvn37Brfeeuv419/7rh/72GDxt584dGQ0DGGoGnsShJLxDbXmqEhWj1Yh/f2URsgv8lLMe2jQaxYsbeGy4LnD9U2YU3cT" +

  "ZWFJwna6E8zl7pTNKtp/fsIEcBRfdABhFRFDXsFrL7kUN158KUbjFu/+wsP48KEnMTMzhwEz2jgCTNvRCPZoJylDEdHbBQDWD2/G" +

  "1jfss5yYKQXqoEs+14gvL/cQOt86rlATvH4vY5PMgeTe17fznNRUzAvny0dcBgYDNZ23zYJjPS+SwRTDJxy3Nvt2iuz9nvKXnbYT" +

  "AgJGiJjnMf7Da7dj2/zCVxYEpKUnLiFOGRRd3YdXV/DJAwfw4cefwB0HDuGxk2tYI2B+dg6zIZ1eiBwlxFLmVuYyCWkqR98LTvtd" +

  "QBr7w5gpVsc7Z+y6KiLZd27/U3RrIO2/SOL/p7xUNzpkaZZCW5rpLW1hvua85DnanxhdUC17q2I/ANA6C/DL8s8kKwUyu2rd3k5V" +

  "TsqckXlxP/gSvlzx6r5Wbxj/sMHe0LXB5PIAMAnvi+Phwtzgb8wv/P4vff3N3/+tb397cybc8ne6dFYBAGam7fv3N/u3b2//0Xve" +

  "839/MjTfuXrkxDg0YRDdug0cxD81AckyZy3QLzUTCLTBoqqXJonGqoItJ+vxwu1LJb/oU6BR6Xrwho8+l4S1U5plgEk0GsPDTFgZ" +

  "r4tAJdCgwVwzAMWYMtxZMwiKrUuQ4s+0oxQmbkz1dAD3jZFp8iIMTbMS4MaZlWq/IyuDBEoNgpAPAnumWMG5whqRGfHpBBwlTTEH" +

  "TkXztPQwSQUhZsdVM38peBWuohrfot4OwIUACzNgo+vOUkAoAC4QDq+v4R9cfSW+89rrviLBgMw5DsTX1SLiweMncOfBA7j98Sdw" +

  "78En8cTyOtabgLnhAHPNDBpixKjiJyRbNKff0/XO1d50vdekOJ48m6/u2CqoBgCwZ1NQqQYVqvUASFeQNzFlhSZo5karDTr3ehtm" +

  "odlzzCd3XN25X+h+50GwtC1bCliWQ1ep0Hql2b0+fQUwzP15CQCWnCPd4GrfTl9n+h0AgrSXYJkACVXMQ73eXdk9SpJXNtQypHkV" +

  "wCk/xDjGdrhpU3P9/ODOf3zjy28g2kXMu/hsEf7A2REDYEREvLS0FOnWW8HMP/aW9912w92zw2uwNmqpoYY4SOrLFCGsGllX+5Zf" +

  "vR+1Vg4nMnzStrginRGMknl/ozXUh2JdH3t/35BUIMbUFjUuFOWwuEgUXVdmP81KGBCxZTiDNkgmL0REHiFSEO0+9dREjIIIeLbk" +

  "NmL1uX5XMJ16bIq/83hnfc2XBdPsVPeufaaCiuSFbDqwQ37VXLNccBIqrbqO7eiskcoVoe31TD4/m5JDJfdVyhPvLUd59PKYnZIK" +

  "K0g5zm4kcsuYQZGwGObwrs8/ge94/jUYDgYb6IxPnRQImRYs4Fqz8p0cj3Dv0aO448ATuPOxQ/jsieM4sjYGBg3mmwEWFxcwD0K6" +

  "U2EN4Ca3TVLkFpKraLiba0G9fYCOHRgrUoArUt6AkustlnvKXFzIQw259Kku0u2dGigGRs7aZ9YrFM9YTyVux6wasucjq3Ydc3fc" +

  "vjPNnbOyNGn+2cYIBnhtXTnAMSnwuTN2tj7ZKQ6J1HpSxlLZm5jkJujsZT/PlAHFCG3LMzPh8gb3/sR1L/47tGsXMe/C2ST8gbMM" +

  "AAApIcNSupDh0G233fa6YxQ/8vnZmQtpfRSJOKggSGEllH7zQkWQZvo3o2PdBKdLNWNVHqTRNW7vZ3QuZt/gGEvNqE3r83VUmqQ0" +

  "ID1JsIA226ASoQxLMEJJ4MSYtKSevhKU2STzHkUNXmIQNSlC2VrMGk5gMk+ZDzuOoONjDEWZlrwYKyaWy+D8AWchTeIntPgIOTFh" +

  "gVpQA7wyS42odoydg+NunoXBxp3QdVkU8wltV34vrzuZQ86t8EcwU3mwNhIYoJRBMYpWDiu/nvdJRyQ5F+yAWX5XTMJE6ZiZCOEo" +

  "Q7jQNLh/bQ13HjyIV1x8cWdengolH36O7G4o9amR71tmPHLiOD51+Ag+fvAQPv7kUXzh5DJWwJgDYaZpsHVukPYKy7kRRgo4lSBW" +

  "Jg38jcVcssv1AOhWZEgkGGwdgZzLRe/3yMOY0/F5oShjaJYmmV05s5/4TCmUAki2Iud4AHbr3AECm9PsA+jR/DO38bE0adtXwCY3" +

  "TyyepZAun01f6j4K9ffQXZ+XZzHnaYTt4iltTx8/9fuqBDF+vdrO6VaGHMOS/95oraaBDBzy3MWW14dNuHx2pv07c3Pfsm1h4aE9" +

  "e/accXn+T4fOOgAAALuJ4tK+fYNbbrnloT+8447/9R2Hj/7JExTaWURqE/dNt++JgNKNa35aE0SysUMWBH1+ppLyJtQNmM1+9o2Y" +

  "yioN12mxZpJWhrSBeatG0r3nbfU0ge5Sf7EQy2YKIuJs36uwySAod0TBjW5qL8AykvZalX9dx9wzKumQMZwCFLj+5oJKhp55ZA0c" +

  "5GpSRUR+1Is5V1ZVDZ0CJwBJm8uBmb4fHe6njKxeV/AMkwpgUzI8kjWRykkWh2h9r+EJeoRMbkY1JuTfFgDj50FGgsGIPMYoAH/+" +

  "hc/hFRdf1Cl/EnnBxYCl3W1USwSw1o7xyPGT+PSTh3Df0WO45/CTePjkOo4zo43AYBAwP5zBYmwxpghwTEdhSYGaBujKfiERANU+" +

  "TK4s5yEnAX/F0hOQ7SRZWtkaTUNyrJVg91OI1Tjnk0/9ZEEMGTeU+yPVF3NkPfv1qgDCvaWabjHhbF8l/YE766jDCgjg6I4xEvJ6" +

  "BhVBwlpWXW4BVrUlhl66z2VRna16vhu6FtOQ1aBW+1WOTvldz07ISyJrANW4ZXejzh0BTDymufbchpqXzOK7/uYNN3x6ad++wc6z" +

  "JOivpi8Oxp8hpNGa/+ZDH/q5D4/5nz1++Ph4QO1gHIDADdT/A+QFpzmfC6K8jZ+K5pMFToAFk3U0NC9ks2DJcrArzAr21tOePsuA" +

  "pg8gVSmkXwy5ehbZQM7cDX40UMH2j/k4M7hI76u2a88or+mzVkywqvSZYgvtoBg/bZzGAIjgdEWbFaS3NvduBwCYqIYPDtWSitsf" +

  "/bc1qIEI7wrMmfAvPqnbye4b9ykz9ESEzesECyVbfIZz06hmmx/qRGKrJYIHAWF1Hb/7qq/H5eduReQoZnoHaMSCZQmoetbmk6ur" +

  "+Pyxo7j3yJO478hR3H/0OA4ur+H4uAU3AzRNwAwFDILcI8/RfLQqYD04B+q1WoJCkFqpNDtPzg6aAWZw73GZEAcM7yrIpnAndIig" +

  "1jRzpyEH3QXObcqCiQWY6igH+06DBVlfsOmRw3C2BygfV+3Hnq5CgKWf5MrLfUcKigwOtNWKjik0uTpNZMQAOHRddjn4UMBW4hSS" +

  "4tjxIrV2nNK6lMELQawSpiTVfCG1zIOr1NvoZtt1j4AR4uicc88dvoabX/uxV9zwllvO0Et+TpfOagAAJBDwT1772vGufe/+vY+2" +

  "9MNrK6PxgDBImN7FAUCZeQrSi7bIysAwpVNZAmp/XfoDWd5v8G5iMrIxHWCY5P8/1aYxS4QT0Ohoil0h5CkqereHiq0zoV36WQ8o" +

  "0X9JBWPWeqwczsGYqcCSiXJVR9kGFdqufaxmYY9msqZY91u1uO7cBzcnTnRwigsQ1d712fWxmieSfpt7Rptl98p7TY1tNRaSm+wB" +

  "1HNRMvPihQSSkNeHL1OLSn0LCCHg6HiEN1x8Id5y08sQYwaMocdHCwAnxmt4dHkFDx47jnsPHsJnjx/DQyeWcXB1HWvM4MEAc2GA" +

  "ISVXAIkWaMLPCxcVzjZO3fWbutQjDR24Z0q5KUInHiDVlPeSTiSbgLE29YAscguhtriQvOKWho15dzVkihqIbBOnhTugpS0nZJDv" +

  "115Vat59ft27NaMgrtb01VLF2q7cN+t3z5gkUKhZBMsnWvdcArIKtHQDlPOs86Jgl6TfxSYs+qpgzrlqGEhxPvWeBsYxjufPOWfw" +

  "4tC+/Ve+7pXf/QMf+cjwbS9/+WiSknI20FkPAMBM2LWLaPfu+Evv/at3frLF69aPnxxToEHufRbWuuCiauEQdO/RfnoYABBCKDaK" +

  "pz4zFnP3u7K5pQ8r9ATsnRolo9OmzuZ0CDk/kwWnXxp9pkVfkp7z1w6eEoy4vmQhL5Cnp6++XO+eyaGV2o6+efCfa0bC0wMAicrM" +

  "fald6fmNZoCg0cWMwHr01F8k48BOXw8otdcbNeABgAhLcmVRFabeF/BkQkmtDv6ZypLBJpAla2NosD5axZtfeA3e8LznYcYJ/ePt" +

  "GAdOLuPBk8dx/5NH8Jmjx/Dg8kkcXF7DcpvOvc9QwKAZYBCaFIgbRYuTmzRzh6wBNhjs2q/+/dJCVolS279wY5JjRfrXqAcVisD0" +

  "+mNdO758t2OIUkZByt/nh91hBEKRqbGzm0xxSL+3mpzGE6twq1aySsRTcHXvPMrAUAW6Aud+ntYUPEJcH1YqdYGkTALFMnUJM1s+" +

  "BnMBqKXUnkqRA/q7DimxREwQFdZ98rujUry0hvyBxmZoLAa3NDPfvHTz7Cd333jjq2jXruO86+yK+O+jsx8AAFhaWgq7AfCuXef/" +

  "/Hv/6t33tHgRLy+3ADVpMeRjNo69QgN78rZAwWA9wverpOsvy0/UgrSrGavJUuotLsUp6zgV1WVzwXgoI2jOgEMhvfVcUXyPxpLL" +

  "5rwhnWYwqe32vrbJj6MXtNLWuk8gSnzZqx/Q36sxitU3ZuVREa4CXoSI4TsFBz1l5sZMtgBxQJTI/ZRvXMqqtO7i7Y4Wo40h19dy" +

  "LhVEZXN+11/btQScLkBLMxtZ8zcAoxDBo4irNi/g8nO2glrGwdUVPLq8jINr61iLjMjAICQz/jAQGjDyvQays4hATEW6BpHyMi6J" +

  "a/s1axqdWnicluvHS782gVAAfbVWZIFXaMU6nrI2bPeyNhDFM3mnIO8nq82V7gWjmcXJFZf3vD6qgjl6nhO7fngtJ60O1eB17Ag1" +

  "z6mGGgZ+DVynKwlVAdLSDV+y72fmV9qjfuzAtu6N95HmePC8pwJyticJ+SFvjdTvHXSorHOlZSsDDD0sHDnG9cEgvGhx9rFff8n1" +

  "N9CmTY9yCiQ/41P9norO+LsATod2794dlwAQ0RPffc6Wb7g4ju6JzbChiNYYky2SdOwqcCgicw2+uwWqm7AwKDmGNClARb/rC6qZ" +

  "oAJJ0WT/b0R9ZWftycctK0OD+xw5xbzrY/F99V1mIFBwfUpBUwtBzziISNB9JfzTl+mPoLBMPyqBmTFYZfbsyqh+S+1J2l7W8rpm" +

  "wrLPri3WA7c2SHLSJ5UvadAV6POARzUl67+1kZEz/RH0amEm+d/V6euY1OYkGMq+TdL2WKQEIZl9IxiDSJgdDHHfyRX8xecfxZ9/" +

  "4XF87PAxHFhv0QxmsGlmFlvmZrFpEDBDDHCLlhktSNqbcusnQR4QKCXJBaWbIInsolwbi3RGIKSfJrzJjb/OuY4ZkgDzKjKAdJys" +

  "mif3LzHZ//XUF8NqYF3LELBSDT0Xqy1pnKHYFwy7cc4LZ12rAkKD7Cm9wa9052T2lHvGbi/l8Sn7rGvJv6X/ByhwyCs7/RcJheZO" +

  "WgmzgQO/G0g6ZDvFKRQUy5rtnXQ0odgv+R4RgTkSjKu8O/2EJR7TvUy2j8s6NNPqILbcYkBXb1oY73j+c76LNm16dGnfvsGzQfgD" +

  "Ndw6y0kzBf7Zpz517X97/NDHP3diZWbYRr3pESAJ9yGSfK4pyCYK5E2CCQaDJxqBnVYGVNqaUD/TFbxNfqNT591cTVfA+3K7jIWB" +

  "EMpob3uPMheRn+zqqM1rWr/VqRtf+wwWIVgj+gnEIasX9m8FROoxkM86VhQnmG04FMmZBUDjLEpHAlj77er17a+EjpqBYXNN8NeI" +

  "5rbquMTi3brMDslayqyrHhlPsYSPPWvMa4b+mS4QdeVALBCSQIKYEUJj2mOa/pgN6CzzrnPGE4CJmGGtL7KOoHvABbhlgVYmkkrf" +

  "97db+9Wl4L535dQSnLwFwIEoG7681idagogQY5Ra/W6YtK6omosatLAbJt0rbi8j2y3yGqZyPRPArG6QvBYUuGvfiRQQlUCq0OKl" +

  "PgO76H/OfZrbgfLEkvXTppiq99z4WcBi3hPEAdm/n/mVlS0D5057cUuhPW9+tv2m8y9443ddd807zqY0v6dDzwoLgNKtt946Xtq3" +

  "b/CN1177qddedu7fvXRxdtQ2ARRZ5J8KkggmhzCBLJxsTem5454hrBa+BwIbCRSFsJMAgwqVQihWPz1g6DNXm/DXsgrh393UWZDl" +

  "doeQrCPKo5Mm4AS/CFpyfrtTUhWY48UdF98UozVRaKUua5kyl6I5ZJBRZQQUrZIqplRaXpzGZMKqZlQuw6H9NPXEQIuWvyE5K1J2" +

  "RPm1pa2PRfS6ChJP2U3Q93nPOHpzu6uQQ0ALxpgZLQNj1hvbtX+izSNp+KiSHOlYZoGhNxtyCisP0Y1V+hHEF25rTvpOlNdx8P+7" +

  "/vsRS79nbVCBa9LgOa3DkNeIvVcsCl2Tzoo2gbzlTT4pxnNji40HtrJ2nfUh5eEo308KTCjWqoI+K5fTGBDLCyIY076N8HdLRES0" +

  "xHazX91mFfyElB8kys8WDNacIoBzYUlbrDxyZSoQUSsMG5/qrFk9rSCFkzvJpHOjbzWgbEVBAg0NA6uB23O3bRncPDPz5u+67pp3" +

  "vOn224fPJuEP9KsRZz3p0Y63fvD2b/vIyZP/9bHVtfGAMbBDUARwTNHiZg0k3fUJZabcALo0N9ZAkvLZFfyThFcfeLC/5acd45fP" +

  "0j7u1+bYWTBMlzTNOYA1w4+jrBfkiv0T/mITUIHN5XllNgSv2W/U75pU6zdg4/uHSRpGpa1VVpLTqFRfnPCAZ+QBk2KECjN/Xbfv" +

  "zwYAoPDhA4Aw/KzFazvENw4SzQ1y1huI3FpZff3k4qOqLxwc02fJZ9DTXoJZzFRIa6pWIMGvjfLcuwqz0YB1zZCV4kW5H4ONtfxS" +

  "SE9qhYoLNfLpUb7OcxsC+MmUYkEyqK3bc3rl6Hoiw2WtOylQ5PvX0pnQd1lU6ke2SdhYBhkvLvcOubn1ZXhLQD6qaag0t8QxFGeA" +

  "cmU5MFuNRd945S/rDJqO18ifpbWCMACwDh4tbN4y/PqF8Bs/89Ibf+IHbr99+Labbhp1Buosp2eVBUDptltvHb/p394+fPPNN/3x" +

  "Ldu2/eql2y4YRuZ24FAnAFt5pAhSllAgIN/JrYez+pkjc9r49QUq/ebZUmvrE5b6dzpWs3F5ecc5bag4rkWwU3Gk9QMQrcpQOnU3" +

  "YaHZdDaz19uztvVUhL80Vn640wCU4dYk4e819hoMnBbm3cCcW/6twKK/DV7XKzVIKn+eilgryT7Q0jKRjraRJsFhAGLBIsp1253y" +

  "kDWNfM98AiU9FZvJmPM5MwA5kDIx2UApwY9p3qR532tXmR+s2kerwjcLnbxv5Gppm0K1MPWzMDKLi/Mto17HXvu0jmVr24Q9W+/T" +

  "U65pHWN5VmMGtK99lsENihLhr6fZE3nhn8sq/eRFe2W9MCJALUhVZM7j4veSttGvabOEEGwtB5l7aGyHa7fnmB4UJ9DQt/4ydSya" +

  "vmTKNWjUgrdKpjrSPwGMNebR3OZNw+evH/+9n3rpjT/xqqWlwdtuuulZpfkrnSYHOjvpln37Bu+79dbxP/nAh37nI8vrb145vjxu" +

  "Bhhks7/6kXLEvI/QhypxHkc5tO19xLaJ3O+TaCNtoDQl5l/r0krN191EJm8GSZtrPmluxNIRzUxWRDQ75mJnqFk3v2qgaaxU8GzU" +

  "/r6YBdcdfVqeLTWYU2lLG5Y94bPT1eT6nptUlwKlvjnPo9VbiVkJCi1XXvCOoPxMFsjeiGHvw13Wom87CwuAiRe1pGekLltHKYFU" +

  "0uySNulJzbyJDRdiA4CYeKmKv6jGw49PZ30j2IcURKy4h8xq4suo+uutSp25MJCBYswmWZfqv/06CUXjS0HcB/gnr0WnbUPslW6d" +

  "lPWn5zndO5ze1dgXA9Sph7kLG4MQX09gvYHQtzVHCnXBiOuvG3f/+aT+G/jvGQ296l37pfzHQLJYpqKu17YdNVs3D19E/Oe7v/7m" +

  "b965dy+fTbf7PVV6VgMAZibauzc0O3e2//T2D+/70Ml2+8qRY6Om4aHuhZxSWpgHEZysE7bX5EI3DB7VI0j9QqrWKrLWTtVnlS4j" +

  "zLbev1qcHXEztKy/JibsQYyaBgEufH4KZNK3OTDQVEA19Vcm/75+Va2UsXQMwY8Yl5+ctsnVjW+XOXaDJTcqu48pnbIdRHbeW2vy" +

  "wrgAhO6dWvBXhYIQXHIkKhmtTlBM2pwCAC/8ffsj2BK/KJiLqbBOX/KaUN95vtbZp1DWzGyac05BcxaCCqgJVOiw+Vvtm0IdHTWn" +

  "aCbGb3dRqMCvgYYuLRIwon2txt2Nfe6vFtUPEOo1U6+tYn1EzvCIyvd9GWk+0UN50xbJcya0w9aPmseJqhKya0pQv/zvj/+4YYHr" +

  "j/BBvbkwHwHU2SRki2PlfqF6b/fsu9MA43kppUBeBae5orwOdN2lKJM4Hi4sDF4xXLjz529+2euI6PASM+1+lkT899Gz0gWgRES8" +

  "tGMHt3v2ND9748t3Xr84uDNsmh3GcRwTxxTIYryWbMF7c2kEpYBB/R95gRbo3ulC9XcT2tb7eQ4IUoTC3Z2F/JVH9yz9YZbAP2Nr" +

  "npkoUGBrrVkSgOKIn/oKzazJCij0kH5mpEWEsW+jfnlKUiG0MZ2OYN/Y3NrVXEogpu2o54fKz0TIxKKurMFFbxkA7MjjRGuCmjSl" +

  "DZ7hWz81di5J6EL4Wxk9plRl1ZF1bfc8I+suBVI1IvR9euHEYkmBpdbJKvyD+1/3UjWO7I+dZaCUbvHMz0Ci2tOlPywYMu+8Tvvz" +

  "tQFFn+0Z0lmpNU35m0rIPWn9lGOWNWumdIySzWjhhJxZKlQD9nu2ywPskKQJaG+iT3OTbv90vIctBFa+k+t1i3sxcowHw7tX9HlZ" +

  "ZxRAEhvis/BpQF+pSMiYcPlZ7WLRtkOOg2ZXQw3pUlkaIGj90La4+dFYJzvVxXEcFhcHL5xp7vz5m696HREderYLf+AsvQzoqdBu" +

  "Ir098ADz0df99Pvv+svPxMWvbU+eaNGgydHtkrQkcW0AqlF4L2epJ2RGQfZx1sq6GuVG5r8+7fWpmK45KjOjHJ8nEY7ZFKqNdJzL" +

  "aQQkjFLRvfZLgQGqTZgVKe6qUL5tfhw6fc5Bb11LSL+QP5U/lSgHTE3UtK2P9bsZWJ3O0JcgkKG6MQDTltN39fD4nP2uT9zCa+S9" +

  "dUIA3gYBilapWQaqo2LydZ2LQduUnvdrJmXNyEKPrG+pDzFjVRu7YCAlFy3zSk5rdjZ0i+6mbJ7X9ydb1FKFWcGn4pkMaCHCLK1X" +

  "c5u5rnB6qTuWqNddsozkI3gO/LNBlWIWy7J8NRVQt9Imnd6AAy6yx6Ehzt24DF0qeVer+698Lrtdog6eDUyHJ7HNVGZ/1F2xZPPi" +

  "XREWneG65NYal3NCMg4svM1gJEcEIoxibAfzmwdXNeM737Llua8j2npoz549zc6z8Ha/p0qnJz2eBcSS+enYww+f/ysP3P+uu06u" +

  "fy2vrbUNUcPUGHNLN4oFQfP53HWfVoXiO9mwuvu9wHXv61WrtSDs852dRp9k8zVSndggjFFmLd/MhQEAtwk/69W4ymSpjBBWTUNz" +

  "eOtGVIMEmSlu8jLLoiazyCI7mLElRo6672d+EwV6ZdqtmVUpNLJWagzbBHXJiIWzlq2fkPM/g5bG+hMpmeC9gbasNPVd2bZqyIlf" +

  "huJ7a47vD2l8h05jOTZ2kkSYpxrkvbsnu6wAtfuSApBCSnnGT3643bjVJDqaB8p2HXOOI7FWM+T0Daqc9cjr2pWca5ZjZ5yFhU5p" +

  "YX1WVVZzUsufROZV6e2BX0c1kNe2WVIxW8tpfqna0xkg+R7k2lQr1pnnosfZH55moQzCcw0qxrxOf+A7F8xSqPsvzVnOHBqLVcgx" +

  "HRPW8cxYxPXeQHtwAKkET6mpGTzlu0vskgyogqL7T+8r0b41YIw5jml+bnANx08sXXTha7ded90hfpZk+TsdetZbAJSIKO5hbrYQ" +

  "HeTj/Lf+9ztvu/3TbXvZcBTb9RCbiKyTRbTK+/Xl9FMFV2dDcf7pIqkVFpN71V9JrAwiyYLMuIqSKytAGTtglZSbXhB/BajT75Hd" +

  "u6nJxvyltcmVoFpdQE5yw/J9WyJ0q6fHl44S3XPxTfm7JtjxZZJ7x2uu0f3uBsc0PZJCahCQ0hcH19NSfBEg5k8yHhQ4rQ69la/O" +

  "hJi0k/ROMCAhA0s6fvkIXNlksnWizDozuUqTw4RocjdIRSyEYj8ZGy0qiCaVb4CUiHEv/FHPGNuEd40G1FkL6UfsWnaCi0mowbBb" +

  "w37Oyca+u/XyK9liYO8rUNWHWdcwbMwJLHc6kO15364OqOIIUHBjSpLy2FkZpMbALNaALIyjDBIraPDsgrKIB6d4DAclREFJloe0" +

  "DlNAnAcUuvqSMiCiu0ZNNhZ+1bs58pCVQ0Yt0F9loGyM9D4FyqDUAdjcviz40zOuTnFXqEWmw2DEoqdgjyKBwS3Pzw+uaehzv/DC" +

  "K9+w9fznHNrD3NBU8zd6VscA1LSTqN2zZ09Dm+nx77n8ym+7dn7mwOoADXNsLbqV01GSArUDKW8AkJBqFbVu5sOCWRTbCMWCBqA+" +

  "X/WXea1sIxeAD3xTDpeBQ0xMw7gnwXyCxprSZxx9OfIO+1vwSuZkbaIWQPITAnIsyIaLrE6OBI6ag0BHQWMT+pZlLOq2cVfAVGgQ" +

  "rl3ufz9mfhw773AEcyuMK7ojnyhVS99uPRIoXey6ZkTawAEMRgEIaxO89bVOTWtM+Km5g3wsQ+knz6l4NcGTfIoMViBpeynnNAru" +

  "e9+JPgxi67mCdlQ+kxM15X5ZLZPmS9pXf93nHrIxCFSCYjcuOonpopt8pMzAS6e8bPnqHEvstDm/GwloKUp63ZTzX9cyu3dLP7/8" +

  "L2WVY+nWBHPvnvCAypdS/6dN7c1zVv/dM846JsqHmHR/+zEr32E3h521TIx0f6CrPVBeKh7gxIhxaNvxoGmuHLef+p5rLnr9+ec/" +

  "5wtTs3+XNuYYz1Law9zsJGo/dvDRV/zeJz/5l59ZbjfNjbhlahsQgalJjCpU6U2ouyH1cwDCuBW1iyZamaVrKgUtg9Akk3vPpiu0" +

  "KakDEeCQdlbWQFT7U1StVFw919OYitkDAh7IvstIXQK0GACaXpO4qMow/7E7IaHDpr49GIjxOpswTKqPWmkd+jxgl8iI5lSPGRem" +

  "zrrfvsak8ZiLPauLSX9zSknCDZUw94U6za+uV7W0ZPbPYK5vfanQyElPGDmJTXq/TuCS63Tz5dqShIyeONATHyELcMo15z64MgmW" +

  "QpZBdiGSxb/I4xxZzqBnAFwLlFOBm9r87lGF4RQ/wuxOuPgRFcHqQWKyhKh/mTtuAJ0BFWa9oFzGQfecau65qfVa8L+lcanziEit" +

  "qTynoVt6P86uLD9GflzMQtEp2Zef9jhcLZNs56kr6RbMNMXZRVFYI90ezj3XuXfl+TYz2/r3wYd5uekvBOY2rg9CuG525tG3bNn8" +

  "0kte+tIn9uzZ0+zcuXMq/CuaAoAJtI95cCvR+ENPPPKaP/jre/7os8dH5zfj2LbEDYgwoCal2SC98AXG2GwrT2RaIp6L751mLtpG" +

  "YsqkKz49QyoQUDK9Tn3C+tjFHYg7gaNkh0MjG1Si9pWp98F+KdNrPN1+JHMjKPnqc7ZCEV7k/I2cns9QhcHWHnmEBUSAkH3nPVnN" +

  "jLnqe3k8MtPzPvPy+Fl6JogMqnIOIPUnNTmBFTjBpPUYg1RrDSUNkoTTb3Rt9CnJmJyLskab5yKFOmeZTHl9ZDeHgjNYWwtxYGvM" +

  "p4FNs6KMPY9JQD6Qhupzx9zJ6Zj5TKkJYBLh5o8sThwCt9ZPCQz8ZxUonvSOCcTqQya3Igm9p3zrXde/61MpQYZax6XvzTKOIwEP" +

  "3T/U04dY5CFRkBW6ZdU1ObBEIrhLkO16I/PWDT11Qj4Es4Tq/ObR83vF8SyHrvvmv3hOV5euA7arfAFKGf4ixzgazISXbJpd/t4r" +

  "Lr/l+ksvvf3Zlt//qdDUBTCBbiUaL+3bN/i6Cy99z49eddXrr5hrHhoPBw0YbeCIEUcRsWljWH7ydJC6ZEKOzMxYm/QYyGdrhDgf" +

  "cwEAf/GFmdYiRGDr0R6dUmG0KoBFCKf91ADc6FPyOLv6nWiomwT/tbtXnZCEYwgGgjT/gJmrPesgFxTHBO4BHVkpZABtl5GJRpVP" +

  "NTjXB+xl/0aliWg9GtFePU2EGIIdj0rCP5VTC//MLMkPqrwTEtSpNcMe03SXuFCc1PxbAz9fZf5FIIO0AXobn7J5oiTkObsEtKyU" +

  "3U/ucGcg2Bk2tS6Qq0xM1P5iJXaA1mueKvxt3IoRkbUgQsK9k39uPGYm2PR53WcbvKO2567ZGQK4ZVy4v4wNYV3Vz/5TFdbyrsBW" +

  "qwTB8uzDWfLKFqiW7IL/DEhoW5AtYIWlRAOC5VYHmz/bXFYTybNk614ABKJp5zoP3l2Xb/LTd/Ke5XqN6Jyp+wM5HscfrU1rKe2R" +

  "ltCuNxResjh39Huvef63XX/ppbfv2cPNVPhPpikA2IB2y+VBL77syjt/4uoXbL9ilh8Yzw0ajhgHTr47M63bomUkCz33cgbdWJ4N" +

  "ZCHKqjLCB/ylcvV2rmCCz0KUSfcyF8wyI/1K5JHffFpWBg7Jp10JfhOc2d+tQXnMnM+12z0uVLW/y+xZhGVy+3vBqc+ms8jqOzSz" +

  "HwCwnlNOMdYqxPL7dY35itC+cDGbOxOCDSwCXmMnnKAnQiEIkjejlUtTyALoLCsZsyUG8nX2C+9ynPK4QwwZmYEa+DCmzu57V2AE" +

  "LEMjpTGDZVHL4a02fN6ioJH3rjjSE+kSBOoBrGUHZCqsDtyzEEnQhlmUiK1fBi8MnAjQjR7QVmCbfEwIWXfqAEmGW5NEmATAgtdw" +

  "FejUwJJ6f5WKStDC1rP++mrt3gCrC7b1Y5NL1dqzwK0fSVOU0isrCPMuI1kVthqy4G3hszZaXARVQEOn1/M+vcJY+sCFgkFABby9" +

  "+0WNEEVMjBs9DdCkSABiOwqhuX7T5iM7r7joDdeff/47l/btG+zcOfX5b0ST4OiUHKn/6N4H7/2af3Hv/f/fI5h7CZ9cHnNDAwCQ" +

  "u/HypgIkgIiNaTwlEtW3DrTL5t/s31VFV3XszEzTZ50sgM58lgtmAQBZwPWFARSJ/lDwoxRUxa6orL5XXesW3DX9+b5nwIGo6W5J" +

  "NDPHMFi1l9Oh3NdCoybto8fFOiahY4Luo+xGcMy6lnvF82RaHhxv9M/bsTprTx5HG2bL+pa1svS4skp/9E1LymNWxlD4fspqI2RB" +

  "TwrvdEHIU/lcIfQiIdJnNB1tUYt2ubzEptaAs4BP61ldGvVYJNzh3WR+xNxzTgP1fe2LPfDt8OXUa7ZvfsvnavfZhHKKuikvCY2M" +

  "D24PWLuya0gf7cQqqBVLgJadmRdFIFRWnWoV9ZKBB50j9p/D+pG9Pz3jaqMD4xd5XHQO81zaetJPiNCibWkw01wzM3zke6967htv" +

  "vOyyDywxD3YTTTX/U9AUAJwmKQh45JFHLvjn9933F/etty+NK6tjIh6ACAEBCM40Jyg2uE3u9SzhBXJUJy/6vO2NvWUropgOPHvL" +

  "e4lBQcywJkSUSQAGFgohQ9nSQHljAegAgL4z0Bo2oO0HskaWWXYeD/seXSbRU7p7mwGOiEQABQRmRKJKaMXSZJlb3lt2YnwanSxj" +

  "LkwsBy5V2or8znIev3/3ZB1P/+oLULTW2bhEU4jKw309z9dab9FPfVs0V1soqumReyMHCwZ2M0YEjv4+B7Z4hvJoWLSWRhUglfSx" +

  "FU3BALH2Q4EoOYQUKo1P/bu1+R8iuKgYwzxvBf6krtCdBOJOJ06j0Eh92eVT8v3k2I9eawK07YqkYUtP3SzkBkuDKi0rnqu920MH" +

  "0BRcOMDp16x7GpZDrB4HeSiDlG4f2fEsCizGgbR2StRbujVKJSPxphTsK2WEgCHSOX8szg6uWF+964fOv+Jvv+xlL3hYg7i7rZlS" +

  "TVMA8BRIQQAfPbrtZ+656513H1t/Ga+sjAeBBq3ukIqxmBBxAotFu53sDiy1gHKXZSyctMvEcL0W1cdUwM6s5trGapqmCI0LSG2E" +

  "lbWhxutwQ79PVjIoVN/V5U5iklyIjRyNrRYAjRHUwEbrrwkAscDY8TInyEET/fKsgkm0/0Q+GwSsHNIX5I8KukwEAGWwF7sfflzS" +

  "dY3JsnR629XmVUGACWaFJwkYaImJR2tgoI52qQNGa1xyQ1lSKGunurZ8mBiVa6Nn0ZNKDul/4FKgR0IlcB0Wdpayzni65529zPWv" +

  "P3j2VIGI9RjnD2qQXIiziWXaeGS0Avg507eLdSnlu1M06Uvq5QHdcVGQqieKtOY0nra3IP72as6Ct1r5PqA7fvm0BQBOR4RzlsgU" +

  "rNjnIMxvSZIx4zOc8icAGIHGMwtzg2vD+GM//ryrX3/ZZZcdmgr/p0bTREBPgXbu3JnyBGzdeoiZX/fLH/nQOz8cwg2j5ZVxCDxg" +

  "KI/02qIyKqf5IzMyLyhs68sfpMeuTOnyTwsqdlreROZlTLXcaElIZI1An+VC69oYBFg0N9gJQc8Q1IKhndJHerQfZSqBHDOV41eU" +

  "i6iFNttZemHsVDKeKNaR0qyR/c4kHVHNq9Tf9dk+wMb27wYYaSJZ/5kVI3aIxOqRxqYbCe+fq+erO77pR6AMkBjZ5w4x1+arfnVe" +

  "U5BkhLsWW03JWr9JwKy6eWOALYFsbxHvRMxabI/w6g/8zKCrfsevBH3eC9AaRJGOl3umtCT0m+xrrX/S1usz++v7/YCd8w9VKjif" +

  "LDG8gNyvJESjjGUOzPWxSSUxIken1bPAXDniWrW/fluD8Ox4JZf8oqoqj7gwPTsOqXuQYPo/MRA5goPBU6jZn5DyJSS+2I5nN88N" +

  "XkEzH/uFv/Gq1xHR4ek5/6dOXwTbmpJZApi3/tx79v2nu2Lzd9pjJ8fDgEEyU8vCrcyeADqMOwv+FDCVGWPph4XbBGa2Nj/Z6RIZ" +

  "Y641PFie73xE61Tav5UqzCprlkhCXKopNCxytdaCqpKypU7EXW1d6wZDM7CpBpNUPzFLB40nqIWJHI+TsTdxT/nZ7n3zHrb5zzID" +

  "63zb0Q5LynCxfNePf5+P2sYALtPcKUzY6XtJREQAc9ttRPmCPFvNb9V2dgA0rc3qaJqWIeAiyD0AOeivr96ySYVgcuPQsSahh7FN" +

  "sI6dzphpe+qnMi4vff35s8nFFYJ14oO6BwFyN47qXBBxTqTl7lpQ0akHkpJ4VddBOTKhwwf0eQHCdjy47Le6Nhkx7y8HsPutDrKT" +

  "VSnQ47j1ySMAFvSsb0UGKKABYY0wHs43g9ds3vyhn7nhxjcQ0aHpOf8vjqYA4IukJeawmygy8+Cn3vXO/3gvDb4nnlwbh4BBJAO7" +

  "shlN7ZWfriCCofZudLEYcZlFEEUrhqP+PZnLdAS4BoQVACCnSVE03mdK9Jpn8VMFvNNWCCmrGYHse8+U1eRXCBXy55D1OXkpamSw" +

  "Mk22uvQYZtL6yzEkAV8RfQypmIJcn5FPpAOYmbXoiQZOuTpPAQAmgqoek20Gf5MBpGZarAFAf59E1zMGrNqviynpWU/ZzwxZr24e" +

  "1HRRa+oI+TQAGJA1HtVVxcmyk/wjqfYC8HC1TpirkbARMcuNjY20RzXk0lRfq9BdUFCWbri4MzZZR4X9m90uvsou+LA5DsE0/I2I" +

  "9BZFmQs77WEaf47nKNqdKk68RLeNwUYFBj1zDpmr3psvXft1/uHHJ/O8MpASkuqZy/FkoD6QpidWIgONtTMgAqP5TYvDl8/Tu3/u" +

  "ppu/iYjWeJrb/4um6THAL5J251sE2994/d/83qvR/u7wnLnBCDwaMnNKGewuQGXJ/V0jXUYW8vK5bmgSBqsmWsPv8s6pqCv8AUbr" +

  "mLWyCU1fXJ7t7TN9+nLVRCoPF9LGWz3skhkt2TFEu7iUs0av6WgDIx0rRGIWxOkon+dHWXxQWT+j0Oqrkel+IvUFmSf7HbDkPqbj" +

  "FeMHS9SiH2mbrL+F/OnH3DqWfmwBdj/Lug2CxGiMtD8Yre65amEidDQIFaqxZrO3+vW1CwY3qYzCV0uOtd/8Lw5kykdBTEAsiQaY" +

  "83IstXi3T/r6pWci86LSQgpLRL1usw6sIASVXuygk81rqQWTulDALpOzWkm6fdE+lHMrn8duimtXE8rjf8IrSLXjvI/M1aHPCXMp" +

  "1q0BPf0tGpjL/xOY9S6MyeIhj6sChPQ8IV3X23U9MDQNeWpTwSzq0vN0gtBKT0fg0ZbztgxfhNV/J8J/fSr8vzSaAoAvgcQCgFfv" +

  "2zf4nde9/kdvavBb287bMjwZIwcRqS2AMRgxAC3JqXBWrUrXeSk8Sy1R7+TWjU4ANTAG5oXwRiQaQ3o+alSXfumEG3XM3rVPltkz" +

  "xywIlA3Y78rYnfaovxCp1SN/T07QAVCDRdJeoAF7WcAIC8sanwMU7jJdlH4HlL/3D1b+Kc8GVbicgNTCvAbI0m7//yTScST3d7/P" +

  "W2NBZL69OZq63SnAR1WfxhGYf1vzTiAlcGCOiJHdGuAsOAWpWTu9IOP8uRNNBaT0wsiWvFiPvG/dfMoTxo2qlcbu1ko/npMmWl0/" +

  "afVwNVZStgEfTju5mid/7NL+c1J4UhyDB1c16Ovz1Su8TYJZ9zBgsNrLPrffOE8Y1J3HTrCaCM7xg4iS1ttcjBQ6vMD3g4jQpzCA" +

  "KuUAia8oCCj2l+8ta8tSnyKny7NmOPIq0eic8zYNXzQa/Zvdr771TaL5Yyr8vzSaAoAvkYiI92/f3o537Gh2v+rWv3/rlvlf3bZl" +

  "JiwzY6ZNcfXMpZmtvAIW0GtuWQW0SUrHHEDJXCh+VA3eynsuiLagGkOPZFDSBEKcNiYbJ8hmxnQhTsWUU0OgmYVzh0rGZriASK5N" +

  "3oARQ9mcZiCT+iqNy4SpY7AmxJD8/omJmQ6mtZg7Jr3Xr11WLUOZsETSqnISBiwBVEkwEHx64GJWWYBDb+/llQnMf5LBG/B92eCZ" +

  "nn7VawsgyzGftVAATMm3zC4tjI27s1JomTUAtaMZ2XzsYyBSwJ/WqQu4qx2jLrfTf/kliJAU0GBAucqHb+8q4PCWLH0y4YIEKjrZ" +

  "KQnEXig6zVwBSzXupRAsAV4f4OuQmfrVVeP7I0BcBDtBgWq23PhERmqJzCl/AOIWugknr9ON11htfZvcN6rGp9zUZO1Iz3FSmHgV" +

  "wGXbzh2+upn9zX/06le9mXbtImYm6kvfOaWnRFMA8GUgImLesye+amlp8KaX3PgLf/uS83/wOefMticDgSLHIQUxMSejWgNypm8X" +

  "4a0byXy/Vr4IWNUAkTQYH0BFnC5VAYwZTNrRGn0NtCDKcQVaF+D2qRO09r6a4tGC5ZY+zRZGgaXM9L8PbDTtUJiW6AQobvmiFM3s" +

  "dYTs/9VGSps0yxgRsiG823EWtVzlJbkvCGRZDD1ZEBdHASfiJmEFKjFlZXTlU2Tj1/V59s4cGMdVzSw3jMW6kjV5NisH8khN1Bw9" +

  "cNOf/n8rQZAaUQICaT5ILgeMskZi+a7Oo/PLs2uL9Q2txT4Ym/bTEnXNianZIT69T54E9XXwhUlqODRKMBBLTdLMqZxX06LVRmHj" +

  "ow8IO5Tm1O8nYwXnFzxo4VI0KzjyY1ML0ryve9YJEwiNAXoiBkI04MS5EIDkhlKyV4vfFeBoX5PbIx+LzQpACeg67hPrh+5lib3J" +

  "9oRC8JcgXvevsxEybP7sFIPECBADA6Bda4gu2DTbvnpm+KM//vIb/8Eb9+xpeNcungr/Lw9NjwF+mUgW5Hhp377B9197w7//H/ff" +

  "9/g78IX/59Mn12fnWmoDo4ki11sC9CiVRvMaGjbm1m/az5qLalYaKCWCWa2hAih6NUEtKxWIxATkTnvTBPsj560Arbe+ERFZQCRB" +

  "2ZrGlF5rodXmUDIGMiTKdXaYI+fhAct1oJXGJYWn3PsQwU9qaa7AhANarLYDr+HKlbAENDI3XgtTUGMX/VCw+jtC0QlbQIVi6Uog" +

  "kWGJuQbfOutdFuCl9lmPfQ0CPHkQQG68nW7aKcePb6fEHgAlqyoLImRrjfL+IElyDAxRyiHgg0EtpkDAhxfc6ibw671sqdbdmE9c" +

  "hXUxdjGPaKd/OufObA83B0V50p4g5caqvtK1tzFA1EFKY6bR8hmo694tYnB8uU6IqwWN7OOUVKsog7sApUBemtq5WhMWeKjzZJ9P" +

  "6JU8l8G/ex3piCEFAC3acRg0L9myuPr6C8/d8YarrnnHjj17mr07d7ZdrjilL5amY/k0kC7UD9x///Vvf+Tz/+2BtfYKrLYjAg9b" +

  "AiIFE3cM2ZmqdpTJvzZmGLLRM9NiKVGFb0d8yFP1JvZsr/qdhbU6xkP2Vmq7Hvki0UbYtSuVQtkC4JmKMiqto9bc9V0wYpB45Ji1" +

  "Tj1p4F0J3nfLVGo+qY0KeJxPF/lSJ3nI2qYjppnyzBWhjLUY4BxUloVEJWx6qPCdak+M+es6EHOuA2h1Gacs37XD3BgoM9VlgFRR" +

  "KXkma675BRMIHteqRlq2txIENg0SI8K5RQZavS+5EnY6hF6TLYFDVSf0NIoDKE5YOjxqb+g4WdqjeuwVEHKevwJ4icSb5B4zQMzI" +

  "yXpILAE6Q7p9oDEL6bv6bIpZImKKkVFXWR5/MuFedMHGMZXL0VsHIFYE5R/ovgs3TdYYRs7aabs2FRgIITLWCaPZxcXhlaH99Pc9" +

  "/5o33njxxZ+Y3uj39NAUADxNpAt2ZeXI8/7lxz/5xx9fG73kxPHl0SxomO4JcNd1yqb0Z303yq6nJmLSDIAsN72lW4igJsNai1MB" +

  "UpzZdubL6jhurkvb4TQLQM4Cm5gumbkeb1IyhqcJd8COKWbSlKZ2NYF8mjQYbbPUFDknDeKUNQ6RTcgYuHDCZpLQMplAuVoDaf6d" +

  "kLWpieJPgEBQ+CCMfyMw1xGKOu5Ic2TDXz1b/9SyayuANzd3hbcHAMVf0DCvXC8y15hgJfDC30BSDwDUPuXyVaTWY9QDSaq1WHxl" +

  "2m45531tDdU8MiXxaVjBg4bqdIMvrwYbNnuuHdYXQanpyoj+dZArde+5Z2wM5DmunlPfPwMW5wFpW6zmgnSl+rkpmtXXHoUaulkz" +

  "aWBuwRE4Hz4EJEZBx4F11hkjYLywsDC4btj81a+88vqdRIuPTIX/00dTAPA0ki5cZj7vN+/44L/90MrKG598co3nAIyD6nvBeEv0" +

  "oMABgD7tLjGJKJtKb8MDdLNGOzwj7JOTX63NOiXy06emPgHT8Wnqzx7GnJmW1ts92pYrC1X0fMmATADXgi4V5gSm9HNSPacgOyIm" +

  "QCdZQTMA8J3m6h3Ti1z+BuvNRMHptF6zy5BZWgr1GF0ZOKnMjawD+n0GKP5ECIOKFeLWk2tLt15COp8O0WC7wtrWkkLISlCW4KUE" +

  "BtqSQon0/ZFiUmxgXrN9YMlOqlASaDreObukL5fzNFSVlpatvqutKR35Q55jgIEQO+3ve1f70Pu9HwQPDqyPWRTraRrlD2qS3xgA" +

  "1JQFuLqrJjxVlMkseTuseWn2o3CwVUI8Z3GxeRnTH/ziq2/+YSJam6b2fXppCgCeZmI5pzoA8Fu3f/AffODQk79+ODYhxLbllIzb" +

  "NmU+5oaUupa6R4bS5lNVVfUMEXJeLZXfA7LmGAFLAZqVh8nMZZLgmPRZwh/BNKRScyy1OdMke+sQpkQuux93Nd+6rUX7GMUxPO+W" +

  "OC0gQFRE8KtLQQeY3L89+m/+6esi55YQQFa6X1z7XTn9gj7ad/mdrrDWvpT+65K6cQWpQpmproB19p6a8tyQKzGt5T6Nua8tk2IP" +

  "tB31CRH/nnvslHPdFXLabrZ/bfP0zvIEgSyxDBp46tulTp1Jpn810XfGye15Wd6un3m9+GBbm1MrwxpoFkJVQvKYevCcx6hOZpXW" +

  "iHRTvjSFw+9pSt+za7EOZwIdEYE5LocGF22eDa+aHf76j99080+3AC0x0+7pMb+nlaanAJ5mopQrgL59z57mR2+6+Te+49JLdj5n" +

  "MZwYB2rCOI4bl82PRKtXwahaSJdZug1IBL2rns1GDOjGL9g6ZSWy0OAnaRZ9gt63wpmp67YpIKiZlImESvir9o6CUYTMpFQoTtBy" +

  "ixbIOBSMFCRWkEnvsghV43JVj/wIZLeNL81bIhip/kgp5oMDmR1ARsj+6ptf9TFnoZHfVFBoLXICSr/zz3CMWRiSK83Apa6H3Mdq" +

  "KsC2sCYLfz8G+iQ74V9TFJ27gC21hm4CXkEm2fK2EekFC1y2xcDcRmvHC8qeoFTXs/L4Wt23fHKCnAA2t5Sry/ezkRpr94X67jUj" +

  "CHEdL8P5P1uDun7cROoJmw1k6iRgVhzjpHIMzNJTrcvUfqAGOxFpX6Sb/biNg9lwxewMvXK2+Z9/7Kabf7rds6dhZkyF/9NP01MA" +

  "XwGiZMNs3/Rv/+3w21/y0j/6i7s+cM+7aPWPH4h0zYmjJ8ezgQcjiiDSyG8xFeoVn4UZzX6zn0kjyEzBM/vInI54cfFyl2k6MFCy" +

  "uwQwrAVajmfqhXqaBZG2RbXdlPktl27R89pmrU9Nz3Js0mt8k/z5feZjE1cSF+BHLfcvw42umyXaQwSkAESz1LjCxLxbghTfVgVy" +

  "fgxFqBaamDYoj6H5kytLiU/U47XMXlLQRCmiXIpzFqVyCrsj5Mak91Otxn0qOeoplPNSx6T0N5d651aBnQb0MVAmRZpUjvSV0bp1" +

  "XAOMGlDFXIbNHwEcbAxVLS599n4+fNit1guwukcQ8570Ahb5YwNS2dQDtYj5UzBu52drnCtHSyMFd1Jl6pPcuFdYGIsuFmSGeyLX" +

  "TkYgvSgoA/e0V2LnfYCwTjwazM0PnxPaz37rhef/yDddd91f3LK0NLht587xRiBzSl8+mo7zV5hcXMDF//QD7/mtu9bbHYdPrMW5" +

  "CPAgBDAhBi+WQqEtmjQChBm08hwh3x6oN6zZG6JRegAA97s32VH3M0edTyaYdal8pLSEu3e4erZbr2oawjg6DFuFZRqD6BigenTB" +

  "XASGRWNBmbkViRFduQpCAHWdkAnfSLn/NiWMwlUAIlAUqw6R+WNTTIEyxuDezeWYakUZDGhSmHoc+3730Mr73M02Q5D2qGVB63Rl" +

  "4RRkDvfuPDJ5LTq3ayJY8YuhD5V4i5jMqdrDGSUwLH3y+bSIb0uuQ27H03kAoPaaFLBbvu9mF0WvdXsSYEmIXH86ABNtYWLX3BEb" +

  "WbmcO9/KNr+6Lg8TzPU4ixlETfbsJo0KmGLP25xpO23faurw3BR1N0ayAmV+xErJendH5DUCFhcX6cVz9LEf+ZrLv/Wyyy57aBrs" +

  "95WnKQD4KpDeXNUA+Od/9e4f/eTK2lsfHw/QjMYtUWhiyHgeIrAAsuN2PqiKnKaiVDIRNvOnpLCBMvheRrOB9uU1C6tL3qk/N8bh" +

  "fu8jD1A6goHFPylPepN+XYrmMUiv5VvpjXkjMzHqlNM15+dvFDjk9rIyuKoPbkQA1khs6V9wYw6IO8LfVG/6o3zmLogipxWqNaZv" +

  "HJwVh5CBiLMv6Nci51kHCcbs0Z0rE3jq5+2dSkrhGpqAQR5TK48CLzFyF2Wr1kkMUEjPBa60XtJ+9bMsBYe9YJSr+Za+pyRF2YUm" +

  "eTsBAAGxsjz5ualHJ49f/lStd0D+RfGKWhDkHwEjClDr/TcxbqICSaatE6Xw4E5z8/rLlpRcT3lplp7SsVdtn+YPuLAs6jqJNiQZ" +

  "XSgwj0A7CtScS8BNWxfe+nOvuPkniWh9Guz31aEpAPgqEXO6tBZE8b9/5lN/+//73EO/+0gzfO7oxNoooB0iNFlLAcz0bGeWAdH6" +

  "u2wpa1pZcyT2/lb/vSlRpgFOFMhQQeIsCVKfMYfKCmCattf6q7InmvXtcBALEJhs7vViOPFVNgWkk1+Aa9di0laTEOCiTz7a33za" +

  "UIbZD0ao/DOBL2Yxh8v7yvy7s1f9BLw5WkwdndeIXOIZuHEk98OGiOrRkmdKoTsJtE2KHTHhwoDenkhWXxIwdSw/+TFwXbPeMyzb" +

  "HKGay8q0ZPIW5RB11zPb2Xp/bbECTRDEtZAdaxk8V0JazPn+VIsJfyCDJpDT3vX4HCFYJrw8nn3WnInWDfeMB7F6Mghgya9UwdSe" +

  "fVpSHiv9adarwkUQrWwFpqYUSPBfAuRhOedlAAA6NUlEQVSEMcd2PDNsrp4frtw03/zAD9xw89sB0NLSEu3evXvq7/8q0BQAfJXp" +

  "TbffPnzbTTeNHn3y0St/+77P/qe/Xhm96uTx5TgLIg5qCqBS61eGQSm9sI907wuWI9F+W9NG8vOlZtIvlD3VAECZfi9jQsnMN7Is" +

  "+O9NkAhnNCDASZMmLrW9sj9Ve52wsiN8esTLBEh0AMBy1BYUmMFyCVO2SVChJVo7rM/pVsFM7u4A/1luLfq3ZLRv+8ib/CdZWwqZ" +

  "LRNTBmoKE9dx6hFGdZ19AAD6MTWd9kYq+0Ca4lYBqSuu486QFyfFDUwmDwN8+ZoD3405RRP66ZnkZieGnZ0HklUjsgAIzd2hOY8Z" +

  "UEtCXnupCnPvIFmsmJPTKridshE47vtbxwjQI75aR74HgXUfVdYC/37mFapg6Li4K4YNp4m7iBn5MqIMGJIbQpBbcjXwOlOcXZhr" +

  "rmrGH9/5Nc/53ldeddVdS/v2DXZt397SNK3vV42mAOAZQC4ugH799g//2seOnfyZQ2tjNOO2DYEaNoGYmE/alpM1f/sbavpOoj32" +

  "zLZZANgL3i6V0dgomX+fwHRleXdD34LrY3Ku8MRIQgQ49LZv4/dLsGGxAIBLfBShY1zBG6iWnvhZMuoHAyAh30hrbRBGysp04fRI" +

  "EbWWsyHVXfbBJ8LRod0YANjzKNdAPS45DsAFLLIfB/KVdkzPXM05ue9r6w/QFK6Wfr9/Fnz+dMYk8FnqsBuNg8xZ8Z6CyI1kjRdm" +

  "ZJ8F5L3DnIJq8yIpbwVMD7nMmFW7RMxDLQDkAEd6R9bphLHvjou3avh2d/eDzlMIodd6ZWI4pD2nvEPbDgMHViU8akv7O8PJmHoW" +

  "R2Ccv3VTuJr5//7lV77yh4hoWbOldhoxpa8oTQHAM4SWlpbC7l27GET8x/f99RvfeeCJ3/38ejifT6y2gdvAeltLCOLfzprapKAq" +

  "83nL5nU3xzsXQE/0+ynaulHEeW049J9vxMD7zJxl0JUKL1/L5PftScp+7WDapBwJdP5OAIiUmX5udWlR0U9UXnrI4Kzn5nopSynk" +

  "q299pz4FHk+FPHjp1xQd4JMqFLTY6QsnzNl3CpUGqeUzW9bHPDdd0GHvUTYVd9qflUarQ8vQNj0VhmW3O5jbhIpvEzlrTL1AKQOv" +

  "AvNSvjUzKNwwoEbZKiAiP41TaanL7UpAMd/al/5WawlxjmaZDKKyI8Ue6fS3pA2+qh5EXliu/boXPKDREwYMgAOhBdrYhObiYWj/" +

  "xta5n/nxl938r0fIMVCn2YIpPY00BQDPMLIUwszP+7U7PvKbdx098c1HTqzyYmiYgRAbsvzaZqir/L9qdlatxVLlqkpqjFHL6QKA" +

  "Xq1PyZl/+8z+vhz/uf1dCWsNFJsUmJgelRgAZvSlr8jCQpuWjlWmdiTmGkTApBK0fr3eN522SMFKk3pUDQMcfyTnI0VyGZCExue8" +

  "+yo4fbnlsTG4dpXvdNvRtfgA3jUyyQKQ6qQNy/cMvny3fL6YV/ukBJX+9EayHKAXAPh666h9fRcTxqLQkM2qIULJBHleN5FbELEI" +

  "a0J0xzi11RpwmS0r+lV+TiNTGMGtG5I5ZavbEn45szx594+6F6TfCgACGlkL5XFPHxvAIET9zh2dZ038cbqkLiHncgFQmP51XjIA" +

  "TN8QRXDMDpQxYRwWNg2u4PjAK88dfPf3fu3NH8TSUpje5PfMoikAeAaSgoAhgLfe+8n//UMHDv3rh5fXm9l1HgMYtEGC4khuHhPB" +

  "ZUfgFAAga6yWBpgyQMjvKZ+olkOPWd0LmcLH6V9TbcZ4vmfmQaKdWc4MwwmiurBCBLmqJlkAPGAxeCTarEawJz1L86MrADCtDsjI" +

  "qCjbCTyVZ5YKNdWjWdySCpSvZNmIB3f7rIKkawY+FdXCWNeDAR43Nj6PAIkoKmoxjb6kOndDUbtfQ8woYx30MR9kCsToBAn5ddYV" +

  "9naSo9c9kOIrcpQ7Q9VRb/HQOU45ZvQaYn/bnq+vtTnVriWDkV25KZ/H5A7yTaNcn4IJVlAIknUHRec2bHbplK1XkqHN+8f3GgL+" +

  "U91iG9S9YDn+8xhblVTuS6J8R0CySKjdIe8bfQ7I88SCtlJcQwsG4iqAbdvODVeurf6///B5X/tDWy/beuiWffsGt02P+D3jaAoA" +

  "nqG0xBx279xJ2Lu3/eBD9938/zx88D/cvzZ+4dqxlTgLplEgIsr51vWXzJq7TDrfA5DInzvvWwqJNcrvFbMwf7qKPyctvKJkOi0R" +

  "OCbGVGuupslEAoUysYqBCTOhZuFs7ahNxToc0ogIf2ac0TjtMtWd8pFnG7lYGVgSnuh3ykGdRpviCbLmnkfAxT0UAiufwND6c9vz" +

  "6PVq5E/F9cKcjh4Cxfx4YetbS8XbpTtAV1Koqs9Dqjq7AinNKdCfaFRdB1abLEuzFHQsQKXQ6Vg+VPNl1XqBfHICIKYUtCettnwK" +

  "aLILiBiWw99QXv5Mzdx1boPkmsg5BPxG8Bn7Isk5AstPLZcOUbRnHGYBCAiyBqNZIwiWM8Lak9eGuh5qdwlXSzNQPsHSHcty+HsD" +

  "QG1P6tmMpEa0oJYHM82FM4SXbFn4uZ976U3/koji9IjfM5emAOAZThosw8zz//qOD/3mHSdGP3Tk5CoCxxYBDSuTUW3bdIUs4CB/" +

  "W4KOXt0uaRAZ2ecn+4SRZiFjdreNue8LEz+REy3W0ILTqGk/5yhXyqfp2QGWUwnEslz3HgC9GCnXor7bdI9BFItAOj2Rj1flsSDn" +

  "r84WgFyWwxKdNgpQs+9UYwso50aFcNc10u8OgOGTAlwRiRD0z3rpn+vT8bHlJIJEAUAaMxdACCdAWPIAcBKaRP0nJEpKFyXVPv++" +

  "Pk4K7ExtblFEvYvwVouQttbHfaSAuQBGm7rpgy+lj/k4nwsoLFGzNCbNk1kU1OXQAQCyHzhp5+mhKEI/t5PlXRXi0c87EThK+cEJ" +

  "Y3jrQr03yjl2gwgueEHfO7B2c7k8AU5tC2BeQ9vOzM8PLuPR3d9yyWX/29+59tr3ASBpSz/DmdJXnaYA4AwgHzTz+3ff9SP7Dz7x" +

  "awfbweZmeXXUEIbrITGabJJ3Pjqw+AcTi1DfqGTkSjm5kQVcoqw5pj8rjV2AxEYXSXQWFgNmvmQAIUdNl2ynCkiLYgUQH7u91bNy" +

  "uzEE0gun1qQc5P6d9NzGpwgymzSNGkGCCd39AcVIUqfcboMz9MhgK3duUhxABwiQAppsB9CRZddfXz6p0PFWCmm2/9v4PdWrRGBP" +

  "5ZtmqIZbRrcDtdzUtRDL+e/pp9Jkq4ho1h2rix7rk1bXjm2XCa835iB9oZXl30nKkn4ToiXRyR1lhZQyai3EkGV+fiXLMSDuuwwl" +

  "PVDrB37aF9ux2jbrdR6B+nXNFcAuQ1aUulzCYzkJ4M4wiLWKEMEcx6uhGVy8eRNevjDY+5Nfe+P3EdHqLfv2DW7bvr3FVPg/o2kK" +

  "AM4QYmb64be9bfC2H/7h0UcPPHLjH3/+kf9438nVlxw7sRwXALQBQY2JyqsYyP5LoShcPYhQjCEnCcokbKtA/M42OEFYqmm35jTm" +

  "UmeASc7NURkApcFMOfEOg925RSq0lVpz6YyVCIIsXu38A+WuZeHh6ihcA2LlkDTAUYRiA4CpEU1NAYAwXTO9sgjwfqGd/ibR0DND" +

  "LTXyfqHfZwnwUyW1owYA5XRSR9gWgWWyiNRSQqRZ8hwAoKJEV7sGXXbZi3c51RczbST8tYpsfp48Fn4UbLKrPqYPJIJGQE+Jeq2V" +

  "XaCkRatZnqpDdS65UABsLaatkdeXNDzFargCDABU4MqXWzRT9zgzOABmFTQA1CDnOHA3Fdp35W7y6YZTeCPb+EQiRCIEjnHcxri4" +

  "9bzBxSEeePWF5/z4//L8a/9wBJ5G+Z9BNL0M6AwhMaONlvbtG9x4waUfZeabf/cTd+z+aNP+9IFlRrM+GjeBBorTk8ajDApQn2u/" +

  "kc+LyPyNiEeIWijfSWARA2GCCaA2fYsoku8qTUTUeRWIVmvl2lC3g/lsJ9Akc7lqeHrcirkMe6Mef3UqIwtxr0mnf+Umc2mnjhdT" +

  "1g4zqaARk7xp7+bNLdvLVMxj2abu76mBOpaacCgLH/KaG+V3e/3qzmye29Qn6P3fFehTuKGWBfeU9ilHsSODwD7Br6UzNGG+NtNw" +

  "aT/A0nf9yq/7wVDZjzwlucnqBqmBoS3V3Bbv6rLX1eVgoBvQoDx1T+j/nT6zBm9aaZ32e+CcxlGTK7kLi6BAQoMe/Vi01d9BBL+L" +

  "NhAgkB6LAGO8PpgdXLp1PrxkcdMf/r2XXPtLFxF9xkX5T4X/GUJTC8AZSEvMYbdclbn/oc9807sePfy796/j8pNHjvIQ4Egcxi6S" +

  "XSOnmbLmpFSaUdPv3SRDqtOm30sX8qRjWZSZHOW3fQR5MvFDYsWU+aj2qdwYwmQrMNBDk4LErBeUAUSuIscdpBgIDwyE4bobeizg" +

  "ihowtyAKZsINLqeC1kMSbLZROwlJUGjUvqZQSYw9FgKs7FcWzAQSjh3BXIoUf7Y+uS64o30D/mREhjh57PIpCbI7Adhpn3qnvAho" +

  "cRmQBlN67V4AiPn+qWsNqHuo6yX65yR6kLhxdaP7vY6DL5WdtWMCF5zkHkkliAtMIxilHwk8NcU8MTSjYI4DsO9sPZVBoHU78rPB" +

  "vS+gElSvWDCSDA6UAwkLS4JcGJYoAL17OM1vFEsWR44jZtpyzlZ6TqD7t19y6S9++3Mv+y9APrnUP5JTeqbSFACcocTMtH3//ua2" +

  "lEFw269/4qM//8Dx8U89ujoC1lbGBB6MiaC+UUAEQY/5Pn+WddEyMXewz0tTqNcMUTCmVK5+ltk4qSbRcw6dI3UYcn47s7lJAKAo" +

  "awIA0GeYgVBZFE4FAHIAHIlA1KNcIcd+hSxsI2kqYOuojaGnSADkhETyJatqm5PmENgMuqQzIgKjsN+QjnMGbXpcNJ3CcDfAVWPk" +

  "e127BgCSwDS4nAdsNevz0coNRdreOoakPjVigLBv3uyn1KkmdbGoQE3lXitmLoSzfq5zkD6dFMVSrtnifR0T0brTBHN+HIAFQdbj" +

  "yzmo05cHaAwD4NsLQnEpEkuGPv9AcdIGbgdrgiFO88WG12T1KAAgHQeqlkWyZEWOCMSMFnG8MNtsowHfeM55v/OT17/gHxHRkR17" +

  "9jTX7djBqpBM6cyiKQA4w8n729538PG/+RcPPPgvPrsWrz925CQHaiMTmryhE9PRADAT11QKQiVGnb/dWwKCezfC53RXzcQr752C" +

  "fZH2TnDn0Tk/q6CAy6K0D3VQlX1/CotATd3nPKDRs9WpvSSxDGwdTT9ilUOAYDLZ+paEn/1lQjoDBP+23EMgdxSoTuvEex4XbUet" +

  "zZFW4IVad77rsegW4sL69DId953eqmfn1/vGkQFnfsn9rZpSuHHs05jN2BY9LwDAW7vsl/7+FZYAWTt2kkU1Xgc7fHuKcbFxd4GG" +

  "gPW9Xk+BIWAlVmACGRWpQHZ97wTgkkEdw3Bka8P3PQfUdqAeZSCjdzl7l0RLev6mbVeA5pwtW3HVgO7cfsEFP/aGK674K2Cq9Z8N" +

  "NAUAZwExM+3cuzfIccHNv3vvPT9/5xNHf+ax8XiwtrbSLowpjOX4sspbFRgq0OC0ESPSK0KdJi+marjEJ97zWQhdLQbufVtyMTMy" +

  "zZJGpabf6WeP5qhBbqcCAKf6ezJA8KydRIPTLIPSR8IGolTap+2HBwCQMlISFqhGX/pYBOCkd1KMgWqu7qIWiLZYv59a7QzhVjA2" +

  "brW822MaJjcRnbFTp7wKFu2rgRDfNXbCLNdXB5ayWECqsyllD0jLjEWyoprYl2kWMp1XLdEDJbIuda0iIrO1y1oOInzAHqyk1AJ/" +

  "G2Un8BJASpYlZwCq8WAKMmYOALk69AroPB5sRwrreWLKAMGPaLIYMY84tMO5xcElgzh+8QULv/rj17z0nxDR2o49e5o9O3ZEmkb4" +

  "n/E0BQBnEXlrwEcevf8Vf/LAI//0fh5+w9Hjqwjt+hjAIKcHZs8nkqZvDC6aAC98h07gpcQ8JBp44gOs5QKeK1ZExb/GatUHqowr" +

  "IYNkqlfWKXLHB4+lKOXJFoA+lwfQFWwZDKCQKlyImSwc8rn99CPKz77jZEHMFzm9qwIdRtRYLQvg67bNhEzMAKAwJVeWkf6I+Nrc" +

  "XWqiRX3FU33tyQCAmZ3AJV0E+eWq3s48UbZmlP7tosKsJZtmm5LwRrVEkJ72SOuOi0A7jXiHCMKid04IpyWb4lckUY/7nBQ1Q+vL" +

  "1hi/qvM6cesKCoQ1rS+hAHBV3wug64Y/xZ6oxUHSVFG2YtSj13G9WPOyFUDbx0hulQhumUKzees8ruLmtu987vN/9mWXnP9hoIw/" +

  "mtKZT1MAcJaRtwYMAfzBPfe8+QOPH/yFR2hw6ckTx3iGKDKnqDSqfOAmiFNBuUwVbFANQ2nStbaA16KICdzHMzinvbVXZElGkTE+" +

  "9WufQJ+EM7p+1u73k77rf0GO+xUJezIw2UgVykxX/lZjimhxsWhH1T+GuW4ssLAyYqsA3LhP5IRMgnb92z8jIHKDq9oymXm5AlBg" +

  "BJ9Iqm/8OQtfFWrJzCz5DsR3rq4QfZ9EoLO3PMGNufizOyZ3OaqZmhutvHRIwgE+yF0AZiLzwMcnakpwNwfTcV6yhowFrBUrIk1i" +

  "wkb+dL8Xvk6Tl0L7rRg+YRGKceoSl3uDqudtnGVdMcd1gGcWFpsLsH70lRde8I/ffN2Lf32dU0KyqdZ/9tEUAJylxMyBdu0Cdu+O" +

  "fOTIeb98991veWB17aeOcAij1ZUoR5KK69W9WHE6k2nFdiUqiebDwZmcoysl67mAaO0V31CzpFd1VMtKP4MJVkJinMzKgPPzWqUY" +

  "Jb7MZOyy6pvvSAmKvCAiIqQsTNo2ylkIKQm+svyqdk754tgEWzL9quApXBmqkRYgwOmmEywhZV+7n1tJlII0vSDte9amRNshEjj9" +

  "cMKLtHV5DaTENJU/3cSjWEwMRHm3RsyVi1YbFKhJ2REBxK20KY+9WlxOnVciwK1GaCxNf6yB64FLTUyc3R21tm8BugY+uvNUXOdt" +

  "loo8vxPdHhP2hcsiyIzYjoZhcN7sLK4ezvzRd15xxVtefNFFerQPNNX6z0qaAoCznHwe7n0PPbD9nQ99YfdnV1dfc2IcQOujNjCH" +

  "lGxPhIloQe4Ss6wlKZuUOACfCzDHvmkQGIzxJYNDLUxV4c/mYq7Msea3JM24Rxa/UJvaE9PUrAU5iKoEHmQ/Oix7Iv/vCv2cDVba" +

  "BIJPlF8z90Ca7S1fyqMKY5Fe1QfHmQDNAtEyBhbZB127bA59cBflbrMHKNK3Ajw5RFWOWO9Q2K9EoMgmSNW2oEmcc8CpCOXa929m" +

  "fDFv2zxqABun4eUi2kRVbWuMrRsAmso5P+30bDs5oIhBXVuTZVzKSyHCnppsmdD+a6/NEpADIhWCGODpEf551H1MRH5O9546HPIc" +

  "VxOSVXxXChdf630JlAIpx+sUBudsWsDlg/bTr7jk3H/0vZdf94cjTIP8ng00TQR0ltNOolaPDN76nCv3Dwm3/Kvb3/d37z268k+e" +

  "aGZecPLkGhqmFsRNa/KRwEGYOoRfF6w8GANUpp/kCWsBIITiimJljmpN0IA/qHaV5ZQLsMrgIGteqZ4IRmgCOJZCi6TMTD0Y1zFd" +

  "QGMMSoFa+3wnE8m1CFy5R6QcQiEGtKZAOTrbB5TF6jMQAbEVjT84v72Lkq/rVX+4yjfrts5nbkvuupfuE9CQlzVElpNHb53URwyo" +

  "QE5FcCm4qqKcIGZXe1pVOVDNxGfxTN3kZJUC9GigDmEh/EtJad/12kXU8kKEOmaCxQJQHvyQfpLmb0CnX/nWSK6EP+SIZU877Cfb" +

  "HqjjRXy8jhrX/NSqrSIQoyVuVyM3W7ZuHTwXo0PXnrv4z3782hf/DhGtYmkpLAGYCv+zn6YWgGcR7dmzp9m5Y0cEETPz4r/40Ht/" +

  "+oETo7ccbJq5kydXQKA2MDeq5RScjfKlJObzVhNkRglZSzH3QAIMSjl4LYiZMxYgIQeVAUlvDsZ8/XLt+LujHtMT6U6pHT5Ja20m" +

  "1aC8fu0/lWPypQIMhQVAuCwTOQadnjQXCcMAU65Br2KWpDmRu/EErEGWOhfdc+R+LBQrkWjUfrzqgAlrSQWIqBPP0R1vHTeWsdGT" +

  "5Mws90uksWvtoXzTXn3KI+FPsRkEpHCLNGDuoUlpJ6VMC4DTNUqSg4GRb9wjSWQHd9KOAIlBmGhCN1O7pvMNImDVlZDBhAYn6hxo" +

  "PgJv0QkCKKKz7kSBid4rJk6KSXAMeh+FWVTMYgZZN9kio5YKJsRRjDyzONecF9fHL9t28b9784te+C/miT4L5MvHJlQ5pbOMpgDg" +

  "WUh+k3/ggQde+KePfO6nPndi7X89Plig9ZPLcYaImdC0YFBIEskz1yjCzrQ6wwDCiKr6yGeJc5omeQnkdEgNVrOoeU5nsxGCuFzZ" +

  "v5yLEMbr+Xgh9J1PWqrKWpG8WATbmYAAOmfNRZ4QOAMjaz/JvQE5DoAAE4y5zWznuvVv84gUQj61Z3JgY60Gk9SntUkZsZX2k1kr" +

  "CsW1Yz3pkgoyiuqmCcU7On7RF1z4ORyISAEOvd+dLrGkY/YASE+GwD6BrT9NuNN//M7HZOj3DJ/VMoGFJj/lhHs+6qrCPgGEIi4E" +

  "WTAbWLb2ecyTvq1uGahI4nD0mIj/RqwDkdJlYAOA28jt+szs4NzNM7h2bubd3/Hci3/+ZedckqL79+0b7Nq+vZ0G+T27aAoAnqXk" +

  "TwsAwH//1KdedfvBJ/7x51fWth/lAUZra7FJGm0wvpY0iCoda8VQkQWhPCCm5syQc3S1XAdrYfFOQDPJffb5/Lcytckyykdsd/or" +

  "mdRgmmFE1l4LPiud6B7Fkp6xPxueLR9FrgPvj1eNzkCDjJlq/M7X38t+1YQrvv8+AKD+7yIAUZIVyWgjnz9PDbEgPYaY2mMBxSaN" +

  "MVz7S4sGbCz8wPmb+spmJ+FdWHac3FZBCfix7gESYmHy1o+qCRv36BSgp3wm54AA2EI/CisM5zYDHt+Vc2wBjQ6EWEBiVuQnUAIY" +

  "RFT1L8HZNEsMIuKWuV0JNDhncQueNzdz/ysu2PLPvu/yK/7dOoBb9u0bbN+/P+7evXsa5PcspCkAeJbTEnO4Z+9e2rtzZzsA8Aef" +

  "+Mg33fHk0Z89OKZbnlxvEUdx3AAhBg6RGBH5GBYAsQSUlAFAyOZw95C3RBcyIYR013lCDM7qIALLAYwgZWSdK/1CMUqhWZIY7/YR" +

  "V65yFcTpI/H16vtahyi6tfxJDDvzziwIcsCi9sKyBvqBsmpYhJ4zcKg1oNAO9eijFzj+c28hKEVI9v0bpKoaw/VUFVQEEGqaY8Vu" +

  "Ah8664H9XPhOM9R0r5+W9eSo+0IrJh0gqddd6Wu9e4oAYFJfq0/MLeVdK+kyi+6Y6XFDbbMfe5K5LqP61UVSjETRlgTYXCpnEfY5" +

  "UYTcIkGSGYOpXSMebDlnEy5o1o9eMTv7Kz//4hvfRkTHsLQUlnbtwvRM/7ObpgBgSgAkwYccGxwA+M+f+MD3fPz46u4H28Hznjy5" +

  "inbUtkNiYqLQgtFQMN9lQSoAWDTQnhVWaIJ2BgoActChXiajWmt6I2RNUM25ydEqAiOA0aKMjtbobHfUy8lFyhUmcePRSccC4LoT" +

  "vKqr7cnoQAUYQ8+x15paSYUGyFxYJRRg+FMXproXlxll7Z9IzrY707QzwmTduooL0LnIDo9uG20IFE+JS8BbM7QvucweXZYIiAQK" +

  "yWjfZ4axEyX2qc5TD6pELKT9qQV/15qw0ZPEDOYWmgsiz1k1Vgzk+I9SiKfnJXjVo8neLImlbDa3go2rXQCJNuhJBvCg5TimQTO/" +

  "dRFb4+rJl557zr//+y988W8Q0QNAeTJoSs9umgKAKRW0Z8+eZufddzN2747MvPn/vPuOv/fxAwd/4rFm4XmHT64Do/W2SdFKgUWL" +

  "sVvkVLEjFeUlALBEK0aqFeV8e1l3DU6z1m+C+9sdCyTVfPJxQWXQBE1CxIYFIuWrfa1t1GRBKZ2o/fHlC1kZLW33TsqyiDAx6/ad" +

  "EsgjkVwFOathv8DUEwWpbu1r1/zc7yZQIKFR+uVBtVSAjB1FqaMq27srFHAwEEMa0yLwsgAA5eioVkzcAKEFuJEjm3lO9Xl/bLGw" +

  "ftiCYeTU1NmEfioAkAP/Ts0GU6IgwAeA5JiAdD+B5rtII9qaZaR77DDDm7IdZvOQ37sy2hL4ONdbwoGBI3OMFJr5rQu4sG2Xn7d1" +

  "8x9891UX/avL5y/6DDBN5jOlLk0BwJR6yacVZubNv3/PXd9/94HD/+BR4MrDy2O07bidZVAMCCoA9FpXdoLf/PGkEfIqFLgUPBUl" +

  "gawX7WpxCgLk88Ik7d71WqMwXjVNq1DzT2dNU8QipXbrMUSn2GvpFm2t7dKrllM/FdSQaY7wIAmlYLXxKIaDXWyAtjyalYKlb8kY" +

  "ohn6qjG0dqo7ghSdJTGtwqy2AIBM++zLsKdGm1C3N4SslWpriQDOeSCSEpt94dGEpNzEGEorhgdu2dqTx61sW7ZysN2LIPNjQaVl" +

  "girto5aV/xZRzA74SHpg4gxyqG8MYUtFyhNYKZYXSOAiTJgDMea1TNJXBT1FuTr3tqaJQWhbhMHclkVs43jimq3ze77j+Rf9+jVz" +

  "l94DTP38U5pMUwAwpYnEzLRr//5mt5wHZuZNv3/3Hd//sYPHf+IA4cojy+vAetsOAlEEAgeYAFRK/kgzT5oAq8/rW+rf/CZUGDP0" +

  "JjVkrY+9JsiWLU8ztOX4Nu5Vpn0thdtC35Hf3FP2u4/cVgUULGfeKQMEn90tyijkYMLyTHvgshYDLT3Wh2xJKbPZTepoFuJU1kqx" +

  "eKVMLsOl0LcgzxxTUUfaR+l7ECAUnbbcJ8jAmvMguMDFMsjTTlFofyvhr+uhz/Ihn1j95kwigOLksUqkmr2sItHiEyDQdSL1pQm3" +

  "LuY2qFavFgpZKAToEVN29RbvUTTgUwYNknW5YW7XmjBY3LQV28ZrK1efu2nv6y85/1duuPA5nwaSxn/d3XfzVPBPaRJNAcCUTknM" +

  "THuBoH5DZl78zx//6A984uTyjz3M4epjK6sYr45jkxh+iJT8lEnQq3ZUSviOBlxId8DyAyQVWpVr9whZEqDyDLgLQiMCYhmlUIsi" +

  "cv8qACDNO2/PkNe/E3+mICZ0ljPsKLIBamvk4Q6UqMVPEISUn1PrQz1O5RhlK4T3oXPxXHoWFphmkes95/2LGjhn9TNNO8uvCrA5" +

  "F4fWVfvpK9J5K3uXZ8iO26kmbCmDUwPM806xAAOuhkpYu3oEoIG7LdTjf2mNwS1NdoLevUUlVCT/iP9iAhBlZj8pyKf3M1BC/joy" +

  "KI6AwebNm3Au1k5eMTv8gzd8zfN+58ZLL/1rQAT/jh08DfCb0qloCgCmdNrUYxGYf/t9H//Bjx44+P0PrzcvOxGB8fJaHIbATNxw" +

  "cWVu0h5V4y6tBOp/F6FHkIArNm2XEe1iIBZQUZ/l7vi95TPLSMj9SVUsUY/kou9NCVsEt4kWWDmZPRBRl4O1T9/LTTPNMaAUXn1H" +

  "ykqtUs+m55+p9ZTyJZDXut0pCGl8aX3RcnoGxrd/wgPqBtD2tR44WZvzWCm4KjR119+y36kf6RNVh/N85Zr6jkbCzO4enNTdKDCD" +

  "WiTkbc1UqR+mkZN4ks7pBlem4hL7o//OBx8bmXNVwJ5XMEREaDjGNnLkZmawsGkOF/D42JVbNv+n7edv/e2vu+yq+wAV/Hfzbppq" +

  "/FM6PZqmAp7SaZMED40VCBDRCoDfZua3/sd7bv/G+w4d/8WHm+Erj8YB1peXeRAk3i6AUgS/pM01k6iep680V5+sxTg9WZpUCxo0" +

  "H/1GXB35GYtRcGZktcqaj9dr/vnfKhBAhHkUU64LdnQgQftgbznpH0xj1fOFxTj3/u5JP856v1gtrKIsfEv3gAgVFaYIaGOLCdV0" +

  "2sHFWGQqBVjnW5N0tck73ZUgFz8J6HMSObUxav0STFn4CJAsMIzSakOabEdGyEcWonjd6tKhI7IokyK2IrVN1q4unN5IQ5XqtghQ" +

  "IZZuOwTE6RHBVvpKAXE9Rg6Dpjl361w4t8VDL5yff/sPXXfFWxcWznsQEB//9u1x9zSyf0pPkaYWgCl90VS7BmZDwNs/f8/f/tjD" +

  "h3/2oZWV7Yd5gLWVNTTgcQA1oGTMZxE8XqfKyYGyxusF/CRBWFJtYCcDC/7bxMBFMHNm9LV9QM25tV85xRvko3mq5HntVQVQOoVQ" +

  "9qfuiwaoaTZCq7+yAqhgz9nv4PImuP45c322BsCVFU34Fn12QQ1mfQEswNHM0ZwNIoSyb5G6/YN7phgj5ION+Za/3BSlACoYVZ0u" +

  "ubF2iu7MLKAsCWizvjjw5yERINiP9NipO7Jp4+jHKac1LgvJM+RBGFkyZy776F8meZIZxJFBTVyJ4xDmZ+jiuXl8zbC5/7LN4bd/" +

  "9Nobf5+IjgJTjX9KXzpNAcCUviwkpwYiAB4AeMcX/vqVt3320e9/fBS/5/hgbu74ygqo5ZaIQUQNO6mVeS1PFPZ9JuhTg4KSQ2cA" +

  "QN1HChXdKpCjebkNRIRYWC1Ek9ZLaDTCG1me1i3vc1m0BAv4Iy+k7LkknAiNAIAJY+WBE4JdOiQ9gJrSzSXCtWBjJ6H82HlwUppY" +

  "iNxNkVU/+34vnqkEqAUQWj35aKTGlLSa+ya/lp4WAaxm/+y18acDcqhj0V6zLHE2FphLwB9JhYEKUNn+UuHvAobCWFCAL+kMEzOh" +

  "bRmDTQubsLVhXDTkv7rxovN/Z8cV1/wPIjoOTKP6p/TloykAmNKXlTwQAICHnnji6j9+7MEfvPvwoe8+OrN42bGVMUbLKzwM6fB3" +

  "BAh6uQpKplxmrvvSAIB/ciOfdt93PtrdMt5ZI0lOJopQdRFgfdbhSZYA1YBVPJUBdukbsCa6qVwGqbD0VOGqCKVZ3GuyZh1wueqj" +

  "AA0XgGbtcPET/ePujj26oan7rm30IIjENWNWhtQqG/fihICOT08L/Lz4OTMPvNRpx/r0CS7XSPdYoA5Y3eNyjios474IAEVE618+" +

  "UZGAHeIYxKEZNPObZrGVV1cumZn5o2+87Hn/6W9ddtk716Q903z9U/py0xQATOlpIWYOOyXFsPx97r//64++8TOHT3z3wTZsP0wB" +

  "J1fWQG07bsCBgeCzyOWIOc6a2AYCvzDTq6+/0pBPtdgD3PluzgmOau22cy5ezM35RIAKqyRQzchgaqj8Y23LWRVJzPMmyEwZd/fJ" +

  "ozql4ASVP+uf+u8gkA5tiC7Iju3dTN5UHQBue4GRjwsg9+ZGwGeSdYeIzJTvPwOqlLk2Yl0Q0CIPaeDcruQaSEkruArwjG4cvNU/" +

  "A7lOY9OPuh8aY5JU+24QKLNcrJX+JyCOOca2jU0zO09bN81gG8YPv/S88//bN1175W9dRnP36tDtYQ47gGkCnyl92WkKAKb0tNIS" +

  "c9i/f3+4TU4OzIaAd3/hc6951+fv3/ng8ug7locLlxxZW0dcXWU0IQZG0NPyoCZro4YLJgsSpfr8vA/Em+SH1zrYCZAsryffypba" +

  "k14mSz4TvDiBXdqCHPhm0iUERNHGGYzgfOnajlwO5CY/NeWX/VOBnzTM9NPSEjlTuEayd2MnY6GFa7XkxqzODVC8nzFG7xxNmjsV" +

  "wYF7nhHBqoDHMuA5gJbKqI4hIjM3C+hjvao3g0qNkVCApe2xuntoIymsAMBbK1jKSjmOQhwBRKEJs4uz2MSMywezH3zpxdt+/3+6" +

  "8sr/QkRHgOTf3wFg5/Rq3ik9jTQFAFP6ipA7QthCdeAjD573f9z/hZ33Lq//0GPjeMMxIqwsryFEbhtmisTJKgBygnMCeSGPUiM1" +

  "U7YKEgvSq1wD8nydJlh9/hNBR5HrPpSuDBHIyV/MyEWQvccaCOHqjeL3LwGAideOOb1ojovIT0cDtacioUPslWIaOJhjAStzu8UW" +

  "aJdqQT453fHEY43u+j/9qI6ByMAlP66uiWyFSEAh9TXVEQR4FfkkI1sMXwIBvsPVJPixPE1K4xbzGDGBOcaWQoygwfziAhZCwFYe" +

  "f+HiuZk/eM1VF//pt1z8/Pcvj8YApmf4p/SVpekxwCl9RUiPEAIpTuCtd99NdM7lhwH8HjP/+//xwD03fPTJJ3/oYQ7fdjTytqOj" +

  "MUbr6xgGGgcgjDkGMbb3CpPkU7W6XM2cJZaT+LECAezcDDkiXYTPBoKt00/917syTBNk07DzkT3vFvB96QtV6wqoSRH3rvd5vOxq" +

  "hWBtAnQcM2jIjolSC/duGdVsNSRBAYEPFrSLgtAVpEV2QsMmOeETQczzhcUkIFhgXlmWjk5hzFfQkO0Sdj1FEV9CeQzq/AQuetDq" +

  "sHF1bYhuvuQ7jow2MgaD2YUwPzMIW0N7cusg7n3heRf+0Q9dffV7NZofKPz7U41/Sl8xmloApvRVozqxkHx2wds+8pFvfGDt5I89" +

  "vDZ+xdEwwMraCKPRiAdE7SDJpQCQ5MoHAAYFd57ehGz6s2EfZOesBD4+QE3NBaiIpgFbfEKfGbvI6CJiSJvj3kvCMRoAyMchrRVQ" +

  "bbeF3DUfuRJO0r4y20w9sE5wUfFx6lsy9xMRYszCvw62VD86/JigFIJfzFW71lsi2CU+wZ1IKCoREz1aBCIX3NctS8dJcuRDMzWm" +

  "UU7zMAbn2I6JoEQTR6EYjxJW+pgBltshIwMhxhgJg2GYX5jFYlzHhWH44YtnNv+7737FC/7sMlp4SMu4Zd++wf7t2yOFECe5G6Y0" +

  "paeTpgBgSl91YmbaBdA9LmhwYTjEB488cuOf/vWnv/nBY6vffqhtv/bkYAbLa+ug9TE3gVsChcDpQHzsCFyY9jmQtOqqERrJsxtv" +

  "gixwk7bofcfVBuJgGqUJZgMHnG6+k88llZE2JIEDClCXRxIq2ezfiQUg97eQPpOD5iqLgTfh29tSHuCEpscV8reo5hFcuFM02O1L" +

  "IkmGRDJUWSNXwa5WAbnKhxU8nV7dPi+DuysSLWrgJoJdkjuxD/8sTg5IiiEWWw9RHMUWPBg283NzWIxjXNg0n79kfv4/v/hrzv2v" +

  "Oy5/wUdXxqLYpxv5MA3qm9IzgaYAYErPKGJm2rt3b/DBT8wc/uTee1/50SOHv/nA2vq3Prk6uvbE3CzGq2PE1TVuArVj4oAQAkWV" +

  "Ftl/XZh8XYS9/o2eEwP++14/sIKHwiJATpAgRX1b3SLIQ+PakrEKvOtBhZ4JH92oXlvvUlDhKe0gUvHNSdMWIRu1KK/FAibycjKd" +

  "lJhGrR61xt8Xe6BBiH1UjqW7u4AoWTRIFWEu3iGgiP8oLoiqyp4UG6HJlqx1zHZqQKFcN8Ax6fmR2YBPSJabSIw4Bqilplmcm8WW" +

  "psHs6uqhixcX/vLqTQv/+e9df/27iGhZy5se4ZvSM5GmAGBKz1hi5rDdnSCQzwb/72fuevldB49/y6H19psPrI9esjIzh5Nrq+DR" +

  "Os9EtEQNMTgQQKaxQ4RGBQCADBBqgaFn1CcCAPdu+iibtOvnkhRX3Zo6zyQFW686RhLgnZZa41DK2QwKet9QMzuy9gwNDDTzNVu6" +

  "mzIGwfWfUJyGMA28tqyckihH5CMbSdLN0QICassCsyQ1yiAkAQOWlgAab6FtrueTbdCSMFerUDE2KIEKC0KLQGTmyKBBMzPEcHYG" +

  "i2Bsbfjg1yzMvPeqhXP+63dd/YI/I6KDWqdL0TsN6JvSM5KmAGBKz3xipj1794a3XnABeTAwPxjg//rYh19+z/ro2x9fXv7Ww+u4" +

  "bnU4h/X1NayvriEw2pAc6RRzQr9+bREAhZBS67rn5AHkILgcPOjal/zpHBHsXoBafOtWk2tmQcgX3ISu1r8R6fW4PcpkEmyV8ENy" +

  "YZiGz5olL9hnqu331a7yP1IGOpy6As1h7zmJatjcc9LCtUh+Dfmzqj+dYE9k0MHQZEEm/lFbDjxuU2tL6keOb4jqxpA5jroWQDEF" +

  "8INbwiAMh5iZm8Xiyjq2Nu3dW8+due2mzRf85RuvuuY9geigVbVnT7MHwI4dO6Ym/ik942kKAKZ0RpG6CO6+4ALaXYGBP/nMJ274" +

  "+ONHv+nB5RO3Hg30quUwM7PcAmvr6+D1EQeilgIoRCc3RBNUH7OPYNe/VbtUseWjw2shBaBPHCEEb0kQKwAx0o2J+Qx8b5+plI3+" +

  "etyc2BZmtlcAwE5rBhM4cDoBSEnop8T9cFkHcyV9Vo9kQs8peFKcQrSBTJfydO9BUMDheuCsJumSKOoBAH1EyKcT6lwJ5TVPitv8" +

  "bOixQHFnuBMFzJFjCDGp+dw0gwEN52awMBxiYeUkX7Rpy10XDmf/9EVbN//htz3/+R9fdUARS0thz65dNPXrT+lMoykAmNKZTLRj" +

  "z57wRGUZaADcdfQL17z/sQO3PHxidOtjx5dvPBLjNSuzc1hbH2F9bQ00jnEYki7NzCEQkb82uCOMGSbQWkQLSAP6feGdhmqMgHmc" +

  "NaAwZ49LxWTtmCgYOMltUDkZN9y92oageQlKk4UExIlQNHdDDgEUGGQJ8SzBkYEfEeBirlfhy8gpfLU7Sct2pnUBPRksSPhhEVMB" +

  "awfBa/B6jZRaNiAuCB8bQWaBAAEUWbEOzFoRI4MQY2QeA4FCCMO5OczNDDHfrmNraB7aNjf86EVbZt5z47Zt73zNBVd80gv9W/bt" +

  "G7x5+3aeCv0pnck0BQBTOluI5Fhh2H3r9tark8w88yePfvrrP3nw2GseO3riG46P11++EuYWVkKDk+troNV1AGgJzBSIAnMKx/e+" +

  "YHICTYQZRef7FwpqRu6JHTBtl1SQi4ZM0XzpudUB3lXRSWvMqvGWfm49vui16TqxEZypP2qdPfVY36X/+l06nMB2zt8VbP/qWBlU" +

  "0HCD4ECEO5dYM6LUhwyYPCjzz+pFQQoaatO/ohIO4vsAeAw0oECzc/NYnBliph1h0zgubwrhI5duHr7r2gsvfNfrL7vinkB0zBc1" +

  "9elP6WyjKQCY0llJS8wB+/eH3QcOMNyJggDgwKEvPOfPDx6+6VMnjt50eDW+9uiJ9Zeuzs7MrYWA9fUxxuvrIOa2ScEBRMyBiSgG" +

  "Mo3Ya5PeHU+ozpeTfy6Ipk/2XTr2F+3Rwm3AejCPrBzVsgkqrPX8PJnQ1VS3/pijPg9XRxSt3fpUNsCeVQAABwAKzd613TOUWCAA" +

  "ab+CC2jF/Uf5yFwH5cl/EktMS1yCMGgqX8IY4AERx8hR0iwPaNhgODvEfDNEM17HYhidOC+E28/fvPm2a7ac+/FXXnTp7ecvLDxU" +

  "dH9pKSxt3x4wFfpTOktpCgCmdNZTETewf3+Eu0Z1BoSPPHTvZbc/fuzlB4FbHx+tvfzJleWXrDVzi8sA1mLEaHUdbYwgxHZIKZVP" +

  "YA7kVFcvYNMH/kw9uUNvei9AhI8rMC3dTgTArhhWi0GS7eL718h+s4OnslMbogERf4yOncbtz/9PHDdUUf8uKJLlZzbVZ6BBnAIG" +

  "a8ODuRDSKyawfZCfWVoiA0ET+iC/I6AowjJCcQQ4pAHFOiIhhGYQGszOzGBxZoDB6nFsacLDm+aHd16wsPVdV84OP/YtV7/w3obo" +

  "sUKqi8B/0YEDPA3im9KzgaYAYErPOlpaWgov2rWL3rp/P93m7iYAgNlAONTGS/7kvvu+/rETR77+yRFedODEiVccRbsNcwtYHrVY" +

  "JWC0tg60LYjRDtLdg0lOx0gIgcznbH5vn+GesuZOElbnRI0eVwsIKdCNNdo9iTsitWl7IRqTwGQgX/bDXfM/nC9e63PmdX80LpXh" +

  "3ytjCQrNPBVkD0Z5v6rZxT6w9NlbBHI5hbFfgUeMjBASLgFhHJkGRA0NBpibm8GAGZtDgxkeHzsn0GObm+aOi7duftdLLtj8sRsv" +

  "eO59RHSiaI4K/O3b+e5du3i3A4ZTmtKzgaYAYErPelJAsHfvXuzduTNJTyHRpLe+57HPvuDTh08+99Cxk99wsB1fsTpuX3p0ff2i" +

  "9flFrHHEOLZYW1kDMzBuxzE0DQcGBzACU2BTj8lfGAfmkM3XetQQ0oJAoqUzCAGU1F6JXtfMeangfM7dCVFm64qZ+yHeAXnQKeQm" +

  "hKUaC/5LTeuJaUC2VnhZ73X/Iq0uuXLcOwYGEhhiaEZippiAFFELpsFgGEABC/NJ2C8MAmaX10abB83DmxbCBxZivPN5m7fe++3X" +

  "Xf9BAIeJaFQ0eM+eZumCC2iq4U9pSommAGBKU6qImWkvEN66fz/dVrkMgHTKYMy88OEH77/uE8dOXPLkysm/+djK6teMW9x0ZHVt" +

  "c7O4eM7xcUQcDtDGgJW1VSAAcdyibdvYhIDAHAlAQ3LHETPATCGdFwSQbgTMvvcmgRFk7TnF4AkA0AyIQHbcoxWzOZspP+XEVyHt" +

  "EAMrPsnpcjN8KMame+pBYw5Ub9cARcoZBAPg3SJRjgYmM0UEIii0qYTQzAxBRJifmcGgCRiMx1gMwHDUPnruYHB4dgbvv2B27nOX" +

  "XLjtjhvOOedzV2w+/wEiWqvn8ZalpcH27duxa/v2CICnAn9KUyppCgCmNKVTkI8h2A+gDxTIc8OTBz5//sfW+AUf+exnti5u2fra" +

  "Tx88PDMzP3PLwZW1mfUWFw0WNm06vroOzM+iRcC4jVhbX8MgNMC4xfpoxCEEUeo5BsjlNUQUwURETJGJ0m80FkhAYidQldxOu6sw" +

  "BuBV/myBkPBB4QSBNeFPPgqYHQ3Wz8w4khkCCWOI8UT9GyyugBCIIocWjMjAcG6GWo4ABSzOJiHfjtaw2AwxWFmPY1594NLNC7y6" +

  "Nn7vVRecf5xGo3d/7bZzD99y+TUfA3CyT5CrsH+RHM1LTZsK/ClNaSOaAoApTemLIAUF2LEDd+/fT7v/zb9h7N3be5XrwnCAk+sj" +

  "Wll58jmfOLZ+6fvuvjOcf9621z56YnXTwZWVczYvLL76seWTWOd47vymLZccW17DOgFhYR4xElqOWF0fWTR+YMba2iqoZUBuQbTT" +

  "/sytCm4190PeAUiO/am1IAfYlfcAprdJThnotbwJOzACQiDiwCC0sUXkFoOZWQwGQ8sqODs7wKBpMEQAj9cQ10eYHwwwOyCsrY/u" +

  "P2/zprUtAYdOLq+8/4UXXoiVlRPvedHlVx6+dvPi8YtnNt0DTBbgS/v2DQDgRdu3890A75pq91Oa0hdFUwAwpSl9mYg5eeH3AgF7" +

  "98IsBi5JUR/NNgFtGzHiJ8/53PrwynfeeSePmrlztywsvOrhw0fC4ydPzpx/7tbXrI3bxcMrK7w6isPFuZlr2ibMrozGWI8Ra22L" +

  "GALmFzeDCRjFFpFTEF/UBDYkrgKkxDjMWfPXI4TkAvjS9btsWRIbAgYAxuvraNfXMEMB84MBFgYDrKyuPTgAH9y2uIm2DJvRoRMn" +

  "PjC/ODz8wosvI145/vnHjh2+88VXXkHP37rAV8xcePdc04xijBj1jIeSafUHDjB2ADuwI0qsxFTYT2lKXwaaAoApTekrQ7TES/Si" +

  "vS+ivQCuu+ACAoD9+/fjtt27NwQIQIo7SDEA6fd15isOAfOfPPQonjhxmD576CBvC4vnXXz+tptWOM4eW1nhtdV1WhmPsDIaY3U8" +

  "xmg8Rhy3GCMithFJAAcJ+kv/DkNAaAJmBg2Gg4CFwQDzswMszMzzpuGAtswEHo1H9z925Minz988O75y2yV03bbn8mbgoYbohGZH" +

  "PGWHdEz27WuwHXjR3gMMADt27PDa/FTQT2lKU5rSlM5+YmZi5rDEHHbs2dMsMQ+W9u0b3JJM3pIBl5/JoF0PGtAtS0uDpX37Bvuk" +

  "D0vMgeV/8DO6D1Oa0rOGphtxSlM6A2mJOewCsMt9ds/evfSjOy4gYDv2Yz+w/8tc6XZgO4ADSL53/VjaMPXDT2lKU5rSlKY0pSlN" +

  "aUrPdPr/ATbMoIW+WU2+AAAAAElFTkSuQmCC" ;
function pngResponse(b64: string): Response {
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  return new Response(bytes, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } });
}
app.get('/icon-192.png', () => pngResponse(ICON_192_B64));
app.get('/icon-512.png', () => pngResponse(ICON_512_B64));
app.get('/manifest.webmanifest', (c) => c.json({
  id: '/',
  name: '财经资讯站',
  short_name: '财经资讯',
  description: '财经资讯站',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#ffffff',
  theme_color: '#10b981',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}));
app.get('/sw.js', (c) => new Response(`const CACHE='pwa-v1';
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png']);
    self.skipWaiting();
  })());
});
self.addEventListener('activate', (e) => { e.waitUntil(clients.claim()); });
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (e.request.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(e.request);
        const cache = await caches.open(CACHE);
        cache.put('/', res.clone());
        return res;
      } catch {
        const cache = await caches.open(CACHE);
        return (await cache.match('/')) || new Response('Offline', { status: 503 });
      }
    })());
    return;
  }
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(e.request);
    const fetchPromise = fetch(e.request).then((res) => {
      if (res.ok && (url.pathname.startsWith('/icon-'))) cache.put(e.request, res.clone());
      return res;
    }).catch(() => cached);
    return cached || fetchPromise;
  })());
});`, { headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' } }));

// Public site info (favicon etc. for static admin page)
app.get('/api/site', async (c) => {
  const [siteName, favicon, logo] = await Promise.all([
    getSetting(c.env.DB, 'site_name', '财经资讯站'),
    getSetting(c.env.DB, 'site_favicon', ''),
    getSetting(c.env.DB, 'site_logo', ''),
  ]);
  return json({ site_name: siteName, favicon, logo });
});

// Browser favicon request → redirect to the uploaded favicon (covers the static
// admin page and browsers that auto-request /favicon.ico without JS).
app.get('/favicon.ico', async (c) => {
  const favicon = await getSetting(c.env.DB, 'site_favicon', '');
  if (!favicon) return c.notFound();
  return c.redirect(favicon, 302);
});

// ---------------------------------------------------------------------------
// Invite API
// ---------------------------------------------------------------------------

app.get('/api/invite', async (c) => {
  const token = await currentUser(c.env, c.req.raw);
  if (!token) return json({ error: 'unauthorized' }, 401);
  const user = await first<{ id: number; invite_code: string }>(c.env.DB, 'SELECT id, invite_code FROM users WHERE id = ?', [token.uid]);
  const count = await first<{ n: number }>(c.env.DB, 'SELECT COUNT(*) AS n FROM invite_tracking WHERE inviter_id = ?', [token.uid]);
  return json({
    invite_code: user?.invite_code,
    invite_url: `${SITE_URL}/?ref=${user?.invite_code}`,
    invited_count: count?.n ?? 0,
  });
});

// ---------------------------------------------------------------------------
// Payment API
// ---------------------------------------------------------------------------

app.post('/api/order', async (c) => {
  const token = await currentUser(c.env, c.req.raw);
  if (!token) return json({ error: '请先登录' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const plan = String(body.plan || 'monthly');
  const method = String(body.method || 'usdt'); // alipay | wxpay | usdt | stripe

  const payMethods = await getSetting(c.env.DB, 'pay_methods', 'alipay,wxpay,usdt');
  const enabledMethods = payMethods.split(',').map((s) => s.trim()).filter(Boolean);
  if (!enabledMethods.includes(method)) return json({ error: '该支付方式未开通' }, 400);

  // map internal method key -> gateway type (e.g. stripe -> fiatstripe)
  const gatewayType = methodType(method);

  const planRow = await getPlanByKey(c.env.DB, plan);
  if (!planRow) return json({ error: '无效方案' }, 400);
  const money = String(planRow.price);
  const label = planRow.name;
  const currency = planRow.currency || (await getSetting(c.env.DB, 'currency', 'USD'));
  const siteName = await getSetting(c.env.DB, 'site_name', '财经资讯站');

  const cfg = await readEpayConfig(c.env);
  if (!cfg.apiUrl || !cfg.pid || !cfg.key) return json({ error: '支付网关未配置' }, 500);

  const orderNo = 'FOP' + Date.now() + randHex(6).slice(0, 6);
  await run(
    c.env.DB,
    'INSERT INTO payment_orders (order_no, user_id, amount, currency, plan, payment_method, status) VALUES (?, ?, ?, ?, ?, ?, \'pending\')',
    [orderNo, token.uid, money, currency, plan, method]
  );

  const base = siteBase(c.env);
  const params = buildOrderParams(cfg, {
    type: gatewayType,
    outTradeNo: orderNo,
    notifyUrl: `${base}/api/payment/callback`,
    returnUrl: `${base}/api/payment/return?order_no=${orderNo}`,
    name: `${siteName} ${label}`,
    money,
  });

  return json({ submit_url: normalizeApiUrl(cfg.apiUrl), params });
});

// 文章下单（单独购买）
app.post('/api/article/order', async (c) => {
  const token = await currentUser(c.env, c.req.raw);
  if (!token) return json({ error: '请先登录' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const articleId = Number(body.article_id);
  const method = String(body.method || 'usdt');
  if (!articleId) return json({ error: '无效文章' }, 400);
  const a = await first<{ id: number; title: string; price: number; access_type: string }>(
    c.env.DB, "SELECT id, title, price, access_type FROM articles WHERE id = ? AND status = 'published'", [articleId]
  );
  if (!a) return json({ error: '文章不存在或未发布' }, 404);
  if (a.access_type !== 'paid' || !(a.price > 0)) return json({ error: '该文章无需单独购买' }, 400);
  const owned = await first(c.env.DB, "SELECT id FROM article_purchases WHERE article_id = ? AND user_id = ? AND status = 'paid'", [articleId, token.uid]);
  if (owned) return json({ error: '您已购买该文章' }, 400);
  const member = await first<{ membership_tier: string; membership_expires_at: string | null }>(c.env.DB, 'SELECT membership_tier, membership_expires_at FROM users WHERE id = ?', [token.uid]);
  if (hasActiveMembership(member)) return json({ error: '您是会员，可直接阅读' }, 400);

  const payMethods = await getSetting(c.env.DB, 'pay_methods', 'alipay,wxpay,usdt');
  const enabledMethods = payMethods.split(',').map((s) => s.trim()).filter(Boolean);
  if (!enabledMethods.includes(method)) return json({ error: '该支付方式未开通' }, 400);
  const gatewayType = methodType(method);
  const cfg = await readEpayConfig(c.env);
  if (!cfg.apiUrl || !cfg.pid || !cfg.key) return json({ error: '支付网关未配置' }, 500);
  const orderNo = 'FAR' + Date.now() + randHex(6).slice(0, 6);
  await run(c.env.DB, "INSERT INTO payment_orders (order_no, user_id, amount, currency, plan, payment_method, status, item_id, item_type) VALUES (?, ?, ?, 'USD', ?, ?, 'pending', ?, 'article')", [orderNo, token.uid, a.price, '购买文章', method, articleId]);
  const base = siteBase(c.env);
  const params = buildOrderParams(cfg, { type: gatewayType, outTradeNo: orderNo, notifyUrl: `${base}/api/payment/callback`, returnUrl: `${base}/api/payment/return?order_no=${orderNo}`, name: a.title, money: String(a.price) });
  return json({ submit_url: normalizeApiUrl(cfg.apiUrl), params });
});

// 课程下单
app.post('/api/course/order', async (c) => {
  const token = await currentUser(c.env, c.req.raw);
  if (!token) return json({ error: '请先登录' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const courseId = Number(body.course_id);
  const method = String(body.method || 'usdt');
  if (!courseId) return json({ error: '无效课程' }, 400);

  const course = await first<{ id: number; title: string; price: number; access_type: string }>(
    c.env.DB, 'SELECT id, title, price, access_type FROM courses WHERE id = ? AND status = 1', [courseId]
  );
  if (!course) return json({ error: '课程不存在或未发布' }, 404);
  if (course.access_type !== 'paid' || !(course.price > 0)) return json({ error: '该课程免费，无需购买' }, 400);
  const owned = await first(c.env.DB, "SELECT id FROM course_purchases WHERE course_id = ? AND user_id = ? AND status = 'paid'", [courseId, token.uid]);
  if (owned) return json({ error: '您已购买该课程' }, 400);
  const member = await first<{ membership_tier: string; membership_expires_at: string | null }>(c.env.DB, 'SELECT membership_tier, membership_expires_at FROM users WHERE id = ?', [token.uid]);
  if (hasActiveMembership(member)) return json({ error: '您是会员，可直接观看该课程' }, 400);

  const payMethods = await getSetting(c.env.DB, 'pay_methods', 'alipay,wxpay,usdt');
  const enabledMethods = payMethods.split(',').map((s) => s.trim()).filter(Boolean);
  if (!enabledMethods.includes(method)) return json({ error: '该支付方式未开通' }, 400);
  const gatewayType = methodType(method);
  const cfg = await readEpayConfig(c.env);
  if (!cfg.apiUrl || !cfg.pid || !cfg.key) return json({ error: '支付网关未配置' }, 500);

  const orderNo = 'FCO' + Date.now() + randHex(6).slice(0, 6);
  await run(c.env.DB, "INSERT INTO payment_orders (order_no, user_id, amount, currency, plan, payment_method, status, item_id, item_type) VALUES (?, ?, ?, 'USD', ?, ?, 'pending', ?, 'course')", [orderNo, token.uid, course.price, '购买课程', method, courseId]);

  const base = siteBase(c.env);
  const params = buildOrderParams(cfg, { type: gatewayType, outTradeNo: orderNo, notifyUrl: `${base}/api/payment/callback`, returnUrl: `${base}/api/payment/return?order_no=${orderNo}`, name: course.title, money: String(course.price) });
  return json({ submit_url: normalizeApiUrl(cfg.apiUrl), params });
});

// ---- 头像上传 ----
app.post('/api/account/avatar', async (c) => {
  const token = await currentUser(c.env, c.req.raw);
  if (!token) return json({ error: '请先登录' }, 401);
  const form = await c.req.parseBody().catch(() => ({}));
  const file = (form as Record<string, unknown>)['file'] as File | undefined;
  if (!file) return json({ error: '未收到文件' }, 400);
  const name = file.name || 'avatar';
  const extMatch = name.match(/\.([a-zA-Z0-9]+)$/);
  const ext = extMatch ? extMatch[1].toLowerCase() : 'png';
  const allowed = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
  if (!allowed.includes(ext)) return json({ error: '仅支持 jpg/png/gif/webp 图片' }, 400);
  const key = `avatars/${token.uid}-${Date.now()}-${randHex(4)}.${ext}`;
  await c.env.MEDIA.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || 'image/png' },
  });
  const url = `/media/${key}`;
  await run(c.env.DB, 'UPDATE users SET avatar = ? WHERE id = ?', [url, token.uid]);
  return json({ ok: true, url });
});

// ---- 收货地址簿 ----
app.get('/api/account/addresses', async (c) => {
  const token = await currentUser(c.env, c.req.raw);
  if (!token) return json({ error: '请先登录' }, 401);
  const rows = await query<any>(c.env.DB, 'SELECT * FROM user_addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC', [token.uid]);
  return json({ addresses: rows });
});
app.post('/api/account/addresses', async (c) => {
  const token = await currentUser(c.env, c.req.raw);
  if (!token) return json({ error: '请先登录' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name || '').trim();
  const phone = String(body.phone || '').trim();
  const detail = String(body.detail || '').trim();
  if (!name || !phone || !detail) return json({ error: '请填写收货人、电话和详细地址' }, 400);
  const count = await first<{ c: number }>(c.env.DB, 'SELECT COUNT(*) AS c FROM user_addresses WHERE user_id = ?', [token.uid]);
  const isDefault = body.is_default ? 1 : (count?.c === 0 ? 1 : 0);
  if (isDefault) await run(c.env.DB, 'UPDATE user_addresses SET is_default = 0 WHERE user_id = ?', [token.uid]);
  const r = await run(c.env.DB, 'INSERT INTO user_addresses (user_id, name, phone, country, province, city, detail, zip, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [token.uid, name, phone, String(body.country || ''), String(body.province || ''), String(body.city || ''), detail, String(body.zip || ''), isDefault]);
  return json({ ok: true, id: (r.meta as any).last_row_id });
});
app.put('/api/account/addresses/:id', async (c) => {
  const token = await currentUser(c.env, c.req.raw);
  if (!token) return json({ error: '请先登录' }, 401);
  const id = parseInt(c.req.param('id'), 10);
  const existing = await first<any>(c.env.DB, 'SELECT * FROM user_addresses WHERE id = ? AND user_id = ?', [id, token.uid]);
  if (!existing) return json({ error: '地址不存在' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name ?? existing.name).trim();
  const phone = String(body.phone ?? existing.phone).trim();
  const detail = String(body.detail ?? existing.detail).trim();
  const isDefault = body.is_default ? 1 : existing.is_default;
  if (isDefault) await run(c.env.DB, 'UPDATE user_addresses SET is_default = 0 WHERE user_id = ?', [token.uid]);
  await run(c.env.DB, "UPDATE user_addresses SET name=?, phone=?, country=?, province=?, city=?, detail=?, zip=?, is_default=?, updated_at=datetime('now') WHERE id=?", [name, phone, String(body.country ?? existing.country), String(body.province ?? existing.province), String(body.city ?? existing.city), detail, String(body.zip ?? existing.zip), isDefault, id]);
  return json({ ok: true });
});
app.put('/api/account/addresses/:id/default', async (c) => {
  const token = await currentUser(c.env, c.req.raw);
  if (!token) return json({ error: '请先登录' }, 401);
  const id = parseInt(c.req.param('id'), 10);
  const existing = await first<any>(c.env.DB, 'SELECT id FROM user_addresses WHERE id = ? AND user_id = ?', [id, token.uid]);
  if (!existing) return json({ error: '地址不存在' }, 404);
  await run(c.env.DB, 'UPDATE user_addresses SET is_default = 0 WHERE user_id = ?', [token.uid]);
  await run(c.env.DB, 'UPDATE user_addresses SET is_default = 1 WHERE id = ?', [id]);
  return json({ ok: true });
});
app.delete('/api/account/addresses/:id', async (c) => {
  const token = await currentUser(c.env, c.req.raw);
  if (!token) return json({ error: '请先登录' }, 401);
  const id = parseInt(c.req.param('id'), 10);
  await run(c.env.DB, 'DELETE FROM user_addresses WHERE id = ? AND user_id = ?', [id, token.uid]);
  return json({ ok: true });
});

// 商品下单（实物需收货地址，虚拟直接下单）
app.post('/api/product/order', async (c) => {
  const token = await currentUser(c.env, c.req.raw);
  if (!token) return json({ error: '请先登录' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const productId = Number(body.product_id);
  const method = String(body.method || 'usdt');
  const quantity = Math.max(1, Number(body.quantity) || 1);
  if (!productId) return json({ error: '无效商品' }, 400);

  const product = await first<any>(c.env.DB, 'SELECT * FROM products WHERE id = ? AND status = 1', [productId]);
  if (!product) return json({ error: '商品不存在或已下架' }, 404);
  const price = product.sale_price > 0 ? product.sale_price : product.price;
  if (!(price > 0)) return json({ error: '该商品免费，无需购买' }, 400);
  const owned = product.type === 'virtual'
    ? await first(c.env.DB, "SELECT id FROM product_orders WHERE product_id = ? AND user_id = ? AND status IN ('paid','shipped','completed')", [productId, token.uid])
    : null;
  if (owned) return json({ error: '您已购买该商品' }, 400);

  // 会员状态 + VIP 权限配置
  const member = await first<{ membership_tier: string; membership_expires_at: string | null }>(c.env.DB, 'SELECT membership_tier, membership_expires_at FROM users WHERE id = ?', [token.uid]);
  const isVip = token.role === 'admin' || hasActiveMembership(member);
  const vipVirtualOpen = (await getSetting(c.env.DB, 'vip_virtual_access', '0')) !== '0';
  const vipDiscount = parseInt(await getSetting(c.env.DB, 'vip_product_discount', '100')) || 100;

  // 虚拟商品：VIP 免费获取
  if (product.type === 'virtual' && isVip && vipVirtualOpen) {
    const freeOrderNo = 'FPO' + Date.now() + randHex(6).slice(0, 6);
    await run(c.env.DB, "INSERT INTO product_orders (order_no, user_id, product_id, product_name, product_image, product_type, quantity, unit_price, total_amount, status, payment_method) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 'paid', 'vip')", [freeOrderNo, token.uid, product.id, product.name, product.cover, product.type, quantity]);
    return json({ free: true });
  }

  // 实物：库存 + 地址校验
  let addr = { name: '', phone: '', country: '', province: '', city: '', detail: '', zip: '' };
  if (product.type === 'physical') {
    if (product.stock <= 0 || quantity > product.stock) return json({ error: '库存不足' }, 400);
    if (body.address_id) {
      const saved = await first<any>(c.env.DB, 'SELECT * FROM user_addresses WHERE id = ? AND user_id = ?', [Number(body.address_id), token.uid]);
      if (!saved) return json({ error: '收货地址不存在' }, 400);
      addr = { name: saved.name, phone: saved.phone, country: saved.country || '', province: saved.province || '', city: saved.city || '', detail: saved.detail, zip: saved.zip || '' };
    } else {
      addr.name = String(body.name || '').trim();
      addr.phone = String(body.phone || '').trim();
      addr.country = String(body.country || '').trim();
      addr.province = String(body.province || '').trim();
      addr.city = String(body.city || '').trim();
      addr.detail = String(body.address || '').trim();
      addr.zip = String(body.zip || '').trim();
    }
    if (!addr.name || !addr.phone || !addr.detail) return json({ error: '请填写收货人、电话和详细地址' }, 400);
  }

  const payMethods = await getSetting(c.env.DB, 'pay_methods', 'alipay,wxpay,usdt');
  const enabledMethods = payMethods.split(',').map((s) => s.trim()).filter(Boolean);
  if (!enabledMethods.includes(method)) return json({ error: '该支付方式未开通' }, 400);
  const gatewayType = methodType(method);
  const cfg = await readEpayConfig(c.env);
  if (!cfg.apiUrl || !cfg.pid || !cfg.key) return json({ error: '支付网关未配置' }, 500);

  const unitPrice = (isVip && vipDiscount < 100 && vipDiscount > 0) ? Math.round(price * vipDiscount) / 100 : price;
  const total = Math.round(unitPrice * quantity * 100) / 100;
  const orderNo = 'FPO' + Date.now() + randHex(6).slice(0, 6);
  await run(c.env.DB, "INSERT INTO product_orders (order_no, user_id, product_id, product_name, product_image, product_type, quantity, unit_price, total_amount, status, payment_method, address_name, address_phone, address_country, address_province, address_city, address_detail, address_zip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)", [orderNo, token.uid, product.id, product.name, product.cover, product.type, quantity, unitPrice, total, method, addr.name, addr.phone, addr.country, addr.province, addr.city, addr.detail, addr.zip]);
  await run(c.env.DB, "INSERT INTO payment_orders (order_no, user_id, amount, currency, plan, payment_method, status, item_id, item_type) VALUES (?, ?, ?, 'USD', ?, ?, 'pending', ?, 'product')", [orderNo, token.uid, total, '购买商品', method, product.id]);
  if (product.type === 'physical') {
    await run(c.env.DB, 'UPDATE products SET stock = stock - ? WHERE id = ?', [quantity, product.id]);
  }

  const base = siteBase(c.env);
  const params = buildOrderParams(cfg, { type: gatewayType, outTradeNo: orderNo, notifyUrl: `${base}/api/payment/callback`, returnUrl: `${base}/api/payment/return?order_no=${orderNo}`, name: product.name, money: String(total) });
  return json({ submit_url: normalizeApiUrl(cfg.apiUrl), params });
});

// 绑定提现账户
app.put('/api/account/withdraw-accounts', async (c) => {
  const token = await currentUser(c.env, c.req.raw);
  if (!token) return json({ error: '请先登录' }, 401);
  const body = await c.req.json().catch(() => ({}));
  await run(c.env.DB, "UPDATE users SET withdraw_name = ?, withdraw_wechat = ?, withdraw_alipay = ?, updated_at = datetime('now') WHERE id = ?", [
    String(body.withdraw_name || '').slice(0, 50),
    String(body.withdraw_wechat || '').slice(0, 100),
    String(body.withdraw_alipay || '').slice(0, 100),
    token.uid,
  ]);
  return json({ ok: true });
});

// 提交提现申请
app.post('/api/withdraw', async (c) => {
  const token = await currentUser(c.env, c.req.raw);
  if (!token) return json({ error: '请先登录' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const method = String(body.method || 'wechat');
  if (method !== 'wechat' && method !== 'alipay') return json({ error: '无效的提现方式' }, 400);
  const amount = parseFloat(String(body.amount || '0'));
  if (!amount || amount <= 0) return json({ error: '请输入有效的提现金额' }, 400);

  const u = await first<any>(c.env.DB, 'SELECT withdraw_name, withdraw_wechat, withdraw_alipay FROM users WHERE id = ?', [token.uid]);
  if (!u) return json({ error: '用户不存在' }, 404);
  const account = method === 'wechat' ? u.withdraw_wechat : u.withdraw_alipay;
  if (!account) return json({ error: '请先绑定提现账户' }, 400);

  const [earnedRow, paidRow, pendingRow] = await Promise.all([
    first<{ s: number }>(c.env.DB, 'SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) AS s FROM commissions WHERE inviter_id = ?', [token.uid]),
    first<{ s: number }>(c.env.DB, "SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) AS s FROM withdrawals WHERE user_id = ? AND status = 'paid'", [token.uid]),
    first<{ s: number }>(c.env.DB, "SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) AS s FROM withdrawals WHERE user_id = ? AND status = 'pending'", [token.uid]),
  ]);
  const available = Math.max(0, (earnedRow?.s ?? 0) - (paidRow?.s ?? 0) - (pendingRow?.s ?? 0));
  if (amount > available) return json({ error: '提现金额超过可提现余额' }, 400);

  await run(c.env.DB, "INSERT INTO withdrawals (user_id, amount, method, account, account_name, status) VALUES (?, ?, ?, ?, ?, 'pending')", [
    token.uid, amount.toFixed(2), method, account, String(u.withdraw_name || ''),
  ]);
  return json({ ok: true });
});

app.post('/api/payment/callback', async (c) => {
  const form = await c.req.parseBody().catch(() => ({}));
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(form)) {
    params[k] = String(v);
  }
  const cfg = await readEpayConfig(c.env);
  const sign = String(params.sign || '');
  if (!cfg.key) return new Response('fail');

  if (!verifyCallbackSign(params, cfg.key, sign)) {
    return new Response('sign error');
  }

  const outTradeNo = String(params.out_trade_no || '');
  const tradeNo = String(params.trade_no || '');
  const tradeStatus = String(params.trade_status || '');

  const order = await first<{ id: number; user_id: number; plan: string; status: string; amount: number; currency: string; item_id: number | null; item_type: string }>(
    c.env.DB,
    'SELECT * FROM payment_orders WHERE order_no = ?',
    [outTradeNo]
  );
  if (!order) return new Response('fail');

  if (tradeStatus === 'TRADE_SUCCESS' && order.status === 'pending') {
    await run(c.env.DB, "UPDATE payment_orders SET status='paid', trade_no=?, paid_at=datetime('now') WHERE id=?", [tradeNo, order.id]);

    if (order.item_type === 'cart') {
      await run(c.env.DB, "UPDATE product_orders SET status='paid', trade_no=?, paid_at=datetime('now') WHERE batch_no = ?", [tradeNo, outTradeNo]);
    } else if (order.item_id) {
      if (order.item_type === 'course') {
        await run(c.env.DB, "INSERT INTO course_purchases (course_id, user_id, order_no, amount, status) VALUES (?, ?, ?, ?, 'paid')", [order.item_id, order.user_id, outTradeNo, order.amount]);
      } else if (order.item_type === 'product') {
        await run(c.env.DB, "UPDATE product_orders SET status='paid', trade_no=?, paid_at=datetime('now') WHERE order_no = ?", [tradeNo, outTradeNo]);
      } else if (order.item_type === 'article') {
        await run(c.env.DB, "INSERT INTO article_purchases (article_id, user_id, order_no, amount, status) VALUES (?, ?, ?, ?, 'paid')", [order.item_id, order.user_id, outTradeNo, order.amount]);
      }
    } else {
      // 会员订阅
      await activateMembership(c.env.DB, order.user_id, order.plan);

      // 返佣：给邀请人记佣金（好友购买会员时，邀请人获得 commission_rate%）
      const inviterRow = await first<{ invited_by: number | null }>(c.env.DB, 'SELECT invited_by FROM users WHERE id = ?', [order.user_id]);
      if (inviterRow?.invited_by && inviterRow.invited_by !== order.user_id) {
        const rate = parseFloat(await getSetting(c.env.DB, 'commission_rate', '20')) || 0;
        if (rate > 0) {
          const commission = ((order.amount * rate) / 100).toFixed(2);
          await run(c.env.DB, 'INSERT INTO commissions (inviter_id, invitee_id, order_id, order_no, amount) VALUES (?, ?, ?, ?, ?)', [
            inviterRow.invited_by, order.user_id, order.id, outTradeNo, commission,
          ]);
        }
      }
    }

    const user = await first<{ email: string }>(c.env.DB, 'SELECT email FROM users WHERE id = ?', [order.user_id]);
    if (user) {
      const subject = order.item_id ? '内容购买成功' : `订单支付成功 — ${order.plan}`;
      const body = order.item_id
        ? `您购买的内容已到账，感谢购买！订单号 ${outTradeNo}`
        : `您的订单 ${outTradeNo} 已支付成功，金额 ${order.amount} ${order.currency}，会员已激活。感谢订阅！`;
      c.executionCtx.waitUntil(sendEmail(c.env, user.email, subject, body, undefined, 'invoice'));
    }
  }

  return new Response('success');
});

app.get('/api/payment/return', async (c) => {
  const orderNo = c.req.query('order_no');
  let status = '支付处理中，请稍后前往账户中心查看订单详情';
  if (orderNo) {
    const order = await first<{ status: string; plan: string; item_type: string; item_id: number | null }>(
      c.env.DB, 'SELECT status, plan, item_type, item_id FROM payment_orders WHERE order_no = ?', [orderNo]);
    if (order?.status === 'paid') {
      if (order.item_type === 'cart') {
        status = '支付成功，商品订单已支付';
      } else if (order.item_id) {
        if (order.item_type === 'course') status = '支付成功，课程已解锁';
        else if (order.item_type === 'product') status = '支付成功，商品订单已支付';
        else if (order.item_type === 'article') status = '支付成功，文章已解锁';
        else status = '支付成功，内容已解锁';
      } else {
        status = '支付成功，会员已激活';
      }
    }
  }
  const info = await siteInfo(c.env);
  const user = await loadUser(c.env, c.req.raw);
  return html(layout({
    title: '支付结果',
    content: `<div class="card center"><h1>${esc(status)}</h1><p><a class="btn-primary" href="/account">前往账户中心查看订单详情</a> <a class="btn-ghost" href="/">返回首页</a></p></div>`,
    ...info,
    user,
  }));
});

// ---------------------------------------------------------------------------
// Media serving (R2)
// ---------------------------------------------------------------------------

app.get('/media/*', async (c) => {
  const key = c.req.path.slice('/media/'.length);
  const obj = await c.env.MEDIA.get(key);
  if (!obj) return c.notFound();
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  return new Response(obj.body, { headers });
});

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

app.get('/api/admin/stats', adminAuth(), async (c) => {
  const [articles, categories, users, orders, paidOrders, pendingWithdrawals, pendingShipments, pendingComments] = await Promise.all([
    first<{ n: number }>(c.env.DB, 'SELECT COUNT(*) AS n FROM articles'),
    first<{ n: number }>(c.env.DB, 'SELECT COUNT(*) AS n FROM categories'),
    first<{ n: number }>(c.env.DB, 'SELECT COUNT(*) AS n FROM users'),
    first<{ n: number }>(c.env.DB, 'SELECT COUNT(*) AS n FROM payment_orders'),
    first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM payment_orders WHERE status='paid'"),
    first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM withdrawals WHERE status='pending'"),
    first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM product_orders WHERE status='paid' AND product_type='physical'"),
    first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM comments WHERE status='pending'"),
  ]);
  const revenue = await first<{ s: number }>(c.env.DB, "SELECT COALESCE(SUM(amount),0) AS s FROM payment_orders WHERE status='paid'");
  return json({ articles: articles?.n, categories: categories?.n, users: users?.n, orders: orders?.n, paid_orders: paidOrders?.n, revenue: revenue?.s ?? 0, pending_withdrawals: pendingWithdrawals?.n ?? 0, pending_shipments: pendingShipments?.n ?? 0, pending_comments: pendingComments?.n ?? 0 });
});

// Categories CRUD
app.get('/api/admin/categories', adminAuth(), async (c) => {
  const type = c.req.query('type');
  const where = type ? 'WHERE c.type = ?' : '';
  const rows = await query<any>(
    c.env.DB,
    `SELECT c.*, COUNT(a.id) AS article_count FROM categories c
     LEFT JOIN articles a ON a.category_id = c.id ${where} GROUP BY c.id ORDER BY c.sort_order ASC`,
    type ? [type] : []
  );
  return json({ categories: rows });
});

app.post('/api/admin/categories', adminAuth(), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name || '').trim();
  let slug = String(body.slug || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  if (!name) return json({ error: '分类名必填' }, 400);
  if (!slug) slug = `cat-${Date.now()}`;
  const exists = await first(c.env.DB, 'SELECT id FROM categories WHERE slug = ?', [slug]);
  if (exists) return json({ error: 'slug 已存在' }, 409);
  const type = ['article', 'course', 'product'].includes(body.type) ? body.type : 'article';
  const result = await run(c.env.DB, 'INSERT INTO categories (name, slug, description, sort_order, type) VALUES (?, ?, ?, ?, ?)', [
    name,
    slug,
    String(body.description || ''),
    Number(body.sort_order || 0),
    type,
  ]);
  return json({ ok: true, id: (result.meta as any).last_row_id });
});

app.put('/api/admin/categories/:id', adminAuth(), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name || '').trim();
  let slug = String(body.slug || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  if (!name) return json({ error: '分类名必填' }, 400);
  if (!slug) slug = `cat-${Date.now()}`;
  const exists = await first(c.env.DB, 'SELECT id FROM categories WHERE slug = ? AND id != ?', [slug, id]);
  if (exists) return json({ error: 'slug 已存在' }, 409);
  const type = ['article', 'course', 'product'].includes(body.type) ? body.type : 'article';
  await run(c.env.DB, 'UPDATE categories SET name=?, slug=?, description=?, sort_order=?, type=? WHERE id=?', [
    name,
    slug,
    String(body.description || ''),
    Number(body.sort_order || 0),
    type,
    id,
  ]);
  return json({ ok: true });
});

app.delete('/api/admin/categories/:id', adminAuth(), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  await run(c.env.DB, 'UPDATE articles SET category_id = NULL WHERE category_id = ?', [id]);
  await run(c.env.DB, 'DELETE FROM categories WHERE id = ?', [id]);
  return json({ ok: true });
});

// Membership plans CRUD
app.get('/api/admin/plans', adminAuth(), async (c) => {
  const rows = await query<any>(
    c.env.DB,
    'SELECT id, key, name, duration_type, duration_value, price, currency, benefits, sort_order, status FROM membership_plans ORDER BY sort_order ASC, id ASC'
  );
  return json({ plans: rows });
});

app.post('/api/admin/plans', adminAuth(), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name || '').trim();
  const key = String(body.key || '').trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-') || `plan-${Date.now()}`;
  if (!name) return json({ error: '会员名称必填' }, 400);
  const durationType = ['day', 'month', 'year', 'forever'].includes(body.duration_type) ? body.duration_type : 'month';
  const durationValue = Math.max(1, parseInt(body.duration_value || '1', 10) || 1);
  const price = Math.max(0, parseFloat(body.price || '0') || 0);
  const currency = String(body.currency || 'USD').trim() || 'USD';
  const benefits = String(body.benefits || '');
  const sortOrder = parseInt(body.sort_order || '0', 10) || 0;
  const status = body.status === 0 || body.status === '0' ? 0 : 1;
  const exists = await first(c.env.DB, 'SELECT id FROM membership_plans WHERE key = ?', [key]);
  if (exists) return json({ error: '方案 key 已存在' }, 409);
  const result = await run(
    c.env.DB,
    'INSERT INTO membership_plans (key, name, duration_type, duration_value, price, currency, benefits, sort_order, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [key, name, durationType, durationValue, price, currency, benefits, sortOrder, status]
  );
  return json({ ok: true, id: (result.meta as any).last_row_id });
});

app.put('/api/admin/plans/:id', adminAuth(), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name || '').trim();
  if (!name) return json({ error: '会员名称必填' }, 400);
  const durationType = ['day', 'month', 'year', 'forever'].includes(body.duration_type) ? body.duration_type : 'month';
  const durationValue = Math.max(1, parseInt(body.duration_value || '1', 10) || 1);
  const price = Math.max(0, parseFloat(body.price || '0') || 0);
  const currency = String(body.currency || 'USD').trim() || 'USD';
  const benefits = String(body.benefits || '');
  const sortOrder = parseInt(body.sort_order || '0', 10) || 0;
  const status = body.status === 0 || body.status === '0' ? 0 : 1;
  await run(
    c.env.DB,
    "UPDATE membership_plans SET name=?, duration_type=?, duration_value=?, price=?, currency=?, benefits=?, sort_order=?, status=?, updated_at=datetime('now') WHERE id=?",
    [name, durationType, durationValue, price, currency, benefits, sortOrder, status, id]
  );
  return json({ ok: true });
});

app.delete('/api/admin/plans/:id', adminAuth(), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  await run(c.env.DB, 'DELETE FROM membership_plans WHERE id = ?', [id]);
  return json({ ok: true });
});

// Articles CRUD
app.get('/api/admin/articles', adminAuth(), async (c) => {
  const type = c.req.query('type');
  const where = type && ['article', 'course', 'product'].includes(type) ? 'WHERE a.type = ?' : '';
  const rows = await query<any>(
    c.env.DB,
    `SELECT a.*, c.name AS category_name FROM articles a
     LEFT JOIN categories c ON a.category_id = c.id ${where} ORDER BY a.is_top DESC, a.sort_order ASC, a.created_at DESC LIMIT 200`,
    type && where ? [type] : []
  );
  return json({ articles: rows });
});

app.get('/api/admin/articles/:id', adminAuth(), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const a = await first<any>(c.env.DB, 'SELECT * FROM articles WHERE id = ?', [id]);
  if (!a) return json({ error: 'not found' }, 404);
  return json({ article: a });
});

app.post('/api/admin/articles', adminAuth(), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const title = String(body.title || '').trim();
  if (!title) return json({ error: '标题必填' }, 400);
  const now = new Date().toISOString();
  const status = body.status === 'published' ? 'published' : 'draft';
  const publishedAt = status === 'published' ? (body.published_at || now) : null;
  const type = ['article', 'course', 'product'].includes(body.type) ? body.type : 'article';
  const price = Number(body.price || 0) || 0;
  const result = await run(
    c.env.DB,
    `INSERT INTO articles (title, slug, category_id, content, excerpt, cover_image, access_type, status, author_id, published_at, type, price, is_top, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [
      title,
      body.slug ? String(body.slug) : null,
      body.category_id ? Number(body.category_id) : null,
      String(body.content || ''),
      String(body.excerpt || ''),
      String(body.cover_image || ''),
      body.access_type === 'paid' || body.access_type === 'vip' ? body.access_type : 'public',
      status,
      (c.get('user') as JWTPayload).uid,
      publishedAt,
      type,
      price,
      body.is_top ? 1 : 0,
      Number(body.sort_order) || 0,
    ]
  );
  const id = (result.meta as any).last_row_id;

  // New article notification (only when published)
  if (status === 'published') {
    c.executionCtx.waitUntil(notifyNewArticle(c.env, id, title));
  }
  return json({ ok: true, id });
});

app.put('/api/admin/articles/:id', adminAuth(), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const body = await c.req.json().catch(() => ({}));
  const existing = await first<any>(c.env.DB, 'SELECT status FROM articles WHERE id = ?', [id]);
  if (!existing) return json({ error: 'not found' }, 404);
  const status = body.status === 'published' ? 'published' : 'draft';
  const publishedAt = status === 'published' ? (body.published_at || existing.published_at || new Date().toISOString()) : existing.published_at;
  const type = ['article', 'course', 'product'].includes(body.type) ? body.type : 'article';
  const price = Number(body.price || 0) || 0;
  await run(
    c.env.DB,
    `UPDATE articles SET title=?, slug=?, category_id=?, content=?, excerpt=?, cover_image=?, access_type=?, status=?, published_at=?, type=?, price=?, is_top=?, sort_order=?, updated_at=datetime('now') WHERE id=?`,
    [
      String(body.title || ''),
      body.slug ? String(body.slug) : null,
      body.category_id ? Number(body.category_id) : null,
      String(body.content || ''),
      String(body.excerpt || ''),
      String(body.cover_image || ''),
      body.access_type === 'paid' || body.access_type === 'vip' ? body.access_type : 'public',
      status,
      publishedAt,
      type,
      price,
      body.is_top ? 1 : 0,
      Number(body.sort_order) || 0,
      id,
    ]
  );
  if (status === 'published' && existing.status !== 'published') {
    c.executionCtx.waitUntil(notifyNewArticle(c.env, id, String(body.title || '')));
  }
  return json({ ok: true });
});

app.delete('/api/admin/articles/:id', adminAuth(), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  await run(c.env.DB, 'DELETE FROM articles WHERE id = ?', [id]);
  await run(c.env.DB, 'DELETE FROM article_links WHERE article_id = ?', [id]);
  return json({ ok: true });
});

// ---- 文章关联内容（相关文章/关联课程/热门商品）----
app.get('/api/admin/articles/:id/links', adminAuth(), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const links = await query<any>(c.env.DB, 'SELECT * FROM article_links WHERE article_id = ? ORDER BY item_type ASC, sort_order ASC, id ASC', [id]);
  const result: Record<string, any[]> = { article: [], course: [], product: [] };
  for (const l of links) {
    let meta: any = null;
    if (l.item_type === 'article') {
      meta = await first<any>(c.env.DB, 'SELECT id, title, cover_image FROM articles WHERE id = ?', [l.item_id]);
      if (meta) result.article.push({ ...l, title: meta.title, cover: meta.cover_image, url: `/article/${meta.id}` });
    } else if (l.item_type === 'course') {
      meta = await first<any>(c.env.DB, 'SELECT id, title, cover_image FROM courses WHERE id = ?', [l.item_id]);
      if (meta) result.course.push({ ...l, title: meta.title, cover: meta.cover_image, url: `/course/${meta.id}` });
    } else if (l.item_type === 'product') {
      meta = await first<any>(c.env.DB, 'SELECT id, name, cover FROM products WHERE id = ?', [l.item_id]);
      if (meta) result.product.push({ ...l, title: meta.name, cover: meta.cover, url: `/product/${meta.id}` });
    }
  }
  return json({ links: result });
});

app.put('/api/admin/articles/:id/links', adminAuth(), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const body = await c.req.json().catch(() => ({}));
  const links = Array.isArray(body.links) ? body.links : [];
  await run(c.env.DB, 'DELETE FROM article_links WHERE article_id = ?', [id]);
  for (const l of links) {
    const itemType = ['article', 'course', 'product'].includes(l.item_type) ? l.item_type : null;
    const itemId = Number(l.item_id);
    if (!itemType || !itemId) continue;
    await run(c.env.DB, 'INSERT INTO article_links (article_id, item_type, item_id, sort_order) VALUES (?, ?, ?, ?)', [id, itemType, itemId, Number(l.sort_order || 0)]);
  }
  return json({ ok: true });
});

// 跨类型搜索（绑定关联内容时的搜索下拉）
app.get('/api/admin/search-items', adminAuth(), async (c) => {
  const q = String(c.req.query('q') || '').trim();
  const type = String(c.req.query('type') || 'article');
  if (!q) return json({ items: [] });
  const like = `%${q}%`;
  let items: any[] = [];
  if (type === 'course') {
    items = (await query<any>(c.env.DB, 'SELECT id, title FROM courses WHERE title LIKE ? ORDER BY id DESC LIMIT 20', [like])).map((x) => ({ id: x.id, title: x.title, type: 'course' }));
  } else if (type === 'product') {
    items = (await query<any>(c.env.DB, 'SELECT id, name FROM products WHERE name LIKE ? ORDER BY id DESC LIMIT 20', [like])).map((x) => ({ id: x.id, title: x.name, type: 'product' }));
  } else {
    items = (await query<any>(c.env.DB, "SELECT id, title FROM articles WHERE type='article' AND title LIKE ? ORDER BY id DESC LIMIT 20", [like])).map((x) => ({ id: x.id, title: x.title, type: 'article' }));
  }
  return json({ items });
});

// ---- 广告 (Adsense) ----
app.get('/api/admin/ads', adminAuth(), async (c) => {
  const rows = await query<any>(c.env.DB, 'SELECT * FROM ads ORDER BY sort_order ASC, id DESC');
  return json({ ads: rows });
});
app.post('/api/admin/ads', adminAuth(), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const title = String(body.title || '').trim();
  if (!title) return json({ error: '标题必填' }, 400);
  const r = await run(c.env.DB, 'INSERT INTO ads (title, image, url, status, sort_order) VALUES (?, ?, ?, ?, ?)', [title, String(body.image || ''), String(body.url || ''), body.status === 0 ? 0 : 1, Number(body.sort_order || 0)]);
  return json({ ok: true, id: (r.meta as any).last_row_id });
});
app.put('/api/admin/ads/:id', adminAuth(), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const body = await c.req.json().catch(() => ({}));
  await run(c.env.DB, 'UPDATE ads SET title=?, image=?, url=?, status=?, sort_order=? WHERE id=?', [String(body.title || ''), String(body.image || ''), String(body.url || ''), body.status === 0 ? 0 : 1, Number(body.sort_order || 0), id]);
  return json({ ok: true });
});
app.delete('/api/admin/ads/:id', adminAuth(), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  await run(c.env.DB, 'DELETE FROM ads WHERE id = ?', [id]);
  return json({ ok: true });
});

// 公开广告列表（前端侧边栏轮播）
app.get('/api/ads', async (c) => {
  const rows = await query<any>(c.env.DB, 'SELECT id, title, image, url FROM ads WHERE status = 1 ORDER BY sort_order ASC, id ASC');
  return json({ ads: rows });
});

// 课程章节/视频管理
app.get('/api/admin/course/:id/chapters', adminAuth(), async (c) => {
  const courseId = parseInt(c.req.param('id'), 10);
  const chapters = await query<any>(c.env.DB, 'SELECT * FROM course_chapters WHERE course_id = ? ORDER BY sort_order ASC, id ASC', [courseId]);
  for (const ch of chapters) {
    ch.videos = await query<any>(c.env.DB, 'SELECT * FROM course_videos WHERE chapter_id = ? ORDER BY sort_order ASC, id ASC', [ch.id]);
    for (const v of ch.videos) {
      v.article_title = v.article_id ? ((await first<any>(c.env.DB, 'SELECT title FROM articles WHERE id = ?', [v.article_id]))?.title || '') : '';
    }
  }
  return json({ chapters });
});

app.put('/api/admin/course/:id/chapters', adminAuth(), async (c) => {
  const courseId = parseInt(c.req.param('id'), 10);
  const body = await c.req.json().catch(() => ({}));
  const chapters = Array.isArray(body.chapters) ? body.chapters : [];
  // 删除重建
  const existing = await query<{ id: number }>(c.env.DB, 'SELECT id FROM course_chapters WHERE course_id = ?', [courseId]);
  for (const ch of existing) {
    await run(c.env.DB, 'DELETE FROM course_videos WHERE chapter_id = ?', [ch.id]);
  }
  await run(c.env.DB, 'DELETE FROM course_chapters WHERE course_id = ?', [courseId]);
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const title = String(ch.title || '').trim();
    if (!title) continue;
    const r = await run(c.env.DB, 'INSERT INTO course_chapters (course_id, title, sort_order) VALUES (?, ?, ?)', [courseId, title, i]);
    const chapterId = (r.meta as any).last_row_id;
    const videos = Array.isArray(ch.videos) ? ch.videos : [];
    for (let j = 0; j < videos.length; j++) {
      const v = videos[j];
      const vtitle = String(v.title || '').trim();
      if (!vtitle || !String(v.video_url || '').trim()) continue;
      await run(c.env.DB, 'INSERT INTO course_videos (chapter_id, title, video_type, video_url, is_free, article_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        chapterId,
        vtitle,
        ['bilibili', 'youtube', 'direct'].includes(v.video_type) ? v.video_type : 'direct',
        String(v.video_url || ''),
        v.is_free ? 1 : 0,
        Number(v.article_id || 0),
        j,
      ]);
    }
  }
  return json({ ok: true });
});

// ---- 课程 CRUD ----
app.get('/api/admin/courses', adminAuth(), async (c) => {
  const rows = await query<any>(c.env.DB, 'SELECT * FROM courses ORDER BY is_top DESC, sticky_order DESC, id DESC LIMIT 200');
  return json({ courses: rows });
});
app.get('/api/admin/courses/:id', adminAuth(), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const course = await first<any>(c.env.DB, 'SELECT * FROM courses WHERE id = ?', [id]);
  if (!course) return json({ error: 'not found' }, 404);
  return json({ course });
});
app.post('/api/admin/courses', adminAuth(), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const title = String(body.title || '').trim();
  if (!title) return json({ error: '标题必填' }, 400);
  const access_type = body.access_type === 'paid' ? 'paid' : 'public';
  const price = access_type === 'paid' ? (Number(body.price) || 0) : 0;
  const r = await run(c.env.DB, 'INSERT INTO courses (title, cover_image, intro, access_type, price, status, is_top, sticky_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
    title, String(body.cover_image || ''), String(body.intro || ''), access_type, price,
    body.status == 0 ? 0 : 1, body.is_top ? 1 : 0, Number(body.sticky_order) || 0,
  ]);
  return json({ ok: true, id: (r.meta as any).last_row_id });
});
app.put('/api/admin/courses/:id', adminAuth(), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const body = await c.req.json().catch(() => ({}));
  const existing = await first<any>(c.env.DB, 'SELECT id FROM courses WHERE id = ?', [id]);
  if (!existing) return json({ error: 'not found' }, 404);
  const access_type = body.access_type === 'paid' ? 'paid' : 'public';
  const price = access_type === 'paid' ? (Number(body.price) || 0) : 0;
  await run(c.env.DB, "UPDATE courses SET title=?, cover_image=?, intro=?, access_type=?, price=?, status=?, is_top=?, sticky_order=?, updated_at=datetime('now') WHERE id=?", [
    String(body.title || ''), String(body.cover_image || ''), String(body.intro || ''), access_type, price,
    body.status == 0 ? 0 : 1, body.is_top ? 1 : 0, Number(body.sticky_order) || 0, id,
  ]);
  return json({ ok: true });
});
app.delete('/api/admin/courses/:id', adminAuth(), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const chapters = await query<{ id: number }>(c.env.DB, 'SELECT id FROM course_chapters WHERE course_id = ?', [id]);
  for (const ch of chapters) await run(c.env.DB, 'DELETE FROM course_videos WHERE chapter_id = ?', [ch.id]);
  await run(c.env.DB, 'DELETE FROM course_chapters WHERE course_id = ?', [id]);
  await run(c.env.DB, 'DELETE FROM course_purchases WHERE course_id = ?', [id]);
  await run(c.env.DB, 'DELETE FROM courses WHERE id = ?', [id]);
  return json({ ok: true });
});

// ---- 商品 CRUD ----
app.get('/api/admin/products', adminAuth(), async (c) => {
  const rows = await query<any>(c.env.DB, 'SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON p.category_id = c.id ORDER BY p.id DESC LIMIT 200');
  return json({ products: rows });
});
app.get('/api/admin/products/:id', adminAuth(), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const product = await first<any>(c.env.DB, 'SELECT * FROM products WHERE id = ?', [id]);
  if (!product) return json({ error: 'not found' }, 404);
  return json({ product });
});
app.post('/api/admin/products', adminAuth(), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name || '').trim();
  if (!name) return json({ error: '商品名称必填' }, 400);
  const type = body.type === 'virtual' ? 'virtual' : 'physical';
  const stock = type === 'virtual' ? -1 : (Number(body.stock) || 0);
  const r = await run(c.env.DB, 'INSERT INTO products (name, category_id, type, price, sale_price, stock, cover, images, description, short_description, is_featured, is_hot, status, sort_order, file_url, file_name, file_size, hidden_content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
    name, Number(body.category_id) || 0, type, Number(body.price) || 0, Number(body.sale_price) || 0, stock,
    String(body.cover || ''), String(body.images || '[]'), String(body.description || ''), String(body.short_description || ''),
    body.is_featured ? 1 : 0, body.is_hot ? 1 : 0, body.status == 0 ? 0 : 1, Number(body.sort_order) || 0,
    String(body.file_url || ''), String(body.file_name || ''), Number(body.file_size) || 0, String(body.hidden_content || ''),
  ]);
  return json({ ok: true, id: (r.meta as any).last_row_id });
});
app.put('/api/admin/products/:id', adminAuth(), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const body = await c.req.json().catch(() => ({}));
  const existing = await first<any>(c.env.DB, 'SELECT type FROM products WHERE id = ?', [id]);
  if (!existing) return json({ error: 'not found' }, 404);
  const type = body.type === 'virtual' ? 'virtual' : 'physical';
  const stock = type === 'virtual' ? -1 : (Number(body.stock) || 0);
  await run(c.env.DB, "UPDATE products SET name=?, category_id=?, type=?, price=?, sale_price=?, stock=?, cover=?, images=?, description=?, short_description=?, is_featured=?, is_hot=?, status=?, sort_order=?, file_url=?, file_name=?, file_size=?, hidden_content=?, updated_at=datetime('now') WHERE id=?", [
    String(body.name || ''), Number(body.category_id) || 0, type, Number(body.price) || 0, Number(body.sale_price) || 0, stock,
    String(body.cover || ''), String(body.images || '[]'), String(body.description || ''), String(body.short_description || ''),
    body.is_featured ? 1 : 0, body.is_hot ? 1 : 0, body.status == 0 ? 0 : 1, Number(body.sort_order) || 0,
    String(body.file_url || ''), String(body.file_name || ''), Number(body.file_size) || 0, String(body.hidden_content || ''), id,
  ]);
  return json({ ok: true });
});
app.delete('/api/admin/products/:id', adminAuth(), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  await run(c.env.DB, 'DELETE FROM product_orders WHERE product_id = ?', [id]);
  await run(c.env.DB, 'DELETE FROM products WHERE id = ?', [id]);
  return json({ ok: true });
});

// ---- 评论管理 ----
app.get('/api/admin/comments', adminAuth(), async (c) => {
  const rows = await query<any>(
    c.env.DB,
    `SELECT cm.*, p.name AS product_name, a.title AS article_title
     FROM comments cm
     LEFT JOIN products p ON p.id = cm.product_id
     LEFT JOIN articles a ON a.id = cm.article_id
     ORDER BY (cm.status = 'pending') DESC, cm.id DESC LIMIT 500`
  );
  return json({ comments: rows });
});

app.put('/api/admin/comments/:id', adminAuth(), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const { action, reply } = await c.req.json().catch(() => ({}));
  if (action === 'approve') await run(c.env.DB, "UPDATE comments SET status = 'approved' WHERE id = ?", [id]);
  else if (action === 'reject') await run(c.env.DB, "UPDATE comments SET status = 'rejected' WHERE id = ?", [id]);
  else if (action === 'reply') await run(c.env.DB, 'UPDATE comments SET reply = ? WHERE id = ?', [reply || '', id]);
  else return json({ error: '未知操作' }, 400);
  return json({ ok: true });
});

app.delete('/api/admin/comments/:id', adminAuth(), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  await run(c.env.DB, 'DELETE FROM comments WHERE id = ?', [id]);
  return json({ ok: true });
});

// ---- 商品订单管理 ----
app.get('/api/admin/product-orders', adminAuth(), async (c) => {
  const rows = await query<any>(c.env.DB, 'SELECT o.*, u.email FROM product_orders o LEFT JOIN users u ON o.user_id = u.id ORDER BY o.id DESC LIMIT 500');
  return json({ orders: rows });
});
app.put('/api/admin/product-orders/:id', adminAuth(), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const body = await c.req.json().catch(() => ({}));
  const order = await first<any>(c.env.DB, 'SELECT * FROM product_orders WHERE id = ?', [id]);
  if (!order) return json({ error: 'not found' }, 404);
  const action = String(body.action || '');
  if (action === 'ship') {
    await run(c.env.DB, "UPDATE product_orders SET status='shipped', tracking_no=?, tracking_company=?, shipped_at=datetime('now') WHERE id=?", [String(body.tracking_no || ''), String(body.tracking_company || ''), id]);
  } else if (action === 'complete') {
    await run(c.env.DB, "UPDATE product_orders SET status='completed' WHERE id=?", [id]);
  } else if (action === 'cancel') {
    if (order.product_type === 'physical' && order.status !== 'cancelled') {
      await run(c.env.DB, 'UPDATE products SET stock = stock + ? WHERE id = ?', [order.quantity, order.product_id]);
    }
    await run(c.env.DB, "UPDATE product_orders SET status='cancelled' WHERE id=?", [id]);
  } else {
    return json({ error: '无效操作' }, 400);
  }
  return json({ ok: true });
});

// ---- 虚拟商品下载 ----
app.get('/api/product/:id/download', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const token = await currentUser(c.env, c.req.raw);
  if (!token) return c.redirect('/login');
  const product = await first<any>(c.env.DB, 'SELECT * FROM products WHERE id = ?', [id]);
  if (!product || product.type !== 'virtual') return json({ error: '无下载内容' }, 404);
  const user = await loadUser(c.env, c.req.raw);
  const allow = user?.role === 'admin' || (await ownsProduct(c.env.DB, id, token.uid));
  if (!allow) return json({ error: '请先购买' }, 403);
  if (!product.file_url) return json({ error: '暂无下载文件' }, 404);
  const key = product.file_url.replace(/^\/media\//, '');
  const obj = await c.env.MEDIA.get(key);
  if (!obj) return json({ error: '文件不存在' }, 404);
  const filename = encodeURIComponent(product.file_name || 'download');
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
    },
  });
});

async function notifyNewArticle(env: Env, id: number, title: string) {
  const siteName = await getSetting(env.DB, 'site_name', '财经资讯站');
  const users = await query<{ email: string }>(
    env.DB,
    'SELECT email FROM users WHERE email_verified = 1 LIMIT 500'
  );
  for (const u of users) {
    await sendEmail(
      env,
      u.email,
      `[${siteName}] 新文章发布`,
      `新文章《${title}》已发布：${SITE_URL}/article/${id}\n\n${await getSetting(env.DB, 'site_slogan', '')}`,
      undefined,
      'new_article'
    );
  }
}

// File upload (通用：图片/视频/音频/文档/压缩包等)
app.post('/api/admin/upload', adminAuth(), async (c) => {
  const form = await c.req.parseBody().catch(() => ({}));
  const file = (form as Record<string, unknown>)['file'] as File | undefined;
  if (!file) return json({ error: '未收到文件' }, 400);
  const name = file.name || 'image';
  const extMatch = name.match(/\.([a-zA-Z0-9]+)$/);
  const ext = extMatch ? extMatch[1].toLowerCase() : 'bin';
  const allowed = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'ico', 'bmp', 'mp4', 'webm', 'mov', 'avi', 'mkv', 'mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'pdf', 'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'txt', 'md', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'json', 'apk', 'dmg', 'exe'];
  if (!allowed.includes(ext)) return json({ error: '不支持的文件类型' }, 400);
  const key = `uploads/${Date.now()}-${randHex(6)}.${ext}`;
  const contentType = file.type || 'application/octet-stream';
  await c.env.MEDIA.put(key, file.stream(), {
    httpMetadata: { contentType },
  });
  await run(c.env.DB, 'INSERT INTO media (key, filename, ext, content_type, size, url) VALUES (?, ?, ?, ?, ?, ?)', [
    key,
    name,
    ext,
    contentType,
    file.size || 0,
    `/media/${key}`,
  ]);
  return json({ url: `/media/${key}`, key });
});

// 媒体库列表（类型筛选 + 文件名搜索 + 服务端分页）
const MEDIA_EXT_GROUPS: Record<string, string[]> = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'ico', 'bmp'],
  video: ['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v'],
  audio: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg'],
  document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'json'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'],
};
const ALL_KNOWN_EXTS = Object.values(MEDIA_EXT_GROUPS).flat();

app.get('/api/admin/media', adminAuth(), async (c) => {
  const type = String(c.req.query('type') || 'all').trim();
  const q = String(c.req.query('q') || '').trim();
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query('page_size') || '24', 10) || 24));
  const offset = (page - 1) * pageSize;

  const where: string[] = [];
  const params: unknown[] = [];
  if (type === 'other') {
    where.push(`ext NOT IN (${ALL_KNOWN_EXTS.map(() => '?').join(',')})`);
    params.push(...ALL_KNOWN_EXTS);
  } else if (MEDIA_EXT_GROUPS[type]) {
    where.push(`ext IN (${MEDIA_EXT_GROUPS[type].map(() => '?').join(',')})`);
    params.push(...MEDIA_EXT_GROUPS[type]);
  }
  if (q) {
    where.push('(filename LIKE ? OR key LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalRow = await first<{ c: number }>(c.env.DB, `SELECT COUNT(*) AS c FROM media ${whereSql}`, params);
  const total = totalRow?.c ?? 0;
  const rows = await query<any>(c.env.DB, `SELECT * FROM media ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
  return json({
    items: rows,
    total,
    page,
    page_size: pageSize,
    total_pages: Math.max(1, Math.ceil(total / pageSize)),
  });
});

// 删除媒体（R2 对象 + 元数据）
app.delete('/api/admin/media', adminAuth(), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const key = String(body.key || '').trim();
  if (!key) return json({ error: '缺少 key' }, 400);
  const row = await first<{ key: string }>(c.env.DB, 'SELECT key FROM media WHERE key = ?', [key]);
  if (!row) return json({ error: '记录不存在' }, 404);
  await c.env.MEDIA.delete(key);
  await run(c.env.DB, 'DELETE FROM media WHERE key = ?', [key]);
  return json({ ok: true });
});

// Settings
app.get('/api/admin/settings', adminAuth(), async (c) => {
  const rows = await query<{ key: string; value: string }>(c.env.DB, 'SELECT key, value FROM settings');
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;
  return json({ settings: map });
});

app.put('/api/admin/settings', adminAuth(), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const allowed = [
    'site_name', 'site_tagline', 'site_slogan', 'site_favicon', 'site_logo',
    'sender_email', 'sender_name', 'resend_api_key',
    'epay_api_url', 'epay_pid', 'epay_key', 'pay_methods',
    'currency', 'commission_rate',
    'vip_article_access', 'vip_course_access', 'vip_virtual_access', 'vip_product_discount',
    'about_content',
    'social_bilibili', 'social_douyin', 'social_xiaohongshu', 'social_facebook', 'social_x', 'social_youtube', 'social_instagram',
    'cs_chat_url', 'cs_wechat_qr', 'cs_whatsapp', 'cs_telegram',
    'ai_base_url', 'ai_model', 'ai_api_key',
    'nav_menu',
  ];
  for (const k of Object.keys(body)) {
    if (allowed.includes(k)) await setSetting(c.env.DB, k, String(body[k]));
  }
  return json({ ok: true });
});

// Users list
app.get('/api/admin/users', adminAuth(), async (c) => {
  const rows = await query<any>(
    c.env.DB,
    `SELECT u.id, u.email, u.name, u.role, u.email_verified, u.membership_tier, u.membership_expires_at, u.invite_code, u.created_at,
            (SELECT COUNT(*) FROM invite_tracking t WHERE t.inviter_id = u.id) AS invited_count
     FROM users u ORDER BY u.id DESC LIMIT 500`
  );
  return json({ users: rows });
});

// Orders list
app.get('/api/admin/orders', adminAuth(), async (c) => {
  const rows = await query<any>(
    c.env.DB,
    `SELECT o.*, u.email FROM payment_orders o LEFT JOIN users u ON o.user_id = u.id ORDER BY o.id DESC LIMIT 500`
  );
  return json({ orders: rows });
});

// Invite stats
app.get('/api/admin/invites', adminAuth(), async (c) => {
  const rows = await query<any>(
    c.env.DB,
    `SELECT t.*, iu.email AS inviter_email, iu.name AS inviter_name, eu.email AS invitee_email
     FROM invite_tracking t
     LEFT JOIN users iu ON iu.id = t.inviter_id
     LEFT JOIN users eu ON eu.id = t.invitee_id
     ORDER BY t.id DESC LIMIT 500`
  );
  return json({ invites: rows });
});

// Withdrawals management
app.get('/api/admin/withdrawals', adminAuth(), async (c) => {
  const rows = await query<any>(
    c.env.DB,
    `SELECT w.*, u.email, u.name FROM withdrawals w
     LEFT JOIN users u ON u.id = w.user_id
     ORDER BY w.id DESC LIMIT 500`
  );
  return json({ withdrawals: rows });
});

app.put('/api/admin/withdrawals/:id', adminAuth(), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const body = await c.req.json().catch(() => ({}));
  const action = String(body.action || '');
  const adminId = c.get('user').uid;
  if (action === 'paid') {
    await run(c.env.DB, "UPDATE withdrawals SET status='paid', reject_reason='', processed_at=datetime('now'), processed_by=? WHERE id=? AND status='pending'", [adminId, id]);
    return json({ ok: true });
  }
  if (action === 'reject') {
    const reason = String(body.reject_reason || '').trim();
    if (!reason) return json({ error: '请填写拒绝原因' }, 400);
    await run(c.env.DB, "UPDATE withdrawals SET status='rejected', reject_reason=?, processed_at=datetime('now'), processed_by=? WHERE id=? AND status='pending'", [reason, adminId, id]);
    return json({ ok: true });
  }
  return json({ error: '无效操作' }, 400);
});

// ---------------------------------------------------------------------------
// MCP (public, no auth)
// ---------------------------------------------------------------------------

app.post('/mcp/', async (c) => {
  const res = await handleMcp(c.env, c.req.raw);
  const headers = new Headers(res.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Headers', 'content-type, authorization');
  headers.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  return new Response(res.body, { status: res.status, headers });
});

app.options('/mcp/', (c) => {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type, authorization',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    },
  });
});

app.get('/mcp/', async (c) => {
  return new Response(JSON.stringify({ name: '财经资讯站', type: 'http', transport: 'http', description: '财经资讯 MCP — POST JSON-RPC 到此端点' }), {
    headers: { 'content-type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
});

// ---------------------------------------------------------------------------
// Static assets fallback (admin SPA, css, js, login, register)
// ---------------------------------------------------------------------------

app.get('/admin', async (c) => {
  return c.env.ASSETS.fetch(new Request(new URL('/admin/index.html', c.req.url), c.req.raw));
});
app.get('/admin/*', async (c) => {
  return c.env.ASSETS.fetch(new Request(new URL('/admin/index.html', c.req.url), c.req.raw));
});

app.get('/login', async (c) => {
  const info = await siteInfo(c.env);
  const user = await loadUser(c.env, c.req.raw);
  return html(renderLogin({ ...info, user }));
});
app.get('/register', async (c) => {
  const info = await siteInfo(c.env);
  const user = await loadUser(c.env, c.req.raw);
  return html(renderRegister({ ...info, user }));
});

// Catch-all: serve from assets
app.all('*', async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
