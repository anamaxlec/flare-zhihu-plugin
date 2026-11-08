import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const pluginPath = fileURLToPath(new URL("../plugin.js", import.meta.url));
const source = await readFile(pluginPath, "utf8");
const requests = [];
let following = false;

const zhihuUserId = "0123456789abcdef0123456789abcdef";
const cookies = [
  { name: "z_c0", value: "z-c0-value" },
  { name: "d_c0", value: "dummy" },
  { name: "_xsrf", value: "xsrf-value" },
];

const context = {
  origin: "https://www.zhihu.com",
  pluginId: "dev.maxlec.zhihu",
  platformId: "zhihu",
  packageHash: "test",
  scope: "account",
  accountId: zhihuUserId,
  locale: "zh-Hans",
  approvedOrigins: ["https://www.zhihu.com"],
  credentialAvailable: true,
  assetHandles: [],
};

function json(value) {
  return {
    status: 200,
    headers: { "content-type": ["application/json"] },
    body: JSON.stringify(value),
  };
}

function route(request) {
  requests.push(request);
  const url = new URL(request.url);
  const path = url.pathname;
  const search = url.search;
  if (path === "/api/v4/me") {
    assert.equal(request.headers["x-zse-93"], "101_3_3.0");
    assert.match(request.headers["x-zse-96"], /^2\.0_.+/);
    assert.equal(request.headers["x-xsrftoken"], "xsrf-value");
    return json({
      id: zhihuUserId,
      name: "Alice",
      url_token: "alice",
      user_type: "people",
      avatar_url: "https://pic1.zhimg.com/avatar.jpg",
    });
  }
  if (path === "/api/v3/feed/topstory/hot-lists/total") {
    return json({
      data: [
        {
          detail_text: "1234 万热度",
          target: {
            id: "999",
            title: "今天的热门问题",
            excerpt: "问题描述",
            answer_count: 88,
            created: 1700000300,
          },
          children: [{ thumbnail: "https://pic1.zhimg.com/hot.jpg" }],
        },
      ],
    });
  }
  if (path === "/api/v3/moments") {
    return json({
      data: [
        {
          type: "feed_group",
          list: [
            {
              type: "feed",
              verb: "VOTEUP_ANSWER",
              created_time: 1700000400,
              actors: [
                {
                  id: "u9",
                  url_token: "dave",
                  name: "Dave",
                  avatar_url: "https://pic1.zhimg.com/d.jpg",
                },
              ],
              target: {
                type: "answer",
                id: "321",
                question: { id: "654", title: "关注页问题" },
                author: {
                  id: "u10",
                  url_token: "erin",
                  name: "Erin",
                },
                excerpt: "关注页摘要",
                voteup_count: 5,
                comment_count: 1,
                created_time: 1700000350,
              },
            },
          ],
        },
      ],
      paging: { is_end: true },
    });
  }
  if (path === "/api/v4/articles/789") {
    return json({
      id: "789",
      title: "一篇文章",
      author: { id: "u1", url_token: "alice", name: "Alice" },
      content: '<p>文章正文</p><img data-original="https://pic1.zhimg.com/article.jpg">',
      image_url: "https://pic1.zhimg.com/article-cover.jpg",
      created: 1700000500,
      voteup_count: 9,
      comment_count: 2,
    });
  }
  if (path === "/api/v3/feed/topstory/recommend") {
    return json({
      data: [
        {
          type: "feed",
          target: {
            type: "answer",
            id: "123",
            question: { id: "456", title: "如何评价 Flutter？" },
            author: {
              id: "u1",
              url_token: "alice",
              name: "Alice",
              avatar_url: "https://pic1.zhimg.com/a.jpg",
              headline: "开发者",
            },
            excerpt: "Flutter 是一个跨平台框架。",
            voteup_count: 42,
            comment_count: 7,
            created_time: 1700000000,
          },
          children: [{ thumbnail: "//pic1.zhimg.com/cover.jpg" }],
        },
      ],
      paging: {
        next: "https://www.zhihu.com/api/v3/feed/topstory/recommend?limit=20&cursor=next",
      },
    });
  }
  if (path === "/api/v4/answers/123" && search.includes("include=")) {
    return json({
      id: "123",
      type: "answer",
      question: { id: "456", title: "如何评价 Flutter？" },
      author: {
        id: "u1",
        url_token: "alice",
        name: "Alice",
        avatar_url: "https://pic1.zhimg.com/a.jpg",
        headline: "开发者",
      },
      content:
        '<p>正文</p><img src="data:image/gif;base64,AAAA" data-original="//pic1.zhimg.com/real.jpg"><script>alert(1)</script>',
      created_time: 1700000000,
      voteup_count: 42,
      comment_count: 7,
    });
  }
  if (path === "/api/v4/answers/123/comments") {
    return json({
      data: [
        {
          id: "c1",
          content: "<p>同意</p>",
          created_time: 1700000100,
          vote_count: 3,
          author: {
            member: {
              id: "u2",
              url_token: "bob",
              name: "Bob",
              avatar_url: "https://pic1.zhimg.com/b.jpg",
            },
          },
          reply_to_author: { member: { name: "Alice" } },
        },
      ],
      paging: { is_end: true },
    });
  }
  if (path === "/api/v4/members/abc" && search.includes("include=")) {
    return json({
      id: "abc",
      name: "Alice",
      url_token: "alice",
      avatar_url: "https://pic1.zhimg.com/a.jpg",
      headline: "开发者",
      follower_count: 10,
      following_count: 5,
      answer_count: 3,
      is_following: following,
      is_followed: false,
    });
  }
  if (path === "/api/v4/members/abc/answers") {
    return json({
      data: [
        {
          id: "124",
          question: { id: "457", title: "另一个问题" },
          author: { id: "abc", url_token: "alice", name: "Alice" },
          excerpt: "回答摘要",
          voteup_count: 1,
          comment_count: 2,
          created_time: 1700000200,
        },
      ],
      paging: { is_end: true },
    });
  }
  if (path === "/api/v4/members/abc/followees") {
    return json({
      data: [
        {
          id: "u3",
          name: "Carol",
          url_token: "carol",
          headline: "设计师",
          follower_count: 2,
        },
      ],
      paging: { is_end: true },
    });
  }
  if (path === "/api/v4/members/abc/followers" && request.method === "POST") {
    following = true;
    return { status: 204, headers: {}, body: "" };
  }
  return {
    status: 404,
    headers: {},
    body: JSON.stringify({ error: { code: 404, message: "not found" } }),
  };
}

const definitions = [];
const sandbox = {
  defineFlareSocialPlugin(definition) {
    definitions.push(definition);
  },
  flare: {
    http: { request: async (request) => route(request) },
    credential: {
      read: async () => ({
        cookies,
        dc0: "dummy",
        xsrf: "xsrf-value",
      }),
      replace: async () => true,
    },
    crypto: {
      randomHex: async (size) => "ab".repeat(size),
      uuid: async () => "00000000-0000-4000-8000-000000000000",
      sha256: async () => "00".repeat(32),
    },
    locale: { current: async () => "zh-Hans" },
    error(value) {
      const error = new Error(value.message?.value || value.message?.fallback || "error");
      error.code = value.code;
      return error;
    },
  },
};

vm.runInNewContext(source, sandbox, { filename: "plugin.js" });
assert.equal(definitions.length, 1, "plugin must register once");
const plugin = definitions[0];

const manifest = JSON.parse(
  await readFile(new URL("../manifest.json", import.meta.url), "utf8"),
);
const services = {
  "flare.datasource.timeline/v1": plugin.capabilities.timeline,
  "flare.datasource.article/v1": plugin.capabilities.article,
  "flare.datasource.profile/v1": plugin.capabilities.profile,
  "flare.datasource.relation/v1": plugin.capabilities.relation,
};
assert.equal(manifest.platform.loginMethods[0].id, "browser");
assert.equal(typeof plugin.login.browser.check, "function");
for (const [capabilityId, declaration] of Object.entries(
  manifest.platform.capabilities,
)) {
  const service = services[capabilityId];
  assert.ok(service, "missing service for " + capabilityId);
  for (const operation of Object.keys(declaration.operations || {})) {
    assert.equal(
      typeof service[operation],
      "function",
      capabilityId + " is missing " + operation,
    );
  }
}
const locale = JSON.parse(
  await readFile(new URL("../locales/zh-Hans.json", import.meta.url), "utf8"),
);
const textKeys = [];
const collectKeys = (value) => {
  if (Array.isArray(value)) {
    value.forEach(collectKeys);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (typeof value.key === "string") textKeys.push(value.key);
  Object.values(value).forEach(collectKeys);
};
collectKeys(manifest);
for (const key of textKeys) {
  assert.equal(typeof locale[key], "string", "missing locale key " + key);
}

assert.equal(
  JSON.stringify(plugin.detector.detect({ origin: "https://www.zhihu.com" }, context)),
  JSON.stringify({
    match: "exact",
    canonicalOrigin: "https://www.zhihu.com",
    software: "Zhihu",
    instance: {
      domain: "www.zhihu.com",
      title: "知乎",
      description: "Zhihu hot list, recommendations and answers",
    },
  }),
);
assert.equal(
  plugin.detector.detect({ origin: "https://example.com" }, context).match,
  "none",
);

const loginContext = { ...context, scope: "login" };
const loginRequest = { methodId: "browser", origin: context.origin, flowId: "flow" };
const loginStart = await plugin.login.browser.begin(loginRequest, loginContext);
const cookieLogin = manifest.platform.loginMethods[0].cookie;
const manifestStartUrl = cookieLogin.startUrl.replace(
  "$accountOrigin",
  loginContext.origin,
);
assert.equal(loginStart.type, "webCookie");
assert.equal(loginStart.startUrl, "https://www.zhihu.com/signin?next=%2F");
assert.equal(loginStart.startUrl, manifestStartUrl);

const login = await plugin.login.browser.check(
  {
    ...loginRequest,
    cookies: {
      cookies: cookieLogin.probes.flatMap((probe) => {
        const sourceUrl = probe.url.replace("$accountOrigin", loginContext.origin);
        return cookies
          .filter((cookie) => probe.cookies.some(({ name }) => name === cookie.name))
          .map((cookie) => ({ ...cookie, sourceUrl }));
      }),
    },
  },
  loginContext,
);
assert.equal(login.type, "success");
assert.equal(login.value.accountId, zhihuUserId);
assert.equal(login.value.profile.key.id, zhihuUserId);
assert.equal(login.value.profile.handle, "alice");
assert.equal(login.value.capabilities["flare.datasource.timeline/v1"][0], "page");

const recommend = await plugin.capabilities.timeline.page(
  {
    timelineId: "recommend",
    page: { direction: "refresh", limit: 20, parameters: {} },
    parameters: {},
  },
  context,
);
assert.equal(recommend.items.length, 1);
assert.equal(recommend.items[0].type, "post");
assert.equal(recommend.items[0].post.key.id, "answer:123");
assert.equal(recommend.items[0].post.detailType, "article");
assert.equal(recommend.items[0].post.author.key.id, "u1");
assert.equal(recommend.items[0].post.media[0].url, "https://pic1.zhimg.com/cover.jpg");
assert.equal(recommend.olderCursor, "https://www.zhihu.com/api/v3/feed/topstory/recommend?limit=20&cursor=next");

const hot = await plugin.capabilities.timeline.page(
  {
    timelineId: "hot",
    page: { direction: "refresh", limit: 20, parameters: {} },
    parameters: {},
  },
  context,
);
assert.equal(hot.items.length, 1);
assert.equal(hot.items[0].post.key.id, "question:999");
assert.equal(hot.items[0].post.detailType, "link");
assert.ok(hot.items[0].post.content.value.includes("#1"));
assert.equal(hot.items[0].post.media[0].url, "https://pic1.zhimg.com/hot.jpg");

const followingTimeline = await plugin.capabilities.timeline.page(
  {
    timelineId: "following",
    page: { direction: "refresh", limit: 20, parameters: {} },
    parameters: {},
  },
  context,
);
assert.equal(followingTimeline.items.length, 1);
assert.equal(followingTimeline.items[0].post.key.id, "answer:321");
assert.equal(
  followingTimeline.items[0].presentation.message.text,
  "Dave 赞同了",
);
assert.equal(
  followingTimeline.items[0].presentation.message.target.type,
  "article",
);

const signedRequest = requests.find((request) =>
  request.url.includes("/api/v3/feed/topstory/recommend"),
);
assert.equal(
  signedRequest.headers["x-zse-96"],
  "2.0_dgGnx1w3jf3iqpSWeQvqbtS7l+Jq/RZz8JnJ=QppJkjXCYRWQ7J8faceQX2cyFTp",
);
assert.equal(signedRequest.headers["x-zse-93"], "101_3_3.0");
assert.equal(JSON.stringify(signedRequest.cookies), JSON.stringify(cookies));
assert.equal("Cookie" in signedRequest.headers, false);

const detail = await plugin.capabilities.article.detail(
  { key: { id: "answer:123", host: "www.zhihu.com" } },
  context,
);
assert.equal(detail.title, "如何评价 Flutter？");
assert.ok(detail.content.value.includes('<img src="https://pic1.zhimg.com/real.jpg"'));
assert.ok(!detail.content.value.includes("<script"));
assert.equal(detail.coverUrl, "https://pic1.zhimg.com/real.jpg");
assert.equal(detail.url, "https://www.zhihu.com/question/456/answer/123");

const articleDetail = await plugin.capabilities.article.detail(
  { key: { id: "article:789", host: "www.zhihu.com" } },
  context,
);
assert.equal(articleDetail.title, "一篇文章");
assert.equal(articleDetail.url, "https://zhuanlan.zhihu.com/p/789");
assert.equal(articleDetail.coverUrl, "https://pic1.zhimg.com/article-cover.jpg");
assert.ok(articleDetail.content.value.includes("https://pic1.zhimg.com/article.jpg"));

const comments = await plugin.capabilities.article.comments(
  {
    key: { id: "answer:123", host: "www.zhihu.com" },
    page: { direction: "refresh", limit: 20, parameters: {} },
  },
  context,
);
assert.equal(comments.items.length, 1);
assert.equal(comments.items[0].post.author.displayName, "Bob");
assert.ok(comments.items[0].post.content.value.includes("回复 @Alice"));
assert.equal(comments.endReached, true);

const profile = await plugin.capabilities.profile.byId(
  { key: { id: "abc", host: "www.zhihu.com" } },
  context,
);
assert.equal(profile.displayName, "Alice");
assert.equal(profile.handle, "alice");
assert.equal(profile.followersCount, 10);
assert.equal(profile.key.id, "abc");

const answers = await plugin.capabilities.profile.timeline(
  {
    profile: { id: "abc", host: "www.zhihu.com" },
    tabId: "answers",
    page: { direction: "refresh", limit: 20, parameters: {} },
    parameters: {},
  },
  context,
);
assert.equal(answers.items.length, 1);
assert.equal(answers.items[0].post.key.id, "answer:124");

const followingPage = await plugin.capabilities.profile.following(
  {
    key: { id: "abc", host: "www.zhihu.com" },
    page: { direction: "refresh", limit: 20, parameters: {} },
  },
  context,
);
assert.equal(followingPage.items.length, 1);
assert.equal(followingPage.items[0].handle, "carol");

const relation = await plugin.capabilities.relation.state(
  { key: { id: "abc", host: "www.zhihu.com" } },
  context,
);
assert.equal(relation.following, false);
assert.equal(relation.followedBy, false);

const mutation = await plugin.capabilities.relation.mutate(
  {
    key: { id: "abc", host: "www.zhihu.com" },
    action: "Follow",
    parameters: {},
  },
  context,
);
assert.equal(mutation.type, "updatedRelation");
assert.equal(mutation.relation.following, true);

console.log("zhihu plugin tests passed");
