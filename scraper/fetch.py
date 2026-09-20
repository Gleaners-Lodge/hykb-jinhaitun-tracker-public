#!/usr/bin/env python3
"""抓取金海豚奖 GameJam 参赛作品热度快照。

数据来源（好游快爆活动页）：
  1. index.php 内联的 window._gameConfig  -> 品类表 typeMap / 全量 ID allIds / 品类归属 typeIds
  2. POST ajax.php  ac=gamePage&ids=...   -> 每个作品的完整记录（含 zan 热度）

一次 POST 就能取回全部作品，无需登录。注意必须用 POST，GET 会被判为未登录。

每次运行产出：
  data/snapshots/<ts>.json  当次热度快照（append-only，源数据）
  data/meta.json            作品元信息 + 品类表（每次覆盖，含首次出现时间）
  data/latest.json          最新一次快照 + 与上一次的差值
  data/series.json          全部快照聚合成的时间序列，供前端画趋势图
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

BASE = "https://act.3839.com/n/hykb/jinhaitun/phase1/pc/"
INDEX_URL = BASE + "index.php"
AJAX_URL = BASE + "ajax.php"

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
HEADERS = {"User-Agent": UA, "Referer": INDEX_URL}

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
SNAPSHOTS = os.path.join(DATA, "snapshots")

# 活动方所在时区，快照时间戳统一按北京时间标注
CST = timezone(timedelta(hours=8))

# 一次请求打包多少个 ID。实测 437 个一次性成功，仍分批以防作品数继续增长。
BATCH = 250
RETRIES = 3


def http(url, data=None, timeout=45):
    body = urllib.parse.urlencode(data).encode() if data else None
    last = None
    for attempt in range(RETRIES):
        try:
            req = urllib.request.Request(url, data=body, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8", "replace")
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last = exc
            if attempt < RETRIES - 1:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"请求失败 {url}: {last}")


def extract_config(html):
    """从 index.php 内联的 window._gameConfig 里取出各字段。

    整个对象不是合法 JSON（末尾有 JS 注释和尾逗号），所以逐个 key 用
    raw_decode 单独解析，比正则稳。
    改这里的解析假设时，同步 scheduler/cf-worker/worker.js 的 scrape()。
    """
    dec = json.JSONDecoder()
    out = {}
    for key in ("typeMap", "allIds", "typeIds", "nameMap"):
        marker = key + ":"
        i = html.find(marker)
        if i < 0:
            raise RuntimeError(f"页面结构变了，找不到 _gameConfig.{key}")
        value, _ = dec.raw_decode(html[i + len(marker):].lstrip())
        out[key] = value
    return out


def fetch_games(ids):
    """按批取回作品完整记录，返回 id -> record。

    改请求方式或响应假设时，同步 scheduler/cf-worker/worker.js 的 scrape()。
    """
    games = {}
    for start in range(0, len(ids), BATCH):
        batch = ids[start:start + BATCH]
        payload = {"ac": "gamePage", "ids": ",".join(batch)}
        res = json.loads(http(AJAX_URL, payload))
        if res.get("key") != "ok":
            raise RuntimeError(f"ajax.php 返回异常: {res.get('key')} {res.get('info')}")
        for rec in res.get("data", {}).get("list", []):
            games[str(rec["id"])] = rec
    return games


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path, obj):
    """先写临时文件再 rename，避免前端读到写了一半的文件。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def build_meta(config, games, now_iso):
    """合并本次元信息到 meta.json，保留历史上出现过但本次缺席的作品。"""
    meta = load_json(os.path.join(DATA, "meta.json"), {})
    old_games = meta.get("games", {})

    merged = dict(old_games)
    for gid, rec in games.items():
        prev = old_games.get(gid, {})
        merged[gid] = {
            "id": gid,
            "name": rec.get("gname", ""),
            "intro": rec.get("intro", ""),
            "img": rec.get("img", ""),
            "icon": rec.get("icon", ""),
            "gid": rec.get("gid", ""),
            # type 形如 "5,4,2"，一个作品可同属多个品类
            "types": [t for t in str(rec.get("type", "")).split(",") if t],
            "tags": [t.get("title", "") for t in rec.get("tags", []) if t.get("title")],
            "firstSeen": prev.get("firstSeen", now_iso),
            "lastSeen": now_iso,
        }

    return {
        "updatedAt": now_iso,
        "typeMap": config["typeMap"],
        "typeIds": config["typeIds"],
        "games": merged,
        "source": INDEX_URL,
    }


def rebuild_series():
    """扫描全部快照，聚合成前端一次就能加载完的时间序列。

    结构: {"ts": [t0, t1, ...], "series": {id: [z0, z1, ...]}}
    某个时间点缺该作品时补 null，前端画线时跳过。
    """
    files = sorted(f for f in os.listdir(SNAPSHOTS) if f.endswith(".json"))
    stamps, per_snapshot = [], []
    for name in files:
        snap = load_json(os.path.join(SNAPSHOTS, name), None)
        if not snap or "zan" not in snap:
            continue
        stamps.append(snap["ts"])
        per_snapshot.append(snap["zan"])

    all_ids = sorted({gid for snap in per_snapshot for gid in snap}, key=int)
    series = {
        gid: [snap.get(gid) for snap in per_snapshot]
        for gid in all_ids
    }
    return {"ts": stamps, "series": series}


def find_baseline(series, zan):
    """给涨幅榜挑一个「上一次」的基准快照。

    活动页的热度不是实时的，是按批刷新的：同一个刷新周期内抓两次，返回的数字
    一模一样（实测 60 秒内两次抓取零差异）。所以不能无脑取上一份快照 —— 万一
    上一份和这次落在同一个周期里，全部 437 个作品的差值都会是 0，涨幅榜直接空掉。

    往回找到最近一份「确实有不同数字」的快照，用它当基准。
    """
    stamps, per_id = series["ts"], series["series"]
    for j in range(len(stamps) - 2, -1, -1):
        prev = {gid: vals[j] for gid, vals in per_id.items()
                if j < len(vals) and vals[j] is not None}
        # 从第三方导入的快照只覆盖它榜上的一百多个作品（import_external.py），
        # 拿它当基准会让涨幅榜缩水一大半 —— 覆盖率不足一半的直接跳过。
        if len(prev) < len(zan) / 2:
            continue
        if any(prev.get(gid) != v for gid, v in zan.items() if gid in prev):
            return stamps[j], prev
    return None, {}


def main():
    now = datetime.now(CST)
    now_iso = now.isoformat(timespec="seconds")

    print(f"[{now_iso}] 读取活动页配置 ...")
    config = extract_config(http(INDEX_URL))
    ids = [str(i) for i in config["allIds"]]
    print(f"  品类 {len(config['typeMap'])} 个，作品 {len(ids)} 个")

    print("  拉取全量热度 ...")
    games = fetch_games(ids)
    missing = [i for i in ids if i not in games]
    if missing:
        print(f"  警告：{len(missing)} 个作品未返回数据: {missing[:10]}", file=sys.stderr)
    if not games:
        raise RuntimeError("一条作品数据都没拿到，中止，不写入快照")

    zan = {gid: int(rec.get("zan") or 0) for gid, rec in games.items()}

    # 源站按小时换批（见 README）：数字和最后一份快照逐个相同，说明还在
    # 同一个批次里 —— 备份排程撞上主力、或手动多触发时就是这样。重复快照
    # 零信息量，只会在点位图上叠出同值的点，跳过不写；latest.json 照常
    # 更新，让顶栏的「多久之前更新」如实反映我们确实来看过。
    files = sorted(f for f in os.listdir(SNAPSHOTS) if f.endswith(".json")) \
        if os.path.isdir(SNAPSHOTS) else []
    last_zan = load_json(os.path.join(SNAPSHOTS, files[-1]), {}).get("zan") if files else None
    if last_zan == zan:
        print("  和最后一份快照同批次（数字完全相同），跳过快照写入")
    else:
        # 快照文件名用 UTC 排序友好的格式，内容里保留带时区的本地时间
        stamp = now.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        snapshot = {"ts": now_iso, "count": len(zan), "zan": zan}
        write_json(os.path.join(SNAPSHOTS, f"{stamp}.json"), snapshot)

    write_json(os.path.join(DATA, "meta.json"), build_meta(config, games, now_iso))

    series = rebuild_series()
    write_json(os.path.join(DATA, "series.json"), series)

    prev_ts, prev_zan = find_baseline(series, zan)
    write_json(os.path.join(DATA, "latest.json"), {
        "ts": now_iso,
        "prevTs": prev_ts,
        "zan": zan,
        "delta": {gid: zan[gid] - prev_zan[gid] for gid in zan if gid in prev_zan},
        "snapshotCount": len(series["ts"]),
    })

    total = sum(zan.values())
    top = sorted(zan.items(), key=lambda kv: -kv[1])[:5]
    meta_games = load_json(os.path.join(DATA, "meta.json"), {}).get("games", {})
    print(f"  完成：{len(zan)} 个作品，总热度 {total}，累计快照 {len(series['ts'])} 份")
    for gid, v in top:
        print(f"    {v:>6}  {meta_games.get(gid, {}).get('name', gid)}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # 定时任务里失败要能从日志看出原因
        print(f"抓取失败: {exc}", file=sys.stderr)
        sys.exit(1)
