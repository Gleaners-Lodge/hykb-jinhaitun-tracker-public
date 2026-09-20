/* 金海豚奖 GameJam 热度追踪 —— 前端全部逻辑，无构建、无依赖。
   读 data/meta.json + data/latest.json + data/series.json，其余都在浏览器里算。 */

(() => {
  'use strict';

  const MAX_PICKS = 6;               // 趋势图最多同时对比几个作品
  const SERIES_SLOTS = 6;            // 分类色槽位数，与 CSS 里的 --series-N 对应
  const FLOW_ROWS = 15;              // 名次迁徙图画前几名
  const BOARD_ROWS = 15;             // 排行榜默认行数：对齐右列「涨幅榜+对比组」两卡的高度
  const MOVER_ROWS = 16;             // 涨幅榜行数

  /* CSV 导出暂停开关：访问量上来之后先收起批量导出入口（2026-08 起）。
     exportCsv() 和按钮都原样留着，恢复时把这里改回 false 即可，别删代码。 */
  const CSV_PAUSED = true;

  // 可选：填活动内部作品 ID 以高亮关注作品；空字符串表示不预设关注对象。
  const FOCUS_ID = '';
  const FOCUS_TYPE = 'all';
  const isOurs = id => Boolean(FOCUS_ID) && String(id) === FOCUS_ID;

  // 可选推荐卡：{ id: '活动内部 ID', badge: '推荐', pitch: '介绍' }。
  // 默认不展示推荐位；只使用公开信息配置。
  const PROMO = [];

  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = {
    meta: null,
    latest: null,
    series: null,
    enrich: {},                      // 作品档案：开发团队 / 评分 / 评价数
    ids: [],                         // 全部作品 id
    type: FOCUS_TYPE,                // 默认视角：关注作品的主品类（数据缺失时回退 all）
    tag: '',
    q: '',
    range: 'all',
    picked: [],                      // 趋势图选中的作品 id
    slots: new Map(),                // id -> 色槽位，保证颜色跟着作品走而不是跟着名次
    moverMode: 'today',              // 涨幅榜口径：'today' 当日新增（默认）/ 'last' 本轮
    boardLimit: BOARD_ROWS,
    tableLimit: 50,
    sort: { key: 'rank', dir: 'asc' },
  };

  /* ---------------- 工具 ---------------- */

  const num = n => (n == null ? '—' : n.toLocaleString('zh-CN'));

  const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(n).toLocaleString('zh-CN');

  /* 数据里存的是北京时间，页面按访问者本地时区渲染 —— 在其他时区查看时会转换。
     所以时区必须标出来，否则「更新于 09:39」会被当成北京时间看岔一小时。 */
  const TZ_LABEL = (() => {
    const off = -new Date().getTimezoneOffset() / 60;
    const h = Math.floor(Math.abs(off));
    const m = Math.round((Math.abs(off) - h) * 60);
    return `UTC${off < 0 ? '−' : '+'}${h}${m ? ':' + String(m).padStart(2, '0') : ''}`;
  })();

  function fmtTime(iso, withDate = true) {
    const d = new Date(iso);
    if (Number.isNaN(+d)) return iso;
    const p = n => String(n).padStart(2, '0');
    const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
    return withDate ? `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}` : hm;
  }

  function fmtSpan(hours) {
    if (hours < 1) return '不足 1 小时';
    if (hours < 48) return `${Math.round(hours)} 小时`;
    return `${(hours / 24).toFixed(1)} 天`;
  }

  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* 评分色阶：好坏一眼可辨，色差刻意拉满（见 style.css 的 .score-*）。
     阈值按本届实际分布定：有分作品几乎全在 8.7~10，唯一差评 4.7 ——
     ≥9 荧光绿、8~8.9 青绿、6~7.9 琥珀、<6 猩红。 */
  const scoreClass = s => `score-${s >= 9 ? 'hi' : s >= 8 ? 'good' : s >= 6 ? 'mid' : 'low'}`;

  /** 涨跌统一画成药丸 chip；v 为 null 时返回 fallback（默认灰色占位）。 */
  function deltaChip(v, { fallback = '<span class="chip chip-zero">—</span>' } = {}) {
    if (v == null) return fallback;
    const cls = v > 0 ? 'chip-up' : v < 0 ? 'chip-down' : 'chip-zero';
    const arrow = v > 0 ? '▲' : v < 0 ? '▼' : '·';
    return `<span class="chip ${cls}">${arrow} ${signed(v)}</span>`;
  }

  /** 列表行的点击/键盘激活统一走 data-key 委托。 */
  function bindActivate(host, fn) {
    const act = ev => {
      const row = ev.target.closest('[data-key]');
      if (!row || !host.contains(row)) return;
      if (ev.type === 'keydown' && ev.key !== 'Enter' && ev.key !== ' ') return;
      if (ev.type === 'keydown') ev.preventDefault();
      fn(row.dataset.key, row, ev);
    };
    host.addEventListener('click', act);
    host.addEventListener('keydown', act);
  }

  /* 作品名普遍带 -PC 后缀，去掉更好看 —— 但本届主题是「别按那个键」，
     光叫这个名字的就有 8 个作品，去后缀之后一堆重名。所以只在不重名时才去，
     连全名都重复的，再挂上开发团队区分。displayName() 在启动时算好。 */
  const stripSuffix = s => String(s || '').replace(/-(PC|安卓|Android|iOS)$/i, '');

  function buildNameMap() {
    const shortCount = new Map(), fullCount = new Map();
    const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
    for (const id of state.ids) {
      bump(fullCount, game(id).name);
      bump(shortCount, stripSuffix(game(id).name));
    }
    state.nameOf = new Map();
    for (const id of state.ids) {
      const full = game(id).name;
      const short = stripSuffix(full);
      let label;
      if (shortCount.get(short) === 1) label = short;
      else if (fullCount.get(full) === 1) label = full;
      else {
        const dev = info(id).developer;
        label = dev ? `${full}（${dev}）` : `${full} #${id}`;
      }
      state.nameOf.set(id, label);
    }
  }

  const displayName = id => state.nameOf.get(id) || game(id).name;

  /** 图表端点空间有限，截断后靠 tooltip / 图例补全。 */
  const chartLabel = (id, max = 12) => {
    const s = displayName(id);
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  };

  function seriesColor(id) {
    if (isOurs(id)) return 'var(--ours)';   // 关注作品固定品牌金，不占六色槽位
    const slot = state.slots.get(id);
    return slot == null ? 'var(--ink-3)' : `var(--series-${slot + 1})`;
  }

  function assignSlot(id) {
    if (isOurs(id) || state.slots.has(id)) return;
    const used = new Set(state.slots.values());
    for (let i = 0; i < SERIES_SLOTS; i++) {
      if (!used.has(i)) { state.slots.set(id, i); return; }
    }
  }

  /* ---------------- 数据派生 ---------------- */

  function game(id) { return state.meta.games[id] || { id, name: id, types: [], tags: [] }; }

  function info(id) { return state.enrich[id] || {}; }

  /* 活动页给每个作品都挂了这两个标签，对筛选没有信息量 */
  const NOISE_TAGS = new Set(['金海豚奖GameJam', 'PC游戏', '手机游戏']);

  const realTags = id => game(id).tags.filter(t => !NOISE_TAGS.has(t));

  function zanOf(id) {
    const v = state.latest.zan[id];
    return v == null ? null : v;
  }

  /** 当前筛选（品类 + 搜索）命中的作品 id，按热度降序。 */
  function filteredIds() {
    const q = state.q.trim().toLowerCase();
    return state.ids
      .filter(id => {
        const g = game(id);
        if (state.type !== 'all' && !g.types.includes(state.type)) return false;
        if (state.tag && !g.tags.includes(state.tag)) return false;
        if (q) {
          const hay = `${g.name} ${info(id).developer || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => (zanOf(b) ?? -1) - (zanOf(a) ?? -1));
  }

  /** 时间范围内的快照下标区间。 */
  function rangeIdx() {
    const ts = state.series.ts;
    if (state.range === 'all' || ts.length === 0) return [0, ts.length];
    const cutoff = archiveTime() - Number(state.range) * 3600 * 1000;
    let start = ts.findIndex(t => new Date(t).getTime() >= cutoff);
    if (start < 0) start = Math.max(0, ts.length - 2);   // 范围内没有点时至少留最后两个
    return [start, ts.length];
  }

  /** 某作品在 N 小时前的热度。看板展示口径已全部改成「当日新增」（北京时间
      so far），这里只剩「今日一荐」的势头评分还在用 24 小时滚动窗 ——
      刻意保留：so far 口径每天零点归零，会让清晨的选品全靠随机数。 */
  function zanHoursAgo(id, hours) {
    const { ts, series } = state.series;
    const vals = series[id];
    if (!vals) return null;
    const cutoff = archiveTime() - hours * 3600 * 1000;
    for (let i = ts.length - 1; i >= 0; i--) {
      if (new Date(ts[i]).getTime() <= cutoff && vals[i] != null) return vals[i];
    }
    return null;
  }

  function delta24(id) {
    const now = zanOf(id), then = zanHoursAgo(id, 24);
    return (now == null || then == null) ? null : now - then;
  }

  function deltaLast(id) {
    const d = state.latest.delta[id];
    return d == null ? null : d;
  }

  /* ---------------- 渲染：顶栏时间戳 ---------------- */

  function renderStamp() {
    const ts = state.latest.ts;
    $('#stamp').innerHTML = `<b>历史存档</b> · 最后快照 ${esc(fmtTime(ts))} ${esc(TZ_LABEL)}`;
    $('#stamp').title =
      `投票截止：2026-08-31 24:00（北京时间）；采集停止：2026-09-07。\n`
      + `「当日新增」和「当日」均指最新快照所在的北京日期；时间范围以最后快照为终点。\n`
      + `原始数据时间戳：${ts} · 已留存 ${state.series.ts.length} 份快照`;
  }

  // 归档中的滚动时间窗与推荐固定在最后快照，避免日后访问时历史曲线缩成两个点。
  const archiveTime = () => new Date(state.latest.ts).getTime();

  /* ---------------- 渲染：领奖台 ---------------- */

  /** 迷你走势线：全历史、无轴无标签，末点一个圆点。Hero 与详情面板共用。 */
  function sparkline(id, w = 120, h = 32, color = 'var(--ours)') {
    const raw = state.series.series[id];
    if (!raw) return '';
    const pts = [];
    raw.forEach((v, i) => { if (v != null) pts.push([i, v]); });
    if (pts.length < 2) return '';
    let lo = Infinity, hi = -Infinity;
    for (const [, v] of pts) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (lo === hi) { lo -= 1; hi += 1; }
    const n = Math.max(1, raw.length - 1);
    const P = 3.5;
    const x = i => P + (i / n) * (w - 2 * P);
    const y = v => P + (h - 2 * P) * (1 - (v - lo) / (hi - lo));
    const d = pts.map(([i, v], k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const [ei, ev] = pts[pts.length - 1];
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
      <path d="${d}" fill="none" stroke="${color}" stroke-width="2"
            stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${x(ei).toFixed(1)}" cy="${y(ev).toFixed(1)}" r="3" fill="${color}"/>
    </svg>`;
  }

  /** 聚焦卡上的竞争情报行：追赶差距 / 领先差距 / 当日新增。 */
  function oursIntel(ids, idx) {
    const me = ids[idx];
    const above = ids[idx - 1], below = ids[idx + 1];
    const bits = [];
    if (above) bits.push(`距上一名还差 ${num(zanOf(above) - zanOf(me))}`);
    if (below) bits.push(`领先下一名 ${num(zanOf(me) - zanOf(below))}`);
    const d = todayDelta(me);
    if (d != null) bits.push(`当日新增 ${signed(d)}`);
    return bits.length ? `<p class="podium-intel">${bits.map(esc).join(' · ')}</p>` : '';
  }

  function renderHero() {
    const host = $('#hero');
    const ids = filteredIds();
    if (!ids.length) { host.innerHTML = ''; host.hidden = true; return; }

    // 名次较上次的变化：用「热度 − 本轮涨幅」还原上一份快照的排序
    const prevRank = new Map();
    ids.map(id => ({ id, v: (zanOf(id) || 0) - (deltaLast(id) || 0) }))
      .sort((a, b) => b.v - a.v)
      .forEach((r, i) => prevRank.set(r.id, i + 1));

    const podium = (id, i) => {
      const g = game(id);
      const e = info(id);
      const ours = isOurs(id);
      const d = deltaLast(id);
      return `
        <article class="podium podium-${i + 1} ${ours ? 'is-ours' : ''}"
                 data-key="${esc(id)}" role="button" tabindex="0"
                 aria-label="第 ${i + 1} 名 ${esc(displayName(id))}">
          <div class="podium-bg" style="background-image:url('${esc(g.img || g.icon || '')}')"></div>
          <div class="podium-scrim"></div>
          <span class="medal medal-${i + 1}">${i + 1}</span>
          <div class="podium-body">
            <div class="podium-title">
              <h3>${esc(displayName(id))}</h3>
              ${e.developer ? `<p class="podium-dev">${esc(e.developer)}</p>` : ''}
            </div>
            <div class="podium-stats">
              <span class="podium-zan">${num(zanOf(id))}</span>
              ${d == null ? '' : deltaChip(d)}
              ${sparkline(id, 110, 30, 'rgba(255,255,255,.9)')}
            </div>
            ${ours ? oursIntel(ids, i) : ''}
          </div>
        </article>`;
    };

    // 关注作品不在前三但在当前筛选里 → 独立聚焦卡
    const focusCard = () => {
      const idx = ids.indexOf(FOCUS_ID);
      if (idx < 0 || idx < 3) return '';
      const id = FOCUS_ID;
      const g = game(id), e = info(id);
      const rank = idx + 1;
      const pr = prevRank.get(id);
      const rd = pr ? pr - rank : 0;   // 正数 = 名次上升
      return `
        <article class="hero-focus" data-key="${esc(id)}" role="button" tabindex="0"
                 aria-label="聚焦：${esc(displayName(id))}，当前第 ${rank} 名">
          <div class="podium-bg" style="background-image:url('${esc(g.img || g.icon || '')}')"></div>
          <div class="focus-scrim"></div>
          <div class="focus-body">
            <header class="focus-head">
              <img class="focus-icon" src="${esc(g.icon || g.img || '')}" alt=""
                   loading="lazy" onerror="this.style.visibility='hidden'">
              <div class="podium-title">
                <h3>${esc(displayName(id))}</h3>
                ${e.developer ? `<p class="podium-dev">${esc(e.developer)}</p>` : ''}
              </div>
            </header>
            <div class="focus-rank">
              <span class="focus-rank-num">#${rank}</span>
              ${rd ? `<span class="chip ${rd > 0 ? 'chip-up' : 'chip-down'}">${rd > 0 ? '▲' : '▼'} ${Math.abs(rd)}</span>`
                   : '<span class="chip chip-zero">· 持平</span>'}
              <span class="focus-of">/ ${num(ids.length)} 个作品</span>
            </div>
            <div class="podium-stats">
              <span class="podium-zan">${num(zanOf(id))}</span>
              ${deltaChip(deltaLast(id), { fallback: '' })}
              ${sparkline(id, 110, 30, '#eac97f')}
            </div>
            ${oursIntel(ids, idx)}
            ${e.score ? `<p class="focus-score">评分 <b class="${scoreClass(e.score)}">${e.score.toFixed(1)}</b> · ${num(e.raters || 0)} 人打分</p>` : ''}
          </div>
        </article>`;
    };

    const focusHtml = focusCard();
    host.classList.toggle('has-focus', !!focusHtml);
    host.hidden = false;
    host.innerHTML = ids.slice(0, 3).map(podium).join('') + focusHtml;
  }

  /* ---------------- 渲染：总览 ---------------- */

  /** 首次进场时 KPI 数字滚动进位；之后（筛选变化等）直接落值。 */
  let kpisAnimated = false;

  function countUp(el, target) {
    if (REDUCED || kpisAnimated || !Number.isFinite(target) || target <= 0) {
      el.textContent = num(target);
      return;
    }
    const dur = 650;
    const t0 = performance.now();
    const step = now => {
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = num(Math.round(target * eased));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function renderKpis() {
    const ids = state.ids;
    const total = ids.reduce((s, id) => s + (zanOf(id) || 0), 0);
    const totalDelta = ids.reduce((s, id) => s + (deltaLast(id) || 0), 0);

    countUp($('#kpiTotal'), total);
    const hasPrev = state.latest.prevTs != null;
    $('#kpiTotalDelta').innerHTML = hasPrev
      ? `${deltaChip(totalDelta)} 较 ${fmtTime(state.latest.prevTs)}`
      : '等待第二份快照后才有对比';

    countUp($('#kpiWorks'), ids.length);
    const typeCount = Object.entries(state.meta.typeMap)
      .filter(([t]) => (state.meta.typeIds[t] || []).length > 0).length;
    const tagCount = new Set(ids.flatMap(realTags)).size;
    $('#kpiWorksSub').textContent = `${typeCount} 个品类 · ${tagCount} 种标签`;

    const teams = new Map();
    for (const id of ids) {
      const dev = info(id).developer;
      if (dev) teams.set(dev, (teams.get(dev) || 0) + 1);
    }
    const multi = [...teams.values()].filter(n => n > 1).length;
    if (teams.size) countUp($('#kpiTeams'), teams.size);
    else $('#kpiTeams').textContent = '—';
    $('#kpiTeamsSub').textContent = teams.size
      ? (multi ? `其中 ${multi} 个团队交了不止一份` : '每个团队各交一份')
      : '跑 scraper/enrich.py 补团队信息';

    // 追踪时长比快照份数对访客有意义 —— 它回答「这些趋势是多长时间里攒出来的」
    const ts = state.series.ts;
    kpisAnimated = true;
    if (ts.length >= 2) {
      const hours = (new Date(ts[ts.length - 1]) - new Date(ts[0])) / 3600000;
      $('#kpiSnaps').textContent = fmtSpan(hours);
      $('#kpiSnapsSub').textContent = `历史快照 · 起于 ${fmtTime(ts[0])}`;
    } else {
      $('#kpiSnaps').textContent = '—';
      $('#kpiSnapsSub').textContent = '再抓一次就能画出趋势';
    }
  }

  function renderTabs() {
    const counts = { all: state.ids.length };
    for (const [t] of Object.entries(state.meta.typeMap)) {
      counts[t] = state.ids.filter(id => game(id).types.includes(t)).length;
    }
    const entries = [['all', '全部']].concat(
      Object.entries(state.meta.typeMap).filter(([t]) => counts[t] > 0)
    );
    $('#typeTabs').innerHTML = entries.map(([t, label]) => `
      <button class="tab" type="button" role="tab" data-type="${esc(t)}"
              aria-selected="${state.type === t}">
        ${esc(label)}<span class="tab-count">${counts[t]}</span>
      </button>`).join('');
  }

  /* ---------------- 渲染：排行榜 ---------------- */

  function renderBoard() {
    const ids = filteredIds();
    const shown = ids.slice(0, state.boardLimit);
    const max = zanOf(ids[0]) || 1;

    const sorted = ids.map(zanOf).filter(v => v != null).sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;

    // 分布极度偏斜（头部几千票、中位数几十票），所以中位数用文字讲比画刻度有用
    $('#rankSub').textContent = ids.length
      ? `${num(ids.length)} 个作品 · 中位数 ${num(median)} · 榜首是中位数的 ${Math.round(max / Math.max(1, median))} 倍`
      : '没有匹配的作品';

    const boardRow = (id, i) => {
      const g = game(id);
      const zan = zanOf(id);
      const d = deltaLast(id);
      const pct = Math.max(1.5, (zan / max) * 100);
      const picked = state.picked.includes(id);
      const e = info(id);
      const devLine = e.developer
        ? `<div class="board-dev">${esc(e.developer)}${e.score ? `<span class="score-chip ${scoreClass(e.score)}">评分 ${e.score.toFixed(1)}</span>` : ''}${e.url ? `<a class="link-out" href="${esc(e.url)}" target="_blank" rel="noreferrer">游戏页 ↗</a>` : ''}</div>`
        : '';
      return `
        <li class="board-row ${i === 0 ? 'board-row-1' : ''} ${isOurs(id) ? 'is-ours' : ''}"
            data-row="${esc(id)}">
          <div class="board-rank">${i + 1}</div>
          <img class="board-cover" src="${esc(g.icon || g.img || '')}" alt=""
               loading="lazy" onerror="this.style.visibility='hidden'">
          <div class="board-main">
            <button class="board-name" type="button" data-id="${esc(id)}"
                    data-picked="${picked ? 1 : 0}"
                    style="--pick-color:${picked ? seriesColor(id) : 'transparent'}"
                    title="${esc(g.name)}（点击看详情）">
              ${esc(displayName(id))}
            </button>
            ${devLine}
            <div class="board-track">
              <div class="board-fill" style="width:${pct}%"></div>
            </div>
          </div>
          <div class="board-meta">
            <span class="board-zan">${num(zan)}</span>
            ${d == null ? '' : deltaChip(d)}
          </div>
          <button class="pin-btn" type="button" data-pin="${esc(id)}"
                  aria-pressed="${picked}" style="${picked ? `color:${seriesColor(id)}` : ''}"
                  aria-label="把《${esc(displayName(id))}》${picked ? '移出' : '加入'}趋势对比"
                  title="${picked ? '移出趋势对比' : '加入趋势对比'}">
            <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
              <path d="M1 11 L5 6 L8 8 L13 2" fill="none" stroke="currentColor"
                    stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </li>`;
    };

    // 关注作品没进当前显示条数时，在列表末尾锚定一行真实名次 —— 排序不动，只是不用翻页找
    const oursIdx = ids.indexOf(FOCUS_ID);
    const anchor = oursIdx >= shown.length
      ? `<li class="board-gap" aria-hidden="true">⋯</li>${boardRow(FOCUS_ID, oursIdx)}`
      : '';

    $('#board').innerHTML =
      (shown.map(boardRow).join('') + anchor) || '<li class="empty">换个关键词或品类试试。</li>';

    const btn = $('#rankMore');
    btn.hidden = ids.length <= BOARD_ROWS;
    btn.textContent = state.boardLimit >= ids.length ? '收起' : `显示更多（还有 ${ids.length - state.boardLimit}）`;
  }

  /* ---------------- 渲染：涨幅榜 ---------------- */

  /* 两个口径：「今日」是默认 —— 当天 0 点（北京时间）以来的 so far 涨幅，
     和大家讨论的「今天谁猛」对得上；「本轮」保留在小 tab 里，给盯最新
     一批数据的人（源站按小时批刷，「本轮」经常整轮全零，当不了默认）。 */
  function renderMovers() {
    const host = $('#movers');
    const base = filteredIds();
    const modeToday = state.moverMode === 'today';

    $('#moverTabs').innerHTML = [['today', '当日'], ['last', '本轮']].map(([m, label]) => `
      <button class="tab" type="button" role="tab" data-movermode="${m}"
              aria-selected="${state.moverMode === m}">${label}</button>`).join('');

    if (!state.latest.prevTs) {
      $('#moversSub').textContent = '需要两份快照才能算涨幅';
      host.innerHTML = `<div class="empty">
        存档中只有 <strong>1 份快照</strong>，不足以计算涨幅。</div>`;
      return;
    }

    const rows = base
      .map(id => ({ id, d: modeToday ? todayDelta(id) : deltaLast(id) }))
      .filter(r => r.d != null && r.d !== 0)
      .sort((a, b) => b.d - a.d)
      .slice(0, MOVER_ROWS);

    $('#moversSub').textContent = modeToday
      ? `最后快照当日 0 点以来（北京时间） · 截至 ${fmtTime(state.latest.ts)}`
      : `${fmtTime(state.latest.prevTs)} → ${fmtTime(state.latest.ts)}`;

    if (!rows.length) {
      host.innerHTML = `<div class="empty">
        ${modeToday ? '最后快照当日' : '最后一轮'}没有热度变化。投票已结束，本站已停止采集并保留历史数据。</div>`;
      return;
    }

    const max = Math.max(...rows.map(r => Math.abs(r.d)));
    host.innerHTML = rows.map(r => {
      const g = game(r.id);
      const w = Math.max(2, (Math.abs(r.d) / max) * 100);
      const neg = r.d < 0;
      return `
        <div class="mover-row ${isOurs(r.id) ? 'is-ours' : ''}"
             data-key="${esc(r.id)}" role="button" tabindex="0" title="查看详情">
          <div>
            <div class="mover-name" title="${esc(g.name)}">${esc(displayName(r.id))}</div>
            <div class="mover-track">
              <div class="mover-fill" data-neg="${neg ? 1 : 0}"
                   style="${neg ? 'right:50%' : 'left:0'};width:${w / (neg ? 2 : 1)}%"></div>
            </div>
          </div>
          <div class="mover-value">${deltaChip(r.d)}</div>
        </div>`;
    }).join('');
  }

  /* ---------------- 渲染：对比组 ---------------- */

  /** 图钉选中作品的就近可视化：色标 + 迷你走势 + 当日新增。
      所有改 picked 的路径（togglePick、重置、切品类 tab）都会走 renderTrend()，
      所以挂在它里面刷新，别再往别的渲染路径里塞。 */
  function renderPicks() {
    const host = $('#pickList');
    if (!host) return;
    if (!state.picked.length) {
      host.innerHTML = '<div class="empty">排行榜行尾的小图钉会把作品加进这里。</div>';
      return;
    }
    host.innerHTML = state.picked.map(id => `
      <div class="pick-row ${isOurs(id) ? 'is-ours' : ''}" data-key="${esc(id)}"
           role="button" tabindex="0"
           title="查看《${esc(displayName(id))}》详情 · 当前热度 ${num(zanOf(id))}">
        <span class="legend-swatch" style="background:${seriesColor(id)}"></span>
        <span class="pick-name">${esc(displayName(id))}</span>
        <span class="pick-spark">${sparkline(id, 72, 24, seriesColor(id))}</span>
        ${deltaChip(todayDelta(id))}
        <button class="pick-remove" type="button" data-unpick="${esc(id)}"
                aria-label="把《${esc(displayName(id))}》移出对比组" title="移出对比组">×</button>
      </div>`).join('');
  }

  /* ---------------- 渲染：可选作品推荐 ---------------- */

  /** 广告位内容和筛选无关，boot() 里只跑一次。 */
  function renderPromo() {
    const host = $('#promo');
    const sec = $('#sec-promo');
    if (!host || !sec) return;

    const topId = state.ids.reduce((a, b) => ((zanOf(b) ?? -1) > (zanOf(a) ?? -1) ? b : a), state.ids[0]);
    const slots = PROMO;

    const cards = slots.map(p => {
      const g = state.meta.games[p.id];
      if (!g) return '';                    // meta 里没有这个 id（换届 / 作品下架）：整张卡跳过

      const e = info(p.id);
      // enrich 没跑或拉挂了就拿 meta 里的主站 gid 拼一条兜底链接
      const url = e.url || (g.gid ? `https://www.3839.com/a/${g.gid}.htm` : '');
      if (!url) return '';

      const chips = g.types.map(t => state.meta.typeMap[t] || t)
        .concat(p.chip ? [p.chip] : [])
        .map(t => `<span class="tag-chip">${esc(t)}</span>`)
        .join('');

      // 带 altBadge 的角标是事实断言（总榜第一），挂之前对一遍数据，掉出第一就换备胎词
      const badge = p.altBadge && String(topId) !== String(p.id) ? p.altBadge : p.badge;
      // 封面回退口径同领奖台：img → icon → 什么都不输出，留容器兜底底色
      const cover = g.img || g.icon || '';

      return `
        <a class="promo-card ${isOurs(p.id) ? 'is-ours' : ''}" href="${esc(url)}"
           target="_blank" rel="noreferrer"
           title="到好游快爆看《${esc(displayName(p.id))}》的游戏页">
          <div class="promo-cover">
            ${cover ? `<img src="${esc(cover)}" alt="" loading="lazy"
                 onerror="this.style.visibility='hidden'">` : ''}
            <span class="promo-badge">${esc(badge)}</span>
          </div>
          <div class="promo-body">
            <h3 class="promo-name">${esc(displayName(p.id))}</h3>
            <p class="promo-pitch">${esc(p.pitch)}</p>
            <div class="promo-chips">${chips}</div>
            <div class="promo-meta">
              <span class="promo-zan">${num(zanOf(p.id))}</span>
              <span class="promo-zan-unit">热度</span>
              ${e.score ? `<span class="score-chip ${scoreClass(e.score)}">评分 ${e.score.toFixed(1)}</span>` : ''}
            </div>
          </div>
        </a>`;
    }).filter(Boolean);

    // 张数写到宿主上：CSS 只在凑满 4 张时才给「首卡双倍宽」的排法（3 张有一套兜底版式），
    // 再少就退回等宽自适应，避免空白推荐区域
    host.dataset.count = String(cards.length);
    host.innerHTML = cards.join('');
    sec.hidden = !cards.length;             // 一张都没剩下就别留个空卡片在版面上
  }

  /* ---------------- 渲染：团队榜 / 标签热度 / 口碑榜 ---------------- */

  /** 三个卡片长得一样：名称 + 细条 + 数值。统一渲染。
      行带 key 时渲染成可点击/可键盘激活的行，具体行为由调用方 bindActivate 决定。 */
  function barList(host, rows, opts = {}) {
    if (!rows.length) {
      host.innerHTML = `<div class="empty">${opts.empty || '暂无数据'}</div>`;
      return;
    }
    const max = Math.max(...rows.map(r => r.value)) || 1;
    host.innerHTML = rows.map(r => `
      <div class="bar-row ${r.ours ? 'is-ours' : ''}"
           ${r.key != null ? `data-key="${esc(r.key)}" role="button" tabindex="0"${r.keyTitle ? ` title="${esc(r.keyTitle)}"` : ''}` : ''}>
        <div>
          <div class="bar-label" title="${esc(r.title || r.label)}">
            ${esc(r.label)}${r.note ? `<small>${esc(r.note)}</small>` : ''}
          </div>
          <div class="bar-track">
            <div class="bar-fill" style="width:${Math.max(2, (r.value / max) * 100)}%"></div>
          </div>
        </div>
        <div class="bar-value${r.displayClass ? ' ' + esc(r.displayClass) : ''}">
          ${esc(r.display)}${r.sub ? `<small>${esc(r.sub)}</small>` : ''}
        </div>
      </div>`).join('');
  }

  function renderTeams() {
    const ids = filteredIds();
    const byDev = new Map();
    for (const id of ids) {
      const dev = info(id).developer;
      if (!dev) continue;
      const cur = byDev.get(dev) || { heat: 0, works: 0, top: null };
      cur.heat += zanOf(id) || 0;
      cur.works += 1;
      if (!cur.top || (zanOf(id) || 0) > (zanOf(cur.top) || 0)) cur.top = id;
      byDev.set(dev, cur);
    }
    const rows = [...byDev.entries()]
      .sort((a, b) => b[1].heat - a[1].heat)
      .slice(0, 12)
      .map(([dev, v]) => ({
        label: dev,
        title: `${dev} — 代表作《${displayName(v.top)}》`,
        note: v.works > 1 ? `${v.works} 部作品` : '',
        value: v.heat,
        display: num(v.heat),
        ours: Boolean(FOCUS_ID) && dev === info(FOCUS_ID).developer,
      }));

    $('#teamSub').textContent = byDev.size
      ? `${num(byDev.size)} 个团队，按名下作品热度合计`
      : '还没有团队数据';
    barList($('#teams'), rows, {
      empty: '团队信息来自主站游戏页。跑一次 <strong>scraper/enrich.py</strong> 就有了。',
    });
  }

  function renderTags() {
    const ids = filteredIds();
    const byTag = new Map();
    for (const id of ids) {
      for (const t of realTags(id)) {
        const cur = byTag.get(t) || { heat: 0, works: 0 };
        cur.heat += zanOf(id) || 0;
        cur.works += 1;
        byTag.set(t, cur);
      }
    }
    const rows = [...byTag.entries()]
      .sort((a, b) => b[1].heat - a[1].heat)
      .slice(0, 12)
      .map(([tag, v]) => ({
        label: tag,
        note: `${v.works}`,
        value: v.heat,
        display: num(v.heat),
        sub: `均 ${num(Math.round(v.heat / v.works))}`,
        key: tag,
        keyTitle: state.tag === tag ? '再点一次取消这个标签筛选' : `只看「${tag}」标签的作品`,
      }));
    barList($('#tags'), rows, { empty: '当前筛选下没有标签数据。' });
  }

  function renderQuality() {
    const ids = filteredIds();
    const rated = ids
      .map(id => ({ id, ...info(id) }))
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score || (b.raters || 0) - (a.raters || 0))
      .slice(0, 12);

    const totalRated = state.ids.filter(id => info(id).score > 0).length;
    $('#qualitySub').textContent = totalRated
      ? `${num(totalRated)} 个作品已有评分，其余还没人打分`
      : '评分和热度是两回事：热度看投票，评分看玩过的人';

    barList($('#quality'), rated.map(r => ({
      label: displayName(r.id),
      title: game(r.id).name,
      note: r.developer || '',
      value: r.score,
      display: r.score.toFixed(1),
      displayClass: scoreClass(r.score),
      sub: `${r.raters || 0} 人打分`,
      ours: isOurs(r.id),
      key: r.id,
      keyTitle: '查看详情',
    })), {
      empty: '存档中没有作品评分。',
    });
  }

  /* ---------------- 图表基座 ---------------- */

  const tip = $('#tooltip');

  function showTip(html, x, y) {
    // 已显示时位置走 CSS 过渡跟着滑；刚出现的那一帧要掐掉过渡，
    // 否则会从上一次收起的位置横穿半个屏幕飘过来
    const wasHidden = tip.hidden;
    tip.innerHTML = html;
    tip.hidden = false;
    if (wasHidden) tip.classList.add('no-trans');
    const r = tip.getBoundingClientRect();
    const left = Math.min(Math.max(8, x + 14), window.innerWidth - r.width - 8);
    const top = Math.min(Math.max(8, y - r.height - 12), window.innerHeight - r.height - 8);
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
    if (wasHidden) requestAnimationFrame(() => tip.classList.remove('no-trans'));
  }

  const hideTip = () => { tip.hidden = true; };

  const chartDrawers = new Map();

  /* 窄屏上图不缩到糊，而是保证最小画布宽度、容器横向滚动 */
  const chartWidth = host =>
    Math.max(host.clientWidth || 640, window.innerWidth <= 720 ? 640 : 0);

  /** draw 负责生成 SVG，after 负责给新生成的节点重新绑事件（重画后旧监听器就没了）。 */
  function mountChart(host, draw, after) {
    chartDrawers.set(host, { draw, after });
    host.innerHTML = draw(chartWidth(host));
    if (after) after();
  }

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      for (const [host, { draw, after }] of chartDrawers) {
        host.innerHTML = draw(chartWidth(host));
        if (after) after();
      }
    }, 140);
  });

  function niceTicks(min, max, count = 5) {
    if (min === max) return [min];
    const span = max - min;
    const raw = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || mag * 10;
    const out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(v);
    return out;
  }

  /** 端点标签防重叠：按 y 排序后互相推开，再用引导线连回线端。 */
  function spreadLabels(items, minGap, top, bottom) {
    const sorted = items.slice().sort((a, b) => a.y - b.y);
    let prev = -Infinity;
    for (const it of sorted) {
      it.ly = Math.max(it.y, prev + minGap);
      prev = it.ly;
    }
    const overflow = sorted.length ? sorted[sorted.length - 1].ly - bottom : 0;
    if (overflow > 0) {
      let next = Infinity;
      for (let i = sorted.length - 1; i >= 0; i--) {
        sorted[i].ly = Math.min(sorted[i].ly - overflow, next - minGap);
        next = sorted[i].ly;
      }
    }
    for (const it of sorted) it.ly = Math.max(top, it.ly);
    return items;
  }

  function emptyChart(msg) {
    return `<div class="empty">${msg}</div>`;
  }

  /* ---------------- 图表：名次迁徙 ---------------- */

  function drawRankFlow(width) {
    const [s0, s1] = rangeIdx();
    const ts = state.series.ts.slice(s0, s1);
    if (ts.length < 2) {
      return emptyChart(`名次迁徙需要至少 <strong>2 份快照</strong>，当前范围内只有 ${ts.length} 份。`);
    }

    const pool = filteredIds();
    if (pool.length < 2) return emptyChart('当前筛选下的作品太少，画不出名次变化。');

    // 每个时间点，在当前筛选集合内重排名次
    const ranksAt = [];
    for (let k = 0; k < ts.length; k++) {
      const i = s0 + k;
      const vals = pool
        .map(id => ({ id, v: state.series.series[id] ? state.series.series[id][i] : null }))
        .filter(r => r.v != null)
        .sort((a, b) => b.v - a.v);
      const map = new Map();
      vals.forEach((r, idx) => map.set(r.id, idx + 1));
      ranksAt.push(map);
    }

    const last = ranksAt[ranksAt.length - 1];
    const lines = pool
      .filter(id => last.get(id) != null && last.get(id) <= FLOW_ROWS)
      .sort((a, b) => last.get(a) - last.get(b));
    if (!lines.length) return emptyChart('这一范围内没有可用的名次数据。');

    const rowH = 22;
    const M = { top: 14, right: Math.min(190, Math.max(120, width * 0.22)), bottom: 26, left: 36 };
    const plotW = Math.max(120, width - M.left - M.right);
    const plotH = FLOW_ROWS * rowH;
    const height = plotH + M.top + M.bottom;

    const x = k => M.left + (ts.length === 1 ? plotW : (k / (ts.length - 1)) * plotW);
    const y = r => M.top + (r - 0.5) * rowH;

    let svg = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"
                    role="img" aria-label="前 ${FLOW_ROWS} 名的排名随时间变化">`;

    // 名次刻度
    for (let r = 1; r <= FLOW_ROWS; r += 2) {
      svg += `<line class="grid-line" x1="${M.left}" x2="${M.left + plotW}" y1="${y(r)}" y2="${y(r)}"/>`;
      svg += `<text class="axis-text" x="${M.left - 8}" y="${y(r) + 4}" text-anchor="end">${r}</text>`;
    }

    // 时间轴
    const tickEvery = Math.max(1, Math.ceil(ts.length / Math.max(2, Math.floor(plotW / 92))));
    for (let k = 0; k < ts.length; k += tickEvery) {
      svg += `<text class="axis-text" x="${x(k)}" y="${M.top + plotH + 17}" text-anchor="middle">${fmtTime(ts[k])}</text>`;
    }
    svg += `<line class="axis-line" x1="${M.left}" x2="${M.left + plotW}" y1="${M.top + plotH}" y2="${M.top + plotH}"/>`;

    const labelItems = [];

    for (const id of lines) {
      const pts = [];
      for (let k = 0; k < ranksAt.length; k++) {
        const r = ranksAt[k].get(id);
        if (r != null && r <= FLOW_ROWS + 6) pts.push([x(k), y(Math.min(r, FLOW_ROWS + 1))]);
      }
      if (pts.length < 2) continue;
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
      const picked = state.picked.includes(id);
      // 关注作品的线常驻金色高亮；其余被选中的走各自槽位色
      const color = isOurs(id) ? 'var(--ours)' : picked ? seriesColor(id) : null;
      const style = color ? `stroke:${color};opacity:1;stroke-width:${isOurs(id) ? 3 : 2.5}` : '';
      svg += `<path class="flow-line" pathLength="1" style="${style}" d="${d}"/>`;
      svg += `<path class="flow-hit" d="${d}" data-id="${esc(id)}"/>`;
      const endRank = last.get(id);
      labelItems.push({ id, y: y(endRank), rank: endRank, color, picked });
    }

    spreadLabels(labelItems, 16, M.top + 6, M.top + plotH - 2);
    for (const it of labelItems) {
      const txt = chartLabel(it.id, 12);
      const lx = M.left + plotW + 12;
      svg += `<line class="grid-line" x1="${M.left + plotW + 2}" y1="${it.y}" x2="${lx - 3}" y2="${it.ly}"/>`;
      svg += `<circle class="trend-dot" cx="${M.left + plotW}" cy="${it.y}" r="3.5"
                fill="${it.color || 'var(--ink-3)'}"/>`;
      svg += `<text class="label-text" x="${lx}" y="${it.ly + 4}"
                style="${it.picked || isOurs(it.id) ? 'font-weight:600' : ''}${isOurs(it.id) ? ';fill:var(--ours)' : ''}">${esc(txt)}</text>`;
    }

    svg += '</svg>';
    return svg;
  }

  /* ---------------- 图表：热度趋势 ---------------- */

  function drawTrend(width) {
    const [s0, s1] = rangeIdx();
    const ts = state.series.ts.slice(s0, s1);
    const picks = state.picked.filter(id => state.series.series[id]);

    if (ts.length < 2) {
      return emptyChart(`趋势线需要至少 <strong>2 份快照</strong>，当前只有 ${state.series.ts.length} 份。<br>
        存档中需要至少两份快照才能显示曲线。`);
    }
    if (!picks.length) return emptyChart('用排行榜行尾的小图钉把作品加进对比组，这里就有曲线了。');

    const vals = [];
    for (const id of picks) {
      for (let i = s0; i < s1; i++) {
        const v = state.series.series[id][i];
        if (v != null) vals.push(v);
      }
    }
    if (!vals.length) return emptyChart('所选作品在这个时间范围内没有数据。');

    /* ---- 线性外推（虚线画到未来）----
       拟合窗口固定取全数据的最近 72 小时（不足就全用）：拿全程拟合会把
       早期慢热平均进来，低估当下节奏。外推跨度取三者最小：3 天、投票截止
       （8-31 24 点北京时间，之后热度冻结）、可见历史跨度的 60%（短范围
       视图里别让预测反客为主）。未来区接在历史区右侧的同一根时间轴上。 */
    const FIT_AHEAD_MS = 72 * 3600e3;
    const VOTE_END_MS = Date.parse('2026-08-31T23:59:59+08:00');
    const tLast = new Date(ts[ts.length - 1]).getTime();
    const histSpan = Math.max(1, tLast - new Date(ts[0]).getTime());
    const aheadMs = Math.min(FIT_AHEAD_MS, Math.max(0, VOTE_END_MS - tLast), histSpan * 0.6);

    const fits = new Map();                    // id -> { slopeH, vProj }
    if (aheadMs > 3600e3) {                    // 不足 1 小时的外推没有意义
      const allTs = state.series.ts;
      const cut = tLast - FIT_AHEAD_MS;
      for (const id of picks) {
        const S = state.series.series[id];
        let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, vLast = null;
        for (let i = 0; i < allTs.length; i++) {
          const v = S[i];
          if (v == null) continue;
          const t = new Date(allTs[i]).getTime();
          if (t < cut) continue;
          const xh = (t - tLast) / 3600e3;     // 以最新快照为原点的小时数
          n++; sx += xh; sy += v; sxx += xh * xh; sxy += xh * v;
          vLast = v;
        }
        const denom = n * sxx - sx * sx;
        if (n < 3 || !denom || vLast == null) continue;
        const slopeH = (n * sxy - sx * sy) / denom;    // 热度 / 小时
        // 锚在真实末点上外推（不是拟合线截距），虚线和实线无缝相接
        const vProj = Math.max(0, Math.round(vLast + slopeH * (aheadMs / 3600e3)));
        fits.set(id, { slopeH, vProj });
        vals.push(vProj);                      // 纵轴范围把虚线终点也装进来
      }
    }

    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (lo === hi) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.12;
    lo = Math.max(0, lo - pad); hi = hi + pad;

    const M = { top: 12, right: Math.min(180, Math.max(110, width * 0.2)), bottom: 28, left: 58 };
    const plotW = Math.max(120, width - M.left - M.right);
    const plotH = 260;
    const height = plotH + M.top + M.bottom;

    // 有外推时历史区按时间占比压缩，未来区补满到绘图区右缘
    const histW = fits.size ? plotW * (histSpan / (histSpan + aheadMs)) : plotW;
    const x = k => M.left + (k / (ts.length - 1)) * histW;
    const y = v => M.top + plotH - ((v - lo) / (hi - lo)) * plotH;

    let svg = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"
                    role="img" aria-label="所选作品的热度随时间变化">`;

    for (const t of niceTicks(lo, hi, 5)) {
      svg += `<line class="grid-line" x1="${M.left}" x2="${M.left + plotW}" y1="${y(t)}" y2="${y(t)}"/>`;
      svg += `<text class="axis-text" x="${M.left - 9}" y="${y(t) + 4}" text-anchor="end">${Math.round(t).toLocaleString('zh-CN')}</text>`;
    }

    const tickEvery = Math.max(1, Math.ceil(ts.length / Math.max(2, Math.floor(histW / 92))));
    for (let k = 0; k < ts.length; k += tickEvery) {
      svg += `<text class="axis-text" x="${x(k)}" y="${M.top + plotH + 18}" text-anchor="middle">${fmtTime(ts[k])}</text>`;
    }
    svg += `<line class="axis-line" x1="${M.left}" x2="${M.left + plotW}" y1="${M.top + plotH}" y2="${M.top + plotH}"/>`;

    // 现在/未来的分界虚线 + 外推终点的时间刻度
    if (fits.size) {
      const bx = (M.left + histW).toFixed(1);
      svg += `<line class="grid-line" x1="${bx}" x2="${bx}" y1="${M.top}" y2="${M.top + plotH}" stroke-dasharray="3 4"/>`;
      svg += `<text class="axis-text" x="${M.left + plotW}" y="${M.top + plotH + 18}" text-anchor="end">≈${fmtTime(tLast + aheadMs)}</text>`;
    }

    const labelItems = [];
    for (const id of picks) {
      const raw = state.series.series[id].slice(s0, s1);
      const pts = [];
      raw.forEach((v, k) => { if (v != null) pts.push([x(k), y(v), v]); });
      if (!pts.length) continue;
      const color = seriesColor(id);
      if (pts.length > 1) {
        const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
        svg += `<path class="trend-line" pathLength="1" style="stroke:${color}" d="${d}"/>`;
      }
      const end = pts[pts.length - 1];
      svg += `<circle class="trend-dot" cx="${end[0]}" cy="${end[1]}" r="4" fill="${color}"/>`;
      const fit = fits.get(id);
      if (fit) {
        // 虚线从真实末点画到外推终点，端点空心圈；标签跟着外推终点走
        const xe = M.left + plotW, ye = y(fit.vProj);
        svg += `<path class="fit-line" style="stroke:${color}" d="M${end[0].toFixed(1)},${end[1].toFixed(1)} L${xe.toFixed(1)},${ye.toFixed(1)}"/>`;
        svg += `<circle class="fit-dot" cx="${xe.toFixed(1)}" cy="${ye.toFixed(1)}" r="3" style="stroke:${color}"/>`;
        labelItems.push({ id, y: ye, x: xe, color, value: end[2], proj: fit.vProj });
      } else {
        labelItems.push({ id, y: end[1], x: end[0], color, value: end[2] });
      }
    }

    // 每个端点标签占两行（作品名 + 数值），间距要按两行算，否则会叠在一起
    spreadLabels(labelItems, 30, M.top + 8, M.top + plotH - 6);
    for (const it of labelItems) {
      const txt = chartLabel(it.id, 11);
      const lx = M.left + plotW + 12;
      svg += `<line class="grid-line" x1="${it.x + 5}" y1="${it.y}" x2="${lx - 3}" y2="${it.ly}"/>`;
      svg += `<text class="label-text" x="${lx}" y="${it.ly}" style="font-weight:600">${esc(txt)}</text>`;
      svg += `<text class="axis-text" x="${lx}" y="${it.ly + 13}">${num(it.value)}${it.proj != null ? ` → ${num(it.proj)}` : ''}</text>`;
    }

    // 十字准星热区只盖真实数据区（histW），未来区没有快照可读；
    // lo/hi 给悬停层换算各系列交点的 y 用
    svg += `<rect x="${M.left}" y="${M.top}" width="${histW}" height="${plotH}"
              fill="transparent" data-crosshair="1"
              data-left="${M.left}" data-plotw="${histW}" data-n="${ts.length}"
              data-lo="${lo}" data-hi="${hi}"/>`;
    svg += `<g id="crosshairLayer"></g>`;
    svg += '</svg>';

    // best fit 的值放在图下方一行不起眼的小字里：窗口、跨度、各作品斜率
    if (fits.size) {
      const bits = picks.filter(id => fits.has(id))
        .map(id => `${esc(chartLabel(id, 9))} ${esc(signed(Math.round(fits.get(id).slopeH * 24)))}/天`);
      svg += `<p class="fit-note">虚线 = 线性外推（近 72 小时最小二乘拟合，前推 ${esc(fmtSpan(aheadMs / 3600e3))}，`
        + `不超过 8-31 投票截止）· ${bits.join(' · ')}</p>`;
    }
    return svg;
  }

  function bindTrendCrosshair() {
    const host = $('#trend');
    const svg = host.querySelector('svg');
    if (!svg) return;
    const hit = svg.querySelector('[data-crosshair]');
    if (!hit) return;

    const [s0, s1] = rangeIdx();
    const ts = state.series.ts.slice(s0, s1);
    const left = +hit.dataset.left, plotW = +hit.dataset.plotw, n = +hit.dataset.n;
    const lo = +hit.dataset.lo, hi = +hit.dataset.hi;
    const top = +hit.getAttribute('y'), ph = +hit.getAttribute('height');
    const layer = svg.querySelector('#crosshairLayer');
    const picks = state.picked.filter(id => state.series.series[id]);

    /* 结构同详情图（bindDetailChart）：一次建好、只挪 transform，滑动交给 CSS 过渡。
       竖虚线组带时间徽标 + 每个系列在当前时刻的交点圆点。 */
    layer.setAttribute('style', 'pointer-events:none');
    layer.innerHTML = `
      <g class="xh-g" data-xg="1">
        <line class="xh-line" x1="0" x2="0" y1="${top}" y2="${top + ph}"/>
        <g class="xh-chip" data-xchip="1">
          <rect rx="4" y="${top + ph + 4}" height="17"/>
          <text y="${top + ph + 16.5}" text-anchor="middle"></text>
        </g>
        ${picks.map(id => `<circle class="xh-dot" data-dot="${esc(id)}" cx="0" cy="0" r="3.5"
            fill="${seriesColor(id)}"/>`).join('')}
      </g>`;
    layer.classList.add('xh-mark');

    const xg = $('[data-xg]', layer);
    const xChipG = $('[data-xchip]', layer);
    const xText = $('[data-xchip] text', layer);
    const xRect = $('[data-xchip] rect', layer);
    const dots = $$('.xh-dot', layer);

    const move = (clientX, clientY) => {
      const box = svg.getBoundingClientRect();
      const scale = box.width / svg.viewBox.baseVal.width;
      const px = (clientX - box.left) / scale;
      const k = Math.round(((px - left) / plotW) * (n - 1));
      const idx = Math.min(n - 1, Math.max(0, k));
      const cx = left + (idx / (n - 1)) * plotW;

      xg.style.transform = `translate(${cx.toFixed(1)}px,0)`;
      xText.textContent = fmtTime(ts[idx]);
      const xw = xText.getComputedTextLength();
      xRect.setAttribute('x', (-xw / 2 - 6).toFixed(1));
      xRect.setAttribute('width', (xw + 12).toFixed(1));
      const half = xw / 2 + 6;
      const dx = Math.min(Math.max(cx, left + half), left + plotW - half) - cx;
      xChipG.style.transform = `translate(${dx.toFixed(1)}px,0)`;

      for (const dot of dots) {
        const v = state.series.series[dot.dataset.dot][s0 + idx];
        dot.style.display = v == null ? 'none' : '';
        if (v != null) {
          const y = top + ph - ((v - lo) / (hi - lo)) * ph;
          dot.style.transform = `translate(0,${y.toFixed(1)}px)`;
        }
      }
      layer.classList.add('is-on');
      svg.classList.add('is-xh');

      const rows = picks
        .map(id => ({ id, v: state.series.series[id][s0 + idx] }))
        .filter(r => r.v != null)
        .sort((a, b) => b.v - a.v)
        .map(r => `<div class="tip-row">
             <span class="tip-dot" style="background:${seriesColor(r.id)}"></span>
             <span>${esc(displayName(r.id))}</span>
             <span class="tip-num" style="margin-left:auto">${num(r.v)}</span>
           </div>`).join('');
      showTip(`<b>${fmtTime(ts[idx])}</b>${rows}`, clientX, clientY);
    };

    const clear = () => { layer.classList.remove('is-on'); svg.classList.remove('is-xh'); hideTip(); };

    hit.addEventListener('mousemove', ev => move(ev.clientX, ev.clientY));
    hit.addEventListener('mouseleave', clear);

    // 触屏：按住滑动同样出十字准星，抬手即收
    hit.addEventListener('touchmove', ev => {
      const t = ev.touches[0];
      if (t) move(t.clientX, t.clientY);
    }, { passive: true });
    hit.addEventListener('touchend', clear);
  }

  function bindFlowHover() {
    const host = $('#rankflow');
    for (const hit of $$('.flow-hit', host)) {
      // 高亮只改 class，不重画整张图 —— 重画会把鼠标底下的节点换掉，
      // mouseleave 就再也不会触发，高亮会卡住
      const line = hit.previousElementSibling;
      hit.addEventListener('mousemove', ev => {
        if (line) line.classList.add('is-active');
        const id = hit.dataset.id;
        showTip(`<b>${esc(displayName(id))}</b>
                 <div class="tip-num">${num(zanOf(id))} 热度</div>
                 <div style="color:var(--ink-3)">点一下看详情</div>`,
          ev.clientX, ev.clientY);
      });
      hit.addEventListener('mouseleave', () => {
        if (line) line.classList.remove('is-active');
        hideTip();
      });
      hit.addEventListener('click', () => { hideTip(); openDetail(hit.dataset.id); });
    }
  }

  /** 线条描边生长只在首次进场跑一遍；之后的重画（筛选、resize）直接出现。 */
  let chartsAnimated = false;

  function chartEntrance(host) {
    if (chartsAnimated || REDUCED) return;
    host.classList.add('chart-animate');
    setTimeout(() => host.classList.remove('chart-animate'), 1000);
  }

  function renderFlow() {
    mountChart($('#rankflow'), drawRankFlow, bindFlowHover);
    chartEntrance($('#rankflow'));
  }

  function renderTrend() {
    mountChart($('#trend'), drawTrend, bindTrendCrosshair);
    chartEntrance($('#trend'));
    renderLegend();
    renderPicks();
  }

  function renderLegend() {
    const el = $('#trendLegend');
    if (!state.picked.length) { el.innerHTML = ''; return; }
    el.innerHTML = state.picked.map(id => `
      <button class="legend-item" type="button" data-id="${esc(id)}" title="移出趋势图">
        <span class="legend-swatch" style="background:${seriesColor(id)}"></span>
        ${esc(displayName(id))}
      </button>`).join('');
  }

  /* ---------------- 渲染：表格 ---------------- */

  function tableRows() {
    const ids = filteredIds();
    const rankOf = new Map(ids.map((id, i) => [id, i + 1]));
    const typeName = t => state.meta.typeMap[t] || t;
    const rows = ids.map(id => {
      const g = game(id);
      const e = info(id);
      return {
        id,
        rank: rankOf.get(id),
        name: g.name,
        dev: e.developer || '',
        url: e.url || '',
        type: g.types.map(typeName).join(' / '),
        tags: realTags(id),
        zan: zanOf(id) ?? 0,
        delta: deltaLast(id),
        today: todayDelta(id),
        score: e.score ?? null,
        comments: e.comments ?? null,
        raters: e.raters ?? null,
      };
    });
    const { key, dir } = state.sort;
    const sign = dir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      const av = a[key], bv = b[key];
      if (typeof av === 'string') return sign * av.localeCompare(bv, 'zh-CN');
      return sign * ((av ?? -Infinity) - (bv ?? -Infinity));
    });
    return rows;
  }

  function renderTable() {
    const all = tableRows();
    const rows = all.slice(0, state.tableLimit);
    const shownAll = rows.length === all.length;
    $('#tableSub').textContent = shownAll
      ? `${num(all.length)} 行 · 表头可排序 · 这也是上面所有图表的等价数据视图`
      : `共 ${num(all.length)} 行，先显示前 ${num(rows.length)} 行 · 表头可排序${CSV_PAUSED ? '' : ' · 导出 CSV 会包含全部'}`;
    $('#tableMore').textContent = shownAll && all.length > 50 ? '只看前 50 行' : '显示全部';
    $('#tableMore').hidden = all.length <= 50;
    const cell = v => v == null
      ? '<span style="color:var(--ink-3)">—</span>'
      : deltaChip(v);

    const dim = '<span style="color:var(--ink-3)">—</span>';
    $('#table tbody').innerHTML = rows.map(r => `
      <tr class="${isOurs(r.id) ? 'is-ours' : ''}" data-key="${esc(r.id)}">
        <td class="col-rank">${r.rank}</td>
        <td class="col-name">
          ${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noreferrer">${esc(r.name)}</a>` : esc(r.name)}
          <div>${r.tags.slice(0, 3).map(t => `<span class="tag-chip">${esc(t)}</span>`).join('')}</div>
        </td>
        <td>${r.dev ? esc(r.dev) : dim}</td>
        <td>${esc(r.type)}</td>
        <td class="col-num">${num(r.zan)}</td>
        <td class="col-num">${cell(r.delta)}</td>
        <td class="col-num">${cell(r.today)}</td>
        <td class="col-num">${r.score ? `<span class="score-num ${scoreClass(r.score)}">${r.score.toFixed(1)}</span>` : dim}</td>
        <td class="col-num">${r.comments ? num(r.comments) : dim}</td>
      </tr>`).join('') || '<tr><td colspan="9" style="color:var(--ink-3)">没有匹配的作品</td></tr>';

    for (const th of $$('#table th[data-sort]')) {
      if (th.dataset.sort === state.sort.key) {
        th.setAttribute('aria-sort', state.sort.dir === 'asc' ? 'ascending' : 'descending');
      } else {
        th.removeAttribute('aria-sort');
      }
    }
  }

  function exportCsv() {
    const rows = tableRows();
    const head = ['名次', 'ID', '作品', '开发团队', '品类', '标签', '热度',
                  '本轮', '当日新增', '评分', '打分人数', '评价数', '游戏页'];
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const body = rows.map(r => [
      r.rank, r.id, r.name, r.dev, r.type, r.tags.join('|'), r.zan,
      r.delta ?? '', r.today ?? '', r.score ?? '', r.raters ?? '', r.comments ?? '', r.url,
    ].map(q).join(','));
    const csv = '﻿' + [head.map(q).join(',')].concat(body).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `hykb-热度-${state.latest.ts.slice(0, 13).replace(/[:T]/g, '')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /* ---------------- 作品详情面板 ---------------- */

  let detailId = null;
  let detailOpener = null;       // 打开面板前的焦点元素，关闭时归还

  const allByZan = () =>
    [...state.ids].sort((a, b) => (zanOf(b) ?? -1) - (zanOf(a) ?? -1));

  function starDistHtml(e) {
    if (!e.starDist || !(e.raters > 0)) return '';
    const total = e.starDist.reduce((s, n) => s + (n || 0), 0) || 1;
    return `<div class="star-dist">${[5, 4, 3, 2, 1].map(star => {
      const n = e.starDist[star - 1] || 0;
      return `<div class="star-row">
        <span class="star-label">${star} 星</span>
        <div class="star-track"><div class="star-fill" style="width:${n ? Math.max(2, (n / total) * 100) : 0}%"></div></div>
        <span class="star-num">${num(n)}</span>
      </div>`;
    }).join('')}</div>`;
  }

  /* ---- 每小时点位图：当日 / 总览 ----
     「当日」和「当日新增」按北京时间（UTC+8）划界：投票、源站整点批刷、
     截止时间全是北京时间的节奏，跟着访问者时区走会把日界线切在源站刷新
     周期半中间，海外访问者看到的「今天」也对不上讨论里的数字。
     总览横轴和悬停仍按本地时区，标注同顶栏。 */

  let detailChartMode = 'day';
  let detailHover = null;          // 当前图的点位（视图坐标），hover 找最近点用

  const pad2 = n => String(n).padStart(2, '0');
  const dayOf = iso => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  };
  const clockOf = (iso, sec = false) => {
    const d = new Date(iso);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}` + (sec ? `:${pad2(d.getSeconds())}` : '');
  };
  /* 北京时间一组：整体平移 8 小时后用 getUTC* 读，和浏览器时区无关。 */
  const bjDate = iso => new Date(new Date(iso).getTime() + 8 * 3600e3);
  const bjDayOf = iso => {
    const d = bjDate(iso);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  };
  const bjClockOf = (iso, sec = false) => {
    const d = bjDate(iso);
    return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}` + (sec ? `:${pad2(d.getUTCSeconds())}` : '');
  };
  const bjHoursOf = iso => {
    const d = bjDate(iso);
    return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  };

  /** 最新快照所在北京日期的点位。当日新增 = 最后一点 − 第一点：
      基准取当天首份快照而不是隔夜最后一份 —— 源站整点批刷，00:05 那份
      才把前一晚最后一两个小时的票结清，拿隔夜值当基准会把那批算进「今天」。 */
  function daySeries(id) {
    const { ts } = state.series;
    const vals = state.series.series[id];
    if (!vals || !ts.length) return null;
    const day = bjDayOf(ts[ts.length - 1]);
    const pts = [];
    ts.forEach((t, i) => {
      const v = vals[i];
      if (v != null && bjDayOf(t) === day) pts.push({ t, v });
    });
    return { day, pts };
  }

  function todayDelta(id) {
    const d = daySeries(id);
    if (!d || !d.pts.length) return null;
    return d.pts[d.pts.length - 1].v - d.pts[0].v;
  }

  /** 「按日」柱状图：每根柱是一个北京时间自然日的热度增量。
      口径：次日首份快照 − 当日首份快照。源站整点批结算，H 点那批清的是
      前一小时的票，所以次日 00:05 的快照恰好收账到当日 24 点 —— 每根柱
      就是当日 0 点到 24 点投出的票，各柱之和等于总涨幅，隔夜批不再
      不归属任何一天地蒸发掉（曾经因此看丢过对手跨日净赚的几百热度）。
      次日整天没快照时退回「当日末份 − 首份」，宁可少算隔夜批也别错归；
      最右是今天，口径同「当日新增」（收口还没到），画成虚边淡柱。
      返回值形状同 detailChart：{ html, hover, note }，悬停走同一套十字线。 */
  function dailyChart(id) {
    const { ts } = state.series;
    const vals = state.series.series[id];

    const byDay = new Map();                   // 北京日期 -> { first, last }
    ts.forEach((t, i) => {
      const v = vals[i];
      if (v == null) return;
      const day = bjDayOf(t);
      const cur = byDay.get(day);
      if (cur) cur.last = v;
      else byDay.set(day, { first: v, last: v });
    });

    const nextDayOf = day => {
      const [y, m, d] = day.split('-').map(Number);
      const t = new Date(Date.UTC(y, m - 1, d) + 24 * 3600e3);
      return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
    };

    const entries = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const days = entries.map(([day, r], k) => {
      if (k === entries.length - 1) return { day, d: r.last - r.first, live: true };
      const next = entries[k + 1];
      return next[0] === nextDayOf(day)
        ? { day, d: next[1].first - r.first, live: false }
        : { day, d: r.last - r.first, live: false };
    });

    const note = `每根柱 = 该日 0 点到次日 0 点结算的票（北京时间，次日首份快照 − 当日首份快照）`
      + (days.some(r => r.live) ? ' · 今天的柱子还在长' : '');
    if (!days.length) {
      return { html: '<p class="d-note">存档中没有可显示的快照。</p>', hover: [], note };
    }

    const W = Math.max(300, Math.min(window.innerWidth, 520) - 40), H = 210;
    const M = { top: 26, right: 14, bottom: 26, left: 46 };
    const plotW = W - M.left - M.right, plotH = H - M.top - M.bottom;

    let lo = Math.min(0, ...days.map(r => r.d));
    let hi = Math.max(0, ...days.map(r => r.d));
    if (lo === hi) hi = 1;
    hi += (hi - lo) * 0.08;

    const Y = v => M.top + plotH * (1 - (v - lo) / (hi - lo));

    let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img"
      aria-label="${esc(displayName(id))}每日热度增量柱状图">`;

    for (const v of niceTicks(lo, hi, 5)) {
      svg += `<line class="grid-line" x1="${M.left}" x2="${M.left + plotW}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/>`;
      svg += `<text class="axis-text" x="${M.left - 8}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${num(v)}</text>`;
    }

    const band = plotW / days.length;
    const barW = Math.max(3, Math.min(34, band * 0.62));
    const color = isOurs(id) ? 'var(--ours)' : 'var(--bar)';

    /* 圆角只给数据端（正柱在顶、负柱在底），基线端平角贴轴 */
    const barPath = (cx, d) => {
      const y0 = Y(0), y1 = Y(d);
      const top = Math.min(y0, y1), h = Math.abs(y1 - y0);
      const x0 = cx - barW / 2, x1 = cx + barW / 2;
      if (h < 0.75) return '';                 // 零增量：不画柱，留给悬停念数
      const r = Math.min(3.5, h, barW / 2);
      if (d >= 0) {
        return `M${x0.toFixed(1)},${y0.toFixed(1)} V${(top + r).toFixed(1)}
          Q${x0.toFixed(1)},${top.toFixed(1)} ${(x0 + r).toFixed(1)},${top.toFixed(1)}
          H${(x1 - r).toFixed(1)} Q${x1.toFixed(1)},${top.toFixed(1)} ${x1.toFixed(1)},${(top + r).toFixed(1)}
          V${y0.toFixed(1)} Z`;
      }
      const bot = top + h;
      return `M${x0.toFixed(1)},${y0.toFixed(1)} V${(bot - r).toFixed(1)}
        Q${x0.toFixed(1)},${bot.toFixed(1)} ${(x0 + r).toFixed(1)},${bot.toFixed(1)}
        H${(x1 - r).toFixed(1)} Q${x1.toFixed(1)},${bot.toFixed(1)} ${x1.toFixed(1)},${(bot - r).toFixed(1)}
        V${y0.toFixed(1)} Z`;
    };

    const hover = [];
    days.forEach((r, k) => {
      const cx = M.left + (k + 0.5) * band;
      const d = barPath(cx, r.d);
      if (d) svg += `<path class="d-bar${r.live ? ' d-bar-live' : ''}" fill="${color}"
        ${r.live ? `stroke="${color}"` : ''} d="${d}"/>`;
      hover.push({
        x: cx, y: Y(r.d), v: r.d,
        label: r.day.slice(5),
        chip: signed(r.d),
        tip: `<b>${esc(r.day.slice(5))}${r.live ? '（今天，进行中）' : ''}</b>
          <div class="tip-num">当日 ${esc(signed(r.d))}</div>`,
      });
    });

    // 日期刻度：按可用宽度抽样，最右（今天）必标
    const labelEvery = Math.max(1, Math.ceil(days.length / Math.max(2, Math.floor(plotW / 46))));
    days.forEach((r, k) => {
      const isLast = k === days.length - 1;
      if (!isLast && (k % labelEvery !== 0 || days.length - 1 - k < labelEvery)) return;
      const cx = M.left + (k + 0.5) * band;
      svg += `<text class="axis-text" x="${cx.toFixed(1)}" y="${M.top + plotH + 18}" text-anchor="middle"
        ${r.live ? 'font-weight="650"' : ''}>${r.day.slice(5)}</text>`;
    });

    // 零基线压在柱子上方画，负增量出现时上下两侧都读得清
    svg += `<line class="axis-line" x1="${M.left}" x2="${M.left + plotW}" y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}"/>`;

    svg += `<rect x="${M.left}" y="${M.top}" width="${plotW}" height="${plotH}" fill="transparent" data-dhover="1"/>`;
    svg += `<g data-dhmark="1" style="pointer-events:none"></g>`;
    svg += '</svg>';
    return { html: svg, hover, note };
  }

  /** 详情面板点位图。返回 { html, hover, note }；当日没数据时 html 是提示文案。 */
  function detailChart(id, mode) {
    if (mode === 'daily') return dailyChart(id);
    const { ts } = state.series;
    const vals = state.series.series[id];
    const day = daySeries(id);

    let pts;                       // [{t, v, u∈0..1, dv 较前一点}]
    if (mode === 'day') {
      pts = day.pts.map(p => ({ ...p, u: bjHoursOf(p.t) / 24 }));
      pts.forEach((p, k) => {
        p.dv = k ? p.v - pts[k - 1].v : null;   // 首点是今日基准，没有可归属的涨幅
      });
    } else {
      const t0 = new Date(ts[0]).getTime();
      const span = Math.max(1, new Date(ts[ts.length - 1]).getTime() - t0);
      pts = [];
      ts.forEach((t, i) => {
        if (vals[i] == null) return;
        pts.push({
          t, v: vals[i], u: (new Date(t).getTime() - t0) / span,
          dv: pts.length ? vals[i] - pts[pts.length - 1].v : null,
        });
      });
    }

    const note = mode === 'day'
      ? `只显示当日（${day.day.slice(5)}，北京时间）数据 · ${pts.length} 个有效记录`
        + ` · 数据更新至 ${bjClockOf(ts[ts.length - 1], true)} · 横线表示热度值未变化`
      : `历史采集始于 ${fmtTime(ts[0])} ${TZ_LABEL} · 共 ${ts.length} 份快照`;

    if (!pts.length) {
      return { html: `<p class="d-note">当日（${day.day.slice(5)}）还没有这个作品的快照。</p>`, hover: [], note };
    }

    /* 画布宽跟着抽屉实际内容宽走（520px 抽屉 − 40px 内边距；窄屏是全宽底部抽屉），
       SVG 就按 1:1 显示，轴字号不会被缩放压小。520 要和 CSS 里 .drawer 的宽度一致。 */
    const W = Math.max(300, Math.min(window.innerWidth, 520) - 40), H = 210;
    const M = { top: 26, right: 14, bottom: 26, left: 46 };
    const plotW = W - M.left - M.right, plotH = H - M.top - M.bottom;

    let lo = Infinity, hi = -Infinity;
    for (const p of pts) { lo = Math.min(lo, p.v); hi = Math.max(hi, p.v); }
    const pad = (hi - lo) * 0.1 || Math.max(2, Math.round(hi * 0.03));
    lo = Math.max(0, lo - pad); hi += pad;

    const X = u => M.left + u * plotW;
    const Y = v => M.top + plotH * (1 - (v - lo) / (hi - lo));

    let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img"
      aria-label="${esc(displayName(id))}${mode === 'day' ? '当日' : '全程'}热度点位图">`;

    for (const v of niceTicks(lo, hi, 5)) {
      svg += `<line class="grid-line" x1="${M.left}" x2="${M.left + plotW}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/>`;
      svg += `<text class="axis-text" x="${M.left - 8}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${num(v)}</text>`;
    }

    if (mode === 'day') {
      for (let h = 0; h <= 18; h += 3) {   // 21 不画，给右端的 23:59 留出地方
        svg += `<text class="axis-text" x="${X(h / 24).toFixed(1)}" y="${M.top + plotH + 18}" text-anchor="middle">${h}</text>`;
      }
      svg += `<text class="axis-text" x="${X(1).toFixed(1)}" y="${M.top + plotH + 18}" text-anchor="end">23:59</text>`;
    } else {
      /* 总览跨多天：在「本地日界」打刻度、只标日期（MM-DD）——
         带时刻的长标签（08-04 15:05）几个并排在这块画布上必然互相压字，
         精确时刻交给悬停十字线去讲。跨度不足两天时日界刻度太少，
         退回按点位取样的时刻刻度（那时至多一个标签带日期，压不起来）。 */
      const t0 = new Date(ts[0]).getTime();
      const t1 = new Date(ts[ts.length - 1]).getTime();
      const span = Math.max(1, t1 - t0);
      const bounds = [];
      const cur = new Date(t0);
      cur.setHours(0, 0, 0, 0); cur.setDate(cur.getDate() + 1);
      while (cur.getTime() <= t1) { bounds.push(cur.getTime()); cur.setDate(cur.getDate() + 1); }
      if (bounds.length >= 2) {
        const step = Math.ceil(bounds.length / Math.max(2, Math.floor(plotW / 56)));
        for (let i = 0; i < bounds.length; i += step) {
          const px = X((bounds[i] - t0) / span);
          if (px > M.left + plotW - 20) break;   // 右端留白，标签别画出画布
          svg += `<line class="grid-line" x1="${px.toFixed(1)}" x2="${px.toFixed(1)}" y1="${M.top}" y2="${M.top + plotH}"/>`;
          svg += `<text class="axis-text" x="${px.toFixed(1)}" y="${M.top + plotH + 18}" text-anchor="middle">${dayOf(bounds[i]).slice(5)}</text>`;
        }
      } else {
        const at = pts.length > 3
          ? [...new Set([0, (pts.length - 1) / 3, (pts.length - 1) * 2 / 3, pts.length - 1].map(Math.round))]
          : pts.map((_, i) => i);
        let lastU = -Infinity, lastDay = '';
        for (const i of at) {
          const p = pts[i];
          const withDate = dayOf(p.t) !== lastDay;
          if (p.u - lastU < (withDate ? 0.26 : 0.14)) continue;
          lastU = p.u; lastDay = dayOf(p.t);
          const anchor = p.u < 0.08 ? 'start' : p.u > 0.92 ? 'end' : 'middle';
          svg += `<text class="axis-text" x="${X(p.u).toFixed(1)}" y="${M.top + plotH + 18}" text-anchor="${anchor}">${withDate ? fmtTime(p.t) : clockOf(p.t)}</text>`;
        }
      }
    }
    svg += `<line class="axis-line" x1="${M.left}" x2="${M.left + plotW}" y1="${M.top + plotH}" y2="${M.top + plotH}"/>`;

    const color = isOurs(id) ? 'var(--ours)' : 'var(--bar)';
    if (pts.length > 1) {
      const d = pts.map((p, k) => `${k ? 'L' : 'M'}${X(p.u).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
      // pathLength=1 是给 CSS 的描边生长动画用的（.d-chart .trend-line）
      svg += `<path class="trend-line" pathLength="1" style="stroke:${color}" d="${d}"/>`;
    }

    const hover = pts.map(p => ({
      x: X(p.u), y: Y(p.v), v: p.v, dv: p.dv,
      label: mode === 'day' ? bjClockOf(p.t) : fmtTime(p.t),
    }));

    if (mode === 'day' || pts.length <= 48) {
      for (let k = 0; k < hover.length - 1; k++) {
        svg += `<circle class="trend-dot" cx="${hover[k].x.toFixed(1)}" cy="${hover[k].y.toFixed(1)}" r="3.5" fill="${color}"/>`;
      }
    }
    const end = hover[hover.length - 1];
    svg += `<circle class="rt-dot" cx="${end.x.toFixed(1)}" cy="${end.y.toFixed(1)}" r="5" style="stroke:${color}"/>`;
    if (mode === 'day') {
      const lx = Math.min(Math.max(end.x, M.left + 14), W - M.right - 14);
      svg += `<text class="rt-label" x="${lx.toFixed(1)}" y="${(end.y - 11).toFixed(1)}" text-anchor="middle" style="fill:${color}">实时</text>`;
    }

    svg += `<rect x="${M.left}" y="${M.top}" width="${plotW}" height="${plotH}" fill="transparent" data-dhover="1"/>`;
    svg += `<g data-dhmark="1" style="pointer-events:none"></g>`;
    svg += '</svg>';
    return { html: svg, hover, note };
  }

  function bindDetailChart() {
    const host = $('#detailChart');
    const svg = host && $('svg', host);
    if (!svg || !detailHover || !detailHover.length) return;
    const hit = $('[data-dhover]', svg);
    const mark = $('[data-dhmark]', svg);
    if (!hit || !mark) return;

    const px0 = +hit.getAttribute('x'), py0 = +hit.getAttribute('y');
    const pw = +hit.getAttribute('width'), ph = +hit.getAttribute('height');

    /* 十字线整套只建一次，之后每帧只挪 transform —— CSS 过渡负责在点位间滑动；
       改用 innerHTML 重建的话，节点一换过渡就没了。
       两条虚线各归一个组：竖线组只在 x 方向动（带着 x 轴的时间徽标），
       横线组只在 y 方向动（带着 y 轴的数值徽标），圆环单独动。 */
    mark.innerHTML = `
      <g class="xh-g" data-xg="1">
        <line class="xh-line" x1="0" x2="0" y1="${py0}" y2="${py0 + ph}"/>
        <g class="xh-chip" data-xchip="1">
          <rect rx="4" y="${py0 + ph + 4}" height="17"/>
          <text y="${py0 + ph + 16.5}" text-anchor="middle"></text>
        </g>
      </g>
      <g class="xh-g" data-yg="1">
        <line class="xh-line" x1="${px0}" x2="${px0 + pw}" y1="0" y2="0"/>
        <g class="xh-chip">
          <rect rx="4" y="-9" height="18"/>
          <text x="${px0 - 8}" y="4" text-anchor="end"></text>
        </g>
      </g>
      <circle class="dh-ring" cx="0" cy="0" r="6"/>`;
    mark.classList.add('xh-mark');

    const xg = $('[data-xg]', mark), yg = $('[data-yg]', mark);
    const ring = $('.dh-ring', mark);
    const xChipG = $('[data-xchip]', mark);
    const xText = $('[data-xg] text', mark), yText = $('[data-yg] text', mark);
    const xRect = $('[data-xg] rect', mark), yRect = $('[data-yg] rect', mark);

    const move = (cx, cy) => {
      const box = svg.getBoundingClientRect();
      const scale = (box.width / svg.viewBox.baseVal.width) || 1;
      const px = (cx - box.left) / scale;
      let best = detailHover[0];
      for (const p of detailHover) if (Math.abs(p.x - px) < Math.abs(best.x - px)) best = p;

      // 徽标按文字实际宽度撑底板；时间徽标贴近两端时往里挪，虚线本身不动
      // y 轴徽标：柱状图给的是带符号的当日增量（best.chip），点位图是热度绝对值
      xText.textContent = best.label;
      yText.textContent = best.chip != null ? best.chip : num(best.v);
      const xw = xText.getComputedTextLength(), yw = yText.getComputedTextLength();
      xRect.setAttribute('x', (-xw / 2 - 6).toFixed(1));
      xRect.setAttribute('width', (xw + 12).toFixed(1));
      yRect.setAttribute('x', (px0 - 8 - yw - 6).toFixed(1));
      yRect.setAttribute('width', (yw + 12).toFixed(1));
      const half = xw / 2 + 6;
      const dx = Math.min(Math.max(best.x, px0 + half), px0 + pw - half) - best.x;
      xChipG.style.transform = `translate(${dx.toFixed(1)}px,0)`;

      xg.style.transform = `translate(${best.x.toFixed(1)}px,0)`;
      yg.style.transform = `translate(0,${best.y.toFixed(1)}px)`;
      ring.style.transform = `translate(${best.x.toFixed(1)}px,${best.y.toFixed(1)}px)`;
      mark.classList.add('is-on');
      svg.classList.add('is-xh');

      showTip(best.tip || `<b>${esc(best.label)}</b>
        <div class="tip-num">${num(best.v)} 热度</div>
        ${best.dv != null ? `<div style="color:var(--ink-3)">较前一点 ${esc(signed(best.dv))}</div>` : ''}`, cx, cy);
    };
    const clear = () => { mark.classList.remove('is-on'); svg.classList.remove('is-xh'); hideTip(); };

    hit.addEventListener('mousemove', ev => move(ev.clientX, ev.clientY));
    hit.addEventListener('mouseleave', clear);
    hit.addEventListener('touchmove', ev => {
      const t = ev.touches[0];
      if (t) move(t.clientX, t.clientY);
    }, { passive: true });
    hit.addEventListener('touchend', clear);
  }

  function renderDetail(id) {
    const g = game(id);
    const e = info(id);
    const order = allByZan();
    const idx = order.indexOf(id);

    // 全场名次与较上次的名次变化（用「热度 − 本轮涨幅」还原上一份快照的排序）
    const prevOrder = state.ids
      .map(x => ({ x, v: (zanOf(x) || 0) - (deltaLast(x) || 0) }))
      .sort((a, b) => b.v - a.v);
    const prevIdx = prevOrder.findIndex(r => r.x === id);
    const rankDelta = (idx >= 0 && prevIdx >= 0) ? prevIdx - idx : 0;   // 正数 = 上升

    const chips = g.types.map(t => `<span class="tag-chip">${esc(state.meta.typeMap[t] || t)}</span>`)
      .concat(realTags(id).map(t => `<span class="tag-chip">${esc(t)}</span>`)).join('');

    const links = [
      e.url && `<a class="ghost-btn" href="${esc(e.url)}" target="_blank" rel="noreferrer">游戏页 ↗</a>`,
      e.forum && `<a class="ghost-btn" href="${esc(e.forum)}" target="_blank" rel="noreferrer">论坛 ↗</a>`,
      e.download && `<a class="ghost-btn" href="${esc(e.download)}" target="_blank" rel="noreferrer">下载 ↗</a>`,
    ].filter(Boolean).join('');

    const metaRows = [
      ['平台', e.platform], ['语言', e.language], ['更新', e.updated], ['发行', e.publisher],
    ].filter(r => r[1]);

    const picked = state.picked.includes(id);

    let chartBlock;
    if (!state.series.series[id]) {
      detailHover = null;
      chartBlock = '<p class="d-note">还没有抓到这个作品的快照。</p>';
    } else {
      const c = detailChart(id, detailChartMode);
      detailHover = c.hover;
      chartBlock = `
        <div class="d-tabs" role="tablist" aria-label="走势范围">
          <button class="tab" type="button" role="tab" data-chartmode="day" aria-selected="${detailChartMode === 'day'}">当日</button>
          <button class="tab" type="button" role="tab" data-chartmode="daily" aria-selected="${detailChartMode === 'daily'}">按日</button>
          <button class="tab" type="button" role="tab" data-chartmode="all" aria-selected="${detailChartMode === 'all'}">总览</button>
        </div>
        <div class="d-chart" id="detailChart">${c.html}</div>
        <p class="d-chart-note">${c.note}</p>`;
    }

    $('#drawerContent').innerHTML = `
      ${g.img ? `<img class="d-banner" src="${esc(g.img)}" alt="" onerror="this.remove()">` : ''}
      <div class="d-body">
        <header class="d-head">
          <img class="focus-icon" src="${esc(g.icon || '')}" alt=""
               loading="lazy" onerror="this.style.visibility='hidden'">
          <div>
            <h2 class="d-title" id="drawerTitle" tabindex="-1">${esc(displayName(id))}</h2>
            ${e.developer ? `<p class="d-dev">${esc(e.developer)}${e.authorized ? ` · ${esc(e.authorized)}` : ''}</p>` : ''}
          </div>
        </header>
        ${chips ? `<div class="d-chips">${chips}</div>` : ''}
        ${g.intro ? `<p class="d-intro">${esc(g.intro)}</p>` : ''}

        <section class="d-section">
          <h3>热度</h3>
          <div class="d-stats">
            <div><span class="d-label">当前热度</span><span class="d-num">${num(zanOf(id))}</span></div>
            <div><span class="d-label">当日新增（北京时间）</span>${deltaChip(todayDelta(id))}</div>
            <div><span class="d-label">全场名次</span><span class="d-num">${idx >= 0 ? '#' + (idx + 1) : '—'}</span>
              ${rankDelta ? `<span class="chip ${rankDelta > 0 ? 'chip-up' : 'chip-down'}">${rankDelta > 0 ? '▲' : '▼'} ${Math.abs(rankDelta)}</span>` : ''}</div>
            <div><span class="d-label" title="较上一份数字有变化的快照 —— 源站约每小时结一批，正常就是最近一个整点批">本轮</span>${deltaChip(deltaLast(id))}</div>
          </div>
          ${chartBlock}
        </section>

        <section class="d-section">
          <h3>玩家评价</h3>
          ${e.score ? `
            <p class="d-score"><b class="${scoreClass(e.score)}">${e.score.toFixed(1)}</b> · ${num(e.raters || 0)} 人打分 · ${num(e.comments || 0)} 条评价</p>
            ${starDistHtml(e)}`
          : '<p class="d-note">还没有玩家评分。评分要玩过的人打出来，和热度是两回事。</p>'}
        </section>

        ${metaRows.length ? `
        <section class="d-section">
          <h3>档案</h3>
          <dl class="d-meta">${metaRows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
        </section>` : ''}

        ${links ? `<section class="d-section"><h3>链接</h3><div class="d-links">${links}</div></section>` : ''}

        <div class="d-actions">
          <button class="ghost-btn" id="drawerPick" type="button" aria-pressed="${picked}">
            ${picked ? '移出趋势对比' : '加入趋势对比'}
          </button>
          <span class="d-actions-spacer"></span>
          <button class="ghost-btn" id="drawerPrev" type="button" ${idx > 0 ? '' : 'disabled'}>← 上一名</button>
          <button class="ghost-btn" id="drawerNext" type="button" ${idx >= 0 && idx < order.length - 1 ? '' : 'disabled'}>下一名 →</button>
        </div>
      </div>`;

    for (const b of $$('[data-chartmode]', $('#drawerContent'))) {
      b.addEventListener('click', () => {
        if (detailChartMode === b.dataset.chartmode) return;
        detailChartMode = b.dataset.chartmode;
        renderDetail(id);
      });
    }
    bindDetailChart();

    $('#drawerPick').addEventListener('click', () => {
      togglePick(id);
      renderDetail(id);          // 刷新按钮文案与压下态
    });
    $('#drawerPrev').addEventListener('click', () => {
      if (idx > 0) openDetail(order[idx - 1], detailOpener);
    });
    $('#drawerNext').addEventListener('click', () => {
      if (idx >= 0 && idx < order.length - 1) openDetail(order[idx + 1], detailOpener);
    });
  }

  function openDetail(id, opener) {
    id = String(id);
    if (!state.meta.games[id]) return;
    if (detailId == null) detailOpener = opener || document.activeElement;
    detailId = id;
    renderDetail(id);
    $('#drawerOverlay').hidden = false;
    $('#drawer').hidden = false;
    $('#drawer').scrollTop = 0;
    document.body.classList.add('drawer-open');
    if (location.hash !== '#g=' + id) history.replaceState(null, '', '#g=' + id);
    $('#drawerTitle').focus();
  }

  function closeDetail() {
    if ($('#drawer').hidden) return;
    $('#drawer').hidden = true;
    $('#drawerOverlay').hidden = true;
    document.body.classList.remove('drawer-open');
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    detailId = null;
    if (detailOpener && document.contains(detailOpener)) detailOpener.focus();
    detailOpener = null;
  }

  /* ---------------- 交互 ---------------- */

  function togglePick(id) {
    const i = state.picked.indexOf(id);
    if (i >= 0) {
      state.picked.splice(i, 1);
      state.slots.delete(id);
    } else {
      if (state.picked.length >= MAX_PICKS) {
        const dropped = state.picked.shift();
        state.slots.delete(dropped);
      }
      state.picked.push(id);
      assignSlot(id);
    }
    renderBoard();
    renderFlow();
    renderTrend();
  }

  function renderTagOptions() {
    const counts = new Map();
    for (const id of state.ids) {
      for (const t of realTags(id)) counts.set(t, (counts.get(t) || 0) + 1);
    }
    const opts = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
      .map(([t, n]) => `<option value="${esc(t)}">${esc(t)}（${n}）</option>`)
      .join('');
    $('#tagFilter').innerHTML = `<option value="">全部标签</option>${opts}`;
  }

  function resetPicks() {
    state.picked = [];
    state.slots.clear();
    // 关注作品有数据就默认在对比组里（即便不在当前筛选下），再补当前筛选的前几名
    if (state.series.series[FOCUS_ID]) state.picked.push(FOCUS_ID);
    for (const id of filteredIds()) {
      if (state.picked.length >= MAX_PICKS) break;
      if (!state.picked.includes(id)) {
        state.picked.push(id);
        assignSlot(id);
      }
    }
  }

  /** 品类 / 标签 / 搜索变化后，除了顶部 tab 之外都要重画 */
  function renderFiltered() {
    renderHero();
    renderKpis();
    renderBoard();
    renderMovers();
    renderTeams();
    renderTags();
    renderQuality();
    renderFlow();
    renderTable();
  }

  function renderAll() {
    renderTabs();
    renderFiltered();
    renderTrend();
  }

  function bindEvents() {
    $('#typeTabs').addEventListener('click', ev => {
      const btn = ev.target.closest('.tab');
      if (!btn) return;
      state.type = btn.dataset.type;
      state.boardLimit = BOARD_ROWS;
      resetPicks();
      renderAll();
    });

    let searchTimer;
    $('#search').addEventListener('input', ev => {
      clearTimeout(searchTimer);
      const v = ev.target.value;
      searchTimer = setTimeout(() => {
        state.q = v;
        state.boardLimit = BOARD_ROWS;
        renderFiltered();
      }, 160);
    });

    $('#tagFilter').addEventListener('change', ev => {
      state.tag = ev.target.value;
      state.boardLimit = BOARD_ROWS;
      renderFiltered();
    });

    // 标签热度榜：点行即筛选，再点同一行取消，和下拉框保持同步
    bindActivate($('#tags'), key => {
      state.tag = state.tag === key ? '' : key;
      $('#tagFilter').value = state.tag;
      state.boardLimit = BOARD_ROWS;
      renderFiltered();
    });

    $('#range').addEventListener('change', ev => {
      state.range = ev.target.value;
      renderFlow();
      renderTrend();
    });

    // 排行榜：行尾图钉管趋势对比，行上其他任何地方（除了外链）都是看详情
    $('#board').addEventListener('click', ev => {
      const pin = ev.target.closest('.pin-btn');
      if (pin) { togglePick(pin.dataset.pin); return; }
      if (ev.target.closest('a')) return;
      const row = ev.target.closest('[data-row]');
      if (row) openDetail(row.dataset.row, row.querySelector('.board-name'));
    });

    // 涨幅榜 / 口碑榜 / 领奖台：点行（卡）看详情
    bindActivate($('#movers'), (id, row) => openDetail(id, row));
    bindActivate($('#quality'), (id, row) => openDetail(id, row));
    bindActivate($('#hero'), (id, row) => openDetail(id, row));

    // 涨幅榜口径切换：今日 / 本轮。换口径时列表淡入一下，标出内容换了
    $('#moverTabs').addEventListener('click', ev => {
      const btn = ev.target.closest('[data-movermode]');
      if (!btn || state.moverMode === btn.dataset.movermode) return;
      state.moverMode = btn.dataset.movermode;
      renderMovers();
      const h = $('#movers');
      h.classList.remove('swap-in');
      void h.offsetWidth;               // 强制回流，动画才能重播
      h.classList.add('swap-in');
    });

    // 对比组：点行看详情，点 × 移出（bindActivate 连键盘激活一起管）
    bindActivate($('#pickList'), (id, row, ev) => {
      if (ev.target.closest('[data-unpick]')) { togglePick(id); return; }
      openDetail(id, row);
    });

    // 「看趋势」：滚到趋势卡看完整曲线；系统减动效时直接落位
    $('#pickJump').addEventListener('click', () => {
      $('#sec-trend').scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth' });
    });

    // 全量表格：点行看详情（行内链接除外；表格行不做 tab 停留，键盘走排行榜）
    $('#table').addEventListener('click', ev => {
      if (ev.target.closest('a') || ev.target.closest('th')) return;
      const tr = ev.target.closest('tr[data-key]');
      if (tr) openDetail(tr.dataset.key);
    });

    // 详情面板：关闭、遮罩、Esc、焦点圈定
    $('#drawerClose').addEventListener('click', closeDetail);
    $('#drawerOverlay').addEventListener('click', closeDetail);
    document.addEventListener('keydown', ev => {
      if ($('#drawer').hidden) return;
      if (ev.key === 'Escape') { closeDetail(); return; }
      if (ev.key !== 'Tab') return;
      const items = $$('button:not([disabled]), a[href]', $('#drawer'));
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
      else if (!$('#drawer').contains(document.activeElement)) { ev.preventDefault(); first.focus(); }
    });

    // 移动端底部抽屉：内容顶到最上时继续下拉即关闭
    const drawerEl = $('#drawer');
    let touchStartY = null;
    drawerEl.addEventListener('touchstart', ev => {
      touchStartY = drawerEl.scrollTop <= 0 ? ev.touches[0].clientY : null;
    }, { passive: true });
    drawerEl.addEventListener('touchmove', ev => {
      if (touchStartY == null) return;
      if (ev.touches[0].clientY - touchStartY > 80) {
        touchStartY = null;
        closeDetail();
      }
    }, { passive: true });

    // #g=<id> 深链：直接打开对应作品
    window.addEventListener('hashchange', () => {
      const m = location.hash.match(/^#g=(\w+)$/);
      if (m && state.meta.games[m[1]]) openDetail(m[1]);
      else closeDetail();
    });

    $('#trendLegend').addEventListener('click', ev => {
      const btn = ev.target.closest('.legend-item');
      if (btn) togglePick(btn.dataset.id);
    });

    $('#rankMore').addEventListener('click', () => {
      const total = filteredIds().length;
      state.boardLimit = state.boardLimit >= total ? BOARD_ROWS : total;
      renderBoard();
    });

    $('#trendReset').addEventListener('click', () => {
      resetPicks();
      renderBoard();
      renderFlow();
      renderTrend();
    });

    $('#tableMore').addEventListener('click', () => {
      state.tableLimit = state.tableLimit === 50 ? Infinity : 50;
      renderTable();
    });

    // 暂停期把按钮整个藏掉（#app 展示前就执行，不会闪现）；恢复只动 CSV_PAUSED
    if (CSV_PAUSED) $('#exportCsv').hidden = true;
    else $('#exportCsv').addEventListener('click', exportCsv);

    $('#table').addEventListener('click', ev => {
      const th = ev.target.closest('th[data-sort]');
      if (!th) return;
      const key = th.dataset.sort;
      if (state.sort.key === key) {
        state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sort = { key, dir: key === 'rank' || key === 'name' ? 'asc' : 'desc' };
      }
      renderTable();
    });

    // 日/月图标本体在 index.html 里，显隐由 CSS 按 data-theme 切，这里只管状态和无障碍文案
    const toggle = $('#themeToggle');
    const labelTheme = dark => {
      const label = dark ? '切换到浅色' : '切换到深色';
      toggle.setAttribute('aria-label', label);
      toggle.title = label;
    };
    const applyTheme = t => {
      document.documentElement.dataset.theme = t;
      labelTheme(t === 'dark');
      try { localStorage.setItem('hykb-theme', t); } catch (_) {}
      renderFlow();
      renderTrend();
    };
    toggle.addEventListener('click', () => {
      const now = document.documentElement.dataset.theme;
      const isDark = now === 'dark' ||
        (!now && matchMedia('(prefers-color-scheme: dark)').matches);
      const next = isDark ? 'light' : 'dark';
      /* 换肤动效走 View Transitions：整页快照做一次合成器级交叉淡化，
         所有组件（包括重画的图表）同一拍换色。别走「给每个元素挂 transition」
         的路子 —— 上千个节点各自跑样式过渡，掉帧还互相不同步。
         不支持的浏览器直接切，和从前一样。 */
      if (!REDUCED && document.startViewTransition) {
        document.startViewTransition(() => applyTheme(next));
      } else {
        applyTheme(next);
      }
    });
    let saved = null;
    try { saved = localStorage.getItem('hykb-theme'); } catch (_) {}
    if (saved) applyTheme(saved);
    else labelTheme(matchMedia('(prefers-color-scheme: dark)').matches);
  }

  /* ---------------- 启动 ---------------- */

  async function boot() {
    const bust = `?_=${Date.now()}`;
    let meta, latest, series;
    try {
      [meta, latest, series] = await Promise.all([
        fetch('data/meta.json' + bust).then(r => r.json()),
        fetch('data/latest.json' + bust).then(r => r.json()),
        fetch('data/series.json' + bust).then(r => r.json()),
      ]);
    } catch (err) {  // eslint-disable-line no-unused-vars
      $('#skeleton').hidden = true;
      $('#bootMsg').innerHTML = `读不到 <code>data/</code> 里的快照。<br><br>
        本站已停止采集。请检查归档数据是否完整，或稍后刷新重试。<br>
        然后用本地服务器打开本页（直接双击 HTML 文件浏览器会拦掉数据请求）：<code>./serve.sh</code>`;
      return;
    }

    // 档案是可选的：还没跑过 enrich.py 也不影响主界面
    try {
      const e = await fetch('data/enrich.json' + bust).then(r => r.json());
      state.enrich = e.games || {};
    } catch (_) {
      state.enrich = {};
    }

    state.meta = meta;
    state.latest = latest;
    state.series = series;
    state.ids = Object.keys(meta.games).filter(id => latest.zan[id] != null);

    // 默认 tab 指向关注作品主品类；万一哪天数据里没有这个品类，回退「全部」
    if (!state.ids.some(id => game(id).types.includes(state.type))) state.type = 'all';

    renderStamp();
    $('#sourceLink').href = meta.source || '#';

    buildNameMap();
    renderPromo();
    renderTagOptions();
    resetPicks();
    bindEvents();
    $('#boot').hidden = true;
    $('#app').hidden = false;
    if (!REDUCED) {
      $('#app').classList.add('reveal');
      // 量值条（排行榜/涨幅榜/三小榜）首屏生长一遍；窗口一过，
      // 之后筛选、图钉引起的重渲染就直接落位，不再抢戏
      $('#app').classList.add('entering');
      setTimeout(() => $('#app').classList.remove('entering'), 1400);
    }
    renderAll();
    // 首屏的进场动画（KPI 滚动、线条生长）都只跑这一次
    requestAnimationFrame(() => { chartsAnimated = true; });

    // 顶栏滚动后压缩成细条；筛选行吸顶后加投影分隔；窄屏底部导航跟随高亮
    // 压缩/展开用两个错开的阈值（迟滞）：压缩会让顶栏矮掉约 60px，浏览器的
    // 滚动锚定会把 scrollY 回补同样的量 —— 单阈值会在临界点来回横跳、顶栏闪个不停
    let condensed = false;
    const topbarEl = $('.topbar');
    // 筛选行吸顶位置 = 顶栏实际高度，量出来写进 CSS 变量。
    // 顶栏高度只在压缩/展开的 padding 过渡结束和窗口尺寸变化时变，
    // 用这两个事件驱动就够（ResizeObserver 不留引用会被回收，实测掉线）
    const setTopbarH = () =>
      document.documentElement.style.setProperty('--topbar-h', topbarEl.offsetHeight + 'px');
    setTopbarH();
    topbarEl.addEventListener('transitionend', setTopbarH);
    window.addEventListener('resize', setTopbarH);
    const navLinks = $$('#mobileNav a');
    window.addEventListener('scroll', () => {
      const want = condensed ? window.scrollY > 40 : window.scrollY > 140;
      if (want !== condensed) {
        condensed = want;
        topbarEl.classList.toggle('is-condensed', want);
      }
      const c = $('.controls');
      c.classList.toggle('is-stuck',
        c.getBoundingClientRect().top <= parseFloat(getComputedStyle(c).top) + 2);

      if (window.innerWidth <= 720) {
        let cur = navLinks[0]?.getAttribute('href');
        for (const a of navLinks) {
          const sec = $(a.getAttribute('href'));
          if (sec && sec.getBoundingClientRect().top <= 160) cur = a.getAttribute('href');
        }
        for (const a of navLinks) a.classList.toggle('active', a.getAttribute('href') === cur);
      }
    }, { passive: true });

    // #g=<id> 深链
    const m = location.hash.match(/^#g=(\w+)$/);
    if (m && state.meta.games[m[1]]) openDetail(m[1]);
  }

  boot();
})();
