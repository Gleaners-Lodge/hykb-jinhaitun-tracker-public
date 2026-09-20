#!/usr/bin/env python3
"""把 data/external/hykb-pc-heat/ 归档的第三方记录合成本仓库格式的快照。

第三方站（hykb-pc-heat.pages.dev）的采集比我们早约 10 小时，还整点抓一次，
正好能补上我们缺的 08-03 晚间收盘点和自己漏抓的小时。原则：

  1. 快照是唯一源数据 —— 这里只写 data/snapshots/<ts>.json，
     然后调 fetch.py 的 rebuild_series() 重建 series.json，别的都不碰。
  2. 源站热度按小时批量刷新（北京时间整点换批），同一小时内不管抓几次
     都是同一个数 —— 所以按「北京小时」去重：该小时已有任何快照就跳过。
     距离去重会误伤：我们 10:50 的快照和第三方 11:00 的桶只差 10 分钟，
     却分属两个刷新批次，是真实增量。
  3. 只导入早于 latest.json 时间戳的点 —— latest.json 是「当前热度」的
     口径，图表末点不能比它还新，否则详情面板两处数字对不上。
  4. 合成的快照带 "source" 字段标明出处；只覆盖它榜上的 137 个作品，
     其余作品在这些时间点上是 null，前端画线时会跳过。

幂等：重复运行会因为 30 分钟去重而全部跳过，不会重复写入。
"""

import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch import CST, DATA, SNAPSHOTS, load_json, rebuild_series, write_json

EXTERNAL = os.path.join(DATA, "external", "hykb-pc-heat")
SOURCE = "hykb-pc-heat.pages.dev"


def cst_hour(dt):
    """去重粒度：北京时间的整点小时，对应源站的一个刷新批次。"""
    return dt.astimezone(CST).strftime("%Y-%m-%dT%H")


def parse_iso(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def collect_points():
    """外部 hourly/daily 文件 -> {采集轮次: {id: heat}}。

    每个作品的点各带自己的 recordedAt（毫秒级差异），按「同一轮采集」
    归并：整点桶用 bucketHour / dayKey 当轮次键，时间戳取该轮最早的。
    """
    rounds = defaultdict(dict)     # key -> {gid: heat}
    stamps = {}                    # key -> 最早 recordedAt

    for fname, kind in (("hourly-20260804.json", "hour"), ("daily-20260804.json", "day")):
        data = load_json(os.path.join(EXTERNAL, fname), {})
        for gid, payload in data.items():
            for p in payload.get("points", []):
                if p.get("isCurrent"):
                    continue       # 实时点没有稳定时间戳，等我们自己的快照
                if p.get("heat") is None:
                    continue
                key = (kind, p.get("bucketHour") or p.get("dayKey"))
                rec = parse_iso(p.get("recordedAt") or p["timestamp"])
                rounds[key][str(gid)] = int(p["heat"])
                if key not in stamps or rec < stamps[key]:
                    stamps[key] = rec
    return [(stamps[k], zan) for k, zan in rounds.items()]


def main():
    latest_ts = load_json(os.path.join(DATA, "latest.json"), {}).get("ts")
    if not latest_ts:
        raise RuntimeError("没有 data/latest.json，先跑一次 fetch.py")
    latest = datetime.fromisoformat(latest_ts)

    covered = set()
    for name in os.listdir(SNAPSHOTS):
        if name.endswith(".json"):
            covered.add(cst_hour(datetime.strptime(name[:-5], "%Y%m%dT%H%M%SZ")
                                 .replace(tzinfo=timezone.utc)))

    imported, skipped = 0, 0
    for rec, zan in sorted(collect_points()):
        if rec >= latest or cst_hour(rec) in covered:
            skipped += 1
            continue
        local = rec.astimezone(CST)
        stamp = rec.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        write_json(os.path.join(SNAPSHOTS, f"{stamp}.json"), {
            "ts": local.isoformat(timespec="seconds"),
            "count": len(zan),
            "zan": zan,
            "source": SOURCE,
        })
        covered.add(cst_hour(rec))
        imported += 1
        print(f"  导入 {local.isoformat(timespec='seconds')}  {len(zan)} 个作品")

    series = rebuild_series()
    write_json(os.path.join(DATA, "series.json"), series)
    print(f"完成：导入 {imported} 份、跳过 {skipped} 份（重复/太新），"
          f"series 重建为 {len(series['ts'])} 个时间点")


if __name__ == "__main__":
    main()
