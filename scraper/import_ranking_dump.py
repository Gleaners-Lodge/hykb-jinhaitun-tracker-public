#!/usr/bin/env python3
"""把外部数据提供方整点爬虫的导出（data/external/ranking-dump-20260804/）合成本仓库快照。

对方从北京时间 08-03 12:00 起整点抓活动页全量 437 个作品，正好补上本仓库
最缺的第一天白天时段。原则沿用 import_external.py：

  1. 快照是唯一源数据 —— 这里只写 data/snapshots/<ts>.json，
     然后调 fetch.py 的 rebuild_series() 重建 series.json，别的都不碰。
  2. 按「北京小时批次」去重：该小时已有快照就跳过。
     例外是升级：该小时只有部分覆盖的旧快照（此前从 hykb-pc-heat 导入的
     137 作品版），且旧值逐个等于本份的子集时，删旧写新 —— 无损换成全量。
     实际只命中一个点：08-03 23:00 收盘。
  3. 对方整点开爬常赶在源站换批之前，快照与上一份完全相同（零信息量），
     这类重复批次直接跳过。
  4. 只导入早于 latest.json 时间戳的点 —— 图表末点不能比「当前热度」还新。
  5. 合成的快照带 "source" 字段标明出处。

幂等：重跑时所有小时都已覆盖（升级过的小时也不再满足升级条件），全部跳过。
"""

import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch import CST, DATA, SNAPSHOTS, load_json, rebuild_series, write_json

DUMP = os.path.join(DATA, "external", "ranking-dump-20260804",
                    "ranking_20260804_1300.json")
SOURCE = "ranking-dump-20260804"


def cst_hour(dt):
    """去重粒度：北京时间的整点小时，对应源站的一个刷新批次。"""
    return dt.astimezone(CST).strftime("%Y-%m-%dT%H")


def load_rounds():
    """导出文件 -> [(采集时间, {id: heat})]，按时间排序。crawled_at 按北京时间理解。"""
    dump = load_json(DUMP, None)
    if not dump:
        raise RuntimeError(f"读不到 {DUMP}")
    rounds = []
    for snap in dump["snapshots"]:
        rec = datetime.fromisoformat(snap["crawled_at"]).replace(tzinfo=CST)
        zan = {g["contest_id"]: int(g["heat"]) for g in snap["games"]}
        rounds.append((rec, zan))
    rounds.sort()
    return rounds


def existing_by_hour():
    """现有快照按北京小时归组：hour -> [(文件名, zan)]。"""
    grouped = {}
    for name in sorted(os.listdir(SNAPSHOTS)):
        if not name.endswith(".json"):
            continue
        dt = datetime.strptime(name[:-5], "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
        zan = load_json(os.path.join(SNAPSHOTS, name), {}).get("zan", {})
        grouped.setdefault(cst_hour(dt), []).append((name, zan))
    return grouped


def main():
    latest_ts = load_json(os.path.join(DATA, "latest.json"), {}).get("ts")
    if not latest_ts:
        raise RuntimeError("没有 data/latest.json，先跑一次 fetch.py")
    latest = datetime.fromisoformat(latest_ts)

    covered = existing_by_hour()
    imported, upgraded, skipped = 0, 0, 0
    prev_zan = None

    for rec, zan in load_rounds():
        dup = zan == prev_zan
        prev_zan = zan
        if dup or rec >= latest:
            skipped += 1
            continue

        hour, held = cst_hour(rec), covered.get(cst_hour(rec), [])
        # 升级条件：该小时现有的全是部分覆盖、且逐值都是本份的子集
        can_upgrade = held and all(
            len(old) < len(zan) and all(zan.get(k) == v for k, v in old.items())
            for _, old in held
        )
        if held and not can_upgrade:
            skipped += 1
            continue

        for name, _ in held:
            os.remove(os.path.join(SNAPSHOTS, name))
            print(f"  删除部分快照 {name}（{len(held[0][1])} 个作品，升级为全量）")
            upgraded += 1

        local = rec.astimezone(CST)
        stamp = rec.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        write_json(os.path.join(SNAPSHOTS, f"{stamp}.json"), {
            "ts": local.isoformat(timespec="seconds"),
            "count": len(zan),
            "zan": zan,
            "source": SOURCE,
        })
        covered[hour] = [(f"{stamp}.json", zan)]
        imported += 1
        print(f"  导入 {local.isoformat(timespec='seconds')}  {len(zan)} 个作品")

    series = rebuild_series()
    write_json(os.path.join(DATA, "series.json"), series)
    print(f"完成：导入 {imported} 份（其中升级 {upgraded} 份）、跳过 {skipped} 份"
          f"（重复批次/该小时已覆盖/太新），series 重建为 {len(series['ts'])} 个时间点")


if __name__ == "__main__":
    main()
