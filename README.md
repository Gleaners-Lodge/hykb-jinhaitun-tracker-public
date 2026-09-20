# 金海豚奖 2026 · 热度追踪

这是供后续参赛者参考的赛事热度追踪工具：Python 采集公开作品数据，保存逐小时快照，纯静态网页展示排名、涨幅、趋势和作品详情。

> **历史归档**：2026 届投票已结束，自动采集于 2026-09-07 停止。最终快照为北京时间 2026-09-07 14:05:40。页面保留实际观测值；9 月仍有少量数据变化，不人为归零。
> Actions 采集任务和 Worker 都有归档保护，默认不会重新采集。部署配置需要使用者自行填写。

## 本地浏览

需要 Python 3，不需要安装 Python 包或前端依赖。

```bash
./serve.sh
# 浏览器打开 http://127.0.0.1:8080/
```

页面必须通过 HTTP 访问，直接双击 HTML 无法正常加载 JSON。历史浏览不需要账号、登录凭据或云服务。

## 文件结构

| 路径 | 用途 |
|---|---|
| `index.html`、`web/` | 静态看板，无构建步骤 |
| `data/snapshots/` | 原始热度快照，每份记录作品 ID 和累计热度 |
| `data/meta.json` | 作品名称、简介、分类、封面和活动 ID |
| `data/enrich.json` | 公开团队资料、评分、评价数等 |
| `data/series.json`、`data/latest.json` | 聚合时间序列和最新排名数据 |
| `data/external/` | 补齐早期时段的外部赛事数据，来源和局限见各目录 README |
| `scraper/fetch.py` | 采集热度并重建聚合数据 |
| `scraper/enrich.py` | 获取公开作品档案 |
| `scraper/import_*.py` | 导入外部历史数据 |
| `scheduler/install.sh` | 可选 macOS launchd 调度器 |
| `scheduler/cf-worker/` | 可选 Cloudflare 调度与快照兜底示例 |
| `.github/workflows/` | 手动部署和已停用的采集流程 |
| `cf-pages/functions/api/status.js` | 静态归档状态接口，不访问 GitHub |

## 公开数据来源与限制

2026 届来源为[官方活动页](https://act.3839.com/n/hykb/jinhaitun/phase1/pc/index.php)。接口和页面结构可能随届次变化，下届使用前需要重新检查。

1. 活动页内联 `window._gameConfig` 提供分类、作品 ID 和名称。
2. 向活动页同目录的 `ajax.php` **POST** `ac=gamePage&ids=<逗号分隔 ID>` 获取热度、封面、简介和标签。GET 返回 `no_login`，不能据此判断必须登录。
3. 主站 `https://www.3839.com/a/<gid>.htm` 提供公开作品档案。
4. `comment.php?ac=get_comment_list&pid=1&fid=<gid>` 提供评分统计；游戏页 HTML 中的分数可能只是异步占位。

脚本只读取公开作品信息，不采集投票人的账号或投票记录。活动内部 `id` 和主站 `gid` 是两套编号，映射见 `meta.json`。热度是活动投票统计，评分是主站玩家评价，两者不能混用。

源站热度曾按小时批量更新。更高采集频率通常只得到重复值；`find_baseline()` 会向前寻找数值确实不同的快照计算涨幅。外部数据的缺失区间和去重规则见来源说明。

## 看板与自定义

支持分类、标签与搜索筛选，排名、涨幅、团队统计、趋势对比、名次迁徙，以及作品详情抽屉。详情中的按日增量图直接开放。日期增量按北京时间计算，显示时间会注明访问者时区。

`web/app.js` 顶部的配置：

- `FOCUS_ID`：可选关注作品的活动内部 ID，默认空，不关联特定参赛者。
- `FOCUS_TYPE`：默认分类，当前为 `all`。
- `PROMO`：可选推荐卡数组，默认空。填写公开作品 ID、角标和介绍即可。
- `MAX_PICKS`、`BOARD_ROWS`：趋势对比数量与排行行数。
- `CSV_PAUSED`：控制 CSV 导出入口。

图表的分类色槽在 JavaScript 和 CSS 中需要保持数量一致。焦点高亮只影响视觉，不改变排名和数值。`#g=<活动内部 ID>` 可以直接打开作品详情。

## 为后续赛事适配采集

先复制一份工作目录，并将 2026 历史数据与新赛事数据分开保存，避免混成同一条时间序列。修改采集脚本中的活动地址、解析字段和分类映射后，再运行：

```bash
python3 scraper/fetch.py
python3 scraper/enrich.py
python3 scraper/enrich.py --refresh
```

这些命令会请求源站并更新本地 `data/`。`enrich.py` 保留请求间隔与并发限制，不要为追求速度提高请求密度。快照是聚合数据的来源；导入和采集脚本会重建聚合文件。

## 可选调度和托管

历史页面可直接部署 `index.html`、`web/` 和四个聚合/元信息 JSON，无需服务端数据库。不要把整个工作目录当作网站根目录上传，尤其不要上传 `.git`、本地日志或凭据文件。

### Cloudflare Pages

两条工作流均使用仓库变量和 Secrets，不含预设的个人项目名或地址：

| 配置 | 类型 | 用途 |
|---|---|---|
| `CF_PAGES_PROJECT` | Actions variable | 使用者自己的 Pages 项目名 |
| `CF_PAGES_URL` | Actions variable | 项目的 HTTPS 根地址，末尾可带斜杠 |
| `CLOUDFLARE_API_TOKEN` | Actions secret | 部署令牌 |
| `CLOUDFLARE_ACCOUNT_ID` | Actions secret | 部署账号 ID |

配置后手动运行 `deploy-pages.yml`。流程只打包运行所需文件，并包含归档状态接口。没有填部署变量时会停止，不会使用原作者的项目。

### Actions 与 Worker

`scrape.yml` 的 job 使用 `if: ${{ false }}` 停止采集。Worker 的 `scheduled()` 提前返回，`wrangler.toml` 的 `crons` 为空。复用时需要明确解除保护，并配置自己的仓库、凭据和定时策略。

Worker 的 `GITHUB_REPOSITORY` 变量使用 `OWNER/REPOSITORY` 占位值；`GITHUB_TOKEN` 通过 `wrangler secret put` 配置，只授权目标仓库所需权限。调度器可以触发 Actions，也可在 Actions 未产出本小时快照时写入兜底快照；聚合文件仍由下一轮采集重建。

### macOS 本地任务

```bash
./scheduler/install.sh            # 安装定时采集任务，会开始按计划更新数据
./scheduler/install.sh uninstall  # 卸载
```

本地采集和云端采集不要同时向同一分支写数据，以免发生冲突。

## 隐私与发布

公开文件保留赛事作品与统计数据，不预设作者关注对象、推广合作、私有功能口令或个人部署目标。凭据仅通过环境变量或托管平台 Secrets 注入；`.env`、`.dev.vars`、私钥、本地日志和部署缓存均应留在 Git 之外。

发布前还需要检查 Git 历史和提交作者信息。删掉当前文件不等于清除旧提交；远端日志、旧部署、缓存及他人已经下载的副本也不随源码修改自动消失。
