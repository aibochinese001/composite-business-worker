// formal_secret_scan.mjs — 正式敏感信息扫描（模拟 gitleaks，遵循 .gitignore）
import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = process.cwd();
const IGNORED_DIRS = new Set(['node_modules', '.wrangler', '.git', 'dist', 'coverage', '.idea', '.vscode']);
const IGNORED_NAMES = new Set(['.env', '.dev.vars', '.DS_Store', 'Thumbs.db']);
const IGNORE_EXT = new Set(['.db', '.db-shm', '.db-wal', '.sqlite', '.sqlite-shm', '.sqlite-wal', '.pem', '.key', '.p12', '.pfx', '.log']);

const files = [];
function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(e.name)) continue;
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else {
      if (IGNORED_NAMES.has(e.name)) continue;
      if (IGNORE_EXT.has(extname(e.name).toLowerCase())) continue;
      files.push(p);
    }
  }
}
walk(ROOT);
console.log('将被提交的文件数:', files.length);

const patterns = [
  ['OpenAI sk-', /sk-[A-Za-z0-9]{20,}/],
  ['CLOUDFLARE token (cf_)', /cf_[A-Za-z0-9_]{20,}/],
  ['CLOUDFLARE_API_TOKEN=', /CLOUDFLARE_API_TOKEN\s*=\s*["']?[A-Za-z0-9_]{15,}/],
  ['Resend (re_)', /re_[A-Za-z0-9]{20,}/],
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['GCP (AIza)', /AIza[0-9A-Za-z_-]{30,}/],
  ['GitHub token (ghp_)', /ghp_[0-9A-Za-z]{30,}/],
  ['Bearer token', /Bearer\s+[A-Za-z0-9._~+/-]{20,}/],
  ['private key block', /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/],
  ['password=...', /password\s*[:=]\s*["'][^"'\s]{6,}["']/i],
  ['api_key=...', /(api[_-]?key|apikey)\s*[:=]\s*["'][^"'\s]{10,}["']/i],
  ['secret=...', /secret\s*[:=]\s*["'][^"'\s]{10,}["']/i],
  ['token=...', /(token|access[_-]?token|auth[_-]?token)\s*[:=]\s*["'][^"'\s]{10,}["']/i],
];

let issues = [];
for (const f of files) {
  let c;
  try { c = readFileSync(f, 'utf8'); } catch { continue; }
  const rel = f.replace(ROOT + '\\', '').replace(ROOT + '/', '');
  const lines = c.split(/\r?\n/);
  lines.forEach((l, i) => {
    for (const [name, re] of patterns) {
      if (re.test(l)) {
        // 排除明显是占位符/示例/变量名声明/文档 export 示例的行
        if (/example|your-|YOUR_|change-me|REPLACE|xxxx|placeholder|示例|占位|TODO|dev-secret|^export\s/.test(l)) continue;
        issues.push({ file: rel, line: i + 1, pattern: name, text: l.trim().slice(0, 100) });
      }
    }
  });
}
console.log('=== 敏感模式命中:', issues.length, '===');
for (const it of issues) console.log('  ' + it.file + ':' + it.line + ' [' + it.pattern + '] ' + it.text);

console.log('=== 个人标识符检查（域名/邮箱/DB ID/邀请码）===');
// ⚠️ 把你的真实敏感标识符填入下面的数组（例如你的域名、邮箱、数据库 ID、邀请码），
//    扫描器会逐项全盘检查。下方示例占位符不会命中任何真实内容。
const personalMarkers = [
  'CHANGE_ME_EMAIL',
  'CHANGE_ME_DOMAIN',
  'CHANGE_ME_DB_ID',
  'CHANGE_ME_INVITE_CODE',
];
let leaked = 0;
for (const f of files) {
  if (f.endsWith('formal_secret_scan.mjs')) continue; // 扫描器自身含模式串，属正常
  const c = readFileSync(f, 'utf8');
  const rel = f.replace(ROOT + '\\', '').replace(ROOT + '/', '');
  const hits = personalMarkers.filter((m) => c.includes(m));
  if (hits.length) {
    console.log('  LEAK: ' + rel + ' -> ' + hits.join(', '));
    leaked++;
  }
}
console.log(leaked === 0 ? '  无个人标识符泄露' : '  发现泄露: ' + leaked);
console.log('=== 扫描结束 ===');
