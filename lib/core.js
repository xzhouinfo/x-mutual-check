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
  "skip_status=1",
].join("&");

/** X 网页端公开 bearer，多年未变；不是用户凭证。 */
export const PUBLIC_BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

export function buildUrl(kind, userId, cursor = "-1", count = 200) {
  const path = API_PATH[kind];
  if (!path) throw new Error("unknown kind: " + kind);
  return `${path}?${COMMON_PARAMS}&user_id=${userId}&count=${count}&cursor=${encodeURIComponent(cursor)}`;
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
  return {
    id,
    sn: u.screen_name || u.sn || "",
    name: u.name || "",
    bio: u.description !== undefined ? u.description : u.bio || "",
    avatar: avatar.replace("_normal.", "_bigger."),
    followers: pick("followers_count", "followers") ?? 0,
    friends: pick("friends_count", "friends") ?? 0,
    tweets: pick("statuses_count", "tweets") ?? 0,
    createdAt: u.created_at || u.createdAt || "",
    verified: !!(u.ext_is_blue_verified ?? u.verified),
    protected: !!u.protected,
    following: !!pick("following", "following"),
    followedBy: !!pick("followed_by", "followedBy"),
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
      pureFans: followers ? pureFans.length : null,
      mutualRate: following.length ? Math.round((mutual.length / following.length) * 1000) / 10 : 0,
    },
  };
}

/**
 * 列表筛选。抽成纯函数，方便单测；UI 只负责传状态。
 * onlyBlue 是主诉求（只看蓝V），query 同时匹配昵称、用户名、简介。
 */
export function filterRows(rows, { onlyBlue = false, minFollowers = 0, query = "" } = {}) {
  const q = String(query || "").trim().toLowerCase();
  return (rows || []).filter((u) => {
    if (!u) return false;
    if (onlyBlue && !u.verified) return false;
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
export function toCsv(rows, { withRelation = true } = {}) {
  const head = ["昵称", "用户名", "粉丝数", "关注数", "发帖数", "蓝V", "主页链接", "简介"];
  if (withRelation) head.splice(6, 0, "是否互关");
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
      pureFans: followers.length ? pureFans.length : null,
      mutualRate: following.length ? Math.round((mutual.length / following.length) * 1000) / 10 : 0,
    },
  };
}
