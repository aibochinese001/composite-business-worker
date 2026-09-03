// 首页三区块（最新文章/精选商品/热门课程）卡片自动轮换
// 规则：区块卡片 > 4 时，置顶卡固定显示，其余位置每 5 秒从候选池随机替换一批。
// 页面隐藏（document.hidden）时暂停。卡片 HTML 由 render.ts 构建后传入。
export interface HomeCard {
  html: string;
  pinned: boolean;
}

export function buildHomeRotate(
  articles: HomeCard[],
  products: HomeCard[],
  courses: HomeCard[]
): string {
  const cfg: Record<string, { pinned: string[]; pool: string[] }> = {};
  const add = (key: string, cards: HomeCard[]) => {
    const shown = cards.slice(0, 4); // 服务端已按置顶优先排序，前 4 张为首屏
    const pinned = shown.filter((c) => c.pinned).map((c) => c.html);
    const restShown = shown.filter((c) => !c.pinned).map((c) => c.html);
    const rest = cards.slice(4).map((c) => c.html);
    // 仅当非置顶候选池超过可见槽位时才需要轮换
    const slots = 4 - pinned.length;
    if (restShown.length + rest.length > slots && slots > 0) {
      cfg[key] = { pinned, pool: restShown.concat(rest) };
    }
  };
  add('articles', articles);
  add('products', products);
  add('courses', courses);

  if (!Object.keys(cfg).length) return '';

  const json = JSON.stringify(cfg).replace(/</g, '\\u003c');
  return `<script>
(function(){
  var CFG = ${json};
  function pick(arr, n){
    var a = arr.slice(), out = [];
    while (out.length < n && a.length) out.push(a.splice(Math.floor(Math.random()*a.length),1)[0]);
    return out;
  }
  var sections = [];
  for (var key in CFG) {
    var grid = document.querySelector('.home-section[data-rotate="' + key + '"] .grid');
    if (grid) sections.push({ grid: grid, cfg: CFG[key] });
  }
  if (!sections.length) return;
  function tick(){
    for (var i = 0; i < sections.length; i++) {
      var s = sections[i];
      var slots = 4 - s.cfg.pinned.length;
      s.grid.innerHTML = s.cfg.pinned.join('') + pick(s.cfg.pool, slots).join('');
    }
  }
  setInterval(function(){ if (!document.hidden) tick(); }, 5000);
})();
</script>`;
}
