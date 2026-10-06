# Devin Search (PI-Desktop plugin)

PI-Desktop 原生插件，移植自 [mimimaster/dsh-devin-search](https://github.com/mimimaster/dsh-devin-search) 的 `pi-devin-search` 扩展（MIT）。**保留了上游的云端多轮规划循环**。

## 贡献项

| 类型 | 名称 | 说明 |
| :--- | :--- | :--- |
| Agent 工具 | `web_search` | 只读的 Devin/Windsurf 云端联网检索（需要先登录）。 |
| Agent 工具 | `code_search` | **云端规划 + 本地只读执行**的代码检索（需要先登录）。 |
| 命令 | `devin-search.open` / `login` / `status` / `logout` | 面板与状态管理。 |
| 面板 | `renderer/index.html` | 登录、状态、web/code 开关；通过 `onPanelInvoke` 调用插件。 |
| 设置 | `webSearch` / `codeSearch` | 布尔开关，即时生效；读取失败时 **fail-closed**（两个都关）。 |

## code_search 的工作方式（与上游一致）

一次 `code_search` 调用内部最多发起 **`SEARCH_TURNS(6) + 2 = 8` 轮云端模型请求**，整体有 **90s deadline**，且同一时刻只允许一个检索在跑（并发调用直接返回 `code_search is busy`）：

1. 本地先枚举工作区（`pi.fs.glob`），应用 **`.gitignore` 过滤**与敏感/依赖/构建路径过滤，把根布局拼进首条用户消息。
2. 每轮云端返回文本，插件解析 `[TOOL_CALLS]`：
   - `restricted_exec`：模型下发结构化只读命令（`rg`/`readfile`/`tree`/`ls`/`glob`，每轮最多 4 条），由本地沙箱执行，结果回灌。
   - `ANSWER`：模型给出文件与行范围，插件再经沙箱**逐条重读校验**后才返回。
   - 第 7、8 轮为强制收尾/纠错。
3. 沙箱本地执行、只读、有界：单文件 ≤512 KiB、单次输出 ≤24 KiB、累计输出 ≤192 KiB、最终片段 ≤48 KiB。

**取消/超时**：工具 `execute(args, ctx)` 会使用宿主传入的 `ctx.signal`；取消或超时后本地循环与云端请求都会中止。

## 登录

1. 面板点击 **开始登录**：插件用 PKCE(S256) 生成授权链接并打开浏览器。
2. 完成授权后复制一次性授权码，粘贴回面板提交。
3. 插件交换会话令牌并写入插件数据目录 `credentials.json`（`0600`，temp+rename+fsync，拒符号链接）。无自动刷新。

## 网络路径（重要）

| 用途 | 通道 | 是否受 `net.domains` 围栏 |
| :--- | :--- | :--- |
| 登录令牌交换 | `pi.net.fetch`（JSON） | 是 |
| `web_search` | `pi.net.fetch`（JSON） | 是 |
| `code_search` 云端补全（`GetUserJwt` / `GetDevstralStream`） | **`node:https`（Connect/protobuf 二进制流）** | 否 |

上游的云端补全是 Connect + protobuf 的**二进制流**，而 PI-Desktop 的 `pi.net.fetch` 只返回文本（`bodyText`）、请求体只接受字符串，无法承载二进制帧。因此 `code_search` 的云端请求改用插件进程内的原生 `node:https`（`lib/cloud.js`）。该路径**不经过宿主的出口审计**——`manifest.net.domains` 对它是"文档性"声明而非强制。其余（登录、`web_search`）仍走受围栏的 `pi.net.fetch`。

## 与上游的对齐情况

**已对齐**：PKCE 参数与授权链接格式、令牌前缀 / 过期策略、`web_search` 双主机容灾与脱敏、`code_search` 的 8 轮循环与全部预算、`.gitignore` 过滤、取消/中止、整体超时、并发互斥、设置 fail-closed、凭据文件加固（0600 / 原子写 / 拒符号链接）。

**仍不对齐**：

- **登录模式**：仅授权码 `code` 模式；上游另有 `loopback`（本地 `127.0.0.1` 回调）。PI-Desktop 无插件网络服务器 API。
- **符号链接防御强度**：沙箱经 `pi.fs.*` 读取，依赖宿主的 realpath 包含校验与保护路径，未做上游那种"逐段 lstat 拒绝 symlink + `O_NOFOLLOW` + 读后 inode 复检"。
- **工具元数据/可见性**：宿主 `registerTool` 只接受 `name/description/risk/schema`，无 `promptSnippet/readOnlyHint/outputSchema/executionMode`，也无 `setActiveTools`/`getAllTools`。因此关闭某工具时它仍对模型可见（仅调用时报错），且无法做上游的工具名冲突检测。
- **命令行 UX**：用面板 + 4 条命令，替代上游的 `/devin-settings`、`/devin-cancel` 与交互选择器。

## 工具结果的自定义 UI

用宿主的 **renderer extension** 接管两个工具的结果卡片：

- `manifest.renderer = "renderer/ui.mjs"`，并声明权限 `renderer.extension`。
- `renderer/ui.mjs` 在**宿主渲染进程内**运行（宿主通过 import map 提供 `react` / `react-dom`），导出 `onLoad(pi)`，用 `pi.slots.register({ slot: "toolCard", toolName, component })` 注册卡片；`toolName` 必须是本插件 `contributes.agentTools` 里的名字。
- `web_search` → 可点击来源列表：标题 / URL / 摘要，每条带「复制」按钮；摘要默认 3 行，较长时按钮显示「展开全文（约 4.0k 字）」，展开后限制 `max-height: 320px` + 内部滚动（全文可读但不撑版面）。
- 所有文字（标题、URL、摘要、代码）都显式设为 `user-select: text`，可正常选中复制（宿主 chip 样式默认 `none`）。
- `code_search` → **默认折叠**：只列「文件 · 段数 · 行数」，点文件行展开；单段代码默认只显示前 12 行，可"展开其余 N 行"（展开后同样限 `max-height: 360px` + 滚动）；卡片头有"全部展开 / 全部收起"。默认不铺代码，避免长结果占满版面。
- 两者都保留"原始输出"回退按钮（切回宿主默认卡片）。
- 工具返回体用 Pi 风格信封（`content` 文本块 + `details` + `structuredContent`）；卡片会递归解包 `structuredContent` / `details` / `content[].text` 各种形态。
- 卡片加载或渲染失败时，宿主会回落到默认卡片。

## 权限

- `ui.panel` — 面板
- `agent.tool.register` — 注册 `web_search` / `code_search`
- `net.fetch`（`api.devin.ai`、`app.devin.ai`、`server.codeium.com`、`server.self-serve.windsurf.com`）— 登录与 `web_search`
- `fs.read`（工作区 `**`）— `code_search` 沙箱
- `shell.openExternal` — 打开 Devin 授权页
- `renderer.extension` — 自定义两个工具的结果卡片（`renderer/ui.mjs`）

## 开发

```bash
pnpm pi-plugin check .
pnpm pi-plugin pack .   # 生成 dist/pi.devin-search-0.1.1.piplug
```

- 插件 id：`pi.devin-search`（数据目录 `…/plugins/data/pi.devin-search/`）。

## License

MIT。第三方协议实现来源见 `NOTICE`。
