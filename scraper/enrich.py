#!/usr/bin/env python3
"""补全作品的「档案」字段：开发团队、评分、评价数、上线时间、语言、下载与论坛链接。

活动页的 ajax 只给热度和标签，这两类字段要另外取：
  1. https://www.3839.com/a/<gid>.htm            开发团队 / 开发商 / 更新时间 / 语言 / 下载 / 论坛
  2. /app/comment.php?ac=get_comment_list&pid=1&fid=<gid>
     评分（star）、打分人数、评价数、1~5 星分布 —— 页面上的分数是这个接口异步填的，
     所以直接扒 HTML 拿不到，必须单独请求。

热度是「有多少人投票」，评分是「玩过的人觉得好不好」，两个维度合起来才看得出名堂。

档案变化很慢，所以按作品缓存到 data/enrich.json，默认只补还没抓过的。
加 --refresh 会全部重抓（比赛期间评分和评价数会一直涨，建议每天跑一次）。

一个作品要打两个请求，437 个作品就是 874 次往返，跑起来主要是在等网络。
串行实测：本地网络 0.43 个/秒（约 17 分钟），GitHub runner 0.70 个/秒（10 分 26 秒）。
瓶颈是「一次只发一个请求」，不是机器在哪儿，所以这里开了个小线程池并发抓。
并发数 × 每轮间隔一起决定请求速率，别调太猛。

用法：
  python3 scraper/enrich.py               # 只补缺的
  python3 scraper/enrich.py --refresh     # 全部重抓
  python3 scraper/enrich.py --stale 7     # 重抓 7 天前抓过的
  python3 scraper/enrich.py --workers 8   # 加大并发（默认 4）
"""

import argparse
import html
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
META = os.path.join(DATA, "meta.json")
OUT = os.path.join(DATA, "enrich.json")

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
CST = timezone(timedelta(hours=8))

# 速率 ≈ WORKERS / (每个作品耗时 + DELAY)。4 个并发、每轮歇 0.3 秒，
# 从境外算下来约 2 个作品/秒，也就是 4 次请求/秒，对一个商业站点很温和。
WORKERS = 4
DELAY = 0.3
RETRIES = 2

RE_DEV = re.compile(
    r'<li><span>开发：</span><a[^>]*href="([^"]*)"[^>]*>(.*?)</a>', re.S)
RE_AUTH = re.compile(r'class="frag-auth"[^>]*>(.*?)</a>', re.S)
RE_INFO_CELL = re.compile(r'<em>(更新时间|语言|开发商)</em>\s*<p>(.*?)</p>', re.S)
RE_PLATFORM = re.compile(r'<span class="g-type-[a-z]*">(.*?)</span>', re.S)
RE_FORUM = re.compile(r'href="(https://bbs\.3839\.com/forum-\d+\.htm)"')
RE_DOWN = re.compile(r'<a[^>]+href="([^"]+\.(?:exe|apk|zip))"', re.I)
RE_TITLE = re.compile(r'<h1 class="frag-name">(.*?)</h1>', re.S)


def text(s):
    """去标签 + 反转义 + 压空白。"""
    return html.unescape(re.sub(r"<[^>]+>", "", s or "")).strip()


def http(url, referer=None):
    last = None
    headers = {"User-Agent": UA}
    if referer:
        headers["Referer"] = referer
    for attempt in range(RETRIES + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None                 # 作品可能已下架，不重试
            last = exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last = exc
        if attempt < RETRIES:
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(str(last))


def parse(page, gid):
    rec = {"gid": gid, "url": f"https://www.3839.com/a/{gid}.htm"}

    m = RE_TITLE.search(page)
    if m:
        rec["title"] = text(m.group(1))

    m = RE_DEV.search(page)
    if m:
        rec["developer"] = text(m.group(2))
        cp = re.search(r"/cp/(\d+)\.html", m.group(1))
        if cp:
            rec["cpId"] = cp.group(1)

    m = RE_AUTH.search(page)
    if m:
        rec["authorized"] = text(m.group(1))     # 例如「官方已入驻」

    # 页面里的评分块只是个占位（永远 display:none，值写死 0），真分数走 fetch_comment()
    for label, value in RE_INFO_CELL.findall(page):
        key = {"更新时间": "updated", "语言": "language", "开发商": "publisher"}[label]
        rec[key] = text(value)

    m = RE_PLATFORM.search(page)
    if m:
        rec["platform"] = text(m.group(1))

    m = RE_FORUM.search(page)
    if m:
        rec["forum"] = m.group(1)

    m = RE_DOWN.search(page)
    if m:
        rec["download"] = m.group(1)

    return rec


def fetch_comment(gid):
    """评分 / 打分人数 / 评价数 / 星级分布。无需登录。"""
    url = ("https://www.3839.com/app/comment.php"
           f"?ac=get_comment_list&m=pc&v=1.0&pid=1&fid={gid}&page=1")
    raw = http(url, referer=f"https://www.3839.com/a/{gid}.htm")
    if not raw:
        return {}
    try:
        res = json.loads(raw).get("result", {})
    except json.JSONDecodeError:
        return {}
    star = res.get("star_info") or {}
    out = {
        "comments": int(res.get("count") or 0),
        "raters": int(star.get("star_usernum") or 0),
    }
    try:
        score = float(star.get("star") or 0)
        if score > 0:
            out["score"] = score
    except (TypeError, ValueError):
        pass
    dist = [int(star.get(f"star_usernum_{i}") or 0) for i in range(1, 6)]
    if any(dist):
        out["starDist"] = dist
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true", help="全部重抓")
    ap.add_argument("--stale", type=float, default=None, help="重抓 N 天前抓过的")
    ap.add_argument("--limit", type=int, default=None, help="本次最多抓几个")
    ap.add_argument("--workers", type=int, default=WORKERS,
                    help=f"并发数，默认 {WORKERS}")
    args = ap.parse_args()

    if not os.path.exists(META):
        print("先跑一次 scraper/fetch.py 生成 data/meta.json", file=sys.stderr)
        return 1

    with open(META, encoding="utf-8") as fh:
        meta = json.load(fh)

    cache = {}
    if os.path.exists(OUT):
        with open(OUT, encoding="utf-8") as fh:
            cache = json.load(fh).get("games", {})

    now = datetime.now(CST)
    stale_before = now - timedelta(days=args.stale) if args.stale else None

    todo = []
    for wid, g in meta["games"].items():
        gid = g.get("gid")
        if not gid:
            continue
        old = cache.get(wid)
        if old and not args.refresh:
            if stale_before is None:
                continue
            try:
                if datetime.fromisoformat(old.get("fetchedAt", "")) >= stale_before:
                    continue
            except ValueError:
                pass
        todo.append((wid, gid))

    if args.limit:
        todo = todo[:args.limit]

    if not todo:
        print("没有需要补的作品档案。加 --refresh 可以全部重抓。")
        return 0

    stamp = now.isoformat(timespec="seconds")
    workers = max(1, args.workers)
    print(f"要补 {len(todo)} 个作品的档案（共 {len(meta['games'])} 个），并发 {workers}")

    def fetch_one(item):
        """一个作品 = 游戏页 + 评价接口两个请求。返回 (wid, 记录, 是否成功)。"""
        wid, gid = item
        try:
            page = http(f"https://www.3839.com/a/{gid}.htm")
            if page is None:      # 404，作品可能已下架
                return wid, {"gid": gid, "missing": True, "fetchedAt": stamp}, False
            rec = parse(page, gid)
            rec.update(fetch_comment(gid))
            rec["fetchedAt"] = stamp
            return wid, rec, True
        except Exception as exc:
            print(f"  {wid}/{gid} 失败: {exc}", file=sys.stderr)
            return wid, None, False
        finally:
            time.sleep(DELAY)     # 每个线程抓完歇一下，控制整体速率

    ok = fail = 0
    lock = threading.Lock()       # _save 会写同一个文件，得排队
    started = time.monotonic()

    with ThreadPoolExecutor(max_workers=workers) as pool:
        # map 按 todo 的顺序产出结果，所以进度和落盘的节奏是确定的
        for i, (wid, rec, good) in enumerate(pool.map(fetch_one, todo), 1):
            if rec is not None:
                cache[wid] = rec
            ok, fail = (ok + 1, fail) if good else (ok, fail + 1)

            if i % 50 == 0 or i == len(todo):
                rate = i / max(0.001, time.monotonic() - started)
                eta = (len(todo) - i) / rate / 60
                print(f"  {i}/{len(todo)}  成功 {ok} 失败 {fail}  "
                      f"{rate:.1f} 个/秒，剩余约 {eta:.1f} 分钟")
                with lock:        # 中途落盘，跑一半被打断也不用从头来
                    _save(cache, now)

    _save(cache, now)

    devs = {r.get("developer") for r in cache.values() if r.get("developer")}
    scored = [r for r in cache.values() if r.get("score")]
    commented = sum(r.get("comments", 0) for r in cache.values())
    elapsed = (time.monotonic() - started) / 60
    print(f"完成：{len(cache)} 份档案，{len(devs)} 个开发团队，"
          f"{len(scored)} 个已有评分，累计 {commented} 条评价，耗时 {elapsed:.1f} 分钟")
    return 0


def _save(cache, now):
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"updatedAt": now.isoformat(timespec="seconds"), "games": cache},
                  fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, OUT)


if __name__ == "__main__":
    sys.exit(main())
