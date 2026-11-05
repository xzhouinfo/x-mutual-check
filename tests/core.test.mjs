import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildUrl,
  normalizeUser,
  classify,
  diffSnapshots,
  toCsv,
  sortByWeight,
  sortByTracked,
  trackedDays,
  filterRows,
  countBlue,
  applyUnfollow,
  FOLLOW_ERRORS,
  WRITE_PATH,
  COMMON_PARAMS,
  PUBLIC_BEARER,
} from "../lib/core.js";

const raw = (sn, extra = {}) => ({
  screen_name: sn,
  name: sn.toUpperCase(),
  description: "bio of " + sn,
  profile_image_url_https: `https://pbs.twimg.com/${sn}_normal.jpg`,
  followers_count: 100,
  friends_count: 50,
  statuses_count: 10,
  created_at: "Wed Oct 10 20:19:24 +0000 2018",
  ext_is_blue_verified: false,
  protected: false,
  following: true,
  followed_by: true,
  ...extra,
});

test("buildUrl 拼装正确且带上全部 include 参数", () => {
  const url = buildUrl("following", "1248740299", "-1", 200);
  assert.ok(url.startsWith("/i/api/1.1/friends/following/list.json?"));
  assert.ok(url.includes("user_id=1248740299"));
  assert.ok(url.includes("count=200"));
  assert.ok(url.includes("cursor=-1"));
  assert.ok(url.includes("include_followed_by=1"));
  assert.equal(url.split("&").length, COMMON_PARAMS.split("&").length + 3);

  const fan = buildUrl("followers", "1", "1730885303739846656");
  assert.ok(fan.startsWith("/i/api/1.1/followers/list.json?"));
  assert.ok(fan.includes("cursor=1730885303739846656"));
});

test("buildUrl 对 cursor 做 URL 编码，未知 kind 抛错", () => {
  const url = buildUrl("following", "1", "a b&c");
  assert.ok(url.includes("cursor=a%20b%26c"));
  assert.throws(() => buildUrl("nope", "1"));
});

test("bearer 是公开常量，长度固定", () => {
  assert.equal(PUBLIC_BEARER.length, 102);
  assert.ok(PUBLIC_BEARER.startsWith("AAAAAAAAAAAAAAAAAAAAANR"));
});

test("normalizeUser 压字段并把头像换成 bigger", () => {
  const u = normalizeUser(raw("alice", { ext_is_blue_verified: true, followers_count: 12345 }));
  assert.equal(u.sn, "alice");
  assert.equal(u.verified, true);
  assert.equal(u.followers, 12345);
  assert.equal(u.avatar, "https://pbs.twimg.com/alice_bigger.jpg");
  assert.equal(u.mutual, undefined);
  assert.equal(normalizeUser(null), null);
});

test("classify：followed_by 决定互关 / 未回关", () => {
  const fol = [raw("a"), raw("b", { followed_by: false }), raw("c")];
  const r = classify(fol);
  assert.equal(r.stats.following, 3);
  assert.equal(r.stats.mutual, 2);
  assert.equal(r.stats.notBack, 1);
  assert.equal(r.notBack[0].sn, "b");
  assert.equal(r.stats.followers, null);
  assert.deepEqual(r.pureFans, []);
  assert.equal(r.stats.mutualRate, 66.7);
});

test("classify：粉丝列表差集可以纠正接口字段（宁漏报不错怪）", () => {
  // 接口说 b 没回关，但 b 确实在粉丝列表里 -> 判定为互关并打 corrected 标记
  const fol = [raw("a"), raw("b", { followed_by: false })];
  const fans = [raw("a"), raw("b"), raw("x")];
  const r = classify(fol, fans);
  assert.equal(r.stats.mutual, 2);
  assert.equal(r.stats.notBack, 0);
  assert.equal(r.following.find((u) => u.sn === "b").corrected, true);
  assert.deepEqual(r.pureFans.map((u) => u.sn), ["x"]);
  assert.equal(r.stats.followers, 3);
  assert.equal(r.stats.pureFans, 1);
});

test("classify：未回关的人即使不在粉丝列表也不会被判成互关", () => {
  const fol = [raw("a", { followed_by: false })];
  const fans = [raw("b")];
  const r = classify(fol, fans);
  assert.equal(r.stats.notBack, 1);
  assert.equal(r.pureFans.length, 1);
});

test("classify：纯粉丝标记 followedBy=true", () => {
  const r = classify([raw("a")], [raw("a"), raw("z")]);
  assert.equal(r.pureFans[0].sn, "z");
  assert.equal(r.pureFans[0].followedBy, true);
});

test("classify：大小写不同的 handle 视为同一人", () => {
  const fol = [raw("Alice", { followed_by: false })];
  const fans = [raw("alice")];
  const r = classify(fol, fans);
  assert.equal(r.stats.notBack, 0);
});

test("diffSnapshots：识别新增未回关 / 已回关 / 掉粉 / 新粉丝 / 你取关", () => {
  const prev = {
    following: [
      { sn: "a", mutual: true, notBack: false },
      { sn: "b", mutual: false, notBack: true },
      { sn: "c", mutual: true, notBack: false },
      { sn: "d", mutual: true, notBack: false },
    ],
    followers: [{ sn: "a" }, { sn: "b" }, { sn: "c" }, { sn: "d" }, { sn: "gone" }],
  };
  const next = {
    following: [
      { sn: "a", mutual: true, notBack: false },
      { sn: "b", mutual: true, notBack: false },
      { sn: "c", mutual: false, notBack: true },
      { sn: "e", mutual: false, notBack: true },
    ],
    followers: [{ sn: "a" }, { sn: "b" }, { sn: "c" }, { sn: "e" }, { sn: "fresh" }],
  };

  const d = diffSnapshots(prev, next);
  assert.equal(d.hasFollowerData, true);
  assert.deepEqual(d.newNotBack.map((u) => u.sn).sort(), ["c", "e"]);
  assert.deepEqual(d.resolved.map((u) => u.sn), ["b"]);
  assert.deepEqual(d.youUnfollowed.map((u) => u.sn), ["d"]);
  assert.deepEqual(d.unfollowedYou.map((u) => u.sn).sort(), ["d", "gone"]);
  assert.deepEqual(d.newFollowers.map((u) => u.sn).sort(), ["e", "fresh"]);
});

test("diffSnapshots：没有粉丝数据时不误报掉粉", () => {
  const prev = { following: [{ sn: "a", notBack: false }], followers: [] };
  const next = { following: [{ sn: "a", notBack: false }], followers: [] };
  const d = diffSnapshots(prev, next);
  assert.equal(d.hasFollowerData, false);
  assert.deepEqual(d.unfollowedYou, []);
  assert.deepEqual(d.newFollowers, []);
});

test("diffSnapshots：缺参数返回空结构不抛错", () => {
  const d = diffSnapshots(null, { following: [] });
  assert.deepEqual(d.newNotBack, []);
  assert.equal(d.hasFollowerData, false);
});

test("toCsv：带 BOM、含互关列、正确转义", () => {
  const rows = [
    { sn: "a", name: 'Ali, "the" one', followers: 1, friends: 2, tweets: 3, verified: true, mutual: false, bio: "line1\nline2" },
  ];
  const csv = toCsv(rows);
  assert.ok(csv.startsWith("\uFEFF昵称,用户名"));
  assert.ok(csv.includes("是否互关"));
  assert.ok(csv.includes('"Ali, ""the"" one"'));
  assert.ok(csv.includes("line1 line2"));
  assert.ok(csv.includes("https://x.com/a"));
});

test("toCsv：可以关掉互关列", () => {
  const csv = toCsv([{ sn: "a", name: "A", followers: 0, friends: 0, tweets: 0, verified: false, mutual: true, bio: "" }], {
    withRelation: false,
  });
  assert.ok(!csv.includes("是否互关"));
});

test("sortByWeight：蓝V优先、再按粉丝数降序、不改原数组", () => {
  const rows = [
    { sn: "small", verified: false, followers: 10 },
    { sn: "big", verified: false, followers: 9999 },
    { sn: "vip", verified: true, followers: 5 },
  ];
  const sorted = sortByWeight(rows);
  assert.deepEqual(sorted.map((u) => u.sn), ["vip", "big", "small"]);
  assert.equal(rows[0].sn, "small");
});

test("normalizeUser 保留 id_str，丢弃会失精的 number id", () => {
  const a = normalizeUser(raw("a", { id_str: "1700000000000000123" }));
  assert.equal(a.id, "1700000000000000123");
  const b = normalizeUser(raw("b", { id_str: undefined, id: 2117144550020177900 }));
  assert.equal(b.id, "", "number 型 id 已丢精度，不能用来关注");
});

test("classify：统计未回关里的蓝V数（核心指标）", () => {
  const fol = [
    raw("blue1", { followed_by: false, ext_is_blue_verified: true }),
    raw("blue2", { followed_by: false, ext_is_blue_verified: true }),
    raw("plain", { followed_by: false, ext_is_blue_verified: false }),
    raw("ok", { followed_by: true, ext_is_blue_verified: true }),
  ];
  const r = classify(fol);
  assert.equal(r.stats.notBack, 3);
  assert.equal(r.stats.notBackBlue, 2);
  assert.equal(countBlue(r.notBack), 2);
});

test("filterRows：只看蓝V + 关键词同时匹配昵称/用户名/简介", () => {
  const rows = [
    { sn: "alice", name: "Alice", bio: "链上数据", verified: true, followers: 100 },
    { sn: "bob", name: "Bob", bio: "Web3 研究", verified: false, followers: 9000 },
    { sn: "carol", name: "Carol", bio: "designer", verified: true, followers: 50 },
  ];
  assert.deepEqual(filterRows(rows, { onlyBlue: true }).map((u) => u.sn), ["alice", "carol"]);
  assert.deepEqual(filterRows(rows, { query: "bob" }).map((u) => u.sn), ["bob"]);
  assert.deepEqual(filterRows(rows, { query: "链上" }).map((u) => u.sn), ["alice"]);
  assert.deepEqual(filterRows(rows, { query: "WEB3" }).map((u) => u.sn), ["bob"]);
  assert.deepEqual(filterRows(rows, { onlyBlue: true, query: "carol" }).map((u) => u.sn), ["carol"]);
  // minFollowers 是 >= 语义：alice 刚好 100 也应保留
  assert.deepEqual(filterRows(rows, { minFollowers: 100 }).map((u) => u.sn), ["alice", "bob"]);
  assert.equal(filterRows(rows, { onlyBlue: true, query: "zzz" }).length, 0);
});

test("filterRows：容错 undefined / 缺字段", () => {
  assert.deepEqual(filterRows(null), []);
  assert.deepEqual(filterRows([null, undefined, { sn: "a" }]).map((u) => u.sn), ["a"]);
});

test("关注相关的接口常量与错误码文案", () => {
  assert.equal(WRITE_PATH.follow, "/i/api/1.1/friendships/create.json");
  assert.equal(WRITE_PATH.unfollow, "/i/api/1.1/friendships/destroy.json");
  assert.ok(FOLLOW_ERRORS[161].includes("上限"));
  assert.ok(FOLLOW_ERRORS[226].includes("自动化"));
});

test("classify：按 firstSeen 记录「第一次被跟踪到」的时间", () => {
  const now = 1_700_000_000_000;
  const seen = new Map([["old", now - 10 * 86400000]]);
  const r = classify([raw("old"), raw("fresh")], null, { firstSeen: seen, now });
  assert.equal(r.following[0].firstSeen, now - 10 * 86400000);
  assert.equal(r.following[1].firstSeen, now);
  assert.equal(trackedDays(r.following[0], now), 10);
  assert.equal(trackedDays(r.following[1], now), 0);
  assert.equal(trackedDays({}, now), null);
});

test("classify：重复 handle 会去重（实测分页会给出重复条目）", () => {
  const r = classify([raw("dup"), raw("DUP"), raw("other")], null);
  assert.equal(r.following.length, 2);
  assert.deepEqual(r.following.map((u) => u.sn), ["dup", "other"]);
  assert.equal(r.stats.following, 2);
});

test("sortByTracked：跟踪最久的排前面，缺 firstSeen 的排末尾，不改原数组", () => {
  const rows = [
    { sn: "recent", firstSeen: 3000 },
    { sn: "unknown" },
    { sn: "old", firstSeen: 1000 },
    { sn: "mid", firstSeen: 2000 },
  ];
  const sorted = sortByTracked(rows);
  assert.deepEqual(sorted.map((u) => u.sn), ["old", "mid", "recent", "unknown"]);
  assert.equal(rows[0].sn, "recent");
});

test("applyUnfollow：摘掉人、重算统计、原对象不被改", () => {
  // blueNoBack 不在粉丝列表里，才是真正的「未回关」
  const fol = [
    raw("blueNoBack", { followed_by: false, ext_is_blue_verified: true }),
    raw("kept", { followed_by: true }),
  ];
  const fans = [raw("kept"), raw("fanOnly")];
  const r = classify(fol, fans);
  assert.equal(r.stats.notBack, 1);
  assert.equal(r.stats.notBackBlue, 1);
  assert.equal(r.stats.pureFans, 1);

  const after = applyUnfollow(r, "blueNoBack");
  assert.equal(after.following.length, 1);
  assert.equal(after.notBack.length, 0);
  assert.equal(after.stats.following, 1);
  assert.equal(after.stats.mutual, 1);
  assert.equal(after.stats.notBackBlue, 0);
  assert.equal(after.stats.mutualRate, 100);
  assert.deepEqual(after.pureFans.map((u) => u.sn), ["fanOnly"]);

  // 原结果不受影响（纯函数）
  assert.equal(r.following.length, 2);
  assert.equal(r.stats.notBack, 1);
});

test("applyUnfollow：取关互关的人，他会从互关落到纯粉丝", () => {
  const r = classify([raw("mutualGuy"), raw("other")], [raw("mutualGuy"), raw("other")]);
  assert.equal(r.stats.pureFans, 0);
  const after = applyUnfollow(r, "mutualGuy");
  assert.equal(after.stats.mutual, 1);
  assert.deepEqual(after.pureFans.map((u) => u.sn), ["mutualGuy"]);
  assert.equal(after.stats.pureFans, 1);
});

test("applyUnfollow：handle 大小写不敏感，陌生人不动统计", () => {
  const r = classify([raw("Alice", { followed_by: false })]);
  const after = applyUnfollow(r, "alice");
  assert.equal(after.following.length, 0);
  const noop = applyUnfollow(r, "nobody");
  assert.equal(noop.following.length, 1);
});

test("端到端：模拟实测账号数据（351 关注 / 420 粉丝 / 100% 互关）", () => {
  const fol = Array.from({ length: 351 }, (_, i) => raw("f" + i, { followed_by: true }));
  const fans = [
    ...fol.map((u) => raw(u.screen_name)),
    ...Array.from({ length: 69 }, (_, i) => raw("fan" + i)),
  ];
  const r = classify(fol, fans);
  assert.equal(r.stats.following, 351);
  assert.equal(r.stats.followers, 420);
  assert.equal(r.stats.notBack, 0);
  assert.equal(r.stats.pureFans, 69);
  assert.equal(r.stats.mutualRate, 100);
});
