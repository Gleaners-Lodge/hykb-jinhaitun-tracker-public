/* 主力排程器 + 兜底抓取：Cloudflare Worker。
   GitHub 自己的 cron 对新仓库经常整槽不触发（本仓库实测连空 4 个小时槽位），
   而 workflow_dispatch 次次都灵 —— 那就只换排程器，抓取逻辑一行不动。

   三条 cron（见 wrangler.toml）：
     5 * * * *      每小时打 dispatch 抓热度（enrich=false）
     20 20 * * *    北京时间次日 04:20，这一轮顺带补档案（enrich=true）
     20,40 * * * *  哨兵：GitHub Actions 整个断供时（2026-08-06 实测 runner
                    层瘫痪，dispatch 被受理但 job 永远分不到机器），Worker
                    亲自抓一份快照经 Contents API 提交进仓库。快照是唯一
                    补不回来的数据；聚合文件等 Actions 复活后自动全量重建。

   哨兵为什么选 :20 和 :40：主力 :05 dispatch 正常 :07 就落库；断供时 job
   排队 15 分钟被 GitHub 放弃（约 :21）。:20 是最早能判定「这轮凉了」的点，
   再早会撞上主力只是慢的情况，抢跑提交会害迟到的主力 push 撞车。:40 是
   双保险 —— :20 自己抓失败可重试，源站换批晚于整点时也能补上。

   判定不用「距上次快照 N 分钟」的滑动窗口（上次提交晚几分钟就误判），
   而是查「本小时（UTC 整点起）有没有快照提交」：主力健康 → 站岗结束。
   源站按北京时间整小时换批，UTC+8 偏移是整小时，UTC 小时桶正好对齐。

   GITHUB_TOKEN 是 fine-grained PAT（Actions + Contents 均需 Read and write），
   用 `npx wrangler secret put GITHUB_TOKEN` 写入，不出现在任何文件里。 */

const WORKFLOW = 'scrape.yml';

const BASE = 'https://act.3839.com/n/hykb/jinhaitun/phase1/pc/';
const INDEX_URL = BASE + 'index.php';
const AJAX_URL = BASE + 'ajax.php';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// 一次请求打包多少个 ID，和 scraper/fetch.py 保持一致
const BATCH = 250;

export default {
  async scheduled(controller, env) {
    // 归档保护：即使旧 cron 尚在传播也不再访问源站或 GitHub。
    return;
    // 正向路由：新加 cron 必须在这里显式接线，不然响亮地炸，
    // 免得哪天新加的 dispatch cron 静默变成每 N 分钟扒源站的哨兵
    switch (controller.cron) {
      case '5 * * * *':     return dispatch(false, env);
      case '20 20 * * *':   return dispatch(true, env);
      case '20,40 * * * *': return sentinel(env);
      default:
        throw new Error(`未知 cron: ${controller.cron}，去 worker.js 的 scheduled() 里接线`);
    }
  },
};

/* ---------------- 主力：打 workflow_dispatch ---------------- */

async function dispatch(enrich, env) {
  const res = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: ghHeaders(env, true),
      body: JSON.stringify({ ref: 'main', inputs: { enrich: String(enrich) } }),
    },
  );
  // 204 = 已受理。抛错让失败在 CF 控制台的调用记录里可见。
  if (res.status !== 204) {
    throw new Error(`dispatch 失败: HTTP ${res.status} ${await res.text()}`);
  }
}

/* ---------------- 兜底：哨兵检查 + 亲自抓取 ---------------- */

async function sentinel(env) {
  // 1) 本小时已有快照落库 → 主力健康，站岗结束
  const commits = await gh(env, '/commits?path=data/snapshots&per_page=1');
  const lastMs = commits.length
    ? Date.parse(commits[0].commit.committer.date)
    : 0;
  const hourStart = Math.floor(Date.now() / 3600e3) * 3600e3;
  if (lastMs >= hourStart) {
    console.log('哨兵：本小时快照已在，站岗结束');
    return;
  }
  console.log(`哨兵：本小时无快照（最近一份 ${new Date(lastMs).toISOString()}），开抓`);

  // 2) 亲自抓一份
  const zan = await scrape();

  // 3) 和最后一份快照比对去重：数字完全相同说明还在同一批次，零信息量。
  //    不能拿 latest.json 比 —— 连续断供两小时后它就是旧的了。
  const last = await lastSnapshot(env);
  if (last?.zan && sameZan(last.zan, zan)) {
    console.log('哨兵：和最后一份快照同批次（数字完全相同），跳过提交');
    return;
  }

  // 4) 经 Contents API 提交。新增唯一文件名，不会和任何提交冲突。
  await commitSnapshot(env, zan);
  console.log(`哨兵：已提交快照，${Object.keys(zan).length} 个作品`);
}

/* 移植自 scraper/fetch.py 的抓取半部：只要 zan，档案交给 enrich.py。 */
async function scrape() {
  const html = await (await srcFetch(INDEX_URL)).text();
  // _gameConfig 不是合法 JSON，但 allIds 是纯数字数组，直接截取解析
  const m = html.match(/allIds\s*:\s*(\[[^\]]*\])/);
  if (!m) throw new Error('页面结构变了，找不到 _gameConfig.allIds');
  const ids = JSON.parse(m[1]).map(String);
  if (!ids.length) throw new Error('allIds 是空的，页面结构可能变了');

  const zan = {};
  for (let i = 0; i < ids.length; i += BATCH) {
    const body = new URLSearchParams({
      ac: 'gamePage',
      ids: ids.slice(i, i + BATCH).join(','),
    });
    // 必须 POST，GET 会被判为未登录（见 fetch.py 头注）
    const res = await (await srcFetch(AJAX_URL, { method: 'POST', body })).json();
    if (res.key !== 'ok') {
      throw new Error(`ajax.php 返回异常: ${res.key} ${res.info || ''}`);
    }
    for (const rec of res.data?.list || []) {
      // 快照是 append-only 源数据，脏键会让 rebuild_series() 永久失败：
      // 非数字 id 直接丢，zan 解析不出整数就响亮地炸（与 fetch.py 的 int() 同为 fail-closed）
      const gid = String(rec.id ?? '');
      if (!/^\d+$/.test(gid)) continue;
      const v = Number(rec.zan || 0);
      if (!Number.isInteger(v)) throw new Error(`作品 ${gid} 的 zan 不是整数: ${rec.zan}`);
      zan[gid] = v;
    }
  }
  // 允许少量缺席（fetch.py 对缺席也只是警告），但明显残缺的快照拒写——
  // 仓库里已有过 137/437 的第三方残缺快照把涨幅榜弄缩水的先例
  const got = Object.keys(zan).length;
  if (got < ids.length * 0.9) {
    throw new Error(`只拿到 ${got}/${ids.length} 个作品，残缺快照不写`);
  }
  return zan;
}

/* 源站请求：带上和 fetch.py 相同的 UA/Referer，45 秒超时（对齐 fetch.py），
   失败退避 1 秒再试一次。不设超时的话源站挂住会把整次 cron 调用吊死，
   :40 那轮就可能和还没断气的 :20 并发出重复快照。 */
async function srcFetch(url, init = {}) {
  const opts = {
    ...init,
    headers: { 'User-Agent': UA, 'Referer': INDEX_URL, ...(init.headers || {}) },
  };
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(45000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      if (attempt >= 1) throw new Error(`源站请求失败 ${url}: ${err}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/* 取仓库里最后一份快照的内容（按文件名排序，Trees API 不受 1000 条上限约束） */
async function lastSnapshot(env) {
  const dataDir = await gh(env, '/contents/data');
  const node = dataDir.find((e) => e.name === 'snapshots');
  if (!node) return null;
  const tree = await gh(env, `/git/trees/${node.sha}`);
  if (tree.truncated) throw new Error('snapshots 目录树被截断，取不到可靠的最后一份');
  const names = tree.tree
    .filter((e) => e.path.endsWith('.json'))
    .map((e) => e.path)
    .sort();
  if (!names.length) return null;
  const file = await gh(env, `/contents/data/snapshots/${names[names.length - 1]}`);
  const bytes = Uint8Array.from(atob(file.content.replace(/\n/g, '')), (c) =>
    c.charCodeAt(0),
  );
  return JSON.parse(new TextDecoder().decode(bytes));
}

function sameZan(a, b) {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

async function commitSnapshot(env, zan) {
  const now = new Date();
  // 文件名 UTC 排序友好，内容里的 ts 按北京时间标注 —— 均与 fetch.py 逐字对齐
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const body = JSON.stringify({
    ts: beijingIso(now),
    count: Object.keys(zan).length,
    zan,
  });
  const utc = now.toISOString().slice(0, 16).replace('T', ' ');
  await gh(env, `/contents/data/snapshots/${stamp}.json`, {
    method: 'PUT',
    body: JSON.stringify({
      message: `数据快照 ${utc} UTC（worker 兜底）`,
      content: btoa(body), // 快照内容纯 ASCII，btoa 直接可用
      branch: 'main',
      committer: { name: 'hykb-bot', email: 'hykb-bot@users.noreply.github.com' },
    }),
  });
}

function beijingIso(d) {
  const t = new Date(d.getTime() + 8 * 3600e3);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}` +
    `T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}+08:00`
  );
}

/* ---------------- GitHub API 小工具 ---------------- */

function ghHeaders(env, json) {
  return {
    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'hykb-scrape-cron',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function gh(env, path, init = {}) {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}${path}`, {
    ...init,
    headers: { ...ghHeaders(env, !!init.body), ...(init.headers || {}) },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${path}: HTTP ${res.status} ${await res.text()}`);
  }
  return res.json();
}
