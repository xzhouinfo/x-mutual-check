/**
 * 跑在页面的 MAIN world。只做两件事，都是只读、不改原有行为：
 *
 * 1. 盯住 X 自己发出的 GraphQL 请求，把 Following / Followers 的 queryId 和 features 抄下来，
 *    写到 <html data-xmc-gql>。queryId 是 X 每次发版都可能换的哈希，硬编码迟早失效。
 * 2. 盯住「关注 / 取关」这一动作，postMessage 给 content.js 记账（每日关注额度要用）。
 *    方向优先看响应体里明确的 following 布尔值；URL 本身能确定的（REST create/destroy）直接用 URL。
 *    拿不准就不报 action，宁可少记，也不把取关算成关注。
 *
 * 这里不发任何请求，也不读 cookie。
 */
(function () {
  "use strict";
  if (window.__xmcQidHooked) return;
  window.__xmcQidHooked = true;

  var seen = {};

  /* ---------------- 一、抄 queryId ---------------- */

  function record(rawUrl) {
    try {
      var s = String(rawUrl || "");
      var m = s.match(/\/i\/api\/graphql\/([^/]+)\/(Following|Followers)\b/);
      if (!m) return;
      var abs = new URL(s, location.origin);
      var features = abs.searchParams.get("features") || "";
      var prev = seen[m[2]];
      if (prev && prev.qid === m[1] && prev.features === features) return;
      seen[m[2]] = { qid: m[1], features: features };
      document.documentElement.setAttribute("data-xmc-gql", JSON.stringify(seen));
    } catch (e) {}
  }

  /* ---------------- 二、关注动作嗅探 ---------------- */

  var REST_FOLLOW = /\/i\/api\/1\.1\/friendships\/(create|destroy)\.json/;
  var GQL_ACTION = /\/i\/api\/graphql\/[^/]+\/(Following|Unfollow)$/;

  function say(payload) {
    try {
      payload.__xmc = 1;
      window.postMessage(payload, "*");
    } catch (e) {}
  }

  /** 只认 POST：GET /graphql/<qid>/Following 是「拉关注列表」，跟关注动作不是一回事。 */
  function classify(url, method, body) {
    try {
      var abs = new URL(String(url || ""), location.origin);
      var m = abs.pathname.match(REST_FOLLOW);
      if (m) return { action: m[1] === "create" ? "follow" : "unfollow", uid: uidFromBody(body) };
      var g = abs.pathname.match(GQL_ACTION);
      if (g && String(method || "GET").toUpperCase() === "POST") {
        // 关注用的 mutation 叫 Following；Unfollow 才反过来
        return { action: g[1] === "Unfollow" ? "unfollow" : null, uid: uidFromBody(body) };
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /** 从请求体里抠 user_id。关注接口三种传法都见过：JSON / 表单 / 只有 queryId。 */
  function uidFromBody(body) {
    if (!body) return "";
    try {
      var s = typeof body === "string" ? body : "";
      var m = s.match(/"user_id"\s*:\s*"?(\d+)"?/) || s.match(/user_id=(\d+)/) || s.match(/"user_id"\s*:\s*"(\d+)"/);
      return m ? m[1] : "";
    } catch (e) {
      return "";
    }
  }

  /** 161 = "You are unable to follow more people at this time"：日限 / 比例限制 / 太快。 */
  function checkErrors(json) {
    var errs = json && json.errors;
    if (!Array.isArray(errs)) return false;
    for (var i = 0; i < errs.length; i++) {
      if (Number(errs[i] && errs[i].code) === 161) return true;
    }
    return false;
  }

  function report(action, uid) {
    if (!action) return;
    say({ kind: "follow", action: action, uid: String(uid || "") });
  }

  /**
   * 响应体里 data.following 才是权威方向；有就覆盖，没有就用调用方推断的方向。
   * ok=false 时不记「动作」——失败的关注不算额度；但 161 这种错误必须抓，
   * 那正是「今天不能再关注了」的明确信号。
   */
  function inspect(json, guess, uid, ok) {
    if (checkErrors(json)) say({ kind: "cap" });
    if (!ok) return;
    if (!json) {
      report(guess, uid);
      return;
    }
    var d = (json && json.data) || {};
    var action = guess;
    if (d.following === true) action = "follow";
    else if (d.following === false) action = "unfollow";
    var id =
      uid ||
      (d.user && d.user.result && (d.user.result.rest_id || (d.user.result.core && d.user.result.core.user_id_str))) ||
      (json && json.id_str) ||
      "";
    report(action, id);
  }

  function tapFetch(res, info) {
    try {
      if (!res || !res.clone) {
        report(info.action, info.uid);
        return;
      }
      var ok = !!res.ok;
      // 只在候选请求上用 clone，避免消费掉原响应体
      res
        .clone()
        .json()
        .then(function (json) {
          inspect(json, info.action, info.uid, ok);
        })
        .catch(function () {
          inspect(null, info.action, info.uid, ok);
        });
    } catch (e) {}
  }

  /* ---------------- 装钩子 ---------------- */

  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : input && input.url;
      record(url);
      var info = null;
      try {
        info = classify(url, (init && init.method) || (input && input.method), init && init.body);
      } catch (e) {}
      var p = origFetch.apply(this, arguments);
      if (info && p && typeof p.then === "function") {
        // 成功与否都看一眼：失败响应里可能有错误码 161（今天不能再关注了）
        p.then(function (res) {
          tapFetch(res, info);
        }).catch(function () {});
      }
      return p;
    };
  }

  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      record(url);
      this.__xmc = classify(url, method, null);
    } catch (e) {}
    return origOpen.apply(this, arguments);
  };

  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    var info = this.__xmc;
    if (info) {
      try {
        info.uid = info.uid || uidFromBody(body);
        var xhr = this;
        xhr.addEventListener("load", function () {
          var json = null;
          try {
            json = JSON.parse(xhr.responseText);
          } catch (e) {}
          inspect(json, info.action, info.uid, xhr.status >= 200 && xhr.status < 300);
        });
      } catch (e) {}
    }
    return origSend.apply(this, arguments);
  };
})();
