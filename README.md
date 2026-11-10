# 知乎 Flare 插件

给 [Flare](https://github.com/DimensionDev/Flare) 用的知乎适配器，基于 Social Plugin API v1。

## 功能

| Flare 能力 | 实现 | 知乎接口 |
| --- | --- | --- |
| `timeline` | 推荐（默认）、热榜、关注动态 | `/api/v3/feed/topstory/recommend`、`/api/v3/feed/topstory/hot-lists/total`、`/api/v3/moments` |
| `article` | 原生阅读回答、文章和想法，查看评论 | `/api/v4/{answers,articles,pins}/{id}`、评论接口 |
| `post` | 问题详情和分页回答列表；回答、文章、想法卡片的赞同与取消 | `/api/v4/questions/{id}`、`/feeds`、各内容的 `/voters` |
| `search` | 搜内容和用户；发现页显示热榜、推荐流作者和热搜词 | `/api/v4/search_v3`、`/api/v4/search/hot_search`、现有信息流 |
| `tabCatalog` | 在「添加标签页」选择自己的知乎收藏夹并浏览 | `/api/v4/people/{handle}/collections`、`/api/v4/collections/{id}/items` |
| `notification` | 查看最近的知乎通知，已知内容目标可在 Flare 中打开 | `/api/v4/notifications/v2/recent` |
| `compose` | 发布公开的纯文字想法；在回答、文章和想法卡片上发表评论 | `/api/v4/content/publish`、`/api/v4/comment_v5/{type}s/{id}/comment` |
| `profile` | 用户资料、回答/文章/想法、关注与粉丝列表 | `/api/v4/members/{id}` 及子资源 |
| `relation` | 关注、取消关注 | `POST /api/v4/members/{id}/followers` |

登录使用 `WebCookie`：在 Flare 内置浏览器打开知乎并登录，Host 收集 `z_c0`、`d_c0` 等 Cookie，再调用 `/api/v4/me` 校验身份。

收藏夹当前支持浏览，发布支持纯文字。知乎原文链接仍可用于查看投票等站点专属内容。

## 安装

### 从 GitHub 安装

在 Flare 的插件管理里填入本仓库地址并点击 **Install**，确认权限后进入添加账号页，输入 `www.zhihu.com`（不用带 `https://`），检测到「知乎」后走浏览器登录。

插件需要 `mediaNetwork` 权限，用于加载知乎头像、封面和正文图片（`pic*.zhimg.com` 等 CDN）。

### 本地开发

Flare Desktop：设置 → 插件 → 右上角菜单 → **Plugin development**，选择本目录（含 `manifest.json`、`plugin.js`、`assets/`）。

```sh
npm install
npm run dev      # 监听 src/plugin.ts，重建根目录 plugin.js
npm run check    # TypeScript 类型检查
npm run build    # 类型检查 + 构建
npm test         # mock Host 的接口/映射测试
npm run package  # 生成 plugin.fpp
```

修改 `plugin.js`、`manifest.json`、`assets/icon.*` 或 `locales/*.json` 后，在 Flare 里点 **Reload plugin**。

## 实现说明

- 所有请求都走 `https://www.zhihu.com`，不需要额外的 `httpOrigins`。
- 知乎 Web 接口需要 `x-zse-93` 和 `x-zse-96` 风控签名。插件在 `plugin.ts` 里实现了纯 JavaScript 的 MD5 + SM4-like 加密，签名输入为 `101_3_3.0 + 请求路径（含查询串）+ d_c0`。
- 请求 Cookie 通过 Host 的结构化 `cookies` 参数传递，不直接设置 `Cookie` 头；`d_c0` 同时保存在 credential 里用于签名。
- 回答、文章和想法使用 Flare 阅读页。问题使用原生详情和回答列表，列表中的回答可以继续打开全文。回答顶部可在知乎网页打开原问题，正文下方评论区的「在 Flare 查看全部回答」可打开原生问题页并翻看其他回答。视频保留原文链接。
- 正文 HTML 会清理 script/style/iframe、事件属性，并把 `data-original` 图片地址提升为 `src`，转成 HTTPS。
- 关注动态来自 `/api/v3/moments`，分组和广告会被展开或跳过；动态条目会带上「谁赞同/回答/关注了」的 `presentation.message`。
- 推荐、热榜和关注动态支持向下翻页。热榜会按榜单顺序展示接口返回的条目。

## 已知限制

- 知乎 Web 接口没有公开文档，属于非官方适配；风控策略或字段变化可能导致请求失败。
- `zse-96` 算法或知乎前端版本变化时需要同步更新签名实现。
- 无 Cookie、伪造 Cookie 或触发风控时，知乎会返回 401/403；插件会提示重新登录或稍后再试。
- 未在真实 Flare 客户端里用真实账号跑过全流程；`npm test` 使用的是 mock Host 和固定响应。

## 发布

仓库根目录提交 `src/`、`manifest.json`、`plugin.js`（已构建）、`assets/`、`locales/`、`package.json`、`package-lock.json`、`tsconfig.json`、`build.mjs`、`test/` 和本 README，然后打与 `manifest.version` 一致的稳定 tag（例如 `v0.1.0`）。Flare 读取 tag 指向的仓库根目录。

```sh
npm run build
git tag v0.1.0
git push origin v0.1.0
```
