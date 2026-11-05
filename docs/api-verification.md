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
