"use strict";

/**
 * Devin Search — PI-Desktop plugin entry point.
 *
 * Port of the `pi-devin-search` extension from mimimaster/dsh-devin-search (MIT).
 *
 * Contributions
 * - agent tools : web_search (Devin cloud JSON), code_search (cloud planning + local sandbox)
 * - commands    : devin-search.open / login / status / logout
 * - panel       : renderer/index.html (login + status + toggles, via onPanelInvoke)
 * - settings    : webSearch / codeSearch booleans
 *
 * Network paths
 * - login token exchange and web_search use the fenced host API `pi.net.fetch`
 *   (JSON only, constrained by `manifest.net.domains`).
 * - code_search's cloud completion uses the Connect/protobuf stream, which needs
 *   binary bodies that `pi.net.fetch` cannot carry; that path uses node:https in
 *   lib/cloud.js. Its local file access still goes through `pi.fs.*`.
 *
 * Credentials live in `<plugin data dir>/credentials.json` (mode 0600) and are
 * never written to plugin settings or model context.
 *
 * Permissions: ui.panel, agent.tool.register, net.fetch, fs.read, shell.openExternal
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const manifest = require("./manifest.json");
const {
  DevinError,
  fail,
  safeError,
  toDevinSessionToken,
  expiry,
  redact,
  check,
  deadline,
} = require("./lib/core");
const { WindsurfCompletion } = require("./lib/cloud");
const { runCodeSearch } = require("./lib/code-search");

const WEB_TOOL = "web_search";
const CODE_TOOL = "code_search";

const EXPIRY_TIME_MIN = -8640000000000000;
const EXPIRY_TIME_MAX = 8640000000000000;

const WEB_PATH = "/exa.api_server_pb.ApiServerService/GetWebSearchResults";
const WEB_HOSTS = ["https://server.codeium.com", "https://server.self-serve.windsurf.com"];
const WEB_TIMEOUT_MS = 20000;

const AUTH_BASE = "https://app.devin.ai/auth/cli/continue";
const TOKEN_URL = "https://api.devin.ai/auth/cli/token";
const LOGIN_TIMEOUT_MS = 300000;

const CREDENTIAL_FILE = "credentials.json";
const MAX_GRANT_BYTES = 64 * 1024;

/* ---------------------------------------------------------- credential store */

async function credentialFile() {
  const dir = await pi.plugin.getDataPath();
  if (typeof dir !== "string" || !dir) fail("storage", "无法获取插件数据目录。");
  fs.mkdirSync(dir, { recursive: true });
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("storage", "插件数据目录不安全。");
  return path.join(dir, CREDENTIAL_FILE);
}

function normalizeGrant(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (value.version !== 1) return undefined;
  if (typeof value.token !== "string" || !value.token || value.token.length > 16384) return undefined;
  if (/[\s\x00-\x1f\x7f]/.test(value.token)) return undefined;
  if (typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt)) return undefined;
  if (value.expiresAt < EXPIRY_TIME_MIN || value.expiresAt > EXPIRY_TIME_MAX) return undefined;
  if (value.expirySource !== "jwt" && value.expirySource !== "fallback") return undefined;
  return {
    version: 1,
    token: value.token,
    expiresAt: value.expiresAt,
    expirySource: value.expirySource,
    ...(value.revoked === true ? { revoked: true } : {}),
  };
}

async function readGrant() {
  let file;
  try {
    file = await credentialFile();
  } catch {
    return undefined;
  }
  let text;
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_GRANT_BYTES) return undefined;
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    return normalizeGrant(JSON.parse(text));
  } catch {
    return undefined;
  }
}

async function writeGrant(grant) {
  const file = await credentialFile();
  let dest;
  try { dest = fs.lstatSync(file); } catch { /* absent */ }
  if (dest && (dest.isSymbolicLink() || !dest.isFile())) fail("storage", "Devin 凭据路径不安全。");
  const temp = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let handle;
  try {
    handle = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
    fs.writeFileSync(handle, JSON.stringify(grant));
    fs.fsyncSync(handle);
  } catch (error) {
    if (handle !== undefined) { try { fs.closeSync(handle); } catch { /* ignore */ } }
    try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
    throw error;
  }
  try { fs.closeSync(handle); } catch { /* ignore */ }
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
    throw error;
  }
  try { fs.chmodSync(file, 0o600); } catch { /* best effort on Windows */ }
  if (process.platform !== "win32") {
    try {
      const dirHandle = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
      try { fs.fsyncSync(dirHandle); } finally { fs.closeSync(dirHandle); }
    } catch { /* best effort */ }
  }
}

async function clearGrant() {
  try {
    const file = await credentialFile();
    fs.rmSync(file, { force: true });
  } catch {
    /* nothing stored */
  }
}

function grantAvailable(grant) {
  return !!grant && !grant.revoked && grant.expiresAt > Date.now();
}

function statusText(grant) {
  if (!grant) return "未登录。请在 Devin Search 面板中登录。";
  if (grant.revoked) return "会话已被提供商拒绝；请重新登录。";
  const when = new Date(grant.expiresAt).toISOString();
  return grantAvailable(grant)
    ? `已登录。到期时间 ${when}（${grant.expirySource}，无自动刷新）。`
    : `会话已过期；请重新登录。到期时间 ${when}（${grant.expirySource}，无自动刷新）。`;
}

/* ---------------------------------------------------------------- settings */

async function readSettings() {
  try {
    const value = await pi.plugin.getSettings();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { webSearch: false, codeSearch: false };
    }
    return value;
  } catch {
    // Fail closed: an unreadable settings store disables both tools (matches upstream).
    return { webSearch: false, codeSearch: false };
  }
}

/* ------------------------------------------------------------------- net */

async function netFetch(url, { method = "GET", headers, body, timeoutMs = WEB_TIMEOUT_MS } = {}) {
  let response;
  try {
    response = await pi.net.fetch({
      url,
      method,
      headers,
      body: typeof body === "string" ? body : body === undefined ? undefined : JSON.stringify(body),
      timeoutMs,
    });
  } catch {
    fail("network", "Devin 网络请求失败。");
  }
  const status = response && Number.isFinite(response.status) ? response.status : 0;
  const text = response && typeof response.bodyText === "string" ? response.bodyText : "";
  return { status, text };
}

/* ------------------------------------------------------------------ login */

let pending = null; // { verifier, startedAt }

function beginLogin() {
  const verifier = crypto.randomBytes(64).toString("base64url");
  const state = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(AUTH_BASE);
  url.search = new URLSearchParams({
    state,
    prompt: "select_account",
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  pending = { verifier, startedAt: Date.now() };
  return url.toString();
}

function validateCode(value) {
  if (typeof value !== "string" || value.length > 8192) fail("bounds", "无效的 Devin 授权码。");
  const code = value.trim();
  if (!code || /[\s\x00-\x1f\x7f]/.test(code)) fail("bounds", "无效的 Devin 授权码。");
  return code;
}

async function exchangeCode(code, verifier) {
  const response = await netFetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier }),
  });
  if (response.status < 200 || response.status >= 300) {
    fail("network", "Devin 授权码交换失败，请重试登录。");
  }
  let data;
  try {
    data = JSON.parse(response.text);
  } catch {
    fail("protocol", "Devin 令牌交换返回无效响应。");
  }
  if (!data || typeof data.token !== "string" || !data.token || data.token.length > 16384) {
    fail("protocol", "Devin 令牌交换未返回有效会话。");
  }
  return data.token;
}

async function submitLoginCode(value) {
  const code = validateCode(value);
  const attempt = pending;
  if (!attempt || Date.now() - attempt.startedAt > LOGIN_TIMEOUT_MS) {
    fail("login", "登录尝试已过期，请重新开始登录。");
  }
  pending = null;
  const token = toDevinSessionToken(await exchangeCode(code, attempt.verifier));
  await writeGrant({ version: 1, token, ...expiry(token) });
  completion?.invalidate();
  return statusText(await readGrant());
}

/* -------------------------------------------------------------- web_search */

async function webSearch(args, signal) {
  const life = deadline(signal, WEB_TIMEOUT_MS);
  const query = String((args && args.query) || "");
  if (!query.trim() || query.length > 8192) fail("bounds", "Devin 查询为空或过长。");
  let limit = Math.trunc(Number((args && args.maxResults) !== undefined ? args.maxResults : 5));
  if (!Number.isFinite(limit)) fail("bounds", "无效的 Devin 结果数量。");
  limit = Math.min(10, Math.max(1, limit));

  const grant = await readGrant();
  if (!grantAvailable(grant)) {
    fail("login", "Devin 会话缺失、过期或已撤销；请先在 Devin Search 面板中登录。");
  }
  const token = toDevinSessionToken(grant.token);

  let authRejected = 0;
  let hostsTried = 0;

  for (const host of WEB_HOSTS) {
    check(life);
    hostsTried += 1;
    let response;
    try {
      response = await netFetch(host + WEB_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "connect-protocol-version": "1",
          accept: "application/json",
          "user-agent": "windsurf/1.9600.41",
        },
        body: JSON.stringify({
          metadata: {
            apiKey: token,
            ideName: "windsurf",
            ideVersion: "1.9600.41",
            extensionName: "windsurf",
            extensionVersion: "1.9600.41",
            locale: "en",
          },
          query: query.trim(),
          limit,
        }),
      });
    } catch {
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      authRejected += 1;
      continue;
    }
    if (response.status < 200 || response.status >= 300) continue;

    let payload;
    try {
      payload = JSON.parse(response.text);
    } catch {
      fail("protocol", "无效的 Devin 网页搜索响应。");
    }
    if (!payload || !Array.isArray(payload.results)) {
      fail("protocol", "无效的 Devin 网页搜索结构。");
    }

    const sources = [];
    let valid = 0;
    const first = (row, keys, cap) => {
      for (const key of keys) {
        const value = row[key];
        if (typeof value === "string" && value.trim()) {
          return redact(value.trim().slice(0, cap), [token]);
        }
      }
      return "";
    };
    for (const raw of payload.results) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const url = first(raw, ["url", "sourceUrl", "webUrl", "link"], 4096);
      try {
        const parsed = new URL(url);
        if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) continue;
      } catch {
        continue;
      }
      valid += 1;
      if (sources.length < limit) {
        sources.push({
          url,
          title: first(raw, ["title", "name", "webTitle"], 512),
          snippet: first(raw, ["snippet", "summary", "text", "content"], 4096),
        });
      }
    }
    const content = sources
      .map((source) => `${source.title || source.url}\n${source.url}\n${source.snippet || ""}`)
      .join("\n\n") || "无网页结果。";
    return { content, sources, truncated: valid > limit };
  }

  if (hostsTried > 0 && authRejected === hostsTried) {
    const current = await readGrant();
    if (current && toDevinSessionToken(current.token) === token) {
      await writeGrant({ ...current, revoked: true });
    }
    fail("login", "Devin 会话被拒绝；请重新登录。");
  }
  fail("network", "所有主机上的 Devin 网页搜索均失败。");
}

/* -------------------------------------------------------------- code_search */

let completion;

function getCompletion() {
  if (!completion) {
    completion = new WindsurfCompletion(
      async () => {
        const grant = await readGrant();
        if (!grantAvailable(grant)) {
          fail("login", "Devin 会话缺失、过期或已撤销；请先在 Devin Search 面板中登录。");
        }
        return { token: toDevinSessionToken(grant.token) };
      },
      {
        onAuthRejected: async (token) => {
          const current = await readGrant();
          if (current && toDevinSessionToken(current.token) === token) {
            await writeGrant({ ...current, revoked: true });
          }
        },
      },
    );
  }
  return completion;
}

async function codeSearch(args, signal) {
  const workspace = await pi.workspace.get();
  if (!workspace || typeof workspace.path !== "string" || !workspace.path) {
    fail("path", "没有打开的工作区，无法执行代码检索。");
  }
  return runCodeSearch({
    searchTerm: args && args.search_term,
    subPath: args && args.path,
    fsApi: pi.fs,
    workspacePath: workspace.path,
    completion: getCompletion(),
    signal,
  });
}

/* ---------------------------------------------------------------- tools */

function toolDef(name) {
  const found = (manifest.contributes.agentTools || []).find((tool) => tool.name === name);
  return found || { name };
}

/** Pi-style tool result envelope the runtime expects (content parts + details + structuredContent). */
function toolResult(result) {
  const text = result && typeof result.content === "string" ? result.content : JSON.stringify(result ?? null, null, 2);
  return { content: [{ type: "text", text }], details: result, structuredContent: result };
}

async function executeWeb(args, ctx) {
  const settings = await readSettings();
  if (settings.webSearch === false) fail("bounds", "web_search 已在 Devin Search 设置中关闭。");
  try {
    return toolResult(await webSearch(args, ctx && ctx.signal));
  } catch (error) {
    throw new Error(error instanceof DevinError ? error.message : safeError(error));
  }
}

async function executeCode(args, ctx) {
  const settings = await readSettings();
  if (settings.codeSearch === false) fail("bounds", "code_search 已在 Devin Search 设置中关闭。");
  try {
    return toolResult(await codeSearch(args, ctx && ctx.signal));
  } catch (error) {
    throw new Error(error instanceof DevinError ? error.message : safeError(error));
  }
}

/* ---------------------------------------------------------- panel RPC */

async function panelStatus() {
  const grant = await readGrant();
  const settings = await readSettings();
  return {
    loggedIn: grantAvailable(grant),
    revoked: !!(grant && grant.revoked),
    status: statusText(grant),
    expiresAt: grant && Number.isFinite(grant.expiresAt) ? grant.expiresAt : null,
    webSearch: settings.webSearch !== false,
    codeSearch: settings.codeSearch !== false,
  };
}

async function onPanelInvoke(channel, payload) {
  switch (channel) {
    case "devin-search.status":
      return panelStatus();

    case "devin-search.login.begin": {
      const url = beginLogin();
      await pi.shell.openExternal(url);
      return { url };
    }

    case "devin-search.login.submit": {
      try {
        const status = await submitLoginCode(payload && payload.code);
        return { ok: true, status };
      } catch (error) {
        pending = null;
        throw new Error(error instanceof DevinError ? error.message : safeError(error));
      }
    }

    case "devin-search.login.cancel":
      pending = null;
      return { ok: true };

    case "devin-search.logout":
      await clearGrant();
      completion?.invalidate();
      return { ok: true, status: statusText(undefined) };

    case "devin-search.settings.set": {
      const patch = {};
      if (payload && typeof payload.webSearch === "boolean") patch.webSearch = payload.webSearch;
      if (payload && typeof payload.codeSearch === "boolean") patch.codeSearch = payload.codeSearch;
      if (Object.keys(patch).length) await pi.plugin.setSettings(patch);
      return { ok: true };
    }

    default:
      throw new Error(`unsupported channel: ${channel}`);
  }
}

/* ------------------------------------------------------------- lifecycle */

async function onLoad() {
  await pi.commands.register({
    id: "devin-search.open",
    title: "Devin Search: 打开面板",
    keywords: ["devin", "search", "login"],
    run: async () => {
      await pi.ui.openPanel({ title: "Devin Search" });
    },
  });

  await pi.commands.register({
    id: "devin-search.login",
    title: "Devin Search: 登录 Devin",
    keywords: ["devin", "login"],
    run: async () => {
      await pi.ui.openPanel({ title: "Devin Search" });
      await pi.ui.showToast("请在 Devin Search 面板中完成登录。");
    },
  });

  await pi.commands.register({
    id: "devin-search.status",
    title: "Devin Search: 查看登录状态",
    keywords: ["devin", "status"],
    run: async () => {
      await pi.ui.showToast(statusText(await readGrant()));
    },
  });

  await pi.commands.register({
    id: "devin-search.logout",
    title: "Devin Search: 退出登录",
    keywords: ["devin", "logout"],
    run: async () => {
      await clearGrant();
      completion?.invalidate();
      await pi.ui.showToast("已退出 Devin 登录，本地凭据已清除。");
    },
  });

  await pi.agent.registerTool({ ...toolDef(WEB_TOOL), execute: async (args, ctx) => executeWeb(args, ctx) });
  await pi.agent.registerTool({ ...toolDef(CODE_TOOL), execute: async (args, ctx) => executeCode(args, ctx) });
}

async function onUnload() {
  pending = null;
  completion?.invalidate();
  await Promise.allSettled([
    pi.commands.unregister("devin-search.open"),
    pi.commands.unregister("devin-search.login"),
    pi.commands.unregister("devin-search.status"),
    pi.commands.unregister("devin-search.logout"),
    pi.agent.unregisterTool(WEB_TOOL),
    pi.agent.unregisterTool(CODE_TOOL),
  ]);
}

module.exports = { onLoad, onUnload, onPanelInvoke };
