/**
 * 核心纯逻辑：接口地址、数据归一化、三档分类、快照 diff、CSV 导出。
 * 这个文件不依赖 chrome API，可以直接被 node 测试（tests/core.test.mjs）。
 */

export const API_PATH = {
  following: "/i/api/1.1/friends/following/list.json",
  followers: "/i/api/1.1/followers/list.json",
};

/** 写接口。两个都实测 200，且都支持 user_id 或 screen_name。 */
export const WRITE_PATH = {
  follow: "/i/api/1.1/friendships/create.json",
  unfollow: "/i/api/1.1/friendships/destroy.json",
};

/**
 * 互动数据源：v2 通知流。
 * 实测 2026-11-05：statuses/* 三个 v1.1 端点（user_timeline / mentions_timeline / home_timeline）
 * 仍然返回 200，但 body 是空的；favorites/list 直接 404。能用的只有这个通知流。
 * 代价：只能翻到有限的历史（实测 371 条，覆盖 26 天），所以排行榜是「最近一段时间」的。
 */
export const NOTIF_PATH = "/i/api/2/notifications/all.json";

/** count 上限 40，超过直接 400。 */
export const NOTIF_PARAMS = [
  "include_mention_filter=true",
  "include_nsfw_user_flag=false",
  "include_nsfw_admin_flag=false",
  "include_ranked_timeline=true",
  "include_alerter_filter=true",
].join("&");

/** 关注失败时的错误码 → 人话（X v1.1 错误码）。 */
export const FOLLOW_ERRORS = {
  108: "这个账号不存在或已注销",
  161: "关注数已达上限，先取关一些再试",
  162: "对方把你拉黑了",
  226: "被判定为自动化操作，停一会儿再试",
  326: "账号被临时锁定，去 x.com 手动操作一次",
  88: "触发频率限制，等 15 分钟再试",
};

/** 只要这些 include_* 参数，就不需要 GraphQL，也不需要 queryId / x-client-transaction-id。 */
export const COMMON_PARAMS = [
  "include_profile_interstitial_type=1",
  "include_blocking=1",
  "include_blocked_by=1",
  "include_followed_by=1",
  "include_want_retweets=1",
  "include_mute_edge=1",
  "include_can_dm=1",
  "include_can_media_tag=1",
  "include_ext_is_blue_verified=1",
  "include_ext_verified_type=1",
  "include_ext_profile_image_shape=1",
].join("&");

/** X 网页端公开 bearer，多年未变；不是用户凭证。 */
export const PUBLIC_BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

/**
 * withStatus=false 时带 skip_status=1，响应体积能小到 1/3；
 * 但它会把用户对象里的 status（最后一条推文）也跳掉，沉默号就无从判断。
 * 默认带 status：实测 524 个关注约 1.7MB / 3 页，可接受。
 */
export function buildUrl(kind, userId, cursor = "-1", count = 200, { withStatus = true } = {}) {
  const path = API_PATH[kind];
  if (!path) throw new Error("unknown kind: " + kind);
  const extra = withStatus ? "" : "&skip_status=1";
  return `${path}?${COMMON_PARAMS}${extra}&user_id=${userId}&count=${count}&cursor=${encodeURIComponent(cursor)}`;
}

export function buildNotifUrl(cursor = null, count = 40) {
  const c = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
  return `${NOTIF_PATH}?${NOTIF_PARAMS}&count=${count}${c}`;
}

/** 把接口返回的 user 压成 UI 只需要的样子，体积缩到原来的 1/8。
 *  同时兼容已经归一化过的对象（重启面板时从 IndexedDB 读回来的旧数据）。 */
export function normalizeUser(u) {
  if (!u) return null;
  const avatar = u.profile_image_url_https || u.profile_image_url || u.avatar || "";
  const pick = (raw, norm) => (u[raw] !== undefined ? u[raw] : u[norm]);
  // id 只认字符串：v1.1 返回的 id 是 number，超过 2^53 已经失精，用它会关注到别人
  const rawId = u.id_str ?? u.rest_id ?? u.id;
  const id = typeof rawId === "string" ? rawId : "";
  // 最后一条推文的时间。原始对象在 status.created_at 里（REST 去掉 skip_status 才有）；
  // GraphQL 不给这个字段，只有补充扫描拿到的 last_tweet_at（null 表示确认零推文）。
  // 从快照读回来的旧数据已经是 lastTweetAt。
  const tweets = pick("statuses_count", "tweets") ?? 0;
  let lastTweetAt = null;
  let statusKnown = false;
  if (u.status && u.status.created_at) {
    const t = Date.parse(u.status.created_at);
    if (!Number.isNaN(t)) {
      lastTweetAt = t;
      statusKnown = true;
    }
  } else if (Number.isFinite(u.lastTweetAt)) {
    lastTweetAt = u.lastTweetAt;
    statusKnown = true;
  } else if (u.last_tweet_at === null || Number.isFinite(u.last_tweet_at)) {
    lastTweetAt = Number.isFinite(u.last_tweet_at) ? u.last_tweet_at : null;
    statusKnown = true;
  } else if (u.status_known === true) {
    statusKnown = true;
  }
  return {
    id,
    sn: u.screen_name || u.sn || "",
    name: u.name || "",
    bio: u.description !== undefined ? u.description : u.bio || "",
    avatar: avatar.replace("_normal.", "_bigger."),
    followers: pick("followers_count", "followers") ?? 0,
    friends: pick("friends_count", "friends") ?? 0,
    tweets,
    createdAt: u.created_at || u.createdAt || "",
    verified: !!(u.ext_is_blue_verified ?? u.verified),
    protected: !!u.protected,
    following: !!pick("following", "following"),
    followedBy: !!pick("followed_by", "followedBy"),
    lastTweetAt,
    // 这个人的最后发帖时间到底知不知道。GraphQL 拿不到、补充扫描也没覆盖到的，为 false，
    // UI 必须显示「未知」而不是「零推文」，否则会把正常人当成死号。
    statusKnown,
    // 一条推文都没发过：跟「很久没更新」不是一回事，单独标出来
    noTweets: tweets === 0,
  };
}

const key = (u) => String(u.sn || u.screen_name || "").toLowerCase();

/**
 * 三档分类。
 * 关键取舍：接口的 followed_by 与粉丝列表差集，任意一方判定「互关」就算互关 ——
 * 宁可漏报「未回关」，也不要错怪人（这类名单会被拿去 @ 人）。
 *
 * firstSeen：可选 Map<handle小写, 首次记录时间戳>，用来算「已跟踪多久仍未回关」。
 */
export function classify(followingRaw = [], followersRaw = null, { firstSeen = null, now = Date.now() } = {}) {
  // 没 handle 的脏数据直接丢掉：否则 key 全变空串，会被当成同一个人。
  // 另外必须去重：实测分页期间列表变动会出现重复条目（352 个关注拉出 375 条）。
  const clean = (list) => {
    const seen = new Set();
    const out = [];
    for (const raw of list) {
      const u = normalizeUser(raw);
      if (!u || !u.sn) continue;
      const k = u.sn.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(u);
    }
    return out;
  };

  const following = clean(followingRaw);
  const followers = followersRaw ? clean(followersRaw) : null;

  for (const u of following) {
    const seenAt = firstSeen && firstSeen.get(u.sn.toLowerCase());
    u.firstSeen = seenAt || now;
  }

  const fanSet = followers && followers.length ? new Set(followers.map(key)) : null;
  const mutual = [];
  const notBack = [];

  for (const u of following) {
    const byField = u.followedBy;
    let isMutual = byField;
    if (fanSet) {
      const inFans = fanSet.has(key(u));
      if (inFans && !byField) u.corrected = true;
      isMutual = inFans || byField;
    }
    u.mutual = isMutual;
    u.notBack = !isMutual;
    (isMutual ? mutual : notBack).push(u);
  }

  let pureFans = [];
  if (followers) {
    const folSet = new Set(following.map(key));
    pureFans = followers.filter((f) => !folSet.has(key(f)));
    const fanMap = new Map(followers.map((f) => [key(f), f]));
    for (const f of pureFans) f.followedBy = true;
    void fanMap;
  }

  return {
    following,
    followers: followers || [],
    mutual,
    notBack,
    pureFans,
    stats: {
      following: following.length,
      followers: followers ? followers.length : null,
      mutual: mutual.length,
      notBack: notBack.length,
      // 核心指标：未回关里有多少蓝V——这类人最可能是「你付费/主动关注但对方没回」
      notBackBlue: notBack.filter((u) => u.verified).length,
      followingNonBlue: following.filter((u) => !u.verified).length,
      pureFans: followers ? pureFans.length : null,
      mutualRate: following.length ? Math.round((mutual.length / following.length) * 1000) / 10 : 0,
    },
  };
}

/**
 * 列表筛选。抽成纯函数，方便单测；UI 只负责传状态。
 * blueMode：all=全部 / blue=只看蓝V / nonblue=只看没认证的（需求「所有没有蓝V的分类」）。
 * onlyBlue 是旧参数，仍兼容。
 */
export function filterRows(rows, { onlyBlue = false, blueMode = null, minFollowers = 0, query = "" } = {}) {
  const q = String(query || "").trim().toLowerCase();
  const mode = blueMode || (onlyBlue ? "blue" : "all");
  return (rows || []).filter((u) => {
    if (!u) return false;
    if (mode === "blue" && !u.verified) return false;
    if (mode === "nonblue" && u.verified) return false;
    if (minFollowers > 0 && (u.followers || 0) < minFollowers) return false;
    if (!q) return true;
    return (
      String(u.sn || "").toLowerCase().includes(q) ||
      String(u.name || "").toLowerCase().includes(q) ||
      String(u.bio || "").toLowerCase().includes(q)
    );
  });
}

/** 统计一组人的蓝V数，给「未回关蓝V」这类临时视图用。 */
export function countBlue(rows) {
  return (rows || []).filter((u) => u && u.verified).length;
}

/**
 * 两次快照对比。prev / next 都是 { following: [...], followers: [...] }。
 * followers 为空时不计算掉粉相关项（返回空数组），避免误报。
 */
export function diffSnapshots(prev, next) {
  const empty = {
    newNotBack: [],
    resolved: [],
    unfollowedYou: [],
    newFollowers: [],
    youUnfollowed: [],
    hasFollowerData: false,
  };
  if (!prev || !next) return empty;

  const pFol = new Map((prev.following || []).map((u) => [key(u), u]));
  const nFol = new Map((next.following || []).map((u) => [key(u), u]));

  const newNotBack = (next.following || []).filter((u) => {
    if (!u.notBack) return false;
    const p = pFol.get(key(u));
    return !p || !p.notBack;
  });

  const resolved = (prev.following || []).filter((u) => {
    if (!u.notBack) return false;
    const n = nFol.get(key(u));
    return n && !n.notBack;
  });

  const youUnfollowed = (prev.following || []).filter((u) => !nFol.has(key(u)));

  const hasFollowerData = (prev.followers || []).length > 0 && (next.followers || []).length > 0;
  let unfollowedYou = [];
  let newFollowers = [];
  if (hasFollowerData) {
    const pFan = new Set((prev.followers || []).map(key));
    const nFan = new Set((next.followers || []).map(key));
    unfollowedYou = (prev.followers || []).filter((u) => !nFan.has(key(u)));
    newFollowers = (next.followers || []).filter((u) => !pFan.has(key(u)));
  }

  return { newNotBack, resolved, youUnfollowed, unfollowedYou, newFollowers, hasFollowerData };
}

function csvCell(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** 带 BOM，Excel 直接打开不乱码。 */
export function toCsv(rows, { withRelation = true, withStale = true, now = Date.now() } = {}) {
  const head = ["昵称", "用户名", "粉丝数", "关注数", "发帖数", "蓝V", "主页链接", "简介"];
  if (withRelation) head.splice(6, 0, "是否互关");
  if (withStale) head.splice(head.length - 2, 0, "最后发帖", "未更新天数");
  const lines = [head.join(",")];
  for (const u of rows) {
    const row = [
      u.name,
      "@" + u.sn,
      u.followers,
      u.friends,
      u.tweets,
      u.verified ? "是" : "否",
    ];
    if (withRelation) row.push(u.mutual ? "是" : "否");
    if (withStale) {
      const d = staleDays(u, now);
      row.push(
        Number.isFinite(u.lastTweetAt) ? new Date(u.lastTweetAt).toISOString().slice(0, 10) : "取不到",
        d === null ? "" : d
      );
    }
    row.push("https://x.com/" + u.sn, (u.bio || "").replace(/\s+/g, " ").slice(0, 300));
    lines.push(row.map(csvCell).join(","));
  }
  return "\uFEFF" + lines.join("\r\n");
}

/** 按粉丝数降序 + 蓝V 优先，未回关名单先看影响力大的。 */
export function sortByWeight(rows) {
  return [...rows].sort((a, b) => (b.verified - a.verified) || (b.followers - a.followers));
}

/**
 * 按「首次记录时间」升序：跟踪最久、一直没回关的人排最前。
 * 这个时间来自你本地快照的历史，不是 X 的关注时间（接口不提供，且返回顺序也不代表关注先后）。
 */
export function sortByTracked(rows) {
  const pos = (u) => (Number.isFinite(u.firstSeen) ? u.firstSeen : Number.MAX_SAFE_INTEGER);
  return [...rows].sort((a, b) => pos(a) - pos(b));
}

/** 已跟踪天数（向下取整）。没有 firstSeen 返回 null。 */
export function trackedDays(u, now = Date.now()) {
  if (!u || !Number.isFinite(u.firstSeen)) return null;
  return Math.floor(Math.max(0, now - u.firstSeen) / 86400000);
}

/**
 * 取关成功后的本地状态同步：从关注/互关/未回关里摘掉这个人，
 * 如果他还在粉丝列表里，会自然落到「纯粉丝」，统计一并重算。
 * 纯函数，不改入参。
 */
export function applyUnfollow(result, sn) {
  const k = String(sn || "").toLowerCase();
  const keep = (u) => u && String(u.sn).toLowerCase() !== k;
  const following = (result.following || []).filter(keep);
  const followers = result.followers || [];
  const folSet = new Set(following.map((u) => String(u.sn).toLowerCase()));
  const pureFans = followers.filter((f) => !folSet.has(String(f.sn).toLowerCase()));
  const mutual = following.filter((u) => u.mutual);
  const notBack = following.filter((u) => !u.mutual);

  return {
    ...result,
    following,
    mutual,
    notBack,
    pureFans,
    stats: {
      following: following.length,
      followers: followers.length ? followers.length : null,
      mutual: mutual.length,
      notBack: notBack.length,
      notBackBlue: notBack.filter((u) => u.verified).length,
      followingNonBlue: following.filter((u) => !u.verified).length,
      pureFans: followers.length ? pureFans.length : null,
      mutualRate: following.length ? Math.round((mutual.length / following.length) * 1000) / 10 : 0,
    },
  };
}

/* ==================== 互动排行榜 ==================== */

/**
 * 通知流里能见到的互动类型 → 权重。
 * element 来自 clientEventInfo.element（不是文案，文案是本地化的）。
 * 权重取舍：回复/引用/转发/@ 是「真的开口说话」，给 3；点赞只是划过去点一下，给 1；
 * 一条通知里点了我多条推文（user_liked_multiple_tweets）说明不止随手，给 2。
 */
export const INTERACT_KINDS = {
  user_replied_to_your_tweet: { key: "reply", label: "回复", weight: 3 },
  users_replied_to_your_tweet: { key: "reply", label: "回复", weight: 3 },
  user_mentioned_you: { key: "mention", label: "@你", weight: 3 },
  users_mentioned_you: { key: "mention", label: "@你", weight: 3 },
  users_retweeted_your_tweet: { key: "retweet", label: "转发", weight: 3 },
  user_retweeted_your_tweet: { key: "retweet", label: "转发", weight: 3 },
  user_quoted_your_tweet: { key: "quote", label: "引用", weight: 3 },
  users_quoted_your_tweet: { key: "quote", label: "引用", weight: 3 },
  users_liked_your_tweet: { key: "like", label: "点赞", weight: 1 },
  user_liked_your_tweet: { key: "like", label: "点赞", weight: 1 },
  user_liked_multiple_tweets: { key: "like", label: "点赞", weight: 2 },
  users_liked_multiple_tweets: { key: "like", label: "点赞", weight: 2 },
  users_followed_you: { key: "follow", label: "关注", weight: 2 },
  user_followed_you: { key: "follow", label: "关注", weight: 2 },
};

const KIND_FALLBACK = { key: "other", label: "其他", weight: 1 };

/** 认不出的类型不要丢，落到「其他」里——宁可少算权重，也不要漏掉这个人。 */
export function kindOf(element) {
  return INTERACT_KINDS[element] || KIND_FALLBACK;
}

/**
 * 把通知记录汇总成排行榜。
 * records: [{ uid, ts, el }]  —— content.js 从每条 entry 里抽出来的
 * users:   { uid: rawUser }   —— 同一批通知带的 globalObjects.users
 *
 * 同一个人在通知流里会出现多次（点赞、回复、关注各一条），按 uid 累加。
 */
export function buildInteractionRank(records = [], users = {}) {
  const byUid = new Map();
  for (const r of records) {
    if (!r || !r.uid) continue;
    const kind = kindOf(r.el);
    let row = byUid.get(r.uid);
    if (!row) {
      const u =
        normalizeUser(users[r.uid]) ||
        { id: r.uid, sn: "", name: "", avatar: "", verified: false, followers: 0, bio: "", tweets: 0, lastTweetAt: null };
      row = { ...u, id: u.id || r.uid, score: 0, count: 0, kinds: {}, lastAt: 0 };
      byUid.set(r.uid, row);
    }
    row.score += kind.weight;
    row.count += 1;
    row.kinds[kind.key] = (row.kinds[kind.key] || 0) + 1;
    if (Number.isFinite(r.ts) && r.ts > row.lastAt) row.lastAt = r.ts;
  }
  return [...byUid.values()];
}

/** 排行榜覆盖的时间范围：给界面写「最近 N 天 / M 条通知」用。 */
export function interactionSummary(records = []) {
  let oldest = null;
  let newest = null;
  const uids = new Set();
  for (const r of records) {
    if (!r || !r.uid) continue;
    uids.add(r.uid);
    if (!Number.isFinite(r.ts)) continue;
    if (oldest === null || r.ts < oldest) oldest = r.ts;
    if (newest === null || r.ts > newest) newest = r.ts;
  }
  return {
    events: records.length,
    users: uids.size,
    oldest,
    newest,
    days: oldest && newest ? Math.max(1, Math.round((newest - oldest) / 86400000)) : null,
  };
}

/** 榜单一：按加权分（说话的分量重）。 */
export function sortByScore(rows) {
  return [...rows].sort((a, b) => b.score - a.score || b.count - a.count || b.lastAt - a.lastAt);
}

/** 榜单二：按互动条数（点了一百个赞也能排前面）。 */
export function sortByInteractions(rows) {
  return [...rows].sort((a, b) => b.count - a.count || b.score - a.score);
}

/** 榜单三：最近还搭理我的排前面——找「还在活跃的关系」。 */
export function sortByRecentInteraction(rows) {
  return [...rows].sort((a, b) => b.lastAt - a.lastAt);
}

export function toInteractionCsv(rows) {
  const head = ["昵称", "用户名", "加权分", "互动次数", "回复", "点赞", "转发", "@你", "关注", "其他", "最后互动", "蓝V", "粉丝数", "主页链接"];
  const lines = [head.join(",")];
  const day = (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : "");
  for (const u of rows) {
    const k = u.kinds || {};
    lines.push(
      [
        u.name,
        "@" + u.sn,
        u.score,
        u.count,
        k.reply || 0,
        k.like || 0,
        k.retweet || 0,
        k.mention || 0,
        k.follow || 0,
        k.other || 0,
        day(u.lastAt),
        u.verified ? "是" : "否",
        u.followers,
        "https://x.com/" + u.sn,
      ]
        .map(csvCell)
        .join(",")
    );
  }
  return "\uFEFF" + lines.join("\r\n");
}

/* ==================== 沉默号（很久没更新） ==================== */

/** 距离最后一条推文多少天。没取到发帖时间返回 null。 */
export function staleDays(u, now = Date.now()) {
  if (!u || !Number.isFinite(u.lastTweetAt)) return null;
  return Math.floor(Math.max(0, now - u.lastTweetAt) / 86400000);
}

/** 分档顺序＝界面 chips 顺序。 */
export const STALE_BUCKETS = [
  { key: "d30", label: "30天+", min: 30 },
  { key: "d90", label: "90天+", min: 90 },
  { key: "d180", label: "半年+", min: 180 },
  { key: "d365", label: "一年+", min: 365 },
  { key: "none", label: "零推文", min: null },
];

/** 按分档筛。bucket 为 all / 空时返回全部（含取不到时间的）。 */
export function filterStale(rows, bucket = "all", now = Date.now()) {
  return (rows || []).filter((u) => {
    if (!u) return false;
    if (bucket === "none") return (u.tweets || 0) === 0;
    if (bucket === "unknown") return (u.tweets || 0) > 0 && !Number.isFinite(u.lastTweetAt);
    if (bucket === "all" || !bucket) return true;
    const b = STALE_BUCKETS.find((x) => x.key === bucket);
    if (!b || b.min === null) return true;
    const days = staleDays(u, now);
    return days !== null && days >= b.min;
  });
}

/**
 * 每个档位有多少人，给 chips 上的数字用。一个人可能同时进 30+/90+/180+，所以是累加桶。
 * unknown 单独算：GraphQL 不给最后发帖时间，补充接口又只覆盖一部分人，
 * 拿不到的必须报「未知」，不能默默当成「不沉默」。
 */
export function staleStats(rows, now = Date.now()) {
  const out = { d30: 0, d90: 0, d180: 0, d365: 0, none: 0, known: 0, unknown: 0 };
  for (const u of rows || []) {
    if (!u) continue;
    if ((u.tweets || 0) === 0) {
      out.none++;
      continue;
    }
    const days = staleDays(u, now);
    if (days === null) {
      out.unknown++;
      continue;
    }
    out.known++;
    if (days >= 30) out.d30++;
    if (days >= 90) out.d90++;
    if (days >= 180) out.d180++;
    if (days >= 365) out.d365++;
  }
  return out;
}

/** 最久没发帖的排最前；从未发过推文的号排在后面。 */
export function sortByStale(rows, now = Date.now()) {
  const pos = (u) => (Number.isFinite(u.lastTweetAt) ? 0 : (u.tweets || 0) === 0 ? 1 : 2);
  return [...rows].sort((a, b) => {
    const pa = pos(a);
    const pb = pos(b);
    if (pa !== pb) return pa - pb;
    const da = staleDays(a, now);
    const db = staleDays(b, now);
    if (da === null || db === null) return 0;
    return db - da;
  });
}
