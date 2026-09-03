// Server-side HTML rendering for SEO + AI-crawlable pages
import { buildHomeRotate, HomeCard } from './home-rotate';

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// TODO: 部署后把 SITE_URL 替换为你的站点域名（也可用 .dev.vars 的 BASE_URL 覆盖，见 AGENTS.md）
const SITE_URL = 'https://your-worker.workers.dev';

type SocialLinks = { bilibili: string; douyin: string; xiaohongshu: string; facebook: string; x: string; youtube: string; instagram: string };
type CsConfig = { chat_url: string; wechat_qr: string; whatsapp: string; telegram: string };
type NoticeItem = { type: string; id: number; title: string; href: string };
type NavMenuItem = { id: string; label: string; url: string; target?: string; children?: NavMenuItem[] };

const SOCIAL_IMAGES: Record<string, string> = {
  bilibili: 'https://your-cdn.example.com/%E7%B4%A0%E6%9D%90%E7%AB%99/202608/social-media-ico/bilibili.png',
  douyin: 'https://your-cdn.example.com/%E7%B4%A0%E6%9D%90%E7%AB%99/202608/social-media-ico/douyin.png',
  xiaohongshu: 'https://your-cdn.example.com/%E7%B4%A0%E6%9D%90%E7%AB%99/202608/social-media-ico/rednote.png',
  facebook: 'https://your-cdn.example.com/%E7%B4%A0%E6%9D%90%E7%AB%99/202608/social-media-ico/icons8-facebook-96.png',
  x: 'https://your-cdn.example.com/%E7%B4%A0%E6%9D%90%E7%AB%99/202608/social-media-ico/x-logo-30.jpeg',
  youtube: 'https://your-cdn.example.com/%E7%B4%A0%E6%9D%90%E7%AB%99/202608/social-media-ico/youtube%20logo%2030.png',
  instagram: 'https://your-cdn.example.com/%E7%B4%A0%E6%9D%90%E7%AB%99/202608/social-media-ico/icons8-instagram-48.png',
};

function socialLinksHtml(social: SocialLinks | undefined): string {
  if (!social) return '';
  const items: [string, string, string][] = [
    ['bilibili', social.bilibili, 'Bilibili'],
    ['douyin', social.douyin, '抖音'],
    ['xiaohongshu', social.xiaohongshu, '小红书'],
    ['facebook', social.facebook, 'Facebook'],
    ['x', social.x, 'X'],
    ['youtube', social.youtube, 'YouTube'],
    ['instagram', social.instagram, 'Instagram'],
  ];
  const links = items
    .filter(([, url]) => url)
    .map(([key, url, label]) => `<a class="social-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(label)}" aria-label="${esc(label)}"><img src="${esc(SOCIAL_IMAGES[key])}" alt="${esc(label)}" loading="lazy"></a>`)
    .join('');
  return links ? `<div class="footer-social"><span class="footer-social-label">Follow us</span><div class="footer-social-icons">${links}</div></div>` : '';
}

function noticeTickerHtml(items: NoticeItem[] | undefined): string {
  if (!items || items.length === 0) return '';
  const item = (it: NoticeItem) => `<a class="notice-item" href="${esc(it.href)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a>`;
  const first = items[0];
  return `<div class="notice-ticker">
  <div class="notice-ticker-inner">
    <span class="notice-speaker" aria-hidden="true">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"></polygon>
        <path class="wave wave1" d="M15.5 8.5a5 5 0 0 1 0 7"></path>
        <path class="wave wave2" d="M18.5 5.5a9 9 0 0 1 0 13"></path>
      </svg>
    </span>
    <div class="notice-viewport">
      <div class="notice-list" id="noticeList">${items.map(item).join('')}${item(first)}</div>
    </div>
  </div>
</div>
<script>
(function () {
  var list = document.getElementById('noticeList');
  if (!list) return;
  var ticker = list.closest('.notice-ticker');
  var total = list.children.length;
  if (total < 2) return;
  var lineH = 40, idx = 0, timer = null;
  function tick() {
    idx++;
    list.classList.remove('no-transition');
    list.style.transform = 'translateY(-' + (idx * lineH) + 'px)';
    if (idx === total - 1) {
      setTimeout(function () {
        list.classList.add('no-transition');
        list.style.transform = 'translateY(0)';
        idx = 0;
      }, 620);
    }
  }
  function start() { if (!timer) timer = setInterval(tick, 5000); }
  function stop() { clearInterval(timer); timer = null; }
  ticker.addEventListener('mouseenter', stop);
  ticker.addEventListener('mouseleave', start);
  start();
})();
</script>`;
}

function csHtml(cs: CsConfig | undefined): string {
  if (!cs) return '';
  const hasCs = !!(cs.chat_url || cs.wechat_qr || cs.whatsapp || cs.telegram);
  if (!hasCs) return '';
  const chatItem = cs.chat_url ? `<button class="cs-item" data-cs-action="chat">💬 在线客服</button>` : '';
  const iconItems = [
    cs.wechat_qr ? `<button class="cs-icon" data-cs-action="wechat" title="微信" aria-label="微信"><img src="https://your-cdn.example.com/%E7%B4%A0%E6%9D%90%E7%AB%99/202608/social-media-ico/wechaticon.png" alt="微信"></button>` : '',
    cs.whatsapp ? `<a class="cs-icon" href="${esc(cs.whatsapp)}" target="_blank" rel="noopener noreferrer" title="WhatsApp" aria-label="WhatsApp"><img src="https://your-cdn.example.com/%E7%B4%A0%E6%9D%90%E7%AB%99/202608/social-media-ico/whatsapp-48.png" alt="WhatsApp"></a>` : '',
    cs.telegram ? `<a class="cs-icon" href="${esc(cs.telegram)}" target="_blank" rel="noopener noreferrer" title="Telegram" aria-label="Telegram"><img src="https://your-cdn.example.com/%E7%B4%A0%E6%9D%90%E7%AB%99/202608/social-media-ico/icons8-telegram-48.png" alt="Telegram"></a>` : '',
  ].filter(Boolean);
  const iconRow = iconItems.length ? `<div class="cs-icons">${iconItems.join('')}</div>` : '';
  const items = `${chatItem}${iconRow}`;
  return `<button class="cs-fab" id="csFab" aria-label="在线客服"><img src="https://your-cdn.example.com/%E7%B4%A0%E6%9D%90%E7%AB%99/202608/chat-icon.png" alt="在线客服"></button>
<div class="cs-panel" id="csPanel" hidden>
  <button class="cs-close" id="csClose" aria-label="关闭">×</button>
  <div class="cs-panel-body" id="csBody">${items}</div>
  <div class="cs-chatbox" id="csChatbox" hidden><iframe id="csFrame" title="在线客服" src="" loading="lazy"></iframe></div>
  <div class="cs-qrbox" id="csQrbox" hidden><img id="csQrImg" alt="微信二维码" src=""><p>扫码添加微信</p></div>
</div>
<script>
(function(){
  var fab=document.getElementById('csFab'); if(!fab) return;
  var panel=document.getElementById('csPanel');
  fab.addEventListener('click', function(){ panel.hidden = !panel.hidden; });
  var close=document.getElementById('csClose');
  close.addEventListener('click', function(){ panel.hidden = true; });
  var chatbox=document.getElementById('csChatbox'), qrbox=document.getElementById('csQrbox');
  var frame=document.getElementById('csFrame'), qr=document.getElementById('csQrImg');
  document.querySelectorAll('[data-cs-action]').forEach(function(el){
    el.addEventListener('click', function(){
      var action=el.getAttribute('data-cs-action');
      chatbox.hidden=true; qrbox.hidden=true;
      if(action==='chat'){ frame.src=${JSON.stringify(cs.chat_url || '')}; chatbox.hidden=false; }
      else if(action==='wechat'){ qr.src=${JSON.stringify(cs.wechat_qr || '')}; qrbox.hidden=false; }
    });
  });
})();
</script>`;
}

function searchHtml(): string {
  return `<button class="search-fab" id="searchFab" aria-label="搜索"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg></button>
<div class="search-panel" id="searchPanel" hidden>
  <button class="search-close" id="searchClose" aria-label="关闭">×</button>
  <div class="search-box">
    <input id="searchInput" type="text" placeholder="搜索文章 / 商品 / 课程" autocomplete="off">
    <button id="searchBtn" aria-label="搜索"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg></button>
  </div>
  <div class="search-tabs">
    <button class="search-tab active" data-tab="all">全部</button>
    <button class="search-tab" data-tab="article">文章</button>
    <button class="search-tab" data-tab="product">商品</button>
    <button class="search-tab" data-tab="course">课程</button>
  </div>
  <div class="search-results" id="searchResults"></div>
</div>
<script>
(function(){
  var fab=document.getElementById('searchFab'); if(!fab) return;
  var panel=document.getElementById('searchPanel');
  var input=document.getElementById('searchInput');
  var results=document.getElementById('searchResults');
  var currentTab='all', allResults=[];
  function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
  fab.addEventListener('click', function(){ panel.hidden=!panel.hidden; if(!panel.hidden) input.focus(); });
  document.getElementById('searchClose').addEventListener('click', function(){ panel.hidden=true; });
  function doSearch(){
    var q=input.value.trim(); if(!q) return;
    fetch('/api/search?q='+encodeURIComponent(q)).then(function(r){return r.json();}).then(function(d){ allResults=d.results||[]; render(); });
  }
  function render(){
    var list=allResults.filter(function(r){ return currentTab==='all' || r.type===currentTab; });
    if(!list.length){ results.innerHTML='<p class="search-empty">无匹配结果</p>'; return; }
    results.innerHTML=list.map(function(r){
      return '<a class="search-item" href="'+r.url+'" target="_blank" rel="noopener noreferrer"><span class="search-type search-type-'+r.type+'">'+esc(r.label)+'</span>'+esc(r.title)+'</a>';
    }).join('');
  }
  input.addEventListener('keydown', function(e){ if(e.key==='Enter'){ e.preventDefault(); doSearch(); } });
  document.getElementById('searchBtn').addEventListener('click', doSearch);
  document.querySelectorAll('.search-tab').forEach(function(t){
    t.addEventListener('click', function(){
      document.querySelectorAll('.search-tab').forEach(function(x){ x.classList.remove('active'); });
      t.classList.add('active'); currentTab=t.getAttribute('data-tab'); render();
    });
  });
})();
</script>`;
}

function aiChatHtml(): string {
  return `<button class="ai-fab" id="aiFab" aria-label="AI 智能客服">🤖</button>
<div class="ai-panel" id="aiPanel" hidden>
  <button class="ai-close" id="aiClose" aria-label="关闭">×</button>
  <div class="ai-head">AI 智能客服</div>
  <div class="ai-body" id="aiBody">
    <div class="ai-msg ai">您好，我是 AI 智能客服，有什么可以帮您？</div>
  </div>
  <div class="ai-input">
    <input id="aiInput" type="text" placeholder="输入问题，回车发送" autocomplete="off">
    <button id="aiSend" aria-label="发送">发送</button>
  </div>
</div>
<script>
(function(){
  var fab=document.getElementById('aiFab'); if(!fab) return;
  var panel=document.getElementById('aiPanel');
  var body=document.getElementById('aiBody');
  var input=document.getElementById('aiInput');
  var send=document.getElementById('aiSend');
  fab.addEventListener('click', function(){ panel.hidden=!panel.hidden; if(!panel.hidden) input.focus(); });
  document.getElementById('aiClose').addEventListener('click', function(){ panel.hidden=true; });
  function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function autoLink(t){ t=esc(t); var links=[]; t=t.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)/g, function(m,txt,url){ links.push('<a href="'+url+'" target="_blank" rel="noopener noreferrer">'+txt+'</a>'); return 'ZZLINK'+(links.length-1)+'ZZ'; }); t=t.replace(/(https?:\\/\\/[^\\s<>\\[\\]()"']+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'); t=t.replace(/ZZLINK(\\d+)ZZ/g, function(m,i){ return links[parseInt(i,10)]; }); return t.replace(/\\n/g,'<br>'); }
  function addMsg(role, html){ var d=document.createElement('div'); d.className='ai-msg '+role; d.innerHTML=html; body.appendChild(d); body.scrollTop=body.scrollHeight; }
  function ask(){
    var q=input.value.trim(); if(!q) return;
    addMsg('user', esc(q)); input.value='';
    var thinking=document.createElement('div'); thinking.className='ai-msg ai'; thinking.textContent='思考中...'; body.appendChild(thinking); body.scrollTop=body.scrollHeight;
    fetch('/api/chat', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({question:q}) })
      .then(function(r){return r.json();})
      .then(function(d){ thinking.remove(); if(d.error){ addMsg('ai', esc(d.error)); } else { addMsg('ai', autoLink(d.reply)); } })
      .catch(function(){ thinking.remove(); addMsg('ai', '网络错误，请稍后再试'); });
  }
  send.addEventListener('click', ask);
  input.addEventListener('keydown', function(e){ if(e.key==='Enter'){ e.preventDefault(); ask(); } });
})();
</script>`;
}

export function layout(opts: {
  title: string;
  description?: string;
  content: string;
  siteName: string;
  tagline: string;
  slogan: string;
  user?: { name: string; email: string; role: string; isVip?: boolean } | null;
  navMenu?: NavMenuItem[];
  favicon?: string;
  logo?: string;
  showHero?: boolean;
  noticeItems?: NoticeItem[];
  social?: SocialLinks;
  cs?: CsConfig;
}): string {
  const u = opts.user;
  const authBar = u
    ? `<div class="nav-user"><a href="/account">用户中心</a>${u.role === 'admin' ? ' · <a href="/admin/">管理后台</a>' : ''} · <a href="/api/logout">退出</a></div>`
    : `<div class="nav-user"><a href="/login">登录</a> <a href="/register" class="btn-ghost">注册</a></div>`;
  const vipBadge = `<a href="/vip" class="vip-badge${u && u.isVip ? ' vip-active' : ''}" title="VIP 会员" aria-label="VIP 会员"><span class="vip-crown">👑</span><span class="vip-text">VIP</span></a>`;
  const navMenuHtml = (opts.navMenu || [])
    .map((m) => {
      const t = m.target === '_blank' ? ' target="_blank" rel="noopener noreferrer"' : '';
      if (m.children && m.children.length) {
        return `<div class="nav-item">
        <a href="${esc(m.url || '#')}"${t}>${esc(m.label)} <span class="nav-caret">▾</span></a>
        <div class="nav-dropdown">${m.children.map((ch) => `<a href="${esc(ch.url || '#')}"${ch.target === '_blank' ? ' target="_blank" rel="noopener noreferrer"' : ''}>${esc(ch.label)}</a>`).join('')}</div>
      </div>`;
      }
      return `<a href="${esc(m.url || '#')}"${t}>${esc(m.label)}</a>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(opts.title)} · ${esc(opts.siteName)}</title>
<meta name="description" content="${esc(opts.description || opts.tagline)}">
<meta name="mcp-server" content="${SITE_URL}/mcp/">
<link rel="mcp-discovery" href="${SITE_URL}/.well-known/mcp/">
<link rel="stylesheet" href="/css/style.css">
${opts.favicon ? `<link rel="icon" href="${esc(opts.favicon)}">` : ''}
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#10b981">
<link rel="apple-touch-icon" href="/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
</head>
<body>
<header class="site-header">
  <div class="container header-inner">
    <a href="/" class="logo">${opts.logo ? `<img src="${esc(opts.logo)}" alt="${esc(opts.siteName)}" class="logo-img">` : esc(opts.siteName)}</a>
    <button class="nav-toggle" id="navToggle" aria-label="打开菜单" aria-expanded="false">☰</button>
    <nav class="main-nav" id="mainNav">
      <a href="/">首页</a>
      <a href="/courses">课程</a>
      <a href="/articles">文章</a>
      <a href="/shop">商城</a>
      <a href="/about">关于我们</a>
      <a href="/helper">帮助中心</a>
      ${navMenuHtml}
    </nav>
    <a href="/cart" class="cart-icon" title="购物车" aria-label="购物车">🛒<span class="cart-count" id="cartCount" style="display:none;">0</span></a>
    ${vipBadge}
    ${authBar}
  </div>
</header>
${opts.showHero ? `<div class="hero">
  <div class="container hero-inner">
    ${noticeTickerHtml(opts.noticeItems)}
    <h1 class="hero-title">${esc(opts.tagline)}</h1>
    <p class="hero-slogan">${esc(opts.slogan)}</p>
    <div class="hero-divider"></div>
  </div>
</div>` : ''}
<main class="container main-content">${opts.content}</main>
<footer class="site-footer">
  <div class="container">
    ${socialLinksHtml(opts.social)}
    <p class="footer-brand">${esc(opts.siteName)} · ${esc(opts.tagline)}</p>
  </div>
</footer>
${aiChatHtml()}
${searchHtml()}
${csHtml(opts.cs)}
<script>
(function(){
  var t=document.getElementById('navToggle');
  if(!t) return;
  t.addEventListener('click', function(){
    var nav=document.getElementById('mainNav');
    var nu=document.querySelector('.nav-user');
    var open=nav.classList.toggle('open');
    if(nu) nu.classList.toggle('open', open);
    t.setAttribute('aria-expanded', open?'true':'false');
  });
})();
async function loadCartCount() {
  try {
    var r = await fetch('/api/cart/count');
    var d = await r.json();
    var el = document.getElementById('cartCount');
    if (el) {
      if (d.count > 0) { el.textContent = d.count > 99 ? '99+' : d.count; el.style.display = ''; }
      else el.style.display = 'none';
    }
  } catch (e) {}
}
loadCartCount();
function toggleCatTabs(btn) {
  var box = btn.parentElement;
  var expanded = box.classList.toggle('expanded');
  btn.textContent = expanded ? '‹' : '›';
  btn.setAttribute('aria-label', expanded ? '收起分类' : '展开更多分类');
  btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
}
function initCatTabs() {
  var boxes = document.querySelectorAll('.category-tabs-box');
  for (var i = 0; i < boxes.length; i++) {
    var box = boxes[i];
    var tabs = box.querySelector('.category-tabs');
    var btn = box.querySelector('.cat-toggle');
    if (!tabs || !btn) continue;
    if (tabs.scrollHeight > tabs.clientHeight + 2) {
      box.classList.add('has-more');
      btn.style.display = '';
    }
  }
}
initCatTabs();
function initAudioPlayers() {
  var players = document.querySelectorAll('.audio-player');
  for (var i = 0; i < players.length; i++) (function (ap) {
    if (ap.getAttribute('data-ap-init')) return;
    ap.setAttribute('data-ap-init', '1');
    ap.classList.add('ap-collapsed');
    var src = ap.getAttribute('data-src');
    if (!src) return;
    var audio = document.createElement('audio');
    audio.src = src;
    audio.preload = 'metadata';
    ap.appendChild(audio);
    var btn = ap.querySelector('.ap-play');
    var bar = ap.querySelector('.ap-bar-fill');
    var time = ap.querySelector('.ap-time');
    function fmt(t) {
      if (!isFinite(t) || t < 0) t = 0;
      var m = Math.floor(t / 60), s = Math.floor(t % 60);
      return m + ':' + (s < 10 ? '0' : '') + s;
    }
    function doPlay() {
      var p = audio.play();
      if (p && p.catch) p.catch(function () {});
    }
    btn.addEventListener('click', function () {
      if (audio.paused) {
        doPlay();
        ap.classList.remove('ap-collapsed');
        ap.classList.add('ap-playing');
        btn.setAttribute('aria-label', '暂停');
        btn.setAttribute('title', '暂停');
      } else {
        audio.pause();
        ap.classList.remove('ap-playing');
        btn.setAttribute('aria-label', '播放');
        btn.setAttribute('title', '点击播放');
      }
    });
    audio.addEventListener('timeupdate', function () {
      if (bar) bar.style.width = (audio.duration ? (audio.currentTime / audio.duration * 100) : 0) + '%';
      if (time) time.textContent = fmt(audio.currentTime) + ' / ' + fmt(audio.duration);
    });
    audio.addEventListener('loadedmetadata', function () {
      if (time) time.textContent = '0:00 / ' + fmt(audio.duration);
    });
    audio.addEventListener('ended', function () {
      ap.classList.remove('ap-playing');
      if (bar) bar.style.width = '0%';
      if (time) time.textContent = '0:00 / ' + fmt(audio.duration);
      btn.setAttribute('aria-label', '播放');
      btn.setAttribute('title', '点击播放');
    });
  })(players[i]);
}
initAudioPlayers();
</script>

<script>if('serviceWorker' in navigator){ window.addEventListener('load', ()=>{ navigator.serviceWorker.register('/sw.js').catch(()=>{}); }); }</script>
</body>
</html>`;
}

export function renderHome(opts: {
  siteName: string;
  tagline: string;
  slogan: string;
  logo?: string;
  favicon?: string;
  social?: SocialLinks;
  cs?: CsConfig;
  hotCourses: { id: number; title: string; cover_image: string; price: number; access_type: string; is_top: number }[];
  featuredProducts: { id: number; name: string; cover: string; price: number; sale_price: number; type: string; is_featured: number }[];
  latestArticles: { id: number; title: string; excerpt: string; access_type: string; category_name: string | null; published_at: string | null; cover_image: string; is_top: number }[];
  noticeItems: NoticeItem[];
  user?: { name: string; email: string; role: string; isVip?: boolean } | null;
  navMenu?: NavMenuItem[];
}): string {
  const courseCards: HomeCard[] = opts.hotCourses
    .map((c) => ({
      pinned: c.is_top === 1,
      html: (() => {
        const cover = c.cover_image ? `<img src="${esc(c.cover_image)}" alt="${esc(c.title)}" class="grid-cover" loading="lazy">` : `<div class="grid-cover grid-cover-ph">🎓</div>`;
        const price = c.access_type === 'paid' && c.price > 0 ? `$${c.price.toFixed(2)}` : '免费';
        const lock = c.access_type === 'paid' ? ' 🔒' : '';
        return `<a class="grid-card" href="/course/${c.id}">${cover}<div class="grid-body"><h3>${esc(c.title)}${lock}</h3><div class="grid-price">${price}</div></div></a>`;
      })(),
    }));

  const productCards: HomeCard[] = opts.featuredProducts
    .map((p) => ({
      pinned: p.is_featured === 1,
      html: (() => {
        const cover = p.cover ? `<img src="${esc(p.cover)}" alt="${esc(p.name)}" class="grid-cover" loading="lazy">` : `<div class="grid-cover grid-cover-ph">🛍</div>`;
        const price = p.sale_price > 0 ? p.sale_price : p.price;
        const typeTag = `<span class="grid-type-tag ${p.type === 'virtual' ? 'vt-virtual' : 'vt-physical'}">${p.type === 'virtual' ? '虚拟' : '实物'}</span>`;
        return `<a class="grid-card" href="/product/${p.id}">${cover}<div class="grid-body"><h3>${esc(p.name)}</h3><div class="grid-meta">${typeTag}</div><div class="grid-price">$${price.toFixed(2)}</div></div></a>`;
      })(),
    }));

  const articleCards: HomeCard[] = opts.latestArticles
    .map((a) => ({
      pinned: a.is_top === 1,
      html: (() => {
        const lock = a.access_type !== 'public' ? ' 🔒' : '';
        const cover = a.cover_image ? `<img src="${esc(a.cover_image)}" alt="${esc(a.title)}" class="grid-cover" loading="lazy">` : `<div class="grid-cover grid-cover-ph">📄</div>`;
        return `<a class="grid-card" href="/article/${a.id}">
        ${cover}
        <div class="grid-body">
          <h3>${esc(a.title)}${lock}</h3>
          <div class="grid-meta">${esc(a.category_name || '')} · ${esc(formatDate(a.published_at))}</div>
          <p class="grid-excerpt">${esc(a.excerpt || '')}</p>
        </div>
      </a>`;
      })(),
    }));

  const homeRotate = buildHomeRotate(articleCards, productCards, courseCards);
  const shown = (cards: HomeCard[]) => cards.slice(0, 4).map((c) => c.html).join('');

  const section = (title: string, moreHref: string, key: string, cards: HomeCard[], empty: string) => `
    <section class="home-section" data-rotate="${key}">
      <div class="section-head"><h2>${title}</h2><a class="section-more" href="${moreHref}">查看更多 →</a></div>
      <div class="grid grid-4">${shown(cards) || `<p class="empty">${empty}</p>`}</div>
    </section>`;

  const content = `
    ${section('最新文章', '/articles', 'articles', articleCards, '暂无文章')}
    ${section('精选商品', '/shop', 'products', productCards, '暂无商品')}
    ${section('热门课程', '/courses', 'courses', courseCards, '暂无课程')}
    ${homeRotate}`;

  return layout({
    title: opts.siteName,
    description: `${opts.tagline} — ${opts.slogan}`,
    content,
    siteName: opts.siteName,
    tagline: opts.tagline,
    slogan: opts.slogan,
    logo: opts.logo,
    favicon: opts.favicon,
    social: opts.social,
    cs: opts.cs,
    user: opts.user,
    navMenu: opts.navMenu,
    showHero: true,
    noticeItems: opts.noticeItems,
  });
}

function adCarouselHtml(adsJson: string): string {
  return `<div class="ad-box" id="adBox">
    <span class="ad-badge">广告</span>
    <a class="ad-item" id="adItem" href="#" target="_blank" rel="noopener noreferrer sponsored">
      <img class="ad-img" id="adImg" alt="" style="display:none;">
      <span class="ad-text" id="adText"></span>
    </a>
  </div>
  <script>
  (function(){
    var ads = ${adsJson};
    if (!ads.length) return;
    var idx = Math.floor(Math.random() * ads.length);
    var link = document.getElementById('adItem');
    var img = document.getElementById('adImg');
    var text = document.getElementById('adText');
    function render(i) {
      var ad = ads[i];
      link.href = ad.url || '#';
      if (ad.image) { img.src = ad.image; img.style.display = ''; } else { img.style.display = 'none'; }
      text.textContent = ad.title || '';
    }
    render(idx);
    setInterval(function () {
      if (ads.length <= 1) return;
      var next;
      do { next = Math.floor(Math.random() * ads.length); } while (next === idx);
      idx = next;
      render(idx);
    }, 15000);
  })();
  </script>`;
}

function articleSidebarHtml(links: Record<string, any[]> | undefined, ads: any[] | undefined): string {
  const hasLinks = !!(links && ((links.article || []).length || (links.course || []).length || (links.product || []).length));
  const hasAds = !!(ads && ads.length);
  if (!hasLinks && !hasAds) return '';
  const sideItem = (it: any, phEmoji: string) => {
    const cover = it.cover
      ? `<img class="side-cover" src="${esc(it.cover)}" alt="${esc(it.title)}" loading="lazy">`
      : `<span class="side-cover side-cover-ph">${phEmoji}</span>`;
    return `<a class="side-item" href="${esc(it.url)}"><span class="side-cover-wrap">${cover}</span><span class="side-item-title">${esc(it.title)}</span></a>`;
  };
  const block = (title: string, items: any[] | undefined, phEmoji: string) =>
    items && items.length
      ? `<div class="side-block"><div class="side-title">${title}</div><div class="side-list">${items.map((it) => sideItem(it, phEmoji)).join('')}</div></div>`
      : '';
  let html = '';
  if (links) {
    html += block('相关文章', links.article, '📄');
    html += block('关联课程', links.course, '🎓');
    html += block('热门商品', links.product, '🛍');
  }
  if (hasAds) {
    const adsJson = JSON.stringify((ads || []).map((ad) => ({ title: ad.title, image: ad.image, url: ad.url })));
    html += `<div class="side-block"><div class="side-title">热门推荐</div>${adCarouselHtml(adsJson)}</div>`;
  }
  return html;
}

export function renderArticle(opts: {
  siteName: string;
  tagline: string;
  slogan: string;
  logo?: string;
  favicon?: string;
  social?: SocialLinks;
  cs?: CsConfig;
  article: {
    id: number;
    title: string;
    content: string;
    excerpt: string;
    access_type: string;
    category_name: string | null;
    published_at: string | null;
    view_count: number;
    type: string;
    price: number;
  };
  canRead: boolean;
  payMethods?: string[];
  links?: Record<string, any[]>;
  ads?: any[];
  user?: { name: string; email: string; role: string; isVip?: boolean } | null;
  navMenu?: NavMenuItem[];
}): string {
  const a = opts.article;
  const url = `${SITE_URL}/article/${a.id}`;

  let body: string;
  if (a.access_type === 'public' || opts.canRead) {
    body = `<div class="article-body">${a.content}</div>`;
  } else {
    const buyBtn =
      a.price > 0
        ? opts.user
          ? `<button class="btn-primary" onclick="openBuyModal(this, 'article', ${a.id}, ${a.price}, false)" data-title="${esc(a.title)}">单独购买 $${a.price.toFixed(2)}</button>`
          : `<a class="btn-primary" href="/login">登录后购买 $${a.price.toFixed(2)}</a>`
        : '';
    body = `<div class="paywall">
      <div class="paywall-box">
        <div class="paywall-icon">🔒</div>
        <h2>本文为付费内容</h2>
        <p>${esc(a.excerpt || '')}</p>
        <div class="paywall-actions">
          <a class="btn-primary" href="/vip">👑 订阅会员，解锁全站文章和课程内容</a>
          ${buyBtn}
        </div>
        ${opts.user ? '<p class="paywall-hint">已是会员？请确认会员状态，或单独购买本文</p>' : '<p class="paywall-hint">请先登录后再购买</p>'}
      </div>
    </div>`;
  }

  const sidebar = articleSidebarHtml(opts.links, opts.ads);

  const content = `
    <div class="article-layout">
      <div class="article-main">
        <article class="article-full">
          <h1>${esc(a.title)}</h1>
          <div class="article-meta">
            ${esc(a.category_name || '未分类')} · ${esc(formatDate(a.published_at))} · ${a.view_count} 阅读
            ${a.access_type !== 'public' ? ' · 🔒 付费' : ''}
            ${a.price > 0 ? ` · 💰 $${a.price.toFixed(2)}` : ''}
          </div>
          ${body}
        </article>
        <div class="article-comments">
          <h2 class="article-comments-title">💬 文章评论 <span id="articleCommentCount" class="comment-count"></span></h2>
          <div id="articleCommentList"><p class="empty">加载中...</p></div>
          <div class="comment-form">
            <h3>发表评论</h3>
            ${opts.user
              ? `<textarea id="articleCommentContent" placeholder="写下你的评论..." rows="3"></textarea>
            <button class="btn-primary" type="button" onclick="submitArticleComment(${a.id})">提交评论</button>
            <div id="articleCommentMsg" style="margin-top:8px;font-size:.85rem;"></div>`
              : `<p class="comment-login-tip">💬 请 <a href="/login">登录</a> 后参与评论</p>`}
          </div>
        </div>
      </div>
      ${sidebar ? `<aside class="article-sidebar">${sidebar}</aside>` : ''}
    </div>
    ${buyScript(opts.payMethods || [])}
    <script>
    async function loadArticleComments(articleId) {
      var el = document.getElementById('articleCommentList');
      var countEl = document.getElementById('articleCommentCount');
      var r = await fetch('/api/articles/' + articleId + '/comments');
      var d = await r.json();
      var list = d.comments || [];
      if (countEl) countEl.textContent = list.length ? '(' + list.length + ')' : '';
      if (!list.length) { el.innerHTML = '<p class="empty">暂无评论，快来抢沙发～</p>'; return; }
      el.innerHTML = list.map(function (cm) {
        var reply = cm.reply ? '<div class="comment-reply">管理员回复：' + cm.reply.replace(/</g, '&lt;') + '</div>' : '';
        return '<div class="comment-item"><div class="comment-head"><span class="comment-name">' + (cm.user_name || '匿名').replace(/</g, '&lt;') + '</span><span class="comment-date">' + (cm.created_at || '').slice(0, 10) + '</span></div><div class="comment-body">' + cm.content.replace(/</g, '&lt;') + '</div>' + reply + '</div>';
      }).join('');
    }
    async function submitArticleComment(articleId) {
      var content = document.getElementById('articleCommentContent').value.trim();
      var msg = document.getElementById('articleCommentMsg');
      if (!content) { msg.textContent = '请填写评论内容'; msg.style.color = '#ff6b6b'; return; }
      var r = await fetch('/api/articles/' + articleId + '/comments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: content }) });
      var d = await r.json();
      if (d.error) { if (d.error.indexOf('登录') >= 0) location.href = '/login'; else { msg.textContent = d.error; msg.style.color = '#ff6b6b'; } return; }
      msg.textContent = '评论已提交，审核通过后展示'; msg.style.color = 'var(--teal)';
      document.getElementById('articleCommentContent').value = '';
    }
    loadArticleComments(${a.id});
    </script>`;

  return layout({
    title: a.title,
    description: a.excerpt,
    content,
    siteName: opts.siteName,
    tagline: opts.tagline,
    slogan: opts.slogan,
    logo: opts.logo,
    favicon: opts.favicon,
    social: opts.social,
    cs: opts.cs,
    user: opts.user,
    navMenu: opts.navMenu,
  });
}

export function renderCategory(opts: {
  siteName: string;
  tagline: string;
  slogan: string;
  logo?: string;
  favicon?: string;
  social?: SocialLinks;
  cs?: CsConfig;
  category: { name: string; description: string };
  articles: {
    id: number;
    title: string;
    excerpt: string;
    access_type: string;
    published_at: string | null;
  }[];
  user?: { name: string; email: string; role: string; isVip?: boolean } | null;
  navMenu?: NavMenuItem[];
}): string {
  const articleList = opts.articles
    .map((a) => {
      const lock = a.access_type !== 'public' ? ' 🔒' : '';
      return `<article class="card article-card">
        <h2><a href="/article/${a.id}">${esc(a.title)}</a>${lock}</h2>
        <div class="article-meta">${esc(formatDate(a.published_at))}</div>
        <p class="excerpt">${esc(a.excerpt || '')}</p>
      </article>`;
    })
    .join('');

  const content = `
    <h1>分类：${esc(opts.category.name)}</h1>
    <p class="cat-desc">${esc(opts.category.description || '')}</p>
    <div class="home-articles">${articleList || '<p class="empty">该分类暂无文章</p>'}</div>`;

  return layout({
    title: opts.category.name,
    description: opts.category.description,
    content,
    siteName: opts.siteName,
    tagline: opts.tagline,
    slogan: opts.slogan,
    logo: opts.logo,
    favicon: opts.favicon,
    social: opts.social,
    cs: opts.cs,
    user: opts.user,
    navMenu: opts.navMenu,
  });
}

function paginationHtml(page: number, totalPages: number, basePath: string): string {
  if (totalPages <= 1) return '';
  const prev = page > 1 ? `<a class="page-btn" href="${basePath}?page=${page - 1}">← 上一组</a>` : `<span class="page-btn disabled">← 上一组</span>`;
  const next = page < totalPages ? `<a class="page-btn" href="${basePath}?page=${page + 1}">下一组 →</a>` : `<span class="page-btn disabled">下一组 →</span>`;
  return `<div class="pagination">${prev}<span class="page-info">${page} / ${totalPages}</span>${next}</div>`;
}

function helperPagination(page: number, totalPages: number, basePath: string): string {
  if (totalPages <= 1) return '';
  let nums = '';
  const start = Math.max(1, page - 2);
  const end = Math.min(totalPages, page + 2);
  if (start > 1) nums += `<a class="page-btn" href="${basePath}?page=1">1</a>${start > 2 ? '<span class="page-info">…</span>' : ''}`;
  for (let i = start; i <= end; i++) nums += `<a class="page-btn${i === page ? ' active' : ''}" href="${basePath}?page=${i}">${i}</a>`;
  if (end < totalPages) nums += `${end < totalPages - 1 ? '<span class="page-info">…</span>' : ''}<a class="page-btn" href="${basePath}?page=${totalPages}">${totalPages}</a>`;
  return `<div class="pagination">
    ${page > 1 ? `<a class="page-btn" href="${basePath}?page=${page - 1}">上一页</a>` : `<span class="page-btn disabled">上一页</span>`}
    ${nums}
    ${page < totalPages ? `<a class="page-btn" href="${basePath}?page=${page + 1}">下一页</a>` : `<span class="page-btn disabled">下一页</span>`}
  </div>`;
}

export function renderHelper(opts: {
  siteName: string;
  tagline: string;
  slogan: string;
  logo?: string;
  favicon?: string;
  social?: SocialLinks;
  cs?: CsConfig;
  articles: { id: number; title: string }[];
  page: number;
  totalPages: number;
  user?: { name: string; email: string; role: string; isVip?: boolean } | null;
  navMenu?: NavMenuItem[];
}): string {
  const list = opts.articles.length
    ? opts.articles.map((a) => `<a class="helper-item" href="/article/${a.id}" target="_blank" rel="noopener noreferrer">${esc(a.title)}</a>`).join('')
    : '<p class="empty">暂无帮助内容</p>';
  const content = `<h1 class="page-title">帮助中心</h1><div class="helper-list">${list}</div>${helperPagination(opts.page, opts.totalPages, '/helper')}`;
  return layout({ title: '帮助中心', description: '帮助中心', content, siteName: opts.siteName, tagline: opts.tagline, slogan: opts.slogan, logo: opts.logo, favicon: opts.favicon, social: opts.social, cs: opts.cs, user: opts.user, navMenu: opts.navMenu });
}

export function renderGrid(opts: {
  siteName: string;
  tagline: string;
  slogan: string;
  logo?: string;
  favicon?: string;
  social?: SocialLinks;
  cs?: CsConfig;
  title: string;
  subtitle: string;
  categories?: { id: number; name: string }[];
  currentCategory?: number;
  items: { id: number; title: string; cover_image: string; price: number; access_type: string; published_at: string | null; category_name: string; type: string; product_type?: string }[];
  page: number;
  totalPages: number;
  basePath: string;
  user?: { name: string; email: string; role: string; isVip?: boolean } | null;
  navMenu?: NavMenuItem[];
}): string {
  const grid = opts.items
    .map((it) => {
      const cover = it.cover_image
        ? `<img src="${esc(it.cover_image)}" alt="${esc(it.title)}" class="grid-cover" loading="lazy">`
        : `<div class="grid-cover grid-cover-ph">${it.type === 'course' ? '🎓' : '🛍'}</div>`;
      const price = it.price > 0 ? `$${it.price.toFixed(2)}` : '免费';
      const lock = it.access_type !== 'public' ? ' 🔒' : '';
      const typeTag = it.product_type ? `<span class="grid-type-tag ${it.product_type === 'virtual' ? 'vt-virtual' : 'vt-physical'}">${it.product_type === 'virtual' ? '虚拟' : '实物'}</span>` : '';
      const href = it.type === 'course' ? `/course/${it.id}` : it.type === 'product' ? `/product/${it.id}` : `/article/${it.id}`;
      return `<a class="grid-card" href="${href}">
        ${cover}
        <div class="grid-body">
          <h3>${esc(it.title)}${lock}</h3>
          <div class="grid-meta">${typeTag}${esc(it.category_name || '')}</div>
          <div class="grid-price">${price}</div>
        </div>
      </a>`;
    })
    .join('');
  const categoryTabs = `<div class="category-tabs-box"><div class="category-tabs"><a href="${esc(opts.basePath)}" class="tab${!opts.currentCategory ? ' active' : ''}">全部</a>${(opts.categories || []).map((cat) => `<a href="${esc(opts.basePath)}?category=${cat.id}" class="tab${opts.currentCategory === cat.id ? ' active' : ''}">${esc(cat.name)}</a>`).join('')}</div><button type="button" class="cat-toggle" style="display:none;" onclick="toggleCatTabs(this)" aria-label="展开更多分类">›</button></div>`;
  const content = `${categoryTabs}<div class="grid grid-4">${grid || '<p class="empty">暂无内容</p>'}</div>${paginationHtml(opts.page, opts.totalPages, opts.basePath)}`;
  return layout({
    title: opts.title,
    content,
    siteName: opts.siteName,
    tagline: opts.tagline,
    slogan: opts.slogan,
    logo: opts.logo,
    favicon: opts.favicon,
    social: opts.social,
    cs: opts.cs,
    user: opts.user,
    navMenu: opts.navMenu,
  });
}

export function renderArticles(opts: {
  siteName: string;
  tagline: string;
  slogan: string;
  logo?: string;
  favicon?: string;
  social?: SocialLinks;
  cs?: CsConfig;
  categories?: { id: number; name: string }[];
  currentCategory?: number;
  articles: { id: number; title: string; excerpt: string; access_type: string; published_at: string | null; category_name: string; cover_image: string }[];
  page: number;
  totalPages: number;
  basePath: string;
  user?: { name: string; email: string; role: string; isVip?: boolean } | null;
  navMenu?: NavMenuItem[];
}): string {
  const list = opts.articles
    .map((a) => {
      const lock = a.access_type !== 'public' ? ' 🔒' : '';
      const cover = a.cover_image ? `<img src="${esc(a.cover_image)}" alt="${esc(a.title)}" class="grid-cover" loading="lazy">` : `<div class="grid-cover grid-cover-ph">📄</div>`;
      return `<a class="grid-card" href="/article/${a.id}">
        ${cover}
        <div class="grid-body">
          <h3>${esc(a.title)}${lock}</h3>
          <div class="grid-meta">${esc(a.category_name || '未分类')} · ${esc(formatDate(a.published_at))}</div>
          <p class="grid-excerpt">${esc(a.excerpt || '')}</p>
        </div>
      </a>`;
    })
    .join('');
  const categoryTabs = `<div class="category-tabs-box"><div class="category-tabs"><a href="${esc(opts.basePath)}" class="tab${!opts.currentCategory ? ' active' : ''}">全部</a>${(opts.categories || []).map((cat) => `<a href="${esc(opts.basePath)}?category=${cat.id}" class="tab${opts.currentCategory === cat.id ? ' active' : ''}">${esc(cat.name)}</a>`).join('')}</div><button type="button" class="cat-toggle" style="display:none;" onclick="toggleCatTabs(this)" aria-label="展开更多分类">›</button></div>`;
  const content = `${categoryTabs}<div class="grid grid-4">${list || '<p class="empty">暂无文章</p>'}</div>${paginationHtml(opts.page, opts.totalPages, opts.basePath)}`;
  return layout({
    title: '文章',
    description: '全部文章',
    content,
    siteName: opts.siteName,
    tagline: opts.tagline,
    slogan: opts.slogan,
    logo: opts.logo,
    favicon: opts.favicon,
    social: opts.social,
    cs: opts.cs,
    user: opts.user,
    navMenu: opts.navMenu,
  });
}

function buildEmbedUrl(video: { video_type: string; video_url: string }): string {
  const type = video.video_type || 'direct';
  const url = (video.video_url || '').trim();
  if (!url) return '';
  if (type === 'bilibili') {
    const m = url.match(/BV[\w]+/i);
    return m ? `https://player.bilibili.com/player.html?bvid=${m[0]}&high_quality=1&autoplay=0` : url;
  }
  if (type === 'youtube') {
    const m = url.match(/(?:v=|youtu\.be\/)([\w-]+)/i);
    return m ? `https://www.youtube.com/embed/${m[1]}?rel=0` : url;
  }
  return url;
}

const PAY_METHOD_LABELS: Record<string, string> = { alipay: '支付宝', wxpay: '微信', usdt: 'USDT', stripe: 'Stripe' };
function buyScript(payMethods: string[]): string {
  const methods = payMethods && payMethods.length ? payMethods : ['usdt', 'wxpay', 'alipay', 'stripe'];
  const radios = methods.map((m, i) => `<label><input type="radio" name="bm_method" value="${m}"${i === 0 ? ' checked' : ''}> ${PAY_METHOD_LABELS[m] || m}</label>`).join('');
  const firstMethod = methods[0] || 'usdt';
  return `<script>
function escHtml(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function submitOrder(url, body) {
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(function(r){ return r.json(); }).then(function(d) {
      if (d.error) { alert(d.error); return; }
      var form = document.createElement('form'); form.method='post'; form.action=d.submit_url;
      for (var k in d.params) { var inp=document.createElement('input'); inp.type='hidden'; inp.name=k; inp.value=d.params[k]; form.appendChild(inp); }
      document.body.appendChild(form); form.submit();
    }).catch(function(){ alert('创建订单失败，请重试'); });
}
var _buyCtx = null;
function ensureBuyModal() {
  if (document.getElementById('buyModalOverlay')) return;
  var html = '<div class="buy-modal-overlay" id="buyModalOverlay" style="display:none;"><div class="buy-modal">' +
    '<div class="bm-head"><span id="bm_title" style="font-weight:700;"></span><a href="javascript:;" onclick="closeBuyModal()" style="color:var(--text-muted);text-decoration:none;">✕</a></div>' +
    '<div class="bm-body">' +
    '<div class="bm-row"><label>金额</label><span class="bm-price" id="bm_price"></span></div>' +
    '<div class="bm-row"><label>数量</label>' +
      '<div class="bm-qty-stepper">' +
        '<button type="button" onclick="bmQty(-1)" aria-label="减少数量">−</button>' +
        '<span id="bm_qty">1</span>' +
        '<button type="button" onclick="bmQty(1)" aria-label="增加数量">＋</button>' +
      '</div>' +
    '</div>' +
    '<div id="bm_addr" style="display:none;">' +
      '<div class="bm-row"><label>收货地址</label></div><div id="bm_addr_list"></div>' +
      '<a href="javascript:;" onclick="toggleNewAddr()" style="font-size:.85rem;color:var(--gold);">＋ 新增地址</a>' +
      '<div id="bm_new_addr" style="display:none;margin-top:8px;">' +
        '<input id="bm_name" placeholder="收货人姓名"><input id="bm_phone" placeholder="联系电话"><input id="bm_detail" placeholder="详细地址">' +
        '<input id="bm_province" placeholder="省/州(可选)"><input id="bm_city" placeholder="城市(可选)"><input id="bm_country" placeholder="国家(可选)">' +
      '</div>' +
    '</div>' +
    '<div class="bm-row"><label>支付方式</label></div>' +
    '<div class="bm-methods">${radios}</div>' +
    '</div>' +
    '<div class="bm-foot"><button class="btn-primary" onclick="submitBuy()" style="width:100%;">提交订单</button></div>' +
    '</div></div>';
  var div = document.createElement('div'); div.innerHTML = html; document.body.appendChild(div.firstChild);
}
function openBuyModal(el, type, id, price, isPhysical) {
  ensureBuyModal();
  _buyCtx = { type: type, id: id, isPhysical: isPhysical };
  document.getElementById('bm_title').textContent = el.getAttribute('data-title') || '';
  document.getElementById('bm_price').textContent = '$' + Number(price).toFixed(2);
  document.getElementById('bm_addr').style.display = isPhysical ? '' : 'none';
  document.getElementById('bm_new_addr').style.display = 'none';
  document.getElementById('bm_qty').textContent = '1';
  document.getElementById('buyModalOverlay').style.display = 'flex';
  if (isPhysical) loadBuyAddresses();
}
function bmQty(delta) {
  var el = document.getElementById('bm_qty');
  var q = parseInt(el.textContent, 10) || 1;
  q = Math.max(1, q + delta);
  el.textContent = String(q);
}
function closeBuyModal() { document.getElementById('buyModalOverlay').style.display = 'none'; }
function toggleNewAddr() { var el = document.getElementById('bm_new_addr'); el.style.display = el.style.display === 'none' ? '' : 'none'; }
async function loadBuyAddresses() {
  var r = await fetch('/api/account/addresses'); var d = await r.json();
  var list = d.addresses || []; var el = document.getElementById('bm_addr_list');
  if (!list.length) { el.innerHTML = '<div style="color:var(--text-muted);font-size:.85rem;">暂无收货地址，请新增</div>'; return; }
  el.innerHTML = list.map(function(a) {
    return '<label style="display:flex;gap:6px;align-items:center;padding:4px 0;font-size:.9rem;"><input type="radio" name="bm_addr_id" value="' + a.id + '"' + (a.is_default ? ' checked' : '') + '> ' + escHtml(a.name) + ' ' + escHtml(a.phone) + '<span style="color:var(--text-muted);font-size:.8rem;">' + escHtml(a.detail) + (a.is_default ? '（默认）' : '') + '</span></label>';
  }).join('');
}
async function submitBuy() {
  if (!_buyCtx) return;
  var m = document.querySelector('input[name="bm_method"]:checked');
  var method = m ? m.value : '${firstMethod}';
  var body = { method: method };
  if (_buyCtx.type === 'course') {
    body.course_id = _buyCtx.id;
    submitOrder('/api/course/order', body);
    return;
  }
  if (_buyCtx.type === 'article') {
    body.article_id = _buyCtx.id;
    submitOrder('/api/article/order', body);
    return;
  }
  body.product_id = _buyCtx.id;
  body.quantity = parseInt(document.getElementById('bm_qty').textContent, 10) || 1;
  if (_buyCtx.isPhysical) {
    var sel = document.querySelector('input[name="bm_addr_id"]:checked');
    if (sel) {
      body.address_id = Number(sel.value);
    } else {
      var name = document.getElementById('bm_name').value.trim();
      var phone = document.getElementById('bm_phone').value.trim();
      var detail = document.getElementById('bm_detail').value.trim();
      if (!name || !phone || !detail) { alert('请填写收货人、电话和详细地址'); return; }
      var ar = await fetch('/api/account/addresses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name, phone: phone, detail: detail, province: document.getElementById('bm_province').value.trim(), city: document.getElementById('bm_city').value.trim(), country: document.getElementById('bm_country').value.trim() }) });
      var ad = await ar.json();
      if (ad.error) { alert(ad.error); return; }
      body.address_id = ad.id;
    }
  }
  submitOrder('/api/product/order', body);
}
</script>`;
}

export function renderCourse(opts: {
  siteName: string;
  tagline: string;
  slogan: string;
  logo?: string;
  favicon?: string;
  social?: SocialLinks;
  cs?: CsConfig;
  course: { id: number; title: string; cover_image: string; intro: string; price: number; access_type: string; is_top: number; sticky_order: number; created_at: string };
  chapters: { id: number; title: string; videos: { id: number; title: string; video_type: string; video_url: string; is_free: number; article_id: number; article_title: string }[] }[];
  canAccess: boolean;
  purchased: boolean;
  payMethods?: string[];
  user?: { name: string; email: string; role: string; isVip?: boolean } | null;
  navMenu?: NavMenuItem[];
}): string {
  const a = opts.course;
  const allVideos: any[] = [];
  for (const ch of opts.chapters) for (const v of ch.videos) allVideos.push(v);
  const firstPlayable = allVideos.find((v) => opts.canAccess || v.is_free);
  const firstEmbed = firstPlayable ? buildEmbedUrl(firstPlayable) : '';

  const player = firstEmbed
    ? `<div class="course-player"><iframe src="${firstEmbed}" allowfullscreen frameborder="0" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture"></iframe></div>`
    : `<div class="course-player course-player-empty"><div>📼 暂无视频内容</div></div>`;

  let purchaseBar = '';
  if (a.access_type === 'paid' && !opts.canAccess) {
    purchaseBar = `<div class="course-buy"><span class="course-price">$${a.price.toFixed(2)}</span>${opts.user ? `<button class="btn-primary" onclick="openBuyModal(this, 'course', ${a.id}, ${a.price}, false)" data-title="${esc(a.title)}">立即购买</button>` : `<a class="btn-primary" href="/login">登录后购买</a>`}</div>`;
  } else if (opts.purchased) {
    purchaseBar = `<div class="course-buy"><span class="badge badge-public">✅ 已购买</span></div>`;
  } else if (opts.canAccess && a.access_type === 'paid') {
    purchaseBar = `<div class="course-buy"><span class="badge badge-public">👑 会员可看</span></div>`;
  }

  const chapterHtml = opts.chapters
    .map((ch) => {
      const videos = ch.videos
        .map((v) => {
          const playable = opts.canAccess || !!v.is_free;
          const lock = playable ? '' : ' 🔒';
          const articleLink = v.article_id
            ? `<a class="course-video-article" href="/article/${v.article_id}" target="_blank" rel="noopener noreferrer" title="在新标签页打开相关文章">📄 相关文章：${esc(v.article_title || '文章 #' + v.article_id)}</a>`
            : '';
          return `<div class="course-video-item"><a href="javascript:;" class="course-video-link${playable ? '' : ' locked'}" data-embed="${esc(buildEmbedUrl(v))}" data-title="${esc(v.title)}" onclick="playVideo(this)">${esc(v.title)}${lock}</a>${articleLink}</div>`;
        })
        .join('');
      return `<div class="course-chapter"><div class="course-chapter-title">${esc(ch.title)}</div>${videos}</div>`;
    })
    .join('');

  const content = `
    <article class="course-full">
      <div class="course-head">
        <h1>${esc(a.title)}</h1>
        <div class="course-head-meta">
          <div class="article-meta">${esc(formatDate(a.created_at))}${a.access_type === 'paid' ? ' · 🔒 付费' : ' · 免费'}</div>
          ${purchaseBar}
        </div>
      </div>
      <div class="course-layout">
        <div class="course-main">
          ${player}
          <div class="course-intro">${a.intro || ''}</div>
        </div>
        <aside class="course-sidebar"><h2>课程目录</h2>${chapterHtml || '<p class="empty">暂无章节</p>'}</aside>
      </div>
    </article>
    <script>
    function playVideo(el) {
      var embed = el.getAttribute('data-embed');
      var iframe = document.querySelector('.course-player iframe');
      if (iframe && embed) iframe.src = embed;
      document.querySelectorAll('.course-video-link').forEach(function(x){ x.classList.remove('active'); });
      el.classList.add('active');
    }
    </script>
    ${buyScript(opts.payMethods || [])}`;
  return layout({ title: a.title, description: a.intro, content, siteName: opts.siteName, tagline: opts.tagline, slogan: opts.slogan, logo: opts.logo, favicon: opts.favicon, social: opts.social, cs: opts.cs, user: opts.user, navMenu: opts.navMenu });
}

export function renderProduct(opts: {
  siteName: string;
  tagline: string;
  slogan: string;
  logo?: string;
  favicon?: string;
  social?: SocialLinks;
  cs?: CsConfig;
  product: { id: number; name: string; cover: string; images: string; short_description: string; price: number; sale_price: number; type: string; description: string; stock: number; file_url: string; file_name: string; file_size: number; hidden_content: string; is_featured: number; is_hot: number; sort_order: number; created_at: string };
  canAccess: boolean;
  purchased: boolean;
  vipDiscount?: number;
  payMethods?: string[];
  user?: { name: string; email: string; role: string; isVip?: boolean } | null;
  navMenu?: NavMenuItem[];
}): string {
  const a = opts.product;
  const isVirtual = a.type === 'virtual';
  const price = a.sale_price > 0 ? a.sale_price : a.price;
  const vipDiscount = opts.vipDiscount ?? 100;
  const isVipDiscount = !!(opts.user?.isVip) && vipDiscount < 100 && vipDiscount > 0 && price > 0;
  const finalPrice = isVipDiscount ? Math.round(price * vipDiscount) / 100 : price;
  const priceText = price > 0 ? `$${price.toFixed(2)}` : '免费';
  const finalPriceText = finalPrice > 0 ? `$${finalPrice.toFixed(2)}` : '免费';
  const priceShow = isVipDiscount ? `<span style="text-decoration:line-through;opacity:.6;margin-right:8px;">${priceText}</span><span class="vip-discount">${finalPriceText}</span><span class="badge badge-public" style="margin-left:8px;">👑 VIP ${vipDiscount}折</span>` : priceText;

  // 相册：封面 + images JSON 数组
  let images: string[] = [];
  try { images = JSON.parse(a.images || '[]'); } catch { images = []; }
  if (!Array.isArray(images)) images = [];
  const gallery = a.cover ? [a.cover, ...images.filter((i) => i && i !== a.cover)] : images.filter(Boolean);
  const galleryJson = JSON.stringify(gallery);

  const shortDesc = a.short_description ? `<div class="product-short-desc">${esc(a.short_description)}</div>` : '';
  const stockText = isVirtual ? '' : (a.stock > 0 ? `<span class="product-stock-in">📦 现货：${a.stock} 件</span>` : `<span class="product-stock-out">📦 暂时缺货</span>`);

  let purchaseBar = '';
  const buyBtn = (finalPrice > 0 || a.type === 'physical')
    ? `<div class="product-actions">
        ${opts.user ? `<button class="btn-primary" onclick="openBuyModal(this, 'product', ${a.id}, ${finalPrice}, ${isVirtual ? 'false' : 'true'})" data-title="${esc(a.name)}">立即购买</button>` : `<a class="btn-primary" href="/login">登录后购买</a>`}
        <button class="btn-ghost add-cart-btn" onclick="addToCart(${a.id})">🛒 加入购物车</button>
      </div>`
    : (price > 0 && !opts.canAccess ? `<div class="product-actions">${opts.user ? `<button class="btn-primary" onclick="openBuyModal(this, 'product', ${a.id}, ${finalPrice}, ${isVirtual ? 'false' : 'true'})" data-title="${esc(a.name)}">立即购买</button>` : `<a class="btn-primary" href="/login">登录后购买</a>`}</div>` : '');
  if (opts.purchased && isVirtual) purchaseBar = `<div class="course-buy"><span class="badge badge-public">✅ 已购买</span></div>`;
  else if (opts.canAccess && isVirtual && price > 0) purchaseBar = `<div class="course-buy"><span class="badge badge-public">👑 会员可看</span></div>`;
  else purchaseBar = buyBtn;

  // 商品描述（公开部分）
  const descHtml = `<div class="article-body">${a.description || '<p>暂无描述</p>'}</div>`;

  // 虚拟商品：下载 + 隐藏内容（购买后可见）
  // 若既无下载文件也无隐藏内容，则不显示下载/付费墙区块
  let virtualBlock = '';
  if (isVirtual && (a.file_url || a.hidden_content)) {
    if (opts.canAccess) {
      const downloadBtn = a.file_url ? `<a class="btn-primary" href="/api/product/${a.id}/download" style="display:inline-flex;align-items:center;gap:6px;">⬇️ 下载文件${a.file_name ? `（${esc(a.file_name)}）` : ''}</a>` : '';
      const hidden = a.hidden_content ? `<div class="hidden-content-box"><div class="hc-title">🔐 购买后可见内容</div><div class="article-body">${a.hidden_content}</div></div>` : '';
      virtualBlock = `<div class="virtual-access">${downloadBtn}${hidden}</div>`;
    } else {
      virtualBlock = `<div class="paywall"><div class="paywall-box"><div class="paywall-icon">🔒</div><h2>购买后可下载</h2><p>购买后即可下载文件${a.hidden_content ? '并查看隐藏内容' : ''}</p></div></div>`;
    }
  }

  const galleryHtml = `<div class="gallery">
      <div class="gallery-main-wrap">
        <div class="gallery-main" id="galleryMain"></div>
        <button class="gallery-btn gallery-prev" type="button" onclick="galleryPrev()" aria-label="上一张">‹</button>
        <button class="gallery-btn gallery-next" type="button" onclick="galleryNext()" aria-label="下一张">›</button>
        <button class="gallery-zoom" type="button" onclick="galleryZoom()" title="放大查看">🔍</button>
        <div class="gallery-count" id="galleryCount"></div>
      </div>
      <div class="gallery-thumbs" id="galleryThumbs"></div>
    </div>`;

  const content = `
    <article class="product-full">
      <div class="product-layout">
        <div class="product-gallery-col">${galleryHtml}</div>
        <div class="product-info-col">
          <h1 class="product-title">${esc(a.name)}</h1>
          ${shortDesc}
          <div class="product-meta">${isVirtual ? '🛒 虚拟商品' : '📦 实物商品'} · ${esc(formatDate(a.created_at))}</div>
          <div class="product-price-row">${priceShow}</div>
          <div class="product-stock-row">${stockText}</div>
          ${purchaseBar}
        </div>
      </div>
      <div class="product-tabs">
        <button class="tab-btn active" type="button" onclick="switchTab('desc', this)">商品描述</button>
        <button class="tab-btn" type="button" onclick="switchTab('reviews', this)">评价</button>
      </div>
      <div class="tab-panel" id="tab-desc">${descHtml}${virtualBlock}</div>
      <div class="tab-panel" id="tab-reviews" style="display:none;">
        <div id="commentList"><p class="empty">加载中...</p></div>
        <div class="comment-form">
          <h3>发表评价</h3>
          <div class="rating-input" id="ratingInput">
            ${[1, 2, 3, 4, 5].map((n) => `<span class="star" data-star="${n}" onclick="setRating(${n})">☆</span>`).join('')}
          </div>
          <textarea id="commentContent" placeholder="分享你的使用体验..." rows="3"></textarea>
          <button class="btn-primary" type="button" onclick="submitComment(${a.id})">提交评价</button>
          <div id="commentMsg" style="margin-top:8px;font-size:.85rem;"></div>
        </div>
      </div>
    </article>
    <div id="lightbox" class="lightbox" style="display:none;" onclick="closeLightbox()"><img id="lightboxImg" alt="商品图片放大图"></div>
    ${buyScript(opts.payMethods || [])}
    <script>
    var _gallery = ${galleryJson};
    var _gi = 0;
    function renderGallery() {
      var main = document.getElementById('galleryMain');
      var thumbs = document.getElementById('galleryThumbs');
      var count = document.getElementById('galleryCount');
      if (!main || !thumbs) return;
      if (!_gallery.length) { main.innerHTML = '<div class="gallery-ph">🛍</div>'; thumbs.innerHTML = ''; if (count) count.textContent = ''; return; }
      main.innerHTML = '<img src="' + _gallery[_gi] + '" alt="商品图片" onclick="galleryZoom()">';
      if (count) count.textContent = (_gi + 1) + ' / ' + _gallery.length;
      thumbs.innerHTML = _gallery.map(function (src, i) {
        return '<img src="' + src + '" class="thumb' + (i === _gi ? ' active' : '') + '" onclick="_gi=' + i + ';renderGallery();" alt="缩略图">';
      }).join('');
    }
    function galleryPrev() { if (_gallery.length) { _gi = (_gi - 1 + _gallery.length) % _gallery.length; renderGallery(); } }
    function galleryNext() { if (_gallery.length) { _gi = (_gi + 1) % _gallery.length; renderGallery(); } }
    function galleryZoom() { if (!_gallery.length) return; document.getElementById('lightboxImg').src = _gallery[_gi]; document.getElementById('lightbox').style.display = 'flex'; }
    function closeLightbox() { document.getElementById('lightbox').style.display = 'none'; }
    function switchTab(tab, btn) {
      document.getElementById('tab-desc').style.display = tab === 'desc' ? '' : 'none';
      document.getElementById('tab-reviews').style.display = tab === 'reviews' ? '' : 'none';
      document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
      if (btn) btn.classList.add('active');
      if (tab === 'reviews') loadComments(${a.id});
    }
    async function addToCart(productId) {
      var r = await fetch('/api/cart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product_id: productId, quantity: 1 }) });
      var d = await r.json();
      if (d.error) { if (d.error.indexOf('登录') >= 0) location.href = '/login'; else alert(d.error); return; }
      alert('已加入购物车 🛒');
      if (typeof loadCartCount === 'function') loadCartCount();
    }
    var _rating = 5;
    function setRating(n) {
      _rating = n;
      document.querySelectorAll('#ratingInput .star').forEach(function (s) { s.textContent = parseInt(s.getAttribute('data-star')) <= n ? '★' : '☆'; });
    }
    setRating(5);
    async function loadComments(productId) {
      var el = document.getElementById('commentList');
      var r = await fetch('/api/products/' + productId + '/comments');
      var d = await r.json();
      var list = d.comments || [];
      if (!list.length) { el.innerHTML = '<p class="empty">暂无评价，快来抢沙发～</p>'; return; }
      el.innerHTML = list.map(function (cm) {
        var stars = ''; for (var i = 1; i <= 5; i++) stars += i <= cm.rating ? '★' : '☆';
        var reply = cm.reply ? '<div class="comment-reply">商家回复：' + cm.reply.replace(/</g, '&lt;') + '</div>' : '';
        return '<div class="comment-item"><div class="comment-head"><span class="comment-name">' + (cm.user_name || '匿名').replace(/</g, '&lt;') + '</span><span class="comment-stars">' + stars + '</span><span class="comment-date">' + (cm.created_at || '').slice(0, 10) + '</span></div><div class="comment-body">' + cm.content.replace(/</g, '&lt;') + '</div>' + reply + '</div>';
      }).join('');
    }
    async function submitComment(productId) {
      var content = document.getElementById('commentContent').value.trim();
      var msg = document.getElementById('commentMsg');
      if (!content) { msg.textContent = '请填写评价内容'; msg.style.color = '#ff6b6b'; return; }
      var r = await fetch('/api/products/' + productId + '/comments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rating: _rating, content: content }) });
      var d = await r.json();
      if (d.error) { if (d.error.indexOf('登录') >= 0) location.href = '/login'; else { msg.textContent = d.error; msg.style.color = '#ff6b6b'; } return; }
      msg.textContent = '评价已提交，审核通过后展示'; msg.style.color = 'var(--teal)';
      document.getElementById('commentContent').value = '';
      loadComments(productId);
    }
    renderGallery();
    </script>`;
  return layout({ title: a.name, description: a.short_description || '', content, siteName: opts.siteName, tagline: opts.tagline, slogan: opts.slogan, logo: opts.logo, favicon: opts.favicon, social: opts.social, cs: opts.cs, user: opts.user, navMenu: opts.navMenu });
}

export function renderCart(opts: {
  siteName: string;
  tagline: string;
  slogan: string;
  logo?: string;
  favicon?: string;
  social?: SocialLinks;
  cs?: CsConfig;
  payMethods?: string[];
  user?: { name: string; email: string; role: string; isVip?: boolean } | null;
  navMenu?: NavMenuItem[];
}): string {
  const methods = (opts.payMethods && opts.payMethods.length) ? opts.payMethods : ['usdt', 'alipay', 'wxpay', 'stripe'];
  const methodOptions = methods.map((m) => `<option value="${m}">${PAY_METHOD_LABELS[m] || m}</option>`).join('');
  const content = `
    <div class="cart-page">
      <h1 class="account-title">购物车</h1>
      <div id="cartList"><p class="empty">加载中...</p></div>
    </div>
    <div id="checkoutModal" class="checkout-modal" style="display:none;">
      <div class="checkout-box">
        <h3>🛒 合并下单</h3>
        <div id="checkoutAddress" style="display:none;">
          <div class="form-group" id="addrSelectGroup" style="display:none;">
            <label>收货地址</label>
            <select id="co_address_id"></select>
          </div>
          <div id="addrManualGroup">
            <div class="form-group"><label>收货人</label><input id="co_name" placeholder="姓名"></div>
            <div class="form-group"><label>电话</label><input id="co_phone" placeholder="手机号"></div>
            <div class="form-group"><label>详细地址</label><input id="co_address" placeholder="省市区 + 详细地址"></div>
          </div>
        </div>
        <div class="form-group"><label>支付方式</label>
          <select id="co_method">${methodOptions}</select>
        </div>
        <div class="form-error" id="co_err"></div>
        <div style="display:flex;gap:10px;margin-top:12px;">
          <button class="btn-primary" type="button" onclick="submitCheckout()">确认下单</button>
          <button class="btn-ghost" type="button" onclick="closeCheckout()">取消</button>
        </div>
      </div>
    </div>
    <script>
    var _cartHasPhysical = false;
    var _addresses = [];
    async function loadCart() {
      var el = document.getElementById('cartList');
      var r = await fetch('/api/cart');
      var d = await r.json();
      if (d.error) {
        el.innerHTML = '<div class="paywall"><div class="paywall-box"><div class="paywall-icon">🛒</div><h2>请先登录</h2><p>登录后即可使用购物车</p><a class="btn-primary" href="/login">去登录</a></div></div>';
        return;
      }
      var items = d.items || [];
      if (!items.length) { el.innerHTML = '<p class="empty">购物车是空的，去商城逛逛吧～</p>'; return; }
      _cartHasPhysical = items.some(function (it) { return it.type === 'physical'; });
      if (_cartHasPhysical) loadAddresses();
      // 会员折扣
      var _isVip = !!d.isVip;
      var _vipDiscount = parseInt(d.vipDiscount || '100', 10) || 100;
      var _vipDiscountActive = _isVip && _vipDiscount > 0 && _vipDiscount < 100;
      var total = 0;
      var vipBanner = _vipDiscountActive
        ? '<div class="cart-vip-banner">👑 VIP 会员专享 <strong>' + _vipDiscount / 10 + ' 折</strong>，商品价格已自动优惠</div>'
        : '';
      el.innerHTML = vipBanner + '<div class="cart-list">' + items.map(function (it) {
        var price = it.sale_price > 0 ? it.sale_price : it.price;
        var unit = _vipDiscountActive ? Math.round(price * _vipDiscount) / 100 : price;
        var sub = unit * it.quantity;
        total += sub;
        var priceHtml = _vipDiscountActive
          ? '<span style="text-decoration:line-through;opacity:.55;font-size:.78rem;">$' + price.toFixed(2) + '</span> <span style="color:var(--gold);font-weight:700;">$' + unit.toFixed(2) + '</span>'
          : '$' + price.toFixed(2);
        return '<div class="cart-item">' +
          '<a class="cart-item-cover" href="/product/' + it.product_id + '">' + (it.cover ? '<img src="' + it.cover + '" alt="">' : '<div class="grid-cover-ph">🛍</div>') + '</a>' +
          '<div class="cart-item-info">' +
            '<a class="cart-item-name" href="/product/' + it.product_id + '">' + it.name.replace(/</g, '&lt;') + '</a>' +
            '<div class="cart-item-price">' + priceHtml + '</div>' +
            '<div class="cart-item-qty">' +
              '<button type="button" onclick="changeQty(' + it.id + ',' + (it.quantity - 1) + ')">−</button>' +
              '<span>' + it.quantity + '</span>' +
              '<button type="button" onclick="changeQty(' + it.id + ',' + (it.quantity + 1) + ')">＋</button>' +
            '</div>' +
          '</div>' +
          '<div class="cart-item-actions">' +
            '<div class="cart-item-sub">$' + sub.toFixed(2) + '</div>' +
            '<a class="btn-ghost" style="font-size:.8rem;" href="/product/' + it.product_id + '">立即购买</a>' +
            '<button class="cart-item-del" type="button" onclick="delCart(' + it.id + ')">删除</button>' +
          '</div>' +
        '</div>';
      }).join('') + '</div>' +
      '<div class="cart-summary"><span>共 ' + items.length + ' 种商品，合计：</span><span class="cart-total">$' + total.toFixed(2) + '</span></div>' +
      '<button class="btn-primary" style="width:100%;margin-top:14px;" type="button" onclick="openCheckout()">合并下单</button>';
    }
    async function loadAddresses() {
      try {
        var r = await fetch('/api/account/addresses');
        var d = await r.json();
        _addresses = d.addresses || [];
      } catch (e) { _addresses = []; }
    }
    function openCheckout() {
      var addrBox = document.getElementById('checkoutAddress');
      document.getElementById('co_err').textContent = '';
      if (_cartHasPhysical) {
        addrBox.style.display = '';
        var selGroup = document.getElementById('addrSelectGroup');
        var manualGroup = document.getElementById('addrManualGroup');
        if (_addresses.length) {
          selGroup.style.display = '';
          manualGroup.style.display = 'none';
          var sel = document.getElementById('co_address_id');
          sel.innerHTML = _addresses.map(function (a) {
            var label = a.name + ' ' + a.phone + ' ' + (a.province || '') + (a.city || '') + (a.detail || '');
            return '<option value="' + a.id + '">' + label.replace(/</g, '&lt;') + (a.is_default ? '（默认）' : '') + '</option>';
          }).join('');
          var def = _addresses.find(function (a) { return a.is_default; }) || _addresses[0];
          if (def) sel.value = def.id;
        } else {
          selGroup.style.display = 'none';
          manualGroup.style.display = '';
        }
      } else {
        addrBox.style.display = 'none';
      }
      document.getElementById('checkoutModal').style.display = 'flex';
    }
    function closeCheckout() { document.getElementById('checkoutModal').style.display = 'none'; }
    async function submitCheckout() {
      var err = document.getElementById('co_err');
      var body = { method: document.getElementById('co_method').value };
      if (_cartHasPhysical) {
        var usingSaved = _addresses.length > 0 && document.getElementById('addrSelectGroup').style.display !== 'none';
        if (usingSaved) {
          body.address_id = document.getElementById('co_address_id').value;
        } else {
          body.name = document.getElementById('co_name').value.trim();
          body.phone = document.getElementById('co_phone').value.trim();
          body.address = document.getElementById('co_address').value.trim();
          if (!body.name || !body.phone || !body.address) { err.textContent = '请填写收货人、电话和详细地址'; return; }
        }
      }
      var r = await fetch('/api/cart/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      var d = await r.json();
      if (d.error) { err.textContent = d.error; return; }
      if (d.free) { alert('下单成功！'); location.reload(); return; }
      var form = document.createElement('form');
      form.method = 'POST'; form.action = d.submit_url;
      Object.keys(d.params || {}).forEach(function (k) {
        var input = document.createElement('input');
        input.type = 'hidden'; input.name = k; input.value = d.params[k];
        form.appendChild(input);
      });
      document.body.appendChild(form); form.submit();
    }
    async function changeQty(id, qty) {
      if (qty < 1) return;
      await fetch('/api/cart/' + id, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quantity: qty }) });
      if (typeof loadCartCount === 'function') loadCartCount();
      loadCart();
    }
    async function delCart(id) {
      if (!confirm('确认移除该商品？')) return;
      await fetch('/api/cart/' + id, { method: 'DELETE' });
      if (typeof loadCartCount === 'function') loadCartCount();
      loadCart();
    }
    loadCart();
    </script>`;
  return layout({ title: '购物车', description: '购物车', content, siteName: opts.siteName, tagline: opts.tagline, slogan: opts.slogan, logo: opts.logo, favicon: opts.favicon, social: opts.social, cs: opts.cs, user: opts.user, navMenu: opts.navMenu });
}

interface AccountUser {
  name: string;
  email: string;
  role: string;
  invite_code: string;
  membership_tier: string;
  membership_expires_at: string | null;
  email_verified: number;
  active: boolean;
  withdraw_name: string;
  withdraw_wechat: string;
  withdraw_alipay: string;
  avatar: string;
}

const PLAN_LABEL: Record<string, string> = { monthly: '月度会员', quarterly: '季度会员', annual: '年度会员' };

function accountShell(u: AccountUser, active: string, inner: string): string {
  const nav = [
    { key: 'overview', href: '/account', label: '概览', icon: '📊' },
    { key: 'purchased', href: '/account/purchased', label: '已购订单', icon: '🔓' },
    { key: 'addresses', href: '/account/addresses', label: '收货地址', icon: '📍' },
    { key: 'invite', href: '/account/invite', label: '共创计划', icon: '🎁' },
    { key: 'password', href: '/account/password', label: '修改密码', icon: '🔒' },
  ];
  const avatarHtml = u.avatar
    ? `<img class="avatar-img" src="${esc(u.avatar)}" alt="头像">`
    : `<div class="avatar">${esc((u.name || u.email || '?').slice(0, 1).toUpperCase())}</div>`;
  return `
    <div class="account-shell">
      <aside class="account-sidebar">
        <div class="account-user">
          <div class="avatar-wrap">
            ${avatarHtml}
            <button class="avatar-upload" type="button" title="更换头像" onclick="document.getElementById('avatarFileInput').click()">📷</button>
          </div>
          <div class="u-name">${esc(u.name || '')}</div>
          <div class="u-email">${esc(u.email)}</div>
          ${u.email_verified
            ? ''
            : '<div class="u-verify"><span class="u-verify-tag">未验证</span><button class="u-resend-btn" type="button" onclick="resendVerify()">重发邮件</button></div>'}
        </div>
        <nav class="account-nav">
          ${nav.map((n) => `<a href="${n.href}" class="${n.key === active ? 'active' : ''}">${n.icon} ${n.label}</a>`).join('')}
          <a href="/api/logout" class="nav-logout">🚪 退出登录</a>
        </nav>
      </aside>
      <div class="account-main">${inner}</div>
    </div>
    <input type="file" id="avatarFileInput" accept="image/*" style="display:none;" onchange="uploadAvatar(this)">
    <script>
    async function uploadAvatar(input) {
      const file = input.files && input.files[0]; if (!file) return;
      const fd = new FormData(); fd.append('file', file);
      const r = await fetch('/api/account/avatar', { method: 'POST', body: fd });
      const d = await r.json();
      if (d.error) { alert(d.error); return; }
      location.reload();
    }
    function toggleMore(id, btn) {
      const el = document.getElementById(id);
      if (!el) return;
      const hidden = el.style.display === 'none';
      el.style.display = hidden ? '' : 'none';
      btn.textContent = hidden ? '收起' : (btn.getAttribute('data-label') || '查看更多');
    }
    async function resendVerify() {
      const btn = document.querySelector('.u-resend-btn');
      if (btn) { btn.disabled = true; btn.textContent = '发送中...'; }
      try {
        const r = await fetch('/api/account/resend-verification', { method: 'POST' });
        const d = await r.json();
        if (d.error) { alert(d.error || '发送失败'); }
        else if (d.already_verified) { alert('邮箱已验证，无需重发'); location.reload(); }
        else { alert('验证邮件已重新发送，请前往收件箱查收（注意垃圾邮件）。'); }
      } catch (e) {
        alert('发送失败，请稍后再试');
      }
      if (btn) { btn.disabled = false; btn.textContent = '重发邮件'; }
    }
    </script>`;
}

export function renderAccountOverview(opts: {
  siteName: string;
  tagline: string;
  slogan: string;
  user: AccountUser;
  planLabels?: Record<string, string>;
  orders: {
    order_no: string;
    plan: string;
    amount: number;
    currency: string;
    payment_method: string;
    status: string;
    created_at: string;
    paid_at: string | null;
  }[];
}): string {
  const u = opts.user;
  const planLabels = opts.planLabels || PLAN_LABEL;
  const tierLabel = planLabels[u.membership_tier] || u.membership_tier || '未订阅';
  const membershipCard = u.active
    ? `<div class="stat-card"><div class="label">当前会员</div><div class="num" style="font-size:1.3rem;">${esc(tierLabel)}</div><div class="label">到期时间：${esc(u.membership_expires_at ? formatDate(u.membership_expires_at) : '永久')}</div></div>`
    : `<div class="stat-card"><div class="label">当前会员</div><div class="num" style="font-size:1.3rem;">未订阅</div><a class="btn-primary" href="/vip" style="margin-top:8px;">去订阅 →</a></div>`;

  const orderRowArray = opts.orders.map(
    (o) => `<tr>
      <td>${esc(o.order_no)}</td>
      <td>${esc(planLabels[o.plan] || o.plan)}</td>
      <td>${o.amount} ${esc(o.currency)}</td>
      <td>${esc(o.payment_method || '-')}</td>
      <td>${o.status === 'paid' ? '✅ 已支付' : esc(o.status)}</td>
      <td>${(o.created_at || '').slice(0, 16)}</td>
    </tr>`
  );
  const firstOrderRows = orderRowArray.slice(0, 5).join('');
  const restOrderRows = orderRowArray.slice(5).join('');
  const hasMoreOrders = opts.orders.length > 5;
  const orderTable = opts.orders.length
    ? `<div class="table-scroll"><table class="table"><thead><tr><th>订单号</th><th>方案</th><th>金额</th><th>方式</th><th>状态</th><th>时间</th></tr></thead>
        <tbody>${firstOrderRows}</tbody>
        ${restOrderRows ? `<tbody id="more-orders" style="display:none;">${restOrderRows}</tbody>` : ''}
      </table></div>`
    : '<div class="table-scroll"><table class="table"><thead><tr><th>订单号</th><th>方案</th><th>金额</th><th>方式</th><th>状态</th><th>时间</th></tr></thead><tbody><tr><td colspan="6" style="text-align:center;color:var(--text-muted);">暂无订单</td></tr></tbody></table></div>';

  const inner = `
    <h1 class="account-title">概览</h1>
    <div class="stat-grid">
      ${membershipCard}
      <div class="stat-card"><div class="label">账号</div><div class="num" style="font-size:1rem;">${esc(u.email)}</div><div class="label">${u.email_verified ? '✅ 邮箱已验证' : '❌ 未验证'}</div></div>
      <div class="stat-card"><div class="label">我的订单</div><div class="num">${opts.orders.length}</div></div>
    </div>
    <div class="section-title-row">
      <h2 class="section-title">我的订单</h2>
      ${hasMoreOrders ? `<button class="btn-ghost load-more-inline" type="button" data-label="查看更多（${opts.orders.length - 5}）" onclick="toggleMore('more-orders', this)">查看更多</button>` : ''}
    </div>
    ${orderTable}`;

  return accountShell(u, 'overview', inner);
}

function gridWithMore(title: string, renderedItems: string[], total: number, emptyText: string, moreId: string, limit = 3): string {
  if (!total) return `<h2 class="section-title">${title}</h2><p class="empty">${emptyText}</p>`;
  const first = renderedItems.slice(0, limit).join('');
  const rest = renderedItems.slice(limit).join('');
  const moreBtn = total > limit
    ? `<button class="btn-ghost load-more" type="button" data-label="查看更多（${total - limit}）" onclick="toggleMore('${moreId}', this)">查看更多（${total - limit}）</button>`
    : '';
  return `<h2 class="section-title">${title}</h2>
    <div class="grid">${first}</div>
    ${rest ? `<div class="grid" id="${moreId}" style="display:none;">${rest}</div>` : ''}
    ${moreBtn}`;
}

export function renderAccountPurchased(opts: {
  siteName: string;
  tagline: string;
  slogan: string;
  user: AccountUser;
  purchasedCourses: { course_id: number; amount: number; created_at: string; title: string; cover_image: string }[];
  purchasedProducts: { product_id: number; total_amount: number; created_at: string; status: string; tracking_no: string; tracking_company: string; name: string; cover: string; type: string }[];
  purchasedArticles: { article_id: number; amount: number; created_at: string; title: string }[];
}): string {
  const u = opts.user;
  const courseItems = opts.purchasedCourses.map((c) => {
    const cover = c.cover_image ? `<img src="${esc(c.cover_image)}" class="grid-cover">` : `<div class="grid-cover grid-cover-ph">🎓</div>`;
    return `<a class="grid-card" href="/course/${c.course_id}">${cover}<div class="grid-body"><h3>${esc(c.title)}</h3><div class="grid-meta">课程 · ${(c.created_at || '').slice(0, 10)}</div><div class="grid-price">✅ 已购</div></div></a>`;
  });
  const courseSection = gridWithMore('已购课程', courseItems, opts.purchasedCourses.length, '暂无已购课程', 'more-courses');

  const statusLabel: Record<string, string> = { paid: '✅ 已支付', shipped: '🚚 已发货', completed: '📦 已完成' };
  const productItems = opts.purchasedProducts.map((p) => {
    const cover = p.cover ? `<img src="${esc(p.cover)}" class="grid-cover">` : `<div class="grid-cover grid-cover-ph">🛍</div>`;
    const download = p.type === 'virtual' ? `<a class="btn-primary" style="margin-top:6px;font-size:.85rem;" href="/api/product/${p.product_id}/download">⬇️ 下载</a>` : '';
    const tracking = p.tracking_no ? `<div class="grid-meta">物流：${esc(p.tracking_company || '')} ${esc(p.tracking_no)}</div>` : '';
    return `<div class="grid-card"><div>${cover}</div><div class="grid-body"><h3>${esc(p.name)}</h3><div class="grid-meta">${p.type === 'virtual' ? '虚拟' : '实物'} · ${statusLabel[p.status] || p.status} · ${(p.created_at || '').slice(0, 10)}</div>${tracking}${download}</div></div>`;
  });
  const productSection = gridWithMore('已购商品', productItems, opts.purchasedProducts.length, '暂无已购商品', 'more-products');

  const articleItems = opts.purchasedArticles.map((a) => `<a class="grid-card" href="/article/${a.article_id}"><div class="grid-cover grid-cover-ph">📄</div><div class="grid-body"><h3>${esc(a.title)}</h3><div class="grid-meta">文章 · ${(a.created_at || '').slice(0, 10)}</div><div class="grid-price">✅ 已购</div></div></a>`);
  const articleSection = gridWithMore('已购文章', articleItems, opts.purchasedArticles.length, '暂无已购文章', 'more-articles');

  const inner = `
    <h1 class="account-title">已购订单</h1>
    ${courseSection}
    ${productSection}
    ${articleSection}
    <div class="vip-upsell">
      <div class="vip-upsell-left">
        <div class="vip-upsell-icon">👑</div>
        <div>
          <h2>建议开通会员，解锁全部视频课程、文章和虚拟商品</h2>
          <p>一次订阅，全站付费内容任意看、任意下</p>
        </div>
      </div>
      <a class="btn-primary" href="/vip" target="_blank" rel="noopener noreferrer">立即开通会员 →</a>
    </div>`;

  return accountShell(u, 'purchased', inner);
}

export function renderAccountAddresses(opts: {
  siteName: string;
  tagline: string;
  slogan: string;
  user: AccountUser;
  addresses: { id: number; name: string; phone: string; country: string; province: string; city: string; detail: string; zip: string; is_default: number }[];
}): string {
  const u = opts.user;
  const list = opts.addresses.length
    ? opts.addresses
        .map(
          (a) => `<div class="addr-card">
            <div class="addr-main">
              <div class="addr-line1"><strong>${esc(a.name)}</strong> ${esc(a.phone)} ${a.is_default ? '<span class="badge badge-public">默认</span>' : ''}</div>
              <div class="addr-line2">${esc([a.country, a.province, a.city, a.detail].filter(Boolean).join(' '))}${a.zip ? ' · ' + esc(a.zip) : ''}</div>
            </div>
            <div class="addr-actions">
              ${!a.is_default ? `<a href="#" onclick="setDefaultAddr(${a.id});return false;">设默认</a> · ` : ''}<a href="#" onclick="editAddr(${a.id});return false;">编辑</a> · <a href="#" style="color:var(--danger);" onclick="delAddr(${a.id});return false;">删除</a>
            </div>
          </div>`
        )
        .join('')
    : '<p class="empty">暂无收货地址，添加后可快速下单</p>';

  const inner = `
    <h1 class="account-title">收货地址</h1>
    <div class="addr-list">${list}</div>
    <h2 class="section-title">${opts.addresses.length ? '新增地址' : '添加地址'}</h2>
    <div class="addr-form">
      <input id="af_name" placeholder="收货人姓名"><input id="af_phone" placeholder="联系电话"><input id="af_detail" placeholder="详细地址">
      <input id="af_province" placeholder="省/州(可选)"><input id="af_city" placeholder="城市(可选)"><input id="af_country" placeholder="国家(可选)"><input id="af_zip" placeholder="邮编(可选)">
      <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" id="af_default"> 设为默认地址</label>
      <button class="btn-primary" onclick="saveAddr()">保存地址</button>
      <span id="af_editId" style="color:var(--text-muted);font-size:.85rem;"></span>
    </div>
    <script>
    var $ = function(id){ return document.getElementById(id); };
    var _editAddrId = null;
    function setDefaultAddr(id) { fetch('/api/account/addresses/' + id + '/default', { method: 'PUT' }).then(function(){ location.reload(); }); }
    function editAddr(id) {
      _editAddrId = id;
      fetch('/api/account/addresses').then(function(r){ return r.json(); }).then(function(d){
        var a = (d.addresses || []).find(function(x){ return x.id === id; });
        if (!a) return;
        $('af_name').value = a.name; $('af_phone').value = a.phone; $('af_detail').value = a.detail;
        $('af_province').value = a.province; $('af_city').value = a.city; $('af_country').value = a.country; $('af_zip').value = a.zip;
        $('af_default').checked = !!a.is_default;
        $('af_editId').textContent = '编辑地址 #' + id;
      });
    }
    async function saveAddr() {
      var body = {
        name: $('af_name').value.trim(), phone: $('af_phone').value.trim(), detail: $('af_detail').value.trim(),
        province: $('af_province').value.trim(), city: $('af_city').value.trim(), country: $('af_country').value.trim(), zip: $('af_zip').value.trim(),
        is_default: $('af_default').checked ? 1 : 0,
      };
      if (!body.name || !body.phone || !body.detail) { alert('请填写收货人、电话和详细地址'); return; }
      var r;
      if (_editAddrId) r = await fetch('/api/account/addresses/' + _editAddrId, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      else r = await fetch('/api/account/addresses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      var d = await r.json();
      if (d.error) { alert(d.error); return; }
      location.reload();
    }
    async function delAddr(id) {
      if (!confirm('确认删除该地址？')) return;
      await fetch('/api/account/addresses/' + id, { method: 'DELETE' });
      location.reload();
    }
    </script>`;

  return accountShell(u, 'addresses', inner);
}

export function renderAccountInvite(opts: {
  siteName: string;
  tagline: string;
  slogan: string;
  user: AccountUser;
  commissionRate: string;
  earned: string;
  paid: string;
  pending: string;
  available: string;
  invited: { email: string; name: string; created_at: string }[];
  withdrawals: { id: number; amount: string; method: string; account: string; status: string; reject_reason: string; created_at: string }[];
}): string {
  const u = opts.user;
  const inviteUrl = `${SITE_URL}/?ref=${u.invite_code}`;
  const methodLabel: Record<string, string> = { wechat: '微信', alipay: '支付宝' };

  const invitedRows = opts.invited.map((i) => `<tr><td>${esc(i.email)}</td><td>${(i.created_at || '').slice(0, 16)}</td></tr>`);
  const invitedBlock = opts.invited.length
    ? `<table class="table"><thead><tr><th>被邀请人</th><th>注册时间</th></tr></thead>
        <tbody>${invitedRows.slice(0, 3).join('')}</tbody>
        ${invitedRows.length > 3 ? `<tbody id="more-invited" style="display:none;">${invitedRows.slice(3).join('')}</tbody>` : ''}
      </table>
      ${invitedRows.length > 3 ? `<button class="btn-ghost load-more" type="button" data-label="查看更多（${invitedRows.length - 3}）" onclick="toggleMore('more-invited', this)">查看更多（${invitedRows.length - 3}）</button>` : ''}`
    : '<p class="empty">还没有邀请记录，快分享你的邀请链接吧</p>';

  const withdrawalRows = opts.withdrawals.length
    ? opts.withdrawals
        .map((w) => {
          const statusBadge =
            w.status === 'pending'
              ? '<span class="badge" style="background:rgba(232,185,35,.15);color:var(--gold);">待处理</span>'
              : w.status === 'paid'
                ? '<span class="badge" style="background:rgba(78,205,196,.15);color:var(--teal);">已处理</span>'
                : '<span class="badge" style="background:rgba(255,107,107,.15);color:#ff6b6b;">已拒绝</span>';
          const reason = w.status === 'rejected' && w.reject_reason ? `<div style="font-size:.8rem;color:#ff6b6b;">原因：${esc(w.reject_reason)}</div>` : '';
          return `<tr>
            <td>${w.amount}</td>
            <td>${esc(methodLabel[w.method] || w.method)}</td>
            <td>${esc(w.account)}</td>
            <td>${statusBadge}${reason}</td>
            <td>${(w.created_at || '').slice(0, 16)}</td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);">暂无提现记录</td></tr>';

  const inner = `
    <h1 class="account-title">共创计划</h1>

    <div class="card invite-hero">
      <h2>🎁 邀请好友，赚取 ${esc(opts.commissionRate)}% 返佣</h2>
      <p>分享你的专属邀请链接，好友注册并购买会员后，你将获得其支付金额的 <strong>${esc(opts.commissionRate)}%</strong> 作为返佣。</p>
      <p class="invite-cookie-note">🔍 <strong>Cookie 跟踪说明：</strong>好友点击你的邀请链接后，系统会通过 Cookie 记录邀请关系（有效期 30 天）。<strong>即使对方当时没有注册，只要在 30 天内使用同一浏览器完成注册，依然会成功计入你的邀请。</strong></p>
    </div>

    <div class="stat-grid" style="margin-top:16px;">
      <div class="stat-card"><div class="label">累计返佣</div><div class="num">${esc(opts.earned)}</div><div class="label">USD</div></div>
      <div class="stat-card"><div class="label">可提现余额</div><div class="num" style="color:var(--gold);">${esc(opts.available)}</div><div class="label">USD</div></div>
      <div class="stat-card"><div class="label">待处理</div><div class="num">${esc(opts.pending)}</div><div class="label">USD</div></div>
      <div class="stat-card"><div class="label">已提现</div><div class="num">${esc(opts.paid)}</div><div class="label">USD</div></div>
    </div>

    <h2 class="section-title">我的邀请</h2>
    <div class="card invite-box">
      <p>我的邀请码：<strong class="invite-code">${esc(u.invite_code)}</strong> · 已邀请 <strong>${opts.invited.length}</strong> 人</p>
      <p>邀请链接：</p>
      <div class="invite-row">
        <input type="text" value="${esc(inviteUrl)}" readonly onclick="this.select()" class="invite-input">
        <button class="btn-ghost" onclick="copyInvite(this)">复制链接</button>
      </div>
    </div>
    ${invitedBlock}

    <h2 class="section-title">提现账户</h2>
    <div class="card">
      <p class="account-sub">绑定收款账户，提现时使用。支持微信、支付宝。</p>
      <div class="form-grid">
        <div class="form-group"><label>收款人姓名</label><input id="w_name" value="${esc(u.withdraw_name || '')}" placeholder="真实姓名"></div>
        <div class="form-group"><label>微信账号</label><input id="w_wechat" value="${esc(u.withdraw_wechat || '')}" placeholder="微信号 / 收款码对应的微信"></div>
        <div class="form-group"><label>支付宝账号</label><input id="w_alipay" value="${esc(u.withdraw_alipay || '')}" placeholder="支付宝账号 / 手机号"></div>
      </div>
      <button class="btn-primary" onclick="saveAccounts(this)">保存账户</button>
    </div>

    <h2 class="section-title">申请提现</h2>
    <div class="card">
      <p class="account-sub">可提现余额：<strong style="color:var(--gold);">${esc(opts.available)} USD</strong></p>
      <div class="withdraw-row">
        <input id="wd_amount" type="number" min="1" step="0.01" placeholder="提现金额 (USD)" style="flex:1;padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg-soft);color:var(--text);">
        <select id="wd_method" style="padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg-soft);color:var(--text);">
          <option value="wechat">微信</option>
          <option value="alipay">支付宝</option>
        </select>
        <button class="btn-primary" onclick="submitWithdraw(this)">提交提现</button>
      </div>
    </div>

    <h2 class="section-title">提现记录</h2>
    <table class="table"><thead><tr><th>金额</th><th>方式</th><th>账户</th><th>状态</th><th>时间</th></tr></thead><tbody>${withdrawalRows}</tbody></table>

    <script>
    function copyInvite(btn) {
      var input = btn.parentElement.querySelector('.invite-input');
      navigator.clipboard && navigator.clipboard.writeText(input.value).then(function() {
        btn.textContent = '已复制'; setTimeout(function(){ btn.textContent = '复制链接'; }, 1500);
      });
    }
    async function saveAccounts(btn) {
      btn.disabled = true;
      var body = { withdraw_name: $('w_name').value, withdraw_wechat: $('w_wechat').value, withdraw_alipay: $('w_alipay').value };
      var r = await fetch('/api/account/withdraw-accounts', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      var d = await r.json();
      btn.disabled = false;
      toastMsg(d.ok ? '账户已保存' : (d.error || '保存失败'));
    }
    async function submitWithdraw(btn) {
      var amount = $('wd_amount').value;
      if (!amount || parseFloat(amount) <= 0) { toastMsg('请输入有效的提现金额'); return; }
      btn.disabled = true;
      var r = await fetch('/api/withdraw', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount: amount, method: $('wd_method').value }) });
      var d = await r.json();
      btn.disabled = false;
      if (d.ok) { toastMsg('提现申请已提交'); setTimeout(function(){ location.reload(); }, 1200); }
      else toastMsg(d.error || '提现失败');
    }
    function toastMsg(msg) { alert(msg); }
    </script>`;

  return accountShell(u, 'invite', inner);
}

export function renderAccountPassword(opts: {
  siteName: string;
  tagline: string;
  slogan: string;
  user: AccountUser;
}): string {
  const u = opts.user;
  const inner = `
    <h1 class="account-title">修改密码</h1>
    <div class="card" style="max-width:480px;">
      <p class="account-sub">修改密码需通过邮件验证，确认是本人操作。</p>
      <div class="form-group"><label>当前密码</label><input type="password" id="cp_old" placeholder="请输入当前密码"></div>
      <div class="form-group"><label>新密码</label><input type="password" id="cp_new" placeholder="至少 6 位"></div>
      <div class="form-group"><label>确认新密码</label><input type="password" id="cp_new2" placeholder="再次输入新密码"></div>
      <div class="form-error" id="cp_err"></div>
      <button class="btn-primary" onclick="submitChangePassword()">发送验证邮件</button>
    </div>
    <script>
    async function submitChangePassword() {
      var oldP = document.getElementById('cp_old').value;
      var newP = document.getElementById('cp_new').value;
      var newP2 = document.getElementById('cp_new2').value;
      var err = document.getElementById('cp_err');
      err.textContent = ''; err.style.color = '';
      if (!oldP || !newP) { err.textContent = '请填写当前密码和新密码'; return; }
      if (newP.length < 6) { err.textContent = '新密码至少 6 位'; return; }
      if (newP !== newP2) { err.textContent = '两次输入的新密码不一致'; return; }
      var r = await fetch('/api/change-password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ old_password: oldP, new_password: newP }) });
      var d = await r.json();
      if (d.ok) { err.style.color = 'var(--teal)'; err.textContent = d.message || '验证邮件已发送'; }
      else err.textContent = d.error || '修改失败';
    }
    </script>`;
  return accountShell(u, 'password', inner);
}

export function renderResetPassword(opts: {
  siteName: string;
  tagline: string;
  slogan: string;
  token: string;
  valid: boolean;
  isConfirm: boolean;
  navMenu?: NavMenuItem[];
}): string {
  const body = opts.valid
    ? (opts.isConfirm
      ? `<p style="text-align:center;color:var(--text-muted);margin-bottom:16px;">点击下方按钮确认修改密码。</p>
         <button class="btn-primary" style="width:100%;" onclick="confirmReset()">确认修改密码</button>`
      : `<div class="form-group"><label>新密码</label><input type="password" id="rp_password" placeholder="至少 6 位"></div>
         <div class="form-group"><label>确认新密码</label><input type="password" id="rp_password2" placeholder="再次输入"></div>
         <button class="btn-primary" style="width:100%;" onclick="submitReset()">重置密码</button>`)
    : `<p style="text-align:center;color:var(--danger);margin-bottom:16px;">链接无效或已过期，请重新发起。</p>
       <a class="btn-ghost" href="/login" style="display:block;text-align:center;">返回登录</a>`;
  const inner = `
    <div class="card form-card">
      <h1 style="margin-bottom:20px;text-align:center;">${opts.isConfirm ? '确认修改密码' : '重置密码'}</h1>
      ${body}
      <div class="form-error" id="rp_err"></div>
    </div>
    <script>
    var TOKEN = ${JSON.stringify(opts.token)};
    async function submitReset() {
      var p = document.getElementById('rp_password').value;
      var p2 = document.getElementById('rp_password2').value;
      var err = document.getElementById('rp_err');
      err.textContent = ''; err.style.color = '';
      if (p.length < 6) { err.textContent = '新密码至少 6 位'; return; }
      if (p !== p2) { err.textContent = '两次输入不一致'; return; }
      var r = await fetch('/api/reset-password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN, password: p }) });
      var d = await r.json();
      if (d.ok) { err.style.color = 'var(--teal)'; err.textContent = d.message + '，正在跳转...'; setTimeout(function(){ location.href = '/login'; }, 1500); }
      else err.textContent = d.error || '重置失败';
    }
    async function confirmReset() {
      var err = document.getElementById('rp_err');
      err.textContent = ''; err.style.color = '';
      var r = await fetch('/api/reset-password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN, password: '' }) });
      var d = await r.json();
      if (d.ok) { err.style.color = 'var(--teal)'; err.textContent = d.message + '，正在跳转...'; setTimeout(function(){ location.href = '/login'; }, 1500); }
      else err.textContent = d.error || '操作失败';
    }
    </script>`;
  return layout({ ...opts, title: opts.isConfirm ? '确认修改密码' : '重置密码', content: inner, showHero: false });
}

export function renderLogin(opts: {
  siteName: string;
  tagline: string;
  slogan: string;
  logo?: string;
  favicon?: string;
  social?: SocialLinks;
  cs?: CsConfig;
  user?: { name: string; email: string; role: string; isVip?: boolean } | null;
  navMenu?: NavMenuItem[];
}): string {
  const inner = `
    <div class="card form-card">
      <h1 style="margin-bottom:20px;text-align:center;">登录</h1>
      <div class="form-group"><label>邮箱</label><input type="email" id="email" placeholder="you@example.com"></div>
      <div class="form-group"><label>密码</label><input type="password" id="password" placeholder="请输入密码"></div>
      <div class="form-error" id="err"></div>
      <button class="btn-primary" style="width:100%;" id="submit">登录</button>
      <p style="margin-top:14px;text-align:center;font-size:.88rem;color:var(--text-muted);">
        <a href="#" id="forgotLink">忘记密码？</a>
        <span style="margin:0 8px;">·</span>
        还没有账号？<a href="/register">立即注册</a>
      </p>
    </div>
    <script>
    const plan = new URLSearchParams(location.search).get('plan') || '';
    document.getElementById('submit').addEventListener('click', async () => {
      const email = document.getElementById('email').value.trim();
      const password = document.getElementById('password').value;
      const err = document.getElementById('err');
      err.textContent = '';
      if (!email || !password) { err.textContent = '请填写邮箱和密码'; return; }
      const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
      const d = await r.json();
      if (!r.ok) { err.textContent = d.error || '登录失败'; return; }
      location.href = plan ? '/pricing?plan=' + plan : '/';
    });
    document.getElementById('forgotLink').addEventListener('click', async (e) => {
      e.preventDefault();
      const email = document.getElementById('email').value.trim();
      const err = document.getElementById('err');
      if (!email) { err.textContent = '请先在上方填写邮箱，再点击「忘记密码」'; return; }
      err.textContent = ''; err.style.color = '';
      const r = await fetch('/api/forgot-password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
      const d = await r.json();
      err.style.color = 'var(--teal)';
      err.textContent = d.message || '重置邮件已发送，请查收';
    });
    </script>`;
  return layout({ ...opts, title: '登录', content: inner, showHero: false });
}

export function renderRegister(opts: {
  siteName: string;
  tagline: string;
  slogan: string;
  logo?: string;
  favicon?: string;
  social?: SocialLinks;
  cs?: CsConfig;
  user?: { name: string; email: string; role: string; isVip?: boolean } | null;
  navMenu?: NavMenuItem[];
}): string {
  const inner = `
    <div class="card form-card">
      <h1 style="margin-bottom:20px;text-align:center;">注册</h1>
      <div class="form-group"><label>邮箱</label><input type="email" id="email" placeholder="you@example.com"></div>
      <div class="form-group"><label>昵称（可选）</label><input type="text" id="name" placeholder="你的昵称"></div>
      <div class="form-group"><label>密码（至少 8 位）</label><input type="password" id="password" placeholder="请输入密码"></div>
      <div class="form-error" id="err"></div>
      <button class="btn-primary" style="width:100%;" id="submit">注册</button>
      <p style="margin-top:14px;text-align:center;font-size:.88rem;color:var(--text-muted);">已有账号？<a href="/login">登录</a></p>
    </div>
    <script>
    function escHtml(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    document.getElementById('submit').addEventListener('click', async () => {
      const email = document.getElementById('email').value.trim();
      const name = document.getElementById('name').value.trim();
      const password = document.getElementById('password').value;
      const err = document.getElementById('err');
      err.textContent = '';
      if (!email || password.length < 8) { err.textContent = '请填写有效邮箱，密码至少 8 位'; return; }
      const r = await fetch('/api/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name, password }) });
      const d = await r.json();
      if (!r.ok) { err.textContent = d.error || '注册失败'; return; }
      var card = document.querySelector('.card.form-card');
      if (card) {
        card.innerHTML = '<div style="text-align:center;padding:18px 6px;">'
          + '<div style="font-size:2.4rem;margin-bottom:10px;">📬</div>'
          + '<h2 style="margin:0 0 12px;">注册成功！</h2>'
          + '<p style="color:var(--text-muted);line-height:1.7;margin:0 0 6px;">请前往收件箱验证邮箱地址：</p>'
          + '<p style="font-weight:600;margin:0 0 14px;">' + escHtml(d.user ? d.user.email : email) + '</p>'
          + '<p style="color:var(--text-muted);font-size:.85rem;line-height:1.6;">验证邮件已发送，请点击邮件中的链接完成验证。<br>如果没收到，请检查垃圾邮件文件夹。</p>'
          + '<button class="btn-primary" style="margin-top:16px;width:100%;" onclick="location.href=\'/\'">返回首页</button>'
          + '</div>';
      } else {
        location.href = '/?welcome=1';
      }
    });
    </script>`;
  return layout({ ...opts, title: '注册', content: inner, showHero: false });
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

export function renderAbout(opts: {
  siteName: string;
  tagline: string;
  slogan: string;
  logo?: string;
  favicon?: string;
  social?: SocialLinks;
  cs?: CsConfig;
  about_content: string;
  user?: { name: string; email: string; role: string; isVip?: boolean } | null;
  navMenu?: NavMenuItem[];
}): string {
  const content = `<h1 class="page-title">关于我们</h1><div class="article-body about-body">${opts.about_content || '<p class="empty">暂无内容</p>'}</div>`;
  return layout({
    title: '关于我们',
    content,
    siteName: opts.siteName,
    tagline: opts.tagline,
    slogan: opts.slogan,
    logo: opts.logo,
    favicon: opts.favicon,
    social: opts.social,
    cs: opts.cs,
    user: opts.user,
    navMenu: opts.navMenu,
  });
}
