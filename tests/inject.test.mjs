/**
 * inject.js 的单测：用 vm 造一个假页面，验证「关注 / 取关」方向判断和 queryId 抄写。
 *
 * 这段逻辑最怕的是把「取关」记成「关注」（会白白扣掉额度），或者把拉列表的 GET
 * 当成关注动作（那额度永远瞬间就满了）。所以每个分支都要有测试兜着。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const CODE = fs.readFileSync(new URL("../inject.js", import.meta.url), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeEnv(fetchImpl) {
  const messages = [];
  const attrs = {};

  class FakeXHR {
    open() {}
    send() {}
    addEventListener() {}
  }

  const win = {
    location: { origin: "https://x.com" },
    postMessage: (m) => messages.push(m),
    fetch: fetchImpl,
    XMLHttpRequest: FakeXHR,
  };

  const ctx = vm.createContext({
    window: win,
    document: { documentElement: { setAttribute: (k, v) => (attrs[k] = v) } },
    location: win.location,
    XMLHttpRequest: FakeXHR,
    URL,
    Response,
    JSON,
    Math,
    String,
    Number,
    Array,
    Object,
    console,
  });
  vm.runInContext(CODE, ctx);
  return { win, messages, attrs };
}

const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const actions = (messages) => messages.filter((m) => m.kind === "follow").map((m) => m.action);
const caps = (messages) => messages.filter((m) => m.kind === "cap").length;

test("REST create.json 记成 follow，uid 从请求体里取", async () => {
  const env = makeEnv(async () => jsonRes({ id_str: "42", following: true }));
  await env.win.fetch("/i/api/1.1/friendships/create.json", { method: "POST", body: "user_id=170001" });
  await sleep(30);
  assert.deepEqual(actions(env.messages), ["follow"]);
  assert.equal(env.messages[0].uid, "170001");
});

test("REST destroy.json 记成 unfollow，不会算到关注额度里", async () => {
  const env = makeEnv(async () => jsonRes({ id_str: "42", following: false }));
  await env.win.fetch("/i/api/1.1/friendships/destroy.json", { method: "POST", body: "user_id=170002" });
  await sleep(30);
  assert.deepEqual(actions(env.messages), ["unfollow"]);
});

test("关注失败（161 不能再关注了）只报 cap，不记成一笔关注", async () => {
  const env = makeEnv(async () =>
    jsonRes({ errors: [{ code: 161, message: "You are unable to follow more people at this time." }] }, 403)
  );
  await env.win.fetch("/i/api/1.1/friendships/create.json", { method: "POST", body: "user_id=170003" });
  await sleep(30);
  assert.equal(caps(env.messages), 1);
  assert.deepEqual(actions(env.messages), []);
});

test("GraphQL 的 POST Following mutation 记成 follow，GET 拉列表不算动作", async () => {
  const env = makeEnv(async () => jsonRes({ data: { following: true } }));
  await env.win.fetch("/i/api/graphql/abc123/Following", { method: "POST", body: '{"variables":{"user_id":"170004"}}' });
  await sleep(30);
  assert.deepEqual(actions(env.messages), ["follow"]);
  assert.equal(env.messages[0].uid, "170004");

  // 同一个 op 名的 GET 是「读关注列表」，绝不能记成关注
  const env2 = makeEnv(async () => jsonRes({ data: {} }));
  await env2.win.fetch("/i/api/graphql/abc123/Following?variables=%7B%7D");
  await sleep(30);
  assert.deepEqual(actions(env2.messages), []);
});

test("GraphQL Unfollow mutation 记成 unfollow", async () => {
  const env = makeEnv(async () => jsonRes({ data: { following: false } }));
  await env.win.fetch("/i/api/graphql/abc123/Unfollow", { method: "POST", body: '{"variables":{"user_id":"170005"}}' });
  await sleep(30);
  assert.deepEqual(actions(env.messages), ["unfollow"]);
});

test("响应体说 following:false 时，即使 URL 像关注也按 unfollow 记", async () => {
  const env = makeEnv(async () => jsonRes({ data: { following: false } }));
  await env.win.fetch("/i/api/graphql/abc123/Following", { method: "POST", body: '{"variables":{"user_id":"170006"}}' });
  await sleep(30);
  assert.deepEqual(actions(env.messages), ["unfollow"]);
});

test("无关请求一条消息都不发", async () => {
  const env = makeEnv(async () => jsonRes({ ok: true }));
  await env.win.fetch("/i/api/1.1/users/show.json?screen_name=alice");
  await env.win.fetch("/i/api/2/notifications/all.json?count=40");
  await sleep(30);
  assert.equal(env.messages.length, 0);
});

test("抄下页面自己用的 queryId 与 features，供扫描复用", async () => {
  const env = makeEnv(async () => jsonRes({ data: {} }));
  await env.win.fetch("/i/api/graphql/QID_FOLLOW/Following?features=%7B%22a%22%3Atrue%7D&variables=%7B%7D");
  await env.win.fetch("/i/api/graphql/QID_FANS/Followers?features=%7B%22a%22%3Atrue%7D");
  await sleep(20);
  const saved = JSON.parse(env.attrs["data-xmc-gql"]);
  assert.equal(saved.Following.qid, "QID_FOLLOW");
  assert.equal(saved.Followers.qid, "QID_FANS");
  assert.equal(saved.Following.features, '{"a":true}');
});

test("网络异常/非 JSON 响应不会抛错，按 URL 推断方向", async () => {
  const env = makeEnv(async () => new Response("boom", { status: 200 }));
  await env.win.fetch("/i/api/1.1/friendships/create.json", { method: "POST", body: "screen_name=alice" });
  await sleep(30);
  assert.deepEqual(actions(env.messages), ["follow"]);
  assert.equal(env.messages[0].uid, "");
});
