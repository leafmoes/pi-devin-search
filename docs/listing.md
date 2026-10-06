# Marketplace listing copy / 商店上架文案

Fill-in text for the plugin listing form. Author and License are already in
`manifest.json`; everything else here is written to be pasted field by field.

> 上架表单的填写文案。`Author` / `License` 已在 `manifest.json` 里（`leafmoes` / `MIT`），其余字段可直接复制。

---

## Name

```
Devin Search
```

## Chinese name / 中文名

```
Devin 搜索
```

## Description

```
Devin-powered search for PI-Desktop. web_search returns live web sources with title, URL and
snippet. code_search plans a multi-turn search in the Devin cloud, then runs bounded read-only
commands inside your workspace (directory listing, ripgrep, read) and returns the file ranges it
re-read and verified, together with the code. Every result renders as a card: files with
expandable line ranges, sources with copy buttons. Requires a Devin/Windsurf account.
```

## Chinese description / 中文描述

```
为 PI-Desktop 加入 Devin 搜索能力。web_search 返回带标题、链接、摘要的实时网页来源；code_search
先在 Devin 云端做多轮规划，再在工作区内执行有界只读命令（列目录、ripgrep、读文件），并把逐条重读
校验过的文件与行范围连同代码一起返回。结果以卡片呈现：文件按行范围展开看代码，来源可一键复制。
需要 Devin/Windsurf 账号。
```

## Author

```
leafmoes
```

## License

```
MIT
```

## Categories

```
devtools, web, productivity
```

PI-Desktop 自身的目录词表为 `devtools` / `web` / `docs` / `data` / `productivity`；
若不允许多选，优先 `devtools`。

## Homepage

```
https://github.com/leafmoes/pi-devin-search
```

## Documentation

```
https://github.com/leafmoes/pi-devin-search/blob/main/README.md
```

## Safety notes

```
Network-connected plugin that sends your search to the Devin cloud. Read before installing.

1. Account: it needs a Devin/Windsurf sign-in (OAuth PKCE; the one-time code is pasted back into
   the plugin panel). The session token is stored only on this machine, in PI-Desktop's plugin
   data directory (credentials.json, mode 0600). It is never written to settings and never enters
   the model context. There is no auto-refresh; the token is discarded on 401/403 and
   "Devin Search: 退出登录" deletes it.

2. Data leaves the machine: your search query, the workspace root layout, and the code snippets
   returned by local read-only commands are sent to the Devin cloud (server.codeium.com,
   server.self-serve.windsurf.com). Do not use code_search on a repository whose code you are not
   allowed to send to that service.

3. Local reads are read-only and bounded: code_search reads only inside the current workspace
   (fs.read scope **), honors .gitignore and skips sensitive/dependency/build paths, and caps each
   file at 512 KiB, each command output at 24 KiB, the run at 192 KiB, and the returned snippets at
   48 KiB. It spawns no processes at all - rg/glob/ls/tree are implemented over the host's read-only
   fs API - and never writes or deletes. One search runs at a time (concurrent calls are rejected)
   and the whole call has a 90 s deadline.

4. Permission scope: login and web_search go through the host net.fetch allowlist
   (api.devin.ai, app.devin.ai, server.codeium.com, server.self-serve.windsurf.com). The
   code_search cloud stream uses node:https instead, because the host fetch API cannot carry
   Connect/protobuf binary frames - that stream is therefore NOT covered by manifest.net.domains.

5. Requested permissions: agent.tool.register and net.fetch (high risk), fs.read (workspace),
   ui.panel, shell.openExternal (opens the login URL in your browser), renderer.extension (custom
   result cards). No background service, no process spawning, no write/delete capability.
```

## Chinese safety notes / 安全说明（中文）

```
联网插件，检索内容会发送到 Devin 云端，安装前请阅读。

1. 账号：需要登录 Devin/Windsurf（OAuth PKCE，一次性授权码粘回插件面板）。会话令牌只保存在本机
   PI-Desktop 的插件数据目录（credentials.json，权限 0600），不写入设置，也不进入模型上下文。
   不会自动刷新；遇到 401/403 会作废，「Devin Search: 退出登录」会删除本地凭据。

2. 数据出网：检索词、工作区根目录结构、以及本地只读命令命中的代码片段会上传到 Devin 云端
   （server.codeium.com、server.self-serve.windsurf.com）。不要在无权外传代码的仓库上使用
   code_search。

3. 本地只读且有界：code_search 只在当前工作区内读取（fs.read 范围 **），遵守 .gitignore 并跳过
   敏感/依赖/构建路径；单文件 512 KiB、单次命令输出 24 KiB、单次运行 192 KiB、最终片段 48 KiB
   为上限。不启动任何子进程（rg/glob/ls/tree 都基于宿主只读 fs API 实现），也不写入、不删除文件。
   同一时刻只允许一个检索，整体 90 秒超时。

4. 权限范围：登录与 web_search 走宿主的 net.fetch 白名单（api.devin.ai、app.devin.ai、
   server.codeium.com、server.self-serve.windsurf.com）；code_search 的云端流改用 node:https
   （宿主 fetch 无法承载 Connect/protobuf 二进制帧），因此该通道不受 manifest.net.domains 约束。

5. 申请的权限：agent.tool.register、net.fetch（高危），fs.read（工作区），ui.panel，
   shell.openExternal（在浏览器打开登录链接），renderer.extension（自定义结果卡片）。
   无常驻服务、不启动任何子进程、无写入/删除能力。
```

---

## 上架检查清单

- [x] 仓库公开：https://github.com/leafmoes/pi-devin-search
- [x] MIT LICENSE（含上游归属）与 NOTICE
- [x] README 说明贡献项、登录流程、网络路径与 `node:https` 例外
- [x] Release v0.1.1 附带可安装的 `pi.devin-search-0.1.1.piplug`
- [ ] 表单字段按本文件填写
