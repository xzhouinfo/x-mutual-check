# X（Twitter）互关检测 —— 接口可行性验证报告

- 验证日期：2026-11-05
- 验证方式：真实浏览器（已登录态）+ 一个测试账号（`@your_account`，uid 已打码）
- 验证环境：Windows 10 / Chrome / 中文界面
- 结论：**可行，且无需 GraphQL、无需维护 queryId、无需生成 x-client-transaction-id**

---

## 一、核心结论

**走 REST v1.1 端点，不走 GraphQL。**

| 验证项 | 结果 | 说明 |
|---|---|---|
| `GET /i/api/1.1/friends/following/list.json` | ✅ 200 | 关注列表，含 `followed_by` |
| `GET /i/api/1.1/followers/list.json` | ✅ 200 | 粉丝列表 |
| 必需请求头 | `authorization: Bearer <公开 web bearer>` + `x-csrf-token: <ct0 cookie>` | 只要两个 |
| `x-client-transaction-id` | ❌ 不需要 | 该头只对 GraphQL 强制，REST 端点不校验 |
| GraphQL queryId | ❌ 不需要 | 彻底绕开 queryId 定期失效的坑 |
| 单页上限 | 200 条 | `count=200` 实测有效 |
| 分页 | `next_cursor_str` 游标；`"0"` 表示结束 | 注意 `"-1"` 也是终止值，别死循环 |
| 单请求耗时 | 1.3–1.6 s（20 万–43 万字节响应） | |
| 限流 | 连续 6 个请求无 429 | 建议保持 ≥1 s 间隔 |

## 二、实测数据（测试账号）

| 指标 | 数值 | 请求数 |
|---|---|---|
| 关注（following） | 351 | 2 页 |
| 粉丝（followers） | 420 | 3 页 |
| 未回关（following − followers） | 0 | — |
| 纯粉丝（followers − following） | 69 | — |
| 互关率 | 100% | — |

拉全量 351 关注 + 420 粉丝，一共 **5 个请求、约 8 秒**。

## 三、`followed_by` 字段有效性（关键验证）

担心 `followed_by` 恒为 `true` 变成假字段，做了两组对照：

| 对照 | 样本 | `followed_by=true` | `followed_by=false` |
|---|---|---|---|
| 自己关注列表 | 351 | 351 | 0 |
| 交叉验证：双列表差集 | 351 vs 420 | 差集 0，与 `followed_by` 完全一致 | — |
| **他人关注列表（@elonmusk 前 100）** | 100 | 83 | **17** |

结论：`followed_by` **有真实区分度**，不是恒真。第 3 组里 17 个 `false` 就是「他关注了、但我没关注」的账号。

> 自己的 351 全 `true` 不是 bug——这个账号本身就是 100% 互关号，双列表差集 0 可以独立佐证。

## 四、响应字段（可直接用于 UI）

`users[]` 每项含：

```
screen_name, name, description, profile_image_url_https, profile_banner_url,
followers_count, friends_count, statuses_count, created_at,
verified, ext_is_blue_verified, protected, location, url,
followed_by,     ← 是否回关你
following,       ← 你是否关注他
can_dm, muting, blocking, blocked_by, follow_request_sent
```

三档过滤全部可以直接在本地算：

- 互关：`following && followed_by`
- 未回关：`following && !followed_by`
- 纯粉丝：`!following && followed_by`

## 五、可复用验证代码（浏览器 console / 插件内直接跑）

```js
const BEARER = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"; // X 网页端公开 bearer
const ct0 = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/)[1];
const COMMON = "include_profile_interstitial_type=1&include_blocking=1&include_blocked_by=1"
  + "&include_followed_by=1&include_want_retweets=1&include_mute_edge=1&include_can_dm=1"
  + "&include_can_media_tag=1&include_ext_is_blue_verified=1&include_ext_verified_type=1"
  + "&include_ext_profile_image_shape=1&skip_status=1";

async function fetchAll(kind, userId) {           // kind: "following" | "followers"
  const path = kind === "following"
    ? "/i/api/1.1/friends/following/list.json"
    : "/i/api/1.1/followers/list.json";
  const out = [];
  let cursor = "-1";
  while (true) {
    const url = `${path}?${COMMON}&user_id=${userId}&count=200&cursor=${encodeURIComponent(cursor)}`;
    const res = await fetch(url, {
      headers: { authorization: "Bearer " + BEARER, "x-csrf-token": ct0 }
    });
    if (!res.ok) throw new Error(`${kind} ${res.status}`);
    const j = await res.json();
    out.push(...(j.users || []));
    const next = j.next_cursor_str;
    if (!next || next === "0" || next === "-1" || next === cursor) break;
    cursor = next;
    await new Promise(r => setTimeout(r, 1200));
  }
  return out;
}
```

> `ct0` 可从 `document.cookie` 读取（非 httpOnly）；`auth_token` 是 httpOnly，读不到也不需要读——同源 fetch 会自动带上 cookie。

## 六、与现有开源路线的差距

| 方案 | 依赖 | 维护成本 |
|---|---|---|
| x-follow-checker / x-purge（GraphQL） | queryId（几周就变）+ `x-client-transaction-id`（前端现算） | 高，需要持续跟进 |
| 本次验证的 REST 方案 | 只依赖公开 bearer + ct0 | **低，bearer 多年未变** |

GraphQL 的 `Following` 响应里，user 对象是精简版，**没有 `followed_by`**；而 REST 端点返回完整 60+ 字段。这是选 REST 的第二个理由。

## 七、对「上 Chrome 商店」的影响

- `x-csrf-token` 需要读 cookie → manifest 需要 `cookies` 权限或 host 权限，审核会重点关注，需在说明里写清「仅用于同源请求鉴权」。
- 不要申请 `tabs` / `webRequest` 等宽权限，用 `host_permissions: ["https://x.com/*", "https://twitter.com/*"]` 就够。
- 只做只读 GET，不碰 follow/unfollow 写操作 → 降低「自动化行为」判定风险。
- 建议在权限说明里明确「数据仅本地处理，不上传服务器」。

## 八、下一步

1. MV3 插件骨架（Side Panel + 扫描 + 三档筛选 + CSV 导出）
2. 快照 diff（掉粉监控、新增未回关）
3. 上架材料（隐私说明、权限说明、截图）

---

# 附：v0.4.0 新增需求的数据源验证（2026-11-05 晚）

三个新需求对应的接口，同样在真实登录态下验证过：互动排行榜、非蓝V 分类、沉默号。

## 九、`status.created_at`：沉默号的数据来源

关注/粉丝列表默认带 `skip_status=1`，用户对象里就没有 `status`。去掉这个参数后：

```
user.status.created_at   // 最后一条推文时间，例："Thu Nov 05 13:01:55 +0000 2026"
user.statuses_count      // 总发帖数，0 表示零推文号
```

实测一个 524 关注的账号：

| 项 | 数值 |
|---|---|
| 能拿到 `status.created_at` | 523 / 524 |
| 零推文（`statuses_count=0`、无 status） | 1 |
| 响应体积 | 1748 KB / 3 页（比 `skip_status=1` 大约 3 倍） |
| 耗时 | 8.4 s（3 页，含 300ms 间隔） |

结论：可靠，直接本地算天数分档即可，不需要额外接口。

## 十、互动排行榜：只有 v2 通知流可用

四个候选数据源，前三个全部不可用：

| 候选 | 结果 |
|---|---|
| `GET /i/api/1.1/statuses/user_timeline.json` | 200，**body 为空**（0 字节）→ 拿不到「我回复了谁」 |
| `GET /i/api/1.1/statuses/mentions_timeline.json` | 200，**body 为空** |
| `GET /i/api/1.1/favorites/list.json` | **404**，`{"code":34,"message":"Sorry, that page does not exist"}` |
| `GET /i/api/2/notifications/all.json` | **200，可用** |

### 10.1 请求

```
GET /i/api/2/notifications/all.json
    ?include_mention_filter=true&include_nsfw_user_flag=false&include_nsfw_admin_flag=false
    &include_ranked_timeline=true&include_alerter_filter=true
    &count=40[&cursor=<上一页的 bottom cursor>]
```

- `count` 上限 **40**，传 `100` 直接 **400**
- 响应约 100 KB/页，结构是老的 `globalObjects` + `timeline.instructions` 那套
- 鉴权与关注列表一致：`authorization: Bearer <公开 bearer>` + `x-csrf-token: <ct0>`

### 10.2 结构

```
timeline.instructions[].addEntries.entries[]
  entryId: "notification-<id>"
  sortIndex: 毫秒时间戳
  content.item.clientEventInfo.element   ← 动作类型
  content.item.content.notification.fromUsers: ["<uid>", ...]   ← 关注/点赞/转发这类
  content.item.content.tweet.id          ← 回复这类只给推文 id
globalObjects.users[uid]                 ← 用户对象（含 ext_is_blue_verified / followed_by）
globalObjects.tweets[tweetId].user_id_str ← 回复类靠它反查是谁
```

`addEntries` 的形态在不同版本里变过：可能是数组，也可能是 `{ entries: [...] }`，两种都要兼容。

### 10.3 动作类型（`clientEventInfo.element`）

| element | 含义 | 本项目权重 |
|---|---|---|
| `user_replied_to_your_tweet` | 回复你 | 3 |
| `user_mentioned_you` | @你 | 3 |
| `users_retweeted_your_tweet` | 转发你 | 3 |
| `users_liked_your_tweet` | 点赞你 | 1 |
| `user_liked_multiple_tweets` | 一次点了你多条 | 2 |
| `users_followed_you` | 关注你 | 2 |
| 未识别的新类型 | —— | 1（落到「其他」，不丢人） |

页面上的文案（`richMessage` / `message.text`）是本地化的，**不要按文案判断类型**，只认 element。

### 10.4 回复类通知的反查验证

一条样本里 27 条 `user_replied_to_your_tweet` 通知，全部能通过 `globalObjects.tweets[id].user_id_str` 反查到是谁，**0 条失败**，且这些人都在 `globalObjects.users` 里。

### 10.5 回溯深度（重要边界）

分批翻页实测（每页 40 条）：

| 页数 | 累计通知 | 最早时间 |
|---|---|---|
| 4 | 159 | 2026-11-05 |
| 8 | 317 | 2026-11-04 |
| 11 | 371 | 2026-10-10 → 到底 |

- 第 11 页后 `cursor-bottom` 不再返回，**没有更多历史**
- 该账号覆盖 **26.2 天 / 371 条**
- 所以排行榜的语义只能是「最近这段时间谁跟你互动最多」，UI 必须显示覆盖范围，不能说成累计

### 10.6 一处容易踩的精度坑（在 mock 里真踩到了）

用户 id 必须用 `id_str`。本地预览的假数据里写成 `String(1700000000000000000 + i)`，超过 2^53 后所有 id 撞成同一个字符串，
结果整张排行榜塌缩成 1 个人、分数把所有记录加在一起。这与 README 里 `id` 丢精度那条是同一个坑，写假数据时同样适用。

---

# 附：v0.5.0 —— 为什么必须换成 GraphQL（2026-11-05 晚）

## 十一、REST v1.1 关注列表有硬上限：1406 关注的账号只给 527

有人反馈「扫描出来的数字跟我主页对不上」。主页显示 **1,406 正在关注 / 670 关注者**，
插件当时扫出来 **524~527 关注**。逐页翻 `friends/following/list.json`（`count=100`，`skip_status=1`）：

| 页 | 返回 | next_cursor_str |
|---|---|---|
| 1 | 100 | 2086365520950120448 |
| 2 | 100 | 1971793307715190784 |
| 3 | 100 | 1731196841801441280 |
| 4 | 100 | 1401130195776532482 |
| 5 | 100 | 590393194 |
| 6 | **27** | **"0"** ← 结束 |

合计 **527 人**，`hasError: null`，服务端清楚地表示「没有下一页了」。换 `count=200` 结论一致。
`total_count` 字段存在但值恒为 `null`，接口不告诉你真实总数。

结论：**这个端点最多给约 500 人**，不是分页写错。用它算互关率、未回关名单，会系统性漏掉三分之二的人。

## 十二、GraphQL `Following` / `Followers` 能拿全量

queryId 从页面真实请求里抓（`inject.js` 在 MAIN world 抄下来的就是这两个）：

| 操作 | queryId（2026-11-05） |
|---|---|
| `Following` | `QPaR5ONQTW_KyiEXQCHP4g` |
| `Followers` | `QgDRdL1wGs4vS0mZ0qKHkA` |

请求形态：

```
GET /i/api/graphql/<qid>/Following
    ?variables={"userId":"…","count":50,"cursor":"","includePromotedContent":false,"withGrokTranslatedBio":true}
    &features={…42 个开关，共 2069 字符…}
```

- 鉴权与 v1.1 相同：`authorization: Bearer <公开 bearer>` + `x-csrf-token: <ct0>`
- **不需要 `x-client-transaction-id`**。早期判断「GraphQL 必须要 txid」是误判——那次失败的真实原因是 queryId 已经过期
- 每页固定 **50 人**（`count: 100` 也只返回 50）
- 全文翻完：关注 **1418 人 / 29 页**（同日再次跑为 1409，主页 1406，差值属主页缓存延迟）

### 12.1 两个会让人静默少数据的坑

**① 随机 404**

同一个 URL 连续发 6 次，结果 `404 / 200 / 404 / 200 / 200 / 404`。这不是 queryId 失效，是纯抖动。
所以代码里 404 要重试（最多 5 次），**绝不能当成「翻完了」**——否则第一页之后直接停，人少一大半。

**② `TimelineTerminateTimeline` 在第一页就有**

第一页 instructions 的顺序是：

```
TimelineClearCache
TimelineTerminateTimeline   ← 这里的含义是「顶部到头」，不是「底部到头」
TimelineAddEntries
```

把它当结束条件，扫描会停在第 1 页 50 人。判断结束只能看 bottom cursor：
空 / 以 `0|` 开头 / 与上一页重复 / 本页没有用户。

### 12.2 新的用户对象结构

GraphQL 返回的用户对象没有 `legacy` 了，字段拆成几块：

```json
{
  "rest_id": "…",
  "core": { "screen_name": "…", "name": "…", "created_at": "…" },
  "relationship_counts": { "followers": 7273, "following": 6574 },
  "tweet_counts": { "tweets": 11523, "media_tweets": 570 },
  "relationship_perspectives": { "followed_by": true, "following": true, "blocking": false, … },
  "is_blue_verified": true,
  "verification": { "verified": false },
  "profile_bio": { "description": "…" },
  "avatar": { "image_url": "…" },
  "privacy": { "protected": false }
}
```

互关判定用 `relationship_perspectives.followed_by`，蓝V用 `is_blue_verified`，都可用。
**但没有 `status` 字段** —— 这是沉默号的硬伤，见下一节。

## 十三、`users/lookup.json` 也下线了

想用批量查询给全量用户补最后发帖时间：

```
GET /i/api/1.1/users/lookup.json?user_id=1,2,3…
→ 404 {"errors":[{"message":"Sorry, that page does not exist","code":34}]}
```

所以沉默号没有全量数据源，只能：
- 全量：用 `tweet_counts.tweets === 0` 判定「零推文」（准确）
- 部分：用 `following/list.json`（带 `status`）补「最后发帖时间」，覆盖约 500 人
- 其余：显示「最后发帖时间未知」，单独一档，不假装成死号

## 十四、每日关注额度：规则、时区与计数方式（v0.6.0）

### 14.1 X 自己怎么写的

来自 help.x.com 的 *About following on X*（2019-03 起沿用至今）：

| 规则 | 原文 | 我们的处理 |
|---|---|---|
| 每日上限 | "Every account is able to follow up to **400 accounts per day**" | 硬编码 `FOLLOW_DAY_LIMIT = 400` |
| 关注总数 | "can follow up to **5,000 accounts**. Once you reach that number… wait until your account has more followers" | 5000 以内按准确余量提示 |
| 超过 5000 | 比例由账号自身粉丝/关注比算出，**X 不公布公式** | 只给「粉丝×1.1」估算，界面标 `estimated` |
| 触顶提示 | "You are unable to follow more people at this time" | v1.1 错误码 **161**；抓到就记一条 `cap` |
| 另有行为规范 | follow churn / indiscriminate following / 复制他人粉丝 / 第三方涨粉服务均违规 | README 免责声明里照抄口径，功能上不提供批量关注 |

原文还有一句很关键的话，做这类工具的人容易忽略：

> "You've followed too many accounts too quickly. **Try again in an hour or so.**"

也就是说 400/天之外还有**小时级软限**（社区实测约 30~50 个/小时），
所以插件里没有任何「批量关注」入口，单条写操作还带 3~6 秒随机间隔。

### 14.2 「一天」从哪一刻算起：官方没说，社区两种口径

| 口径 | 依据 | 现状 |
|---|---|---|
| 美西 0 点（America/Los_Angeles） | X 总部时区；第三方工具普遍这么写 | **插件默认** |
| 滚动 24 小时 | 有一部分工具/博客说「不是零点重置，是滚动窗口」 | 作为可选项保留 |
| UTC 0 点 | 少数文章这么说（多是把 API 的 15 分钟窗口张冠李戴） | 未采用 |

官方文档只写 "per day"，没有时区。所以这里不赌单一答案：默认按美西日界线，面板里可以一键
切到「滚动 24 小时」，两种口径的剩余数会同时算好（卡片上的主数字跟着选项走）。

夏令时是真会出事的地方，所以时区计算没有手写偏移表，全部走 `Intl.DateTimeFormat` +
两遍偏移校正（`ptDayStart` / `ptNextStart`）。单测覆盖了两个切换日：

- 2026-03-08（春令时）当天只有 **23 小时**：`00:00 PST(08:00Z)` → 次日 `00:00 PDT(07:00Z)`
- 2026-11-01（秋令时）当天 **25 小时**：`00:00 PDT(07:00Z)` → 次日 `00:00 PST(08:00Z)`

### 14.3 关注次数从哪来（X 没有查询今日已用次数的接口）

试过/想过的路子，以及为什么都不行：

| 想法 | 结果 |
|---|---|
| `friendships/show.json` 之类的接口返回今日计数 | 不存在这样的字段 |
| 关注列表按关注时间倒序 → 数头部 | 实测过：列表顺序**不代表**关注先后（刚关注的人 7 分钟后仍不在前 200 里），见 README 的坑 |
| 通知流里找自己发出的关注 | 通知只有「别人对你做的动作」，没有「你关注了谁」 |
| 关注/取关接口的 `x-rate-limit-*` 响应头 | v1.1 老接口给的是 API 配额（15 分钟窗口），不是日限；GraphQL 的 mutation 也不返回，不能当额度用 |

所以只能自己记账。v0.6.0 三个来源合并去重：

| 来源 `s` | 触发 | 准确度 |
|---|---|---|
| `page` | `inject.js` 在 MAIN world 钩 fetch/XHR，识别 `friendships/create.json`、`destroy.json`、GraphQL `Following`/`Unfollow` mutation | 高（方向以响应体 `data.following` 为准） |
| `panel` | 插件里点「+ 关注」成功后直接记一笔 | 100% |
| `scan` | 扫描时对比上次快照，新增的 handle 计入**当次扫描时刻** | 中（覆盖手机端操作，但时间粒度只能到扫描那一刻） |

`scan` 补记有两道闸，防止把几天的量全塞进今天：

1. 距上次扫描 **> 20 小时**就不补，界面提示「中间新增的 N 个关注没法拆到具体哪一天」
2. 已实时记过账的 uid 不重复计（按 uid 去重）

### 14.4 方向判断：宁可少记，不肯多记

取关被误记成关注会白扣额度（用户会以为没额度了），关注被漏记则会让用户超限——两害相权，
代码在拿不准时**不报 action**：

```
URL 能定性（REST create/destroy） → 直接用
GraphQL mutation                   → 先按 op 名猜（Following=关注、Unfollow=取关）
响应体有 data.following 布尔值      → 以它为准（覆盖上面的猜测）
都没有                             → 不报
```

`tests/inject.test.mjs` 把这几种情况全钉住了：GET 拉列表不算动作、`following:false` 反着记、
403 + code 161 只报 `cap` 不记关注。

### 14.5 已知误差

- 手机上、别的设备上关注的，插件看不到；只能靠下次扫描补记，且时间落点是扫描时刻
- 扫描补记时，昨天深夜关注的会被算到今天（跨了美西 0 点）
- 页面里有极少数关注入口可能不走这两个端点（比如某些 A/B 实验的路径），会漏记
- 所以留了三个兜底手段：`标记已满`（等价于 cap）、`今日清零`、`校准为 N`
