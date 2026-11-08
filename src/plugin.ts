const TIMELINE_CAPABILITY = "flare.datasource.timeline/v1";
const ARTICLE_CAPABILITY = "flare.datasource.article/v1";
const PROFILE_CAPABILITY = "flare.datasource.profile/v1";
const RELATION_CAPABILITY = "flare.datasource.relation/v1";

const ZHIHU_HOST = "www.zhihu.com";
const ZHIHU_ORIGIN = "https://www.zhihu.com";
const ZSE93 = "101_3_3.0";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MEMBER_INCLUDE =
  "id,name,url_token,avatar_url,headline,description,cover_url,gender,follower_count,following_count,answer_count,articles_count,is_following,is_followed,user_type";
const ANSWER_DETAIL_INCLUDE =
  "content,excerpt,voteup_count,comment_count,question.title,question.id,author.name,author.url_token,author.avatar_url,author.headline,created_time,updated_time";
const ARTICLE_DETAIL_INCLUDE =
  "content,excerpt,voteup_count,comment_count,author.name,author.url_token,author.avatar_url,author.headline,created,updated,image_url";
const RECOMMEND_PATH = "/api/v3/feed/topstory/recommend";
const PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 20;
const PREVIEW_LENGTH = 240;
const URL_TOKEN_CACHE = new Map<string, string>();

type JsonObject = Record<string, unknown>;
type ZhihuCookie = { name: string; value: string };
type ArticleKind = "answer" | "article";
type ArticleRef = { kind: ArticleKind; id: string };
type AuthState = { cookies: ZhihuCookie[]; dc0: string; xsrf: string };

defineFlareSocialPlugin({
  detector: {
    detect(request) {
      if (request.origin.toLowerCase() !== ZHIHU_ORIGIN) {
        return { match: "none", canonicalOrigin: request.origin };
      }
      return {
        match: "exact",
        canonicalOrigin: request.origin,
        software: "Zhihu",
        instance: {
          domain: ZHIHU_HOST,
          title: "知乎",
          description: "Zhihu hot list, recommendations and answers",
        },
      };
    },
  },
  login: {
    browser: {
      async begin(_request, context) {
        return { type: "webCookie", startUrl: context.origin + "/signin?next=%2F" };
      },
      async check(request, context) {
        const path = "/api/v4/me";
        const probeUrl = context.origin + path;
        const cookies = request.cookies.cookies
          .filter((cookie) => cookie.sourceUrl === probeUrl)
          .map(({ name, value }) => ({ name, value }));
        const auth: AuthState = {
          cookies,
          dc0: cookieValue(cookies, "d_c0"),
          xsrf: cookieValue(cookies, "_xsrf"),
        };
        if (!hasCookie(cookies, "z_c0") || !auth.dc0) {
          return { type: "pending" };
        }
        const response = await hostRequest({
          url: probeUrl,
          cookies,
          headers: signedHeaders(path, auth, false),
        });
        if (response.status === 401 || response.status === 403) {
          return { type: "pending" };
        }
        if (response.status < 200 || response.status >= 300) {
          fail("Remote", "知乎拒绝了登录校验请求");
        }
        const root = parseJsonObject(response.body);
        if (!root || asObject(root.error) || root.user_type === "guest") {
          return { type: "pending" };
        }
        const userId = text(root.id).trim();
        if (!userId) return { type: "pending" };
        const name = text(root.name).trim();
        const urlToken = text(root.url_token).trim();
        return {
          type: "success",
          value: {
            accountId: userId,
            origin: context.origin,
            credential: {
              ...auth,
              userId,
              urlToken,
              userName: name,
              avatarUrl: text(root.avatar_url),
            },
            profile: {
              key: { id: userId, host: accountHost(context) },
              handle: urlToken || name || userId,
              displayName: name || urlToken || userId,
              avatarUrl: normalizeMediaUrl(text(root.avatar_url)),
              url: "https://www.zhihu.com/people/" + encodeURIComponent(urlToken || userId),
            },
            capabilities: {
              [TIMELINE_CAPABILITY]: ["page"],
              [ARTICLE_CAPABILITY]: ["detail", "comments"],
              [PROFILE_CAPABILITY]: [
                "byId",
                "byHandle",
                "timeline",
                "following",
                "followers",
              ],
              [RELATION_CAPABILITY]: ["state", "mutate"],
            },
          },
        };
      },
    },
  },
  capabilities: {
    timeline: {
      async page(request, context) {
        if (request.page.direction === "newer") {
          fail("Unsupported", "知乎时间线不支持更新方向的分页");
        }
        if (request.timelineId === "recommend") {
          return loadRecommend(request.page, context);
        }
        if (request.timelineId === "hot") {
          return loadHot(request.page, context);
        }
        if (request.timelineId === "following") {
          return loadFollowing(request.page, context);
        }
        fail("Unsupported", "未知的知乎时间线：" + request.timelineId);
      },
    },
    article: {
      async detail(request, context) {
        const ref = parseArticleKey(request.key.id);
        if (!ref) fail("NotFound", "无法识别这条知乎内容");
        const path =
          ref.kind === "answer"
            ? "/api/v4/answers/" + encodeURIComponent(ref.id) + "?include=" + ANSWER_DETAIL_INCLUDE
            : "/api/v4/articles/" + encodeURIComponent(ref.id) + "?include=" + ARTICLE_DETAIL_INCLUDE;
        const root = await apiGet(path, context, true);
        if (!root) fail("NotFound", "这条知乎内容不存在或已被删除");
        return mapArticleDetail(ref, root, request.key, context);
      },
      async comments(request, context) {
        const ref = parseArticleKey(request.key.id);
        if (!ref) fail("NotFound", "无法识别这条知乎内容");
        if (request.page.direction === "newer") {
          fail("Unsupported", "知乎评论不支持更新方向的分页");
        }
        const offset = parseOffset(request.page);
        const limit = clampLimit(request.page.limit);
        const plural = ref.kind === "answer" ? "answers" : "articles";
        const path =
          "/api/v4/" +
          plural +
          "/" +
          encodeURIComponent(ref.id) +
          "/comments?limit=" +
          String(limit) +
          "&offset=" +
          String(offset);
        const root = await apiGet(path, context);
        const data = asArray(root.data);
        const items: TimelineItemV1[] = [];
        for (const value of data) {
          const item = mapComment(value, ref, context);
          if (item) items.push({ type: "post", post: item });
        }
        const paging = asObject(root.paging);
        const endReached = boolOr(paging?.is_end, items.length < limit);
        const next =
          nextOffsetFromUrl(paging?.next) ??
          (endReached ? undefined : offset + Math.max(items.length, limit));
        return {
          items,
          olderCursor: endReached || next === undefined ? undefined : String(next),
          endReached,
        };
      },
    },
    profile: {
      async byId(request, context) {
        const member = await fetchMember(request.key.id, context);
        return mapMemberProfile(member, request.key.id, context);
      },
      async byHandle(request, context) {
        const handle = request.handle.trim();
        if (!handle) fail("NotFound", "知乎用户名不能为空");
        const member = await fetchMember(handle, context);
        const id = memberIdOf(member) || handle;
        return mapMemberProfile(member, id, context);
      },
      async timeline(request, context) {
        const tabId = request.tabId || "answers";
        if (tabId !== "answers" && tabId !== "articles" && tabId !== "pins") {
          fail("Unsupported", "未知的知乎个人页标签：" + tabId);
        }
        if (request.page.direction === "newer") {
          fail("Unsupported", "知乎个人页不支持更新方向的分页");
        }
        const offset = parseOffset(request.page);
        const limit = clampLimit(request.page.limit);
        const memberId = await memberSubresourceId(request.profile.id, context);
        const path =
          "/api/v4/members/" +
          encodeURIComponent(memberId) +
          "/" +
          tabId +
          "?offset=" +
          String(offset) +
          "&limit=" +
          String(limit);
        const root = await apiGet(path, context);
        const items: TimelineItemV1[] = [];
        for (const value of asArray(root.data)) {
          const obj = asObject(value);
          if (!obj) continue;
          const post =
            tabId === "answers"
              ? mapAnswerPreview(obj, undefined, context)
              : tabId === "articles"
                ? mapArticlePreview(obj, undefined, context)
                : mapPinPreview(obj, context);
          if (post) items.push({ type: "post", post });
        }
        return pageFromOffset(root, offset, limit, items);
      },
      async following(request, context) {
        return loadPeople(request.key.id, "followees", request.page, context);
      },
      async followers(request, context) {
        return loadPeople(request.key.id, "followers", request.page, context);
      },
    },
    relation: {
      async state(request, context) {
        const member = await fetchMember(request.key.id, context);
        return relationOf(member, request.key);
      },
      async mutate(request, context) {
        if (request.action !== "Follow" && request.action !== "Unfollow") {
          fail("Unsupported", "知乎只支持关注和取消关注");
        }
        const path =
          "/api/v4/members/" + encodeURIComponent(request.key.id) + "/followers";
        const body = request.action === "Follow" ? {} : { _method: "DELETE" };
        await apiPost(path, body, context);
        const member = await fetchMember(request.key.id, context);
        return {
          type: "updatedRelation",
          relation: relationOf(member, request.key),
        };
      },
    },
  },
});

async function loadRecommend(
  page: PageRequestV1,
  context: PluginInvocationContextV1,
): Promise<PageV1<TimelineItemV1>> {
  const limit = clampLimit(page.limit);
  const path =
    page.direction === "older"
      ? recommendPagePath(page.cursor ?? "", limit)
      : RECOMMEND_PATH + "?limit=" + String(limit);
  if (!path) {
    fail("Validation", "推荐流分页游标无效");
  }
  const root = await apiGet(path, context);
  const items = mapFeedItems(asArray(root.data), context).slice(0, limit);
  const paging = asObject(root.paging);
  const next = text(paging?.next).trim();
  const nextPath = recommendPagePath(next, limit);
  const olderCursor =
    paging?.is_end !== true && nextPath && nextPath !== path ? next : undefined;
  return {
    items,
    olderCursor,
    endReached: olderCursor === undefined,
  };
}

function recommendPagePath(cursor: string, limit: number): string | undefined {
  const path = cursor.replace(/^(?:https?:)?\/\/www\.zhihu\.com(?=\/)/i, "");
  if (path.startsWith(RECOMMEND_PATH + "?") && !/[\s#\\]/.test(path)) return path;
  if (!/^[\w.~%+/=-]+$/.test(cursor) || cursor.startsWith("/")) return undefined;
  return RECOMMEND_PATH + "?limit=" + String(limit) + "&cursor=" + encodeURIComponent(cursor);
}

async function loadHot(
  page: PageRequestV1,
  context: PluginInvocationContextV1,
): Promise<PageV1<TimelineItemV1>> {
  let index = parseOffset(page);
  const root = await apiGet(
    "/api/v3/feed/topstory/hot-lists/total?limit=50",
    context,
  );
  const limit = clampLimit(page.limit);
  const items: TimelineItemV1[] = [];
  const data = asArray(root.data);
  for (; index < data.length && items.length < limit; index += 1) {
    const item = mapHotItem(data[index], index + 1, context);
    if (item) items.push({ type: "post", post: item });
  }
  return {
    items,
    olderCursor: index < data.length ? String(index) : undefined,
    endReached: index >= data.length,
  };
}

async function loadFollowing(
  page: PageRequestV1,
  context: PluginInvocationContextV1,
): Promise<PageV1<TimelineItemV1>> {
  const limit = clampLimit(page.limit);
  const offset = page.direction === "older" ? parseCursorOffset(page.cursor) : 0;
  let path = "/api/v3/moments?limit=" + String(limit);
  if (offset > 0) path += "&offset=" + String(offset);
  const root = await apiGet(path, context);
  const items = mapMomentItems(asArray(root.data), context).slice(0, limit);
  const paging = asObject(root.paging);
  const next = nextOffsetFromUrl(paging?.next);
  const endReached = boolOr(paging?.is_end, next === undefined);
  return {
    items,
    olderCursor: endReached || next === undefined ? undefined : String(next),
    endReached,
  };
}

async function loadPeople(
  profileId: string,
  kind: "followees" | "followers",
  page: PageRequestV1,
  context: PluginInvocationContextV1,
): Promise<PageV1<ProfileV1>> {
  if (page.direction === "newer") {
    fail("Unsupported", "知乎关注列表不支持更新方向的分页");
  }
  const offset = parseOffset(page);
  const limit = clampLimit(page.limit);
  const memberId = await memberSubresourceId(profileId, context);
  const path =
    "/api/v4/members/" +
    encodeURIComponent(memberId) +
    "/" +
    kind +
    "?offset=" +
    String(offset) +
    "&limit=" +
    String(limit);
  const root = await apiGet(path, context);
  const items: ProfileV1[] = [];
  for (const value of asArray(root.data)) {
    const member = asObject(value);
    if (!member) continue;
    const id = memberIdOf(member);
    if (!id) continue;
    const profile = mapMemberProfile(member, id, context);
    if (profile) items.push(profile);
  }
  return pageFromOffset(root, offset, limit, items);
}

function pageFromOffset<T>(
  root: JsonObject,
  offset: number,
  limit: number,
  items: T[],
): PageV1<T> {
  const paging = asObject(root.paging);
  const endReached = boolOr(paging?.is_end, items.length < limit);
  const next =
    nextOffsetFromUrl(paging?.next) ??
    (endReached ? undefined : offset + Math.max(items.length, limit));
  return {
    items,
    olderCursor: endReached || next === undefined ? undefined : String(next),
    endReached,
  };
}

function mapFeedItems(
  data: unknown[],
  context: PluginInvocationContextV1,
): TimelineItemV1[] {
  const items: TimelineItemV1[] = [];
  for (const value of data) {
    const entry = asObject(value);
    if (!entry) continue;
    const type = text(entry.type);
    if (type === "feed_advert" || type === "feed_ad") continue;
    if (type === "feed_group") {
      items.push(...mapFeedItems(asArray(entry.list), context));
      continue;
    }
    const children = asArray(entry.children);
    const thumbnail = text(asObject(children[0])?.thumbnail);
    const post = mapFeedTarget(asObject(entry.target), context, thumbnail);
    if (post) items.push({ type: "post", post });
  }
  return items;
}

function mapFeedTarget(
  target: JsonObject | undefined,
  context: PluginInvocationContextV1,
  thumbnail?: string,
): PostV1 | undefined {
  if (!target) return undefined;
  const type = text(target.type);
  if (type === "answer") {
    return mapAnswerPreview(target, thumbnail, context);
  }
  if (type === "article") {
    return mapArticlePreview(target, thumbnail, context);
  }
  if (type === "pin") return mapPinPreview(target, context);
  if (type === "zvideo" || type === "video") {
    return mapVideoPreview(target, context);
  }
  if (type === "question") return mapQuestionPreview(target, context);
  return undefined;
}

function mapAnswerPreview(
  target: JsonObject,
  thumbnail: string | undefined,
  context: PluginInvocationContextV1,
  createdAtOverride?: string,
): PostV1 | undefined {
  const id = text(target.id).trim();
  if (!/^\d+$/.test(id)) return undefined;
  const question = asObject(target.question);
  const questionId = text(question?.id).trim();
  const title = text(question?.title).trim();
  const excerpt = stripTags(
    text(target.excerpt) || text(target.content),
  ).trim();
  const keyId = "answer:" + id;
  return {
    key: { id: keyId, host: accountHost(context) },
    author: mapAuthor(target.author, context),
    createdAt:
      createdAtOverride ??
      isoFromTimestamp(target.created_time ?? target.updated_time) ??
      nowIso(),
    content: {
      format: "html",
      value: titleAndBody(title, excerpt),
    },
    sourceLanguages: zhihuSourceLanguages(title, excerpt),
    media: imageMedia(thumbnail, keyId + "-cover"),
    detailType: "article",
    url: questionId
      ? "https://www.zhihu.com/question/" +
        encodeURIComponent(questionId) +
        "/answer/" +
        encodeURIComponent(id)
      : "https://www.zhihu.com/answer/" + encodeURIComponent(id),
    favouritesCount: numberOrUndefined(target.voteup_count),
    repliesCount: numberOrUndefined(target.comment_count),
  };
}

function mapArticlePreview(
  target: JsonObject,
  thumbnail: string | undefined,
  context: PluginInvocationContextV1,
  createdAtOverride?: string,
): PostV1 | undefined {
  const id = text(target.id).trim();
  if (!/^\d+$/.test(id)) return undefined;
  const title = text(target.title).trim();
  const excerpt = stripTags(
    text(target.excerpt) || text(target.content),
  ).trim();
  const keyId = "article:" + id;
  return {
    key: { id: keyId, host: accountHost(context) },
    author: mapAuthor(target.author, context),
    createdAt:
      createdAtOverride ??
      isoFromTimestamp(
        target.created_time ?? target.created ?? target.updated_time,
      ) ??
      nowIso(),
    content: {
      format: "html",
      value: titleAndBody(title, excerpt),
    },
    sourceLanguages: zhihuSourceLanguages(title, excerpt),
    media:
      imageMedia(thumbnail, keyId + "-cover") ??
      imageMedia(text(target.image_url), keyId + "-cover"),
    detailType: "article",
    url: "https://zhuanlan.zhihu.com/p/" + encodeURIComponent(id),
    favouritesCount: numberOrUndefined(target.voteup_count),
    repliesCount: numberOrUndefined(target.comment_count),
  };
}

function mapPinPreview(
  target: JsonObject,
  context: PluginInvocationContextV1,
): PostV1 | undefined {
  const id = text(target.id).trim();
  if (!id) return undefined;
  const excerpt = pinExcerpt(target);
  const title = text(target.excerpt_title).trim() || (excerpt ? "" : "想法");
  const url = normalizeLinkUrl(text(target.url)) ||
    "https://www.zhihu.com/pin/" + encodeURIComponent(id);
  const keyId = "pin:" + id;
  return {
    key: { id: keyId, host: accountHost(context) },
    author: mapAuthor(target.author, context),
    createdAt:
      isoFromTimestamp(target.created ?? target.created_time) ?? nowIso(),
    content: { format: "html", value: titleAndBody(title, excerpt) },
    sourceLanguages: zhihuSourceLanguages(title, excerpt),
    media: pinMedia(target, keyId),
    detailType: "link",
    url,
    favouritesCount: numberOrUndefined(
      target.like_count ?? target.reaction_count,
    ),
    repliesCount: numberOrUndefined(target.comment_count),
  };
}

function mapQuestionPreview(
  target: JsonObject,
  context: PluginInvocationContextV1,
  hotText?: string,
  rank?: number,
): PostV1 | undefined {
  const id = text(target.id).trim();
  const title = text(target.title).trim();
  if (!id || !title) return undefined;
  const excerpt = stripTags(
    text(target.detail) || text(target.excerpt),
  ).trim();
  const heading = rank === undefined ? title : "#" + String(rank) + " " + title;
  const answerCount = numberOrUndefined(target.answer_count);
  const answerUnit = context.locale.toLowerCase().startsWith("zh")
    ? " 个回答"
    : (answerCount === 1 ? " answer" : " answers");
  const answers = answerCount === undefined ? "" : String(answerCount) + answerUnit;
  const metadata = [hotText, answers].filter(Boolean).join(" · ");
  const body = [metadata, excerpt === title ? "" : excerpt].filter(Boolean).join("\n");
  return {
    key: { id: "question:" + id, host: accountHost(context) },
    createdAt:
      isoFromTimestamp(target.created ?? target.created_time) ?? nowIso(),
    content: {
      format: "html",
      value: titleAndBody(heading, body),
    },
    sourceLanguages: zhihuSourceLanguages(title, excerpt),
    media: imageMedia(text(target.thumbnail), "question:" + id + "-cover"),
    detailType: "link",
    url: "https://www.zhihu.com/question/" + encodeURIComponent(id),
  };
}

function mapVideoPreview(
  target: JsonObject,
  context: PluginInvocationContextV1,
): PostV1 | undefined {
  const id = text(target.id).trim();
  if (!id) return undefined;
  const title = text(target.title).trim();
  const excerpt = stripTags(
    text(target.description) || text(target.excerpt),
  ).trim();
  const url =
    normalizeLinkUrl(text(target.url)) ||
    "https://www.zhihu.com/zvideo/" + encodeURIComponent(id);
  return {
    key: { id: "video:" + id, host: accountHost(context) },
    author: mapAuthor(target.author, context),
    createdAt:
      isoFromTimestamp(
        target.created_time ?? target.created ?? target.updated,
      ) ?? nowIso(),
    content: { format: "html", value: titleAndBody(title, excerpt) },
    sourceLanguages: zhihuSourceLanguages(title, excerpt),
    media: imageMedia(
      text(target.thumbnail) || text(target.cover_url),
      "video:" + id + "-cover",
    ),
    detailType: "link",
    url,
    favouritesCount: numberOrUndefined(
      target.vote_count ?? target.voteup_count,
    ),
    repliesCount: numberOrUndefined(target.comment_count),
  };
}

function mapHotItem(
  value: unknown,
  rank: number,
  context: PluginInvocationContextV1,
): PostV1 | undefined {
  const item = asObject(value);
  if (!item) return undefined;
  const target = asObject(item.target);
  if (!target) return undefined;
  const detail = text(item.detail_text).trim();
  const children = asArray(item.children);
  const firstChild = asObject(children[0]);
  const thumbnail = text(firstChild?.thumbnail) || text(target.thumbnail);
  const post = mapQuestionPreview(
    target,
    context,
    detail,
    rank,
  );
  if (!post) return undefined;
  post.media = imageMedia(thumbnail, "question:" + text(target.id) + "-cover");
  return post;
}

function mapMomentItems(
  data: unknown[],
  context: PluginInvocationContextV1,
): TimelineItemV1[] {
  const items: TimelineItemV1[] = [];
  for (const value of data) {
    const entry = asObject(value);
    if (!entry) continue;
    const type = text(entry.type);
    if (type === "feed_advert" || type === "feed_ad") continue;
    if (type === "feed_group") {
      items.push(...mapMomentItems(asArray(entry.list), context));
      continue;
    }
    const item = mapMoment(entry, context);
    if (item) items.push(item);
  }
  return items;
}

function mapMoment(
  entry: JsonObject,
  context: PluginInvocationContextV1,
): TimelineItemV1 | undefined {
  const target = asObject(entry.target);
  if (!target) return undefined;
  const targetType = text(target.type);
  const targetId = text(target.id).trim();
  if (!targetId) return undefined;
  const createdAt =
    isoFromTimestamp(entry.created_time) ?? nowIso();
  const thumbnail = text(target.thumbnail) || text(target.cover_url);
  let post: PostV1 | undefined;
  if (targetType === "answer") {
    post = mapAnswerPreview(target, thumbnail, context, createdAt);
  } else if (targetType === "article") {
    post = mapArticlePreview(target, thumbnail, context, createdAt);
  } else if (targetType === "pin") {
    post = mapPinPreview(target, context);
  } else if (targetType === "question") {
    post = mapQuestionPreview(target, context);
  } else if (targetType === "zvideo" || targetType === "video") {
    post = mapVideoPreview(target, context);
  }
  if (!post) return undefined;
  post.createdAt = createdAt;

  const verb = text(entry.verb);
  const action = momentAction(verb);
  const actors = asArray(entry.actors);
  const actor = asObject(actors[0]);
  const actorName = text(actor?.name).trim();
  const actorProfile = mapAuthor(actor, context);
  const textParts = [actorName, action].filter(Boolean);
  const message: MessageV1 = {
    key: {
      id: "moment:" + targetType + ":" + targetId + ":" + createdAt,
      host: accountHost(context),
    },
    createdAt,
    actor: actorProfile,
    text: textParts.join(" ") || "关注动态",
    target:
      post.detailType === "article"
        ? { type: "article", key: post.key }
        : post.url
          ? { type: "link", url: post.url }
          : undefined,
  };
  return {
    type: "post",
    post,
    presentation: { message },
  };
}

function momentAction(verb: string): string {
  if (verb.includes("VOTEUP") || verb.includes("VOTE_PIN")) return "赞同了";
  if (verb.includes("ANSWER_QUESTION")) return "回答了";
  if (verb.includes("CREATE_ARTICLE")) return "发表了文章";
  if (verb.includes("CREATE_PIN")) return "发布了想法";
  if (verb.includes("FOLLOW")) return "关注了";
  return verb;
}

function mapArticleDetail(
  ref: ArticleRef,
  root: JsonObject,
  key: EntityKeyV1,
  context: PluginInvocationContextV1,
): ArticleV1 {
  const title =
    ref.kind === "answer"
      ? text(asObject(root.question)?.title).trim() || "知乎回答"
      : text(root.title).trim() || "知乎文章";
  const content = cleanHtml(text(root.content) || text(root.excerpt));
  const coverUrl = normalizeMediaUrl(text(root.image_url));
  const coverInBody = coverUrl !== undefined &&
    content.includes('<img src="' + escapeAttribute(coverUrl) + '"');
  const questionId = text(asObject(root.question)?.id).trim();
  const url =
    ref.kind === "answer"
      ? questionId
        ? "https://www.zhihu.com/question/" +
          encodeURIComponent(questionId) +
          "/answer/" +
          encodeURIComponent(ref.id)
        : "https://www.zhihu.com/answer/" + encodeURIComponent(ref.id)
      : "https://zhuanlan.zhihu.com/p/" + encodeURIComponent(ref.id);
  const createdAt =
    isoFromTimestamp(
      root.created_time ?? root.updated_time ?? root.created ?? root.updated,
    ) ?? nowIso();
  return {
    key,
    title,
    author: mapAuthor(root.author, context),
    createdAt,
    content: { format: "html", value: content },
    url,
    coverUrl: coverInBody ? undefined : coverUrl,
  };
}

function mapComment(
  value: unknown,
  ref: ArticleRef,
  context: PluginInvocationContextV1,
): PostV1 | undefined {
  const comment = asObject(value);
  if (!comment) return undefined;
  const id = text(comment.id).trim();
  if (!id) return undefined;
  const authorObject =
    asObject(asObject(comment.author)?.member) ?? asObject(comment.author);
  const replyTo = text(
    asObject(asObject(comment.reply_to_author)?.member)?.name,
  ).trim();
  const body = cleanHtml(text(comment.content));
  const prefix = replyTo
    ? "<p>回复 @" + escapeHtml(replyTo) + "：</p>"
    : "";
  const url =
    ref.kind === "answer"
      ? "https://www.zhihu.com/answer/" + encodeURIComponent(ref.id)
      : "https://zhuanlan.zhihu.com/p/" + encodeURIComponent(ref.id);
  return {
    key: { id: "comment:" + id, host: accountHost(context) },
    author: mapAuthor(authorObject, context),
    createdAt: isoFromTimestamp(comment.created_time) ?? nowIso(),
    content: { format: "html", value: prefix + body || " " },
    sourceLanguages: zhihuSourceLanguages(stripTags(body)),
    detailType: "link",
    url,
    favouritesCount: numberOrUndefined(comment.vote_count),
  };
}

function mapMemberProfile(
  member: JsonObject,
  keyId: string,
  context: PluginInvocationContextV1,
): ProfileV1 {
  const fallback = text(member.url_token).trim() || keyId;
  const id = keyId || memberIdOf(member) || fallback;
  const handle = text(member.url_token).trim() || id;
  const name = text(member.name).trim() || handle;
  const headline =
    text(member.headline).trim() || text(member.description).trim();
  return {
    key: { id, host: accountHost(context) },
    handle,
    displayName: name,
    avatarUrl: normalizeMediaUrl(text(member.avatar_url)),
    bannerUrl: normalizeMediaUrl(text(member.cover_url)),
    description: headline
      ? { format: "plain", value: headline }
      : undefined,
    url: "https://www.zhihu.com/people/" + encodeURIComponent(handle),
    followersCount: numberOrUndefined(member.follower_count),
    followingCount: numberOrUndefined(member.following_count),
    postsCount: numberOrUndefined(member.answer_count),
    entityToken: handle,
  };
}

function mapAuthor(
  value: unknown,
  context: PluginInvocationContextV1,
): ProfileV1 | undefined {
  const author = asObject(value);
  if (!author) return undefined;
  const id =
    text(author.id).trim() ||
    text(author.url_token).trim();
  if (!id) return undefined;
  const handle = text(author.url_token).trim() || id;
  const name = text(author.name).trim() || handle;
  const headline =
    text(author.headline).trim() || text(author.description).trim();
  return {
    key: { id, host: accountHost(context) },
    handle,
    displayName: name,
    avatarUrl: normalizeMediaUrl(text(author.avatar_url)),
    description: headline
      ? { format: "plain", value: headline }
      : undefined,
    url: "https://www.zhihu.com/people/" + encodeURIComponent(handle),
  };
}

function relationOf(member: JsonObject, key: EntityKeyV1): RelationV1 {
  return {
    profileKey: key,
    following: boolOr(member.is_following, false),
    followedBy: boolOr(member.is_followed, false),
  };
}

async function fetchMember(
  id: string,
  context: PluginInvocationContextV1,
): Promise<JsonObject> {
  const member = await apiGet(
    "/api/v4/members/" +
      encodeURIComponent(id) +
      "?include=" +
      MEMBER_INCLUDE,
    context,
    true,
  );
  if (!member) fail("NotFound", "知乎用户不存在");
  if (!memberIdOf(member)) fail("InvalidResponse", "知乎用户资料不完整");
  return member;
}

async function memberSubresourceId(
  id: string,
  context: PluginInvocationContextV1,
): Promise<string> {
  const cached = URL_TOKEN_CACHE.get(id);
  if (cached) return cached;
  const needsResolution =
    /^\d+$/.test(id) || /^[0-9a-f]{32}$/i.test(id) || /^[0-9a-f-]{36}$/i.test(id);
  if (!needsResolution) {
    URL_TOKEN_CACHE.set(id, id);
    return id;
  }
  try {
    const member = await fetchMember(id, context);
    const token = text(member.url_token).trim() || id;
    URL_TOKEN_CACHE.set(id, token);
    URL_TOKEN_CACHE.set(token, token);
    return token;
  } catch {
    URL_TOKEN_CACHE.set(id, id);
    return id;
  }
}

async function apiGet(
  path: string,
  context: PluginInvocationContextV1,
  allowNotFound = false,
): Promise<JsonObject> {
  const result = await apiRequest("GET", path, undefined, context, allowNotFound);
  if (!result) fail("NotFound", "知乎内容不存在");
  return result;
}

async function apiPost(
  path: string,
  body: JsonObject,
  context: PluginInvocationContextV1,
): Promise<JsonObject> {
  const result = await apiRequest("POST", path, body, context, false);
  if (!result) fail("Remote", "知乎没有返回结果");
  return result;
}

async function apiRequest(
  method: "GET" | "POST",
  path: string,
  body: JsonObject | undefined,
  context: PluginInvocationContextV1,
  allowNotFound: boolean,
): Promise<JsonObject | undefined> {
  const auth = await readAuth();
  const response = await hostRequest({
    method,
    url: context.origin + path,
    cookies: auth.cookies,
    headers: signedHeaders(path, auth, method === "POST"),
    body:
      method === "POST"
        ? { type: "json", value: (body ?? {}) as JsonValue }
        : undefined,
  });
  if (response.status === 401) {
    fail("AuthenticationRequired", "知乎登录已过期，请重新登录");
  }
  if (response.status === 404 && allowNotFound) return undefined;
  if (response.status === 403) {
    fail("Remote", "知乎风控拦截了请求，请稍后再试或重新登录");
  }
  if (response.status < 200 || response.status >= 300) {
    fail("Remote", "知乎接口返回错误（" + String(response.status) + "）");
  }
  if (response.status === 204 || !response.body.trim()) {
    if (method === "POST") return {};
    fail("InvalidResponse", "知乎没有返回内容");
  }
  const root = parseJsonObject(response.body);
  if (!root) fail("InvalidResponse", "知乎没有返回 JSON");
  const error = asObject(root.error);
  if (error) {
    const message = text(error.message);
    if (text(error.code) === "101" || /未经过验证|登录/.test(message)) {
      fail("AuthenticationRequired", "知乎登录已过期，请重新登录");
    }
    fail("Remote", message || "知乎接口返回错误");
  }
  return root;
}

async function readAuth(): Promise<AuthState> {
  const stored = asObject(await flare.credential.read());
  if (!stored) fail("AuthenticationRequired", "请先登录知乎");
  const cookies = parseStoredCookies(stored.cookies);
  if (!hasCookie(cookies, "z_c0")) {
    fail("AuthenticationRequired", "知乎登录已过期，请重新登录");
  }
  const dc0 = text(stored.dc0) || cookieValue(cookies, "d_c0");
  if (!dc0) {
    fail("AuthenticationRequired", "知乎登录缺少 d_c0，请重新登录");
  }
  const xsrf =
    text(stored.xsrf) ||
    cookieValue(cookies, "_xsrf") ||
    cookieValue(cookies, "xsrf");
  const userId = text(stored.userId).trim();
  const urlToken = text(stored.urlToken).trim();
  if (userId && urlToken) {
    URL_TOKEN_CACHE.set(userId, urlToken);
    URL_TOKEN_CACHE.set(urlToken, urlToken);
  }
  return { cookies, dc0, xsrf };
}

function parseStoredCookies(value: unknown): ZhihuCookie[] {
  const list = Array.isArray(value) ? value : [];
  const cookies: ZhihuCookie[] = [];
  for (const entry of list) {
    const cookie = asObject(entry);
    if (!cookie) continue;
    const name = text(cookie.name);
    const content = text(cookie.value);
    if (name && content) cookies.push({ name, value: content });
  }
  return cookies;
}

function signedHeaders(
  path: string,
  auth: AuthState,
  post: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    Referer: ZHIHU_ORIGIN + "/",
    "User-Agent": USER_AGENT,
    "x-requested-with": "fetch",
    "x-zse-93": ZSE93,
    "x-zse-96": "2.0_" + encryptZseV4(md5Hex(ZSE93 + "+" + path + "+" + auth.dc0)),
  };
  if (auth.xsrf) headers["x-xsrftoken"] = auth.xsrf;
  if (post) headers["Content-Type"] = "application/json";
  return headers;
}

async function hostRequest(request: HttpRequestV1): Promise<HttpResponseV1> {
  try {
    return await flare.http.request(request);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      const code = (error as { code?: unknown }).code;
      if (code === "host.unavailable") {
        fail("Network", "网络请求失败");
      }
    }
    throw error;
  }
}

function parseArticleKey(id: string): ArticleRef | undefined {
  const match = /^(answer|article):(\d+)$/.exec(id);
  if (!match) return undefined;
  return { kind: match[1] as ArticleKind, id: match[2] };
}

function parseOffset(page: PageRequestV1): number {
  if (page.direction === "refresh") return 0;
  const cursor = page.cursor;
  if (!cursor || !/^\d+$/.test(cursor)) {
    fail("Validation", "分页游标无效");
  }
  const value = Number(cursor);
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("Validation", "分页游标无效");
  }
  return value;
}

function parseCursorOffset(cursor: string | undefined): number {
  if (!cursor) fail("Validation", "分页游标无效");
  if (!/^\d+$/.test(cursor)) fail("Validation", "分页游标无效");
  const value = Number(cursor);
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("Validation", "分页游标无效");
  }
  return value;
}

function nextOffsetFromUrl(value: unknown): number | undefined {
  const raw = text(value).trim();
  if (!raw) return undefined;
  const match = /[?&]offset=([^&]+)/.exec(raw);
  if (match) {
    const decoded = decodeURIComponent(match[1]);
    if (/^\d+$/.test(decoded)) {
      const parsed = Number(decoded);
      if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
    }
    return undefined;
  }
  if (/^\d+$/.test(raw)) {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value)) return PAGE_SIZE;
  return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(value)));
}

function titleAndBody(title: string, body: string): string {
  const parts: string[] = [];
  if (title) parts.push("<b>" + escapeHtml(title) + "</b>");
  if (body && body !== title) {
    const characters = Array.from(body);
    const preview =
      characters.length > PREVIEW_LENGTH
        ? characters.slice(0, PREVIEW_LENGTH).join("").trimEnd() + "…"
        : body;
    parts.push(escapeHtml(preview).replace(/\n/g, "<br/>"));
  }
  return parts.join("<br/>") || " ";
}

function pinExcerpt(target: JsonObject): string {
  const parts: string[] = [];
  for (const value of asArray(target.content)) {
    const item = asObject(value);
    if (!item) continue;
    const content = stripTags(text(item.content)).trim();
    if (content) parts.push(content);
  }
  const textValue = parts.join(" ").trim();
  return textValue || stripTags(text(target.excerpt_title)).trim();
}

function pinMedia(target: JsonObject, keyId: string): MediaV1[] | undefined {
  const urls: string[] = [];
  for (const value of asArray(target.content)) {
    const item = asObject(value);
    if (!item) continue;
    const direct = normalizeMediaUrl(text(item.image_url));
    if (direct) urls.push(direct);
    for (const nested of asArray(item.image_urls)) {
      const url = normalizeMediaUrl(text(nested));
      if (url) urls.push(url);
    }
  }
  const unique: string[] = [];
  for (const url of urls) {
    if (!unique.includes(url)) unique.push(url);
    if (unique.length >= 9) break;
  }
  return unique.length
    ? unique.map((url, index) => ({
        id: keyId + "-" + String(index),
        type: "image" as const,
        url,
      }))
    : undefined;
}

function imageMedia(
  value: string | undefined,
  id: string,
): MediaV1[] | undefined {
  const url = normalizeMediaUrl(value || "");
  return url ? [{ id, type: "image", url }] : undefined;
}

function cleanHtml(value: string): string {
  let html = value
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "");
  html = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const source =
      attribute(tag, "data-original") ||
      attribute(tag, "data-actualsrc") ||
      attribute(tag, "src");
    const alt = attribute(tag, "alt");
    const url = normalizeMediaUrl(source);
    if (!url) return "";
    const altAttribute = alt
      ? ' alt="' + escapeAttribute(decodeEntities(alt)) + '"'
      : "";
    return '<img src="' + escapeAttribute(url) + '"' + altAttribute + " />";
  });
  html = html
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "");
  html = html.replace(/(src|href)=(["'])\/\//gi, "$1=$2https://");
  html = html.replace(/(src|href)=(["'])http:\/\//gi, "$1=$2https://");
  html = html.replace(
    /href="https:\/\/link\.zhihu\.com\/\?target=([^"]+)"/gi,
    (original, target: string) => {
      try {
        return 'href="' + escapeAttribute(decodeURIComponent(decodeEntities(target))) + '"';
      } catch {
        return original;
      }
    },
  );
  return html.trim() || " ";
}

function attribute(tag: string, name: string): string {
  const pattern = new RegExp("\\b" + name + "\\s*=\\s*([\"'])([\\s\\S]*?)\\1", "i");
  const match = pattern.exec(tag);
  return match ? match[2] : "";
}

function normalizeMediaUrl(value: string): string | undefined {
  let url = decodeEntities(value).trim();
  if (!url || /^data:/i.test(url) || /^javascript:/i.test(url)) {
    return undefined;
  }
  if (url.startsWith("//")) url = "https:" + url;
  url = url.replace(/^http:\/\//i, "https://");
  return /^https:\/\/[^\s]+$/i.test(url) ? url : undefined;
}

function normalizeLinkUrl(value: string): string | undefined {
  return normalizeMediaUrl(value);
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");
}

function zhihuSourceLanguages(...parts: string[]): string[] | undefined {
  const prose = parts.map((part) => part.replace(/(?:https?:\/\/|www\.)\S+/gi, ""));
  const combined = prose.join(" ");
  if (!/\p{Script=Han}/u.test(combined)) return undefined;
  if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(combined)) {
    return undefined;
  }

  // Check the excerpt separately so a Chinese question title cannot hide a foreign answer.
  for (const part of prose) {
    const hanCount = part.match(/\p{Script=Han}/gu)?.length ?? 0;
    const foreignWords = part.replace(/\p{Script=Han}/gu, " ").match(/\p{L}+/gu)?.length ?? 0;
    if (foreignWords >= 2 && foreignWords * 2 > hanCount) return undefined;
  }

  // Use common script-specific forms. Shared Han characters follow Zhihu's Simplified default.
  const simplified = /[与为书买亲们众会体写动发变听问国图场实对学应开当总戏战报换数时术机条样汉没测湾点现环画种简经网线号视计评语说读课车转这过还进选长门闭间队际难电风马验龙]/u;
  const traditional = /[與為書買親們眾會體寫動發變聽問國圖場實對學應開當總戲戰報換數時術機條樣漢沒測灣點現環畫種簡經網線號視計評語說讀課車轉這過還進選長門閉間隊際難電風馬驗龍個熱頁關]/u;
  if (!traditional.test(combined)) return ["zh-Hans"];
  return simplified.test(combined) ? undefined : ["zh-Hant"];
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

function memberIdOf(member: JsonObject): string {
  return text(member.id).trim() || text(member.url_token).trim();
}

function hasCookie(cookies: ZhihuCookie[], name: string): boolean {
  return cookies.some(
    (cookie) => cookie.name === name && cookie.value.length > 0,
  );
}

function cookieValue(cookies: ZhihuCookie[], name: string): string {
  const found = cookies.find((cookie) => cookie.name === name);
  return found ? found.value : "";
}

function parseJsonObject(body: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    return asObject(parsed);
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function numberOrUndefined(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  if (value === true || value === 1 || value === "1" || value === "true") {
    return true;
  }
  if (value === false || value === 0 || value === "0" || value === "false") {
    return false;
  }
  return fallback;
}

function isoFromTimestamp(value: unknown): string | undefined {
  const raw =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isFinite(raw) || raw <= 0) return undefined;
  const milliseconds = raw > 1e12 ? raw : raw * 1000;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

function accountHost(context: PluginInvocationContextV1): string {
  return context.origin.slice("https://".length);
}

function fail(code: PluginErrorCodeV1, message: string): never {
  throw flare.error({ code, message: { value: message } });
}

function encryptZseV4(input: string): string {
  const inputBytes = utf8Bytes(input);
  const plain = new Uint8Array(2 + inputBytes.length);
  plain[0] = 210;
  plain[1] = 0;
  plain.set(inputBytes, 2);
  const pad = 16 - (plain.length % 16);
  const padded = new Uint8Array(plain.length + pad);
  padded.set(plain);
  padded.fill(pad, plain.length);
  const first = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    first[index] = padded[index] ^ KEY16[index] ^ 42;
  }
  let previous = rBlock(first);
  const cipher = new Uint8Array(padded.length);
  cipher.set(previous, 0);
  for (let offset = 16; offset < padded.length; offset += 16) {
    const block = new Uint8Array(16);
    for (let index = 0; index < 16; index += 1) {
      block[index] = padded[offset + index] ^ previous[index];
    }
    previous = rBlock(block);
    cipher.set(previous, offset);
  }
  return customEncode(cipher);
}

const ZSE_ZB = [
  20, 223, 245, 7, 248, 2, 194, 209, 87, 6, 227, 253, 240, 128, 222, 91, 237,
  9, 125, 157, 230, 93, 252, 205, 90, 79, 144, 199, 159, 197, 186, 167, 39, 37,
  156, 198, 38, 42, 43, 168, 217, 153, 15, 103, 80, 189, 71, 191, 97, 84, 247,
  95, 36, 69, 14, 35, 12, 171, 28, 114, 178, 148, 86, 182, 32, 83, 158, 109, 22,
  255, 94, 238, 151, 85, 77, 124, 254, 18, 4, 26, 123, 176, 232, 193, 131, 172,
  143, 142, 150, 30, 10, 146, 162, 62, 224, 218, 196, 229, 1, 192, 213, 27, 110,
  56, 231, 180, 138, 107, 242, 187, 54, 120, 19, 44, 117, 228, 215, 203, 53,
  239, 251, 127, 81, 11, 133, 96, 204, 132, 41, 115, 73, 55, 249, 147, 102, 48,
  122, 145, 106, 118, 74, 190, 29, 16, 174, 5, 177, 129, 63, 113, 99, 31, 161,
  76, 246, 34, 211, 13, 60, 68, 207, 160, 65, 111, 82, 165, 67, 169, 225, 57,
  112, 244, 155, 51, 236, 200, 233, 58, 61, 47, 100, 137, 185, 64, 17, 70, 234,
  163, 219, 108, 170, 166, 59, 149, 52, 105, 24, 212, 78, 173, 45, 0, 116, 226,
  119, 136, 206, 135, 175, 195, 25, 92, 121, 208, 126, 139, 3, 75, 141, 21, 130,
  98, 241, 40, 154, 66, 184, 49, 181, 46, 243, 88, 101, 183, 8, 23, 72, 188,
  104, 179, 210, 134, 250, 201, 164, 89, 216, 202, 220, 50, 221, 152, 140, 33,
  235, 214,
];

const ZSE_ZK = [
  1170614578, 1024848638, 1413669199, 3951632832, 3528873006, 2921909214,
  4151847688, 3997739139, 1933479194, 3323781115, 3888513386, 460404854,
  3747539722, 2403641034, 2615871395, 2119585428, 2265697227, 2035090028,
  2773447226, 4289380121, 4217216195, 2200601443, 3051914490, 1579901135,
  1321810770, 456816404, 2903323407, 4065664991, 330002838, 3506006750,
  363569021, 2347096187,
];

const ZSE_ALPHABET =
  "6fpLRqJO8M/c3jnYxFkUVC4ZIG12SiH=5v0mXDazWBTsuw7QetbKdoPyAl+hN9rgE";
const KEY16 = new Uint8Array([
  0x30, 0x35, 0x39, 0x30, 0x35, 0x33, 0x66, 0x37, 0x64, 0x31, 0x35, 0x65,
  0x30, 0x31, 0x64, 0x37,
]);

function rotateLeft(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function zseG(tt: number): number {
  const ti =
    ((ZSE_ZB[(tt >>> 24) & 255] << 24) |
      (ZSE_ZB[(tt >>> 16) & 255] << 16) |
      (ZSE_ZB[(tt >>> 8) & 255] << 8) |
      ZSE_ZB[tt & 255]) >>>
    0;
  return (
    ti ^
    rotateLeft(ti, 2) ^
    rotateLeft(ti, 10) ^
    rotateLeft(ti, 18) ^
    rotateLeft(ti, 24)
  ) >>> 0;
}

function rBlock(input: Uint8Array): Uint8Array {
  const tr = new Array<number>(36);
  for (let index = 0; index < 4; index += 1) {
    tr[index] = readU32Be(input, index * 4);
  }
  for (let index = 0; index < 32; index += 1) {
    tr[index + 4] =
      (tr[index] ^
        zseG((tr[index + 1] ^ tr[index + 2] ^ tr[index + 3] ^ ZSE_ZK[index]) >>> 0)) >>>
      0;
  }
  const output = new Uint8Array(16);
  writeU32Be(tr[35], output, 0);
  writeU32Be(tr[34], output, 4);
  writeU32Be(tr[33], output, 8);
  writeU32Be(tr[32], output, 12);
  return output;
}

function customEncode(bytesIn: Uint8Array): string {
  let bytes = bytesIn;
  const remainder = bytes.length % 3;
  if (remainder !== 0) {
    const padded = new Uint8Array(bytes.length + (3 - remainder));
    padded.set(bytes);
    bytes = padded;
  }
  let output = "";
  let index = 0;
  for (let position = bytes.length - 1; position >= 0; position -= 3) {
    let value = 0;
    const mask0 = (58 >>> (8 * (index % 4))) & 255;
    index += 1;
    value |= (bytes[position] ^ mask0) & 255;
    const mask1 = (58 >>> (8 * (index % 4))) & 255;
    index += 1;
    value |= ((bytes[position - 1] ^ mask1) & 255) << 8;
    const mask2 = (58 >>> (8 * (index % 4))) & 255;
    index += 1;
    value |= ((bytes[position - 2] ^ mask2) & 255) << 16;
    output += ZSE_ALPHABET[value & 63];
    output += ZSE_ALPHABET[(value >>> 6) & 63];
    output += ZSE_ALPHABET[(value >>> 12) & 63];
    output += ZSE_ALPHABET[(value >>> 18) & 63];
  }
  return output;
}

function readU32Be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function writeU32Be(value: number, bytes: Uint8Array, offset: number): void {
  bytes[offset] = (value >>> 24) & 255;
  bytes[offset + 1] = (value >>> 16) & 255;
  bytes[offset + 2] = (value >>> 8) & 255;
  bytes[offset + 3] = value & 255;
}

function md5Hex(value: string): string {
  const message = utf8Bytes(value);
  const bitLengthLow = (message.length << 3) >>> 0;
  const bitLengthHigh = Math.floor(message.length / 536870912) >>> 0;
  const paddedLength = (Math.floor((message.length + 8) / 64) + 1) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;
  for (let index = 0; index < 4; index += 1) {
    padded[paddedLength - 8 + index] = (bitLengthLow >>> (8 * index)) & 255;
    padded[paddedLength - 4 + index] = (bitLengthHigh >>> (8 * index)) & 255;
  }
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const words = new Array<number>(16);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const wordOffset = offset + index * 4;
      words[index] =
        padded[wordOffset] |
        (padded[wordOffset + 1] << 8) |
        (padded[wordOffset + 2] << 16) |
        (padded[wordOffset + 3] << 24);
    }
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let index = 0; index < 64; index += 1) {
      let f: number;
      let g: number;
      if (index < 16) {
        f = (b & c) | (~b & d);
        g = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        g = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        g = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * index) % 16;
      }
      const nextD = c;
      c = b;
      b = (b + rotateLeft((a + f + MD5_K[index] + words[g]) >>> 0, MD5_S[index])) >>> 0;
      a = d;
      d = nextD;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  return (
    littleEndianHex(a0) +
    littleEndianHex(b0) +
    littleEndianHex(c0) +
    littleEndianHex(d0)
  );
}

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
  9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
  16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10,
  15, 21,
];

const MD5_K = (() => {
  const table = new Array<number>(64);
  for (let index = 0; index < 64; index += 1) {
    table[index] = Math.floor(
      Math.abs(Math.sin(index + 1)) * 4294967296,
    ) >>> 0;
  }
  return table;
})();

function littleEndianHex(value: number): string {
  const bytes = [
    value & 255,
    (value >>> 8) & 255,
    (value >>> 16) & 255,
    (value >>> 24) & 255,
  ];
  let output = "";
  for (const byte of bytes) {
    output += HEX[byte >>> 4] + HEX[byte & 15];
  }
  return output;
}

const HEX = "0123456789abcdef";

function utf8Bytes(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    let code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        index += 1;
      }
    }
    if (code <= 0x7f) {
      bytes.push(code);
    } else if (code <= 0x7ff) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code <= 0xffff) {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}
