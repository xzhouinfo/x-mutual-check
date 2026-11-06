# X 互关检测

查 X（Twitter）上的互关情况：谁没回关你、谁只是你的粉丝、这次相比上次掉了谁，
以及**今天还能关注多少个**（X 每天 400 个上限，按美西 0 点重置）。
所有数据只在你本机处理，不发往任何服务器。

## 数据从哪来

关注 / 粉丝列表走 X 网页版的 GraphQL：

```
GET /i/api/graphql/<queryId>/Following?variables={userId,count,cursor,…}&features={…}
GET /i/api/graphql/<queryId>/Followers?variables={…}
```

只需要 `authorization: Bearer <X 网页端公开 bearer>` 和 `x-csrf-token: <ct0 cookie>`，
**不需要 `x-client-transaction-id`**（实测重放页面抓到的请求，不带这个头照样 200）。

queryId 是 X 每次发版可能更换的哈希。插件里内置了一份兜底值，同时 `inject.js`
（跑在页面 MAIN world）会把页面自己发出的真实 queryId 和 features 抄下来写到 `<html data-xmc-gql>`，
所以 X 换哈希后一般不用改代码——打开一次 x.com 的「正在关注」页面即可。

> **为什么不用 REST v1.1？** 早期版本用 `friends/following/list.json`，看着更稳，其实有硬上限：
> 翻到第 6 页就返回 `next_cursor_str: "0"`，一个 1406 关注的账号只能扫出 **527 人**，
> 互关率、未回关名单、沉默号统计全是错的。GraphQL 能翻到 **1418 人 / 29 页**，所以换了过来。
> （`following/list.json` 现在只用来补「最后发帖时间」，见下面沉默号的说明。）

## 功能

- **每日关注额度**：顶部常驻一张卡，显示今天还剩多少个关注额度、离重置还有多久，附近 14 天柱状图和取关计数
- **一键扫描**：读你的关注列表，按 `followed_by` 字段判断谁没回关
- **三档分类**：未回关 / 互关 / 纯粉丝（关注你但你没关注）
- **未回关蓝V**：统计栏单独一格，点一下直接筛出「你关注了但对方没回关」的蓝V名单
- **蓝V / 非蓝V 切换**：筛选按钮点一下看蓝V、再点看**非蓝V**，任何一档里都能切
- **互动排行榜**：读通知流，按人统计最近谁跟你互动最多（回复 / 点赞 / 转发 / @你 / 关注），带加权分、明细和最后互动时间
- **沉默号**：按最后发帖时间分档（30天+/90天+/半年+/一年+/零推文），找出关注了但早就不更新的号
- **快照对比**：和上次扫描比对，列出掉了哪些粉、新增了哪些未回关、谁回关了你
- **筛选排序**：蓝V优先、粉丝数降序；也可按跟踪最久、最久没更新、互动分 / 互动次数 / 最近互动排
- **直接回关**：纯粉丝列表每行有「+ 关注」按钮，点一下就关注，不用跳页面
- **直接取关**：未回关 / 沉默号列表每行有「取关」按钮，两段式确认（第一次变「确认?」，3 秒内再点才执行）
- **导出 CSV**：带 BOM，Excel 直接打开不乱码，文件名自动带「蓝V / 非V / 分档」后缀

## 每日关注额度（v0.6.0）

X 官方的规则（[About following](https://help.x.com/en/using-x/following)）：

| 规则 | 说明 |
|---|---|
| 每天 400 个 | 所有账号一视同仁，Premium 也一样 |
| 关注总数 5000 | 到 5000 之后能否继续关注，取决于你自己的「粉丝/关注」比例（X 不公布公式） |
| 小时级软限 | 官方在报错说明里写了「followed too many accounts too quickly，等一小时」；社区实测约 30~50 个/小时 |
| 行为红线 | follow churn（反复关注+取关刷粉）、无差别批量关注、复制他人粉丝、第三方涨粉服务，都违反 X Rules |

面板顶部因此常驻一张额度卡：

```
今日还能关注                    363 / 400  明细
▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
已关注 37 · 6:06:08 后重置 · 取关 1
```

点「明细」展开近 14 天柱状图（按美西日切分）和 5000/粉丝比提示，下面两行是低频操作：
`美西 0 点 / 滚动 24h` 切口径、`导出` 拿 CSV；数字跟 X 对不上时用 `实际已用 → 校准` 改回来，
X 已经提示不能再关注了就点 `标记已满`（再点一次取消）。

### 「一天」从哪一刻开始

官方只写 "per day"，没写时区。插件**默认按美西（America/Los_Angeles）0 点**切日——
X 总部时区，也是第三方工具最常用的口径；明细里可以一键改成「滚动 24 小时」。

时区计算没有手写偏移表，走 `Intl.DateTimeFormat` + 两遍偏移校正，夏令时切换日（23 或 25 小时）
也照常算对，单测里钉了 2026-03-08 / 2026-11-01 两天。

### 数字是怎么数出来的

X 没有「查询今日已关注次数」的接口，所以只能本机记账，三个来源合并去重：

| 来源 | 怎么来的 | 准确度 |
|---|---|---|
| 页面点击 | `inject.js` 在页面里钩 fetch/XHR，识别关注/取关请求，方向以响应体 `data.following` 为准 | 高 |
| 面板点击 | 插件里点「+ 关注」成功后直接记一笔 | 100% |
| 扫描补记 | 扫描时对比上次快照，新增的 handle 记到**当次扫描时刻**（覆盖手机上点的关注） | 中 |

扫描补记有两道闸：距上次扫描超过 20 小时就不补（几天的量没法拆到每一天），
已经实时记过的 uid 不重复计。

> 拿不准的时候**不记**：取关被误记成关注会白扣额度，比漏记更让人困惑。

## 和同类开源项目比

| 项目 | 形态 | 数据来源 | 有额度统计 | 有互动榜 | 全量关注 |
|---|---|---|---|---|---|
| 本项目 | MV3 侧边栏 | GraphQL `Following/Followers` | ✅ 美西日界线 | ✅ 通知流加权 | ✅ 1418 人实测 |
| [442635398/x-follow-checker](https://github.com/442635398/x-follow-checker) | MV3 页面浮窗 | 页面会话调内部接口，分片+冷却续扫 | — | — | 单次约 1000 人上限，需「继续检测」 |
| [BryceYuuu/x-non-follower-checker](https://github.com/BryceYuuu/x-non-follower-checker) | MV3 弹窗+侧栏 | 读关注列表的 "Follows you" 标记 | — | — | — |
| [互关标记 for X](https://zuoye.si/mutualbadge)（MIT） | 内容脚本标记 | **不发请求**，只读时间线里已有的关系字段 | — | — | — |
| [Andrew-liu/snow-x-assistant](https://github.com/Andrew-liu/snow-x-assistant) | MV3 | 页面已加载数据 + 逐条点击取关 | — | — | — |
| [yaohongan/x-follower-lens](https://github.com/yaohongan/x-follower-lens) | MV3 | 页面已加载数据 + 本地粉丝数历史 | — | — | — |
| [prathamdby/x-followers-monitor](https://github.com/prathamdby/x-followers-monitor) | Python + Playwright | cookie 注入 + GitHub Actions 每 6 小时跑 | — | — | 快照 diff |
| [xmac11/twitter-unfollowers-detector](https://github.com/xmac11/twitter-unfollowers-detector) | Python 脚本 | 官方 API v2（要开发者账号） | — | — | followers.json 比对 |

三类技术路线：① 借浏览器登录态直接打内部接口（本项目、x-follow-checker）；② 只读页面已渲染的数据，
零额外请求（互关标记、snow-x-assistant）；③ 自带 cookie / API key 的独立脚本（两个 Python 项目）。

**没人做「每日 400 个额度」这件事**——这是本项目独有的：它们要么只管关系不管频率，
要么把「别关注太快」写进 README 当免责声明。额度这块的规则、时区和误差分析见
[docs/api-verification.md 第十四节](docs/api-verification.md)。

## 读写边界

| 操作 | 接口 | 说明 |
|---|---|---|
| 扫描关注/粉丝 | `GET /i/api/1.1/friends/following/list.json`、`GET /i/api/1.1/followers/list.json` | 只读，带 `status` 拿最后发帖时间 |
| 扫互动榜 | `GET /i/api/2/notifications/all.json` | 只读，读你自己的通知流，最多 12 页 |
| 核对关系 | `GET /i/api/1.1/friendships/show.json` | 只读，写操作后用来确认是否真生效 |
| 单条关注 | `POST /i/api/1.1/friendships/create.json` | 只有你点「+ 关注」才发，一次一个人 |
| 单条取关 | `POST /i/api/1.1/friendships/destroy.json` | 只有你点两次「取关」才发，一次一个人 |

写操作有三道闸：

1. UI 层 3 秒冷却，连点会被拦下并提示剩余秒数
2. 内容脚本 3~6 秒随机间隔（实测连写几次就 429，间隔太小等于自找限流）
3. 没有「全部关注 / 全部取关」这种批量入口

写操作失败会按 X 的错误码给人话提示（161 关注数上限、226 被判自动化、88 频率限制、108 用户不存在）。
写成功后还会用 `friendships/show.json` 核对真实状态；核对不上时提示「已提交，去 x.com 看一眼」，不会假装成功。

## 安装（开发者模式）

1. 下载或克隆本目录
2. Chrome 打开 `chrome://extensions/`
3. 右上角开启「开发者模式」
4. 点「加载已解压的扩展程序」，选择本目录（含 `manifest.json` 那一层）
5. 点工具栏拼图图标固定「X 互关检测」，点它打开侧边栏

Edge 同理，地址换成 `edge://extensions/`。

## 使用

1. 打开并登录 x.com（任意页面都行，插件要借这个页面的登录态）
2. 点插件图标打开侧边栏，显示「已连接 · 账号 ID …」就绪
3. 勾选「同时拉取粉丝列表」可多算纯粉丝和掉粉（请求数翻倍）
4. 点「开始扫描」。关注上千时要等一分钟左右（GraphQL 每页 50 人，1400 个关注 ≈ 29 页），进度条会显示翻到第几页；扫完顺手补一次最后发帖时间给沉默号用
5. 点统计栏的「未回关蓝V」「未回关非V」「半年未更」「零推文」都能直接跳到对应名单；工具栏的筛选按钮可以在任何一档里切 全部 / 蓝V / 非V
6. 要看谁跟你互动最多，点「扫互动」：读通知流，按加权分排出排行榜（回复 / 转发 / @ 各 3 分，关注 2 分，点赞 1 分）
7. 纯粉丝标签里点「+ 关注」当场回关；未回关 / 沉默号标签里连点两次「取关」清人；要留档就点「导出」

### 实测接口状态（2026-11-05）

| 端点 | 结果 |
|---|---|
| GraphQL `Following` | 200，**50 条/页**（`count=100` 也只给 50），能翻到全部 1418 人 / 29 页 |
| GraphQL `Followers` | 200，同样 50 条/页 |
| GraphQL 用户对象 | 新结构：`core` / `relationship_perspectives.followed_by` / `is_blue_verified` / `relationship_counts` / `tweet_counts`，**没有 `status`** |
| `following/list.json` | 200，200 条/页，但**最多只给约 500 人**（第 6 页 `next_cursor=0`） |
| `following/list.json`（不带 `skip_status`） | 200，多出 `status.created_at` → 沉默号靠它；体积约 3 倍（524 人 ≈ 1.7MB） |
| `v2/notifications/all.json` | 200，`count` 上限 40，超过直接 400；能翻到约 371 条就到底 |
| `friendships/create.json` | 200，`user_id` 与 `screen_name` 两种传法都可用，幂等 |
| `friendships/destroy.json` | 200，幂等 |
| `friendships/show.json` | 200，`source_id+target_id`、`source_id+target_screen_name`、双 `screen_name` 三种传法都可用 |
| `statuses/user_timeline.json` | **200 但 body 为空**，v1.1 状态类端点对网页端已废 |
| `statuses/mentions_timeline.json` | **同上，200 + 空 body** |
| `favorites/list.json` | **404 `code 34`**，点赞列表拿不到 |
| `users/show.json` | **404，已下线**（所以关注时用 `screen_name` 兜底，不依赖它） |
| `users/lookup.json` | **404 `code 34`**，批量查最后发帖时间这条路也堵死了 |

几个必须知道的坑：

> **GraphQL 会随机返回 404**：同一个 URL 连发六次实测 `404/200/404/200/200/404`，纯抖动。
> 必须重试，而且**绝不能把 404 当成「没有下一页」**——那样会静默少掉一大半人。
>
> **`TimelineTerminateTimeline` 不代表翻完了**：它在第一页的 instructions 里就出现（含义是「顶部到头」），
> 拿它当结束条件会让扫描停在第 1 页 50 人。判断结束只能看 bottom cursor（空 / `0|` 开头 / 重复 / 本页没用户）。
>
> **沉默号拿不全**：GraphQL 不返回最后发帖时间，只有 `following/list.json`（带 `status`）有这个字段，
> 而它只覆盖约 500 人。所以插件对拿不到的人显示「最后发帖时间未知」，单独一档列出来，
> 不会把正常人当成死号。`users/lookup.json` 想批量补也 404 了。
>
> **`id` 会丢精度**：v1.1 返回的 `id` 是 number，超过 2^53 已经失精（实测 `2117144550020177920` → `...178000`），
> 用它关注会关注到别人。代码只认 `id_str` / `rest_id`。
>
> **写接口的响应体会滞后**：实测 `destroy.json` 返回 200 但 body 里 `following` 还是 `true`，
> 而 `friendships/show.json` 查出来已经是 `false`。所以成败以 show 为准，别看 body。
>
> **关注列表顺序不代表关注先后**：刚关注的人在 7 分钟后仍未出现在列表前 200 里，全量 375 条也找不到（总数只有 352）。
> 说明接口按某种缓存顺序返回，`order` 不能当「关注时间」用。插件因此改用**本地扫描历史**算「已跟踪 N 天」。
>
> **分页会重复**：两次拉取共 375 条，而实际关注 352 个。`classify` 已按 handle 去重。

## 权限说明

| 权限 | 为什么需要 |
|---|---|
| `sidePanel` | 界面放在浏览器侧边栏 |
| `storage` | 保存你的偏好设置 |
| `scripting` | 首次安装后给已打开的 x.com 页面补注入脚本，免得你手动刷新 |
| `host_permissions: x.com / twitter.com` | 在 x.com 页面内读取 cookie 并发同源请求 |

不申请 `cookies`（不需要，内容脚本直接读 `document.cookie`）、不申请 `tabs`（只用 URL 匹配找标签页）、
不申请 `webRequest`、不申请 `downloads`（导出用 Blob + a[download]）。
「+ 关注」是内容脚本在 x.com 页内发的同源 POST，同样不需要额外权限。
读通知流也是同源 `fetch`（`/i/api/2/notifications/all.json`），不多一个权限。

## 隐私

- 关注/粉丝数据只写本机 IndexedDB，最多保留每个账号最近 12 次快照
- 无任何上报、无统计、无远端接口
- 卸载扩展即清除全部数据；面板底部也有「清除本机记录」

## 已知限制

- 必须有一个已登录的 x.com 标签页（登录态来自它）
- 关注/粉丝都上千时扫描要一分钟左右：GraphQL 每页只给 50 人，1400 个关注就得翻 29 页。会有进度条，可随时「停止」
- 单次最多 80 页（4000 人）
- 被限流（429）会自动退避重试 3 次，仍失败就跳过粉丝列表、保留关注列表结果
- 判定取舍：接口 `followed_by` 与粉丝列表差集**任意一方说互关就算互关**，宁可漏报也不错怪人
- 关注/取关都是真实写操作：一次一个、间隔 3~6 秒，一天别超过几十个，否则可能触发 226（自动化判定）或 429
- 写完之后名单不会立刻重排，要点「开始扫描」才更新；按钮会先给出结果状态
- 「已跟踪 N 天」来自**你本机的扫描历史**，不是 X 的关注时间——第一次扫描时所有人的天数都是 0，用得越久越准
- 关注列表接口有缓存延迟：刚关注/取关的人可能几分钟内不出现在列表里（实测 7 分钟仍未刷新）
- **互动榜只看得到通知流里还有的历史**：X 不按时间倒着无限给，实测一个账号翻到 371 条就到底（覆盖 26 天）。所以榜单是「最近这段时间谁跟你互动最多」，不是终身累计，面板底部会写清覆盖范围
- **互动榜只算他 → 你的方向**：回复、点赞、转发、@你、关注你。你 → 他的方向拿不到——`statuses/user_timeline.json` 和 `favorites/list.json` 都已失效（见上表），没有可靠数据源
- 互动数据**只存在内存里**，关掉侧边栏就没了，重开要点一次「扫互动」；关注/粉丝快照才会存进 IndexedDB
- **额度是本机记账，不是 X 的计数**：手机上/别的浏览器里关注的看不到，只能靠下次扫描补记（时间落到扫描时刻）；页面里少数 A/B 入口可能漏记。所以留了两个兜底：`标记已满`（等价于 X 的 161，再点取消）、`实际已用 → 校准`（填 0 等于清零）
- **官方没公布「一天」的时区**：默认美西 0 点，可切滚动 24 小时。两种口径在边界上会差几个小时
- **沉默号只能覆盖一部分人**：GraphQL 不返回最后发帖时间，只有旧接口 `following/list.json` 带 `status.created_at`，而它最多给约 500 个关注。所以只有这部分人有真实的「最后发帖 N 天」，其余显示「最后发帖时间未知」，单独一档可查，不会把正常人当死号。零推文号（`tweet_counts.tweets = 0`）能准确判定，「零推文」一档是全量的

## 开发

```bash
# 单测（67 个用例，含实测账号数据回归 + 美西时区/夏令时边界）
node --test "tests/**/*.test.mjs"
# 或分开跑
node --test tests/core.test.mjs    # 分类 / 互动 / 沉默 / 额度 58 个
node --test tests/inject.test.mjs  # 关注/取关嗅探方向判断 9 个

# UI 本地预览（伪造 chrome API + 假数据，不需要装扩展）
python -m http.server 8765 --bind 127.0.0.1
# 打开 http://127.0.0.1:8765/dev/preview.html

# 无头 Chrome 截图 + 交互自检（需要本机装了 Chrome）
node dev/shot.cjs http://127.0.0.1:8765/dev/preview.html /tmp/shot.png
```

目录：

```
manifest.json      扩展清单
background.js      打开侧边栏 + 关注/取关记账（串行写 storage，避免多标签页互相覆盖）
content.js         在 x.com 页面里发 GraphQL / REST 请求（无 ES module）
inject.js          跑在页面 MAIN world，抄 GraphQL queryId + 嗅探关注/取关动作（只读，不发请求）
lib/core.js        纯逻辑：分类 / 互动排行 / 沉默分档 / 额度与美西时区 / diff / CSV（不依赖 chrome，可单测）
lib/db.js          IndexedDB 快照存储
sidepanel/         侧边栏 UI
dev/               本地预览用，打包时排除
tests/             node 单测
docs/              接口验证报告（GraphQL / REST 端点实测记录）
```

接口怎么试出来的、踩过哪些坑，全在 [docs/api-verification.md](docs/api-verification.md)。

## 打包上架

```bash
python - <<'PY'
import zipfile, pathlib
root = pathlib.Path(".")
skip = {"dev", "tests", "dist", "node_modules", ".git"}
with zipfile.ZipFile("dist/x-mutual-check-0.6.1.zip", "w", zipfile.ZIP_DEFLATED) as z:
    for p in root.rglob("*"):
        if p.is_dir() or p.suffix == ".zip" or p.suffix == ".md":
            continue
        if skip & set(p.parts):
            continue
        z.write(p, p.as_posix())
PY
```

上架检查清单：

- [ ] 商店描述里别写「抓取 / scrape」，用「读取你自己账号的关注列表」
- [ ] 隐私说明写明「数据仅本地处理，不上传」
- [ ] 截图准备 1 张侧边栏截图（1280x800）+ 1 张 logo 128x128
- [ ] 单一用途描述：检查 X 账号的关注关系
- [ ] 不宣称能自动取关 / 批量涨粉（会被判为自动化工具）；「单条回关 / 单条取关」要说明是用户逐次点击且带二次确认

## 免责声明

本项目使用 X 网页端自用的非公开 REST 接口，**不是 X 官方 API，也没有得到 X 授权**。
接口随时可能变动或失效，X 也可能认为这类自动化访问违反其服务条款。
使用风险自负：请只操作自己的账号、控制操作频率，不要用于批量涨粉、刷量或任何骚扰行为。

## 许可证

[MIT](LICENSE)
