# X 互关检测

查 X（Twitter）上的互关情况：谁没回关你、谁只是你的粉丝、这次相比上次掉了谁。
所有数据只在你本机处理，不发往任何服务器。

## 为什么这个实现比同类工具稳

同类开源项目（x-follow-checker、x-purge 等）走 GraphQL 内部接口，需要维护会定期失效的
`queryId`，还要处理前端现算的 `x-client-transaction-id`。

这个插件走 REST v1.1 端点：

```
GET  /i/api/1.1/friends/following/list.json?user_id=...&count=200&cursor=-1&include_followed_by=1
GET  /i/api/1.1/followers/list.json?user_id=...&count=200&cursor=-1&include_followed_by=1
POST /i/api/1.1/friendships/create.json        body: user_id=... 或 screen_name=...
```

只需要 `authorization: Bearer <X 网页端公开 bearer>` 和 `x-csrf-token: <ct0 cookie>`，
**不需要 queryId、不需要 transaction-id**，也不依赖页面 DOM 结构。X 前端改版基本不影响。

## 功能

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
4. 点「开始扫描」——顺手把每个人的最后发帖时间也读回来，沉默号就用它
5. 点统计栏的「未回关蓝V」「未回关非V」「半年未更」「零推文」都能直接跳到对应名单；工具栏的筛选按钮可以在任何一档里切 全部 / 蓝V / 非V
6. 要看谁跟你互动最多，点「扫互动」：读通知流，按加权分排出排行榜（回复 / 转发 / @ 各 3 分，关注 2 分，点赞 1 分）
7. 纯粉丝标签里点「+ 关注」当场回关；未回关 / 沉默号标签里连点两次「取关」清人；要留档就点「导出」

### 实测接口状态（2026-11-05）

| 端点 | 结果 |
|---|---|
| `following/list.json` | 200，200 条/页，`followed_by` 字段 20/20 都在 |
| `followers/list.json` | 200，200 条/页 |
| `following/list.json`（不带 `skip_status`） | 200，多出 `status.created_at` → 沉默号靠它；体积约 3 倍（524 人 ≈ 1.7MB） |
| `v2/notifications/all.json` | 200，`count` 上限 40，超过直接 400；能翻到约 371 条就到底 |
| `friendships/create.json` | 200，`user_id` 与 `screen_name` 两种传法都可用，幂等 |
| `friendships/destroy.json` | 200，幂等 |
| `friendships/show.json` | 200，`source_id+target_id`、`source_id+target_screen_name`、双 `screen_name` 三种传法都可用 |
| `statuses/user_timeline.json` | **200 但 body 为空**，v1.1 状态类端点对网页端已废 |
| `statuses/mentions_timeline.json` | **同上，200 + 空 body** |
| `favorites/list.json` | **404 `code 34`**，点赞列表拿不到 |
| `users/show.json` | **404，已下线**（所以关注时用 `screen_name` 兜底，不依赖它） |
| GraphQL `Following` | 需要 `x-client-transaction-id`，且响应里**没有** `followed_by`，故弃用 |

几个必须知道的坑：

> **`id` 会丢精度**：v1.1 返回的 `id` 是 number，超过 2^53 已经失精（实测 `2117144550020177920` → `...178000`），
> 用它关注会关注到别人。代码只认 `id_str`。
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
- 粉丝数上万时扫描要几十秒，会有进度条；单次最多 60 页（12000 人）
- 被限流（429）会自动退避重试 3 次，仍失败就跳过粉丝列表、保留关注列表结果
- 判定取舍：接口 `followed_by` 与粉丝列表差集**任意一方说互关就算互关**，宁可漏报也不错怪人
- 关注/取关都是真实写操作：一次一个、间隔 3~6 秒，一天别超过几十个，否则可能触发 226（自动化判定）或 429
- 写完之后名单不会立刻重排，要点「开始扫描」才更新；按钮会先给出结果状态
- 「已跟踪 N 天」来自**你本机的扫描历史**，不是 X 的关注时间——第一次扫描时所有人的天数都是 0，用得越久越准
- 关注列表接口有缓存延迟：刚关注/取关的人可能几分钟内不出现在列表里（实测 7 分钟仍未刷新）
- **互动榜只看得到通知流里还有的历史**：X 不按时间倒着无限给，实测一个账号翻到 371 条就到底（覆盖 26 天）。所以榜单是「最近这段时间谁跟你互动最多」，不是终身累计，面板底部会写清覆盖范围
- **互动榜只算他 → 你的方向**：回复、点赞、转发、@你、关注你。你 → 他的方向拿不到——`statuses/user_timeline.json` 和 `favorites/list.json` 都已失效（见上表），没有可靠数据源
- 互动数据**只存在内存里**，关掉侧边栏就没了，重开要点一次「扫互动」；关注/粉丝快照才会存进 IndexedDB
- 沉默号依赖 `status.created_at`：零推文号没有这个字段，单独归到「零推文」一档；极少数账号取不到时间，不在任何档里

## 开发

```bash
# 核心逻辑单测（40 个用例，含实测账号数据回归）
node --test tests/core.test.mjs

# UI 本地预览（伪造 chrome API + 假数据，不需要装扩展）
python -m http.server 8765 --bind 127.0.0.1
# 打开 http://127.0.0.1:8765/dev/preview.html
```

目录：

```
manifest.json      扩展清单
background.js      打开侧边栏
content.js         在 x.com 页面里发 REST 请求（无 ES module）
lib/core.js        纯逻辑：分类 / 互动排行 / 沉默分档 / diff / CSV（不依赖 chrome，可单测）
lib/db.js          IndexedDB 快照存储
sidepanel/         侧边栏 UI
dev/               本地预览用，打包时排除
tests/             node 单测
docs/              接口验证报告（REST v1.1 端点实测记录）
```

接口怎么试出来的、踩过哪些坑，全在 [docs/api-verification.md](docs/api-verification.md)。

## 打包上架

```bash
python - <<'PY'
import zipfile, pathlib
root = pathlib.Path(".")
skip = {"dev", "tests", "dist", "node_modules", ".git"}
with zipfile.ZipFile("dist/x-mutual-check-0.4.0.zip", "w", zipfile.ZIP_DEFLATED) as z:
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
