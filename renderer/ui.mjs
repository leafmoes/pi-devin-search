// PI-Desktop renderer extension: custom result cards for this plugin's tools.
//
// Contract (verified against the host):
//   - manifest: permissions ["renderer.extension"] + "renderer": this file (.mjs)
//   - this module runs inside the host renderer document and must export onLoad(pi)
//   - pi = { plugin:{id,version}, slots:{register}, ui:{injectStyle, openLayer}, composer:{...}, dispatch }
//   - si.slots.register({ slot:"toolCard", toolName, component }) — toolName must be one
//     of this plugin's contributes.agentTools names.
//   - "react" / "react-dom" / "react-dom/client" are provided by the host import map.
//   - the component receives the tool message: { toolName, toolArgs, toolStatus,
//     toolResult, toolError, messageId, sessionId } plus `entry` and `fallback`.
import * as React from "react";

const h = React.createElement;

/** Set by onLoad; shown in the card head so the build that is actually running is visible. */
let hostVersion = "";

const C = {
  card: {
    border: "1px solid var(--pi-border, rgba(127,127,127,0.28))",
    borderRadius: 10,
    padding: "10px 12px",
    margin: "6px 0",
    font: "12.5px/1.5 -apple-system, 'Segoe UI', Roboto, 'Microsoft YaHei', sans-serif",
    color: "var(--pi-fg, inherit)",
    background: "var(--pi-surface, rgba(127,127,127,0.06))",
  },
  head: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 },
  badge: {
    fontSize: 11,
    fontWeight: 600,
    padding: "1px 7px",
    borderRadius: 999,
    background: "rgba(47,111,237,0.14)",
    color: "var(--pi-accent, #2f6fed)",
  },
  badgeCloud: { background: "rgba(154,103,0,0.16)", color: "var(--pi-warn, #9a6700)" },
  sub: { opacity: 0.72 },
  warn: { fontSize: 11, color: "var(--pi-warn, #9a6700)" },
  err: { color: "var(--pi-err, #b3261e)" },
  list: { listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 },
  item: { paddingLeft: 10, borderLeft: "2px solid rgba(47,111,237,0.35)" },
  link: { color: "var(--pi-accent, #2f6fed)", textDecoration: "none", fontWeight: 600 },
  url: { opacity: 0.6, fontSize: 11, wordBreak: "break-all" },
  snip: { opacity: 0.85, marginTop: 2, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" },
  file: {
    border: "1px solid var(--pi-border, rgba(127,127,127,0.22))",
    borderRadius: 8,
    padding: "6px 8px",
    marginBottom: 6,
  },
  path: { fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", fontWeight: 600 },
  range: { fontSize: 11, opacity: 0.7, marginLeft: 6 },
  pre: {
    margin: "6px 0 0",
    padding: "6px 8px",
    borderRadius: 6,
    background: "rgba(127,127,127,0.10)",
    overflowX: "auto",
    whiteSpace: "pre",
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
    fontSize: 11.5,
    lineHeight: 1.45,
  },
  btn: {
    font: "inherit",
    fontSize: 11,
    padding: "1px 7px",
    borderRadius: 6,
    border: "1px solid var(--pi-border, rgba(127,127,127,0.3))",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
  },
};

// The host wraps tool cards in chip styles that set `user-select: none`. Opt every
// text surface back in so titles / urls / snippets / code can be selected and copied.
const SELECTABLE = { userSelect: "text", WebkitUserSelect: "text" };
for (const key of ["card", "link", "url", "snip", "pre", "path", "sub", "warn"]) {
  if (C[key]) Object.assign(C[key], SELECTABLE);
}
C.snipFull = { opacity: 0.85, marginTop: 2, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 320, overflowY: "auto", ...SELECTABLE };
// Expanded code ranges get the same treatment: readable, but never unbounded.
C.preTall = { ...C.pre, maxHeight: 360, overflowY: "auto" };
// Plain-text fallback surface (unknown result shape): selectable and copyable too.
C.textFallback = { ...C.pre, maxHeight: 320, overflowY: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word" };
C.diag = { fontSize: 10.5, marginTop: 6, opacity: 0.65, fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", ...SELECTABLE };
C.ver = { fontSize: 10, opacity: 0.55, fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace" };

/** Rough size hint so the cost of expanding is visible before clicking (rounded down). */
function formatSize(chars) {
  if (chars >= 10000) return `${(Math.floor(chars / 1000) / 10).toFixed(1)} 万字`;
  if (chars >= 1000) return `${(Math.floor(chars / 100) / 10).toFixed(1)}k 字`;
  return `${chars} 字`;
}

const WS = {
  head: { display: "flex", alignItems: "center", gap: 6 },
  more: {
    font: "inherit",
    fontSize: 11,
    marginTop: 4,
    padding: "1px 7px",
    borderRadius: 6,
    border: "1px solid var(--pi-border, rgba(127,127,127,0.3))",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
  },
};

function parseMaybeJson(text) {
  if (typeof text !== "string") return undefined;
  const t = text.trim();
  if (!t || (t[0] !== "{" && t[0] !== "[")) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/**
 * One of our own payloads: code_search carries `files`, web_search `sources`.
 * `status` + `content` is NOT enough — the host's envelopes carry both as plain
 * text, and accepting them made the card render raw text as "0 files".
 */
function isPayload(o) {
  return (
    !!o &&
    typeof o === "object" &&
    !Array.isArray(o) &&
    (Array.isArray(o.files) || Array.isArray(o.sources))
  );
}

/** Compact structural summary — rendered only when nothing structured was found. */
function describeShape(value, depth = 0) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return depth >= 2 || value.length === 0 ? `array[${value.length}]` : `array[${value.length}](${describeShape(value[0], depth + 1)})`;
  }
  if (typeof value === "string") return `str(${value.length})`;
  if (typeof value !== "object") return typeof value;
  if (depth >= 2) return "object";
  const keys = Object.keys(value).slice(0, 10);
  return `{${keys.map((k) => `${k}:${describeShape(value[k], depth + 1)}`).join(",")}}`;
}

const MAX_NODES = 800;
const MAX_DEPTH = 10;

/**
 * The host hands tool results over in several shapes: our payload directly, one
 * or two MCP-style envelopes ({content:[{type:"text",text}], details?,
 * structuredContent?}), a JSON-encoded string, or a mixture of those. Walk the
 * whole object graph breadth-first — parsing JSON strings on the way — and
 * return the first node that is one of our payloads, whatever the nesting.
 */
function findPayload(root) {
  const seen = new Set();
  const queue = [[root, 0]];
  for (let head = 0; head < queue.length && head < MAX_NODES; head += 1) {
    const [value, depth] = queue[head];
    if (value == null || depth > MAX_DEPTH) continue;
    if (typeof value === "string") {
      const parsed = parseMaybeJson(value);
      if (parsed !== undefined) queue.push([parsed, depth + 1]);
      continue;
    }
    if (typeof value !== "object") continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (isPayload(value)) return value;
    const children = Array.isArray(value) ? value : Object.values(value);
    for (const child of children) {
      if (child && (typeof child === "object" || typeof child === "string")) queue.push([child, depth + 1]);
    }
  }
  return null;
}

/** Largest readable string in the graph: the honest fallback when nothing structured exists. */
function findText(root) {
  const seen = new Set();
  const queue = [[root, 0]];
  let best = "";
  for (let head = 0; head < queue.length && head < MAX_NODES; head += 1) {
    const [value, depth] = queue[head];
    if (value == null || depth > MAX_DEPTH) continue;
    if (typeof value === "string") {
      if (value.length > best.length) best = value;
      continue;
    }
    if (typeof value !== "object") continue;
    if (seen.has(value)) continue;
    seen.add(value);
    const children = Array.isArray(value) ? value : Object.values(value);
    for (const child of children) {
      if (child && (typeof child === "object" || typeof child === "string")) queue.push([child, depth + 1]);
    }
  }
  return best;
}

/** Where a tool result may hide, most trustworthy first. */
const RESULT_SOURCES = [
  ["props.toolResult", (p, m) => p.toolResult],
  ["props.result", (p, m) => p.result],
  ["message.toolResult", (p, m) => m && m.toolResult],
  ["message.result", (p, m) => m && m.result],
  ["props.content", (p, m) => p.content],
  ["message.content", (p, m) => m && m.content],
  ["message", (p, m) => m],
];

/** Tolerate either `{entry,message,fallback,...state}` or the state spread directly. */
function normalize(props) {
  const p = props || {};
  const entry = p.entry;
  const message = p.message;
  const shapes = [];
  let payload = null;
  let text = "";
  let source = "";
  for (const [name, read] of RESULT_SOURCES) {
    let value;
    try {
      value = read(p, message);
    } catch {
      value = undefined;
    }
    if (value == null) continue;
    shapes.push(`${name}=${describeShape(value)}`);
    const found = findPayload(value);
    if (found) {
      payload = found;
      source = name;
      break;
    }
    if (!text) text = findText(value);
  }
  return {
    entry,
    fallback: p.fallback ?? null,
    toolName: p.toolName ?? entry?.toolName ?? message?.toolName ?? "",
    toolArgs: p.toolArgs ?? message?.toolArgs ?? {},
    toolStatus: p.toolStatus ?? message?.toolStatus ?? "completed",
    toolError: p.toolError ?? message?.toolError,
    result: payload ?? (text ? { content: text } : {}),
    // A payload was found: the result is structured, no diagnostic is needed.
    structured: payload !== null,
    source,
    shape: shapes.join(" · "),
  };
}

function Shell({ children, status, error, fallback, meta }) {
  const [raw, setRaw] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(typeof children === "string" ? children : String(meta?.copyText ?? ""));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };
  return h(
    "div",
    { style: C.card },
    h(
      "div",
      { style: C.head },
      ...(meta?.head ?? []),
      h("span", { style: { flex: 1 } }),
      meta?.copyText
        ? h("button", { type: "button", style: C.btn, onClick: copy }, copied ? "已复制" : "复制")
        : null,
      fallback ? h("button", { type: "button", style: C.btn, onClick: () => setRaw((v) => !v) }, raw ? "收起原始" : "原始输出") : null,
    ),
    status === "error"
      ? h("div", { style: C.err }, String(error || "工具调用失败"))
      : status === "running"
        ? h("div", { style: C.sub }, "运行中…")
        : raw
          ? h("div", null, fallback)
          : children,
  );
}

/**
 * Body used when no structured payload could be recognised: show the text we do
 * have (selectable, clamped) and name the shape we received, so a broken
 * host/plugin contract is visible instead of silently rendering "0 files".
 */
function FallbackText({ text, structured, shape, empty }) {
  const body = text == null ? "" : String(text);
  return h(
    "div",
    null,
    body ? h("pre", { style: C.textFallback }, body) : h("div", { style: C.sub }, empty),
    structured ? null : h("div", { style: C.diag }, `未识别到结构化结果 · ${shape || "无候选字段"}`),
  );
}

function SourceItem({ source }) {
  const title = String(source?.title || source?.url || "");
  const url = String(source?.url || "");
  const snippet = source?.snippet ? String(source.snippet) : "";
  const isLong = snippet.length > 160 || snippet.split("\n").length > 3;
  const [full, setFull] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText([title, url, snippet].filter(Boolean).join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };
  return h(
    "li",
    { style: C.item },
    h(
      "div",
      { style: WS.head },
      h("a", { href: url || "#", target: "_blank", rel: "noreferrer noopener", style: C.link }, title),
      h("span", { style: { flex: 1 } }),
      h("button", { type: "button", style: C.btn, onClick: copy }, copied ? "已复制" : "复制"),
    ),
    h("div", { style: C.url }, url),
    snippet ? h("div", { style: full || !isLong ? C.snipFull : C.snip }, snippet) : null,
    isLong ? h("button", { type: "button", style: WS.more, onClick: () => setFull((v) => !v) }, full ? "收起" : `展开全文（约 ${formatSize(snippet.length)}）`) : null,
  );
}

function WebSearchCard(props) {
  const s = normalize(props);
  const r = s.result || {};
  const sources = Array.isArray(r.sources) ? r.sources : [];
  const head = [
    h("span", { key: "b", style: { ...C.badge, ...C.badgeCloud } }, "Devin 网页搜索"),
    h("span", { key: "q", style: C.sub }, String(s.toolArgs?.query ?? "")),
    hostVersion ? h("span", { key: "v", style: C.ver }, `v${hostVersion}`) : null,
    r.truncated ? h("span", { key: "t", style: C.warn }, "已截断") : null,
  ].filter(Boolean);

  const body =
    sources.length === 0
      ? h(FallbackText, { text: r.content, structured: s.structured, shape: s.shape, empty: "无结果" })
      : h(
          "ol",
          { style: C.list },
          ...sources.map((src, i) => h(SourceItem, { key: i, source: src })),
        );

  return h(Shell, { status: s.toolStatus, error: s.toolError, fallback: s.fallback, meta: { head } }, body);
}


const CODE_PREVIEW_LINES = 12;

const CS = {
  group: { marginBottom: 6 },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    width: "100%",
    padding: "4px 6px",
    border: "1px solid var(--pi-border, rgba(127,127,127,0.22))",
    borderRadius: 8,
    background: "transparent",
    color: "inherit",
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
  },
  caret: { opacity: 0.6, width: 10, flex: "0 0 auto" },
  more: {
    font: "inherit",
    fontSize: 11,
    marginTop: 4,
    padding: "1px 7px",
    borderRadius: 6,
    border: "1px solid var(--pi-border, rgba(127,127,127,0.3))",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
  },
};

// `CodeRange` is exported as a test seam; the host only consumes onLoad/onUnload.
export function CodeRange({ range }) {
  const content = String(range && range.content != null ? range.content : "");
  const lines = content.split("\n");
  const [all, setAll] = React.useState(false);
  const shown = all ? lines : lines.slice(0, CODE_PREVIEW_LINES);
  return h(
    "div",
    null,
    h("pre", { style: all ? C.preTall : C.pre }, shown.join("\n")),
    !all && lines.length > CODE_PREVIEW_LINES
      ? h(
          "button",
          { type: "button", style: CS.more, onClick: () => setAll(true) },
          `展开其余 ${lines.length - CODE_PREVIEW_LINES} 行（共 ${lines.length} 行）`,
        )
      : null,
  );
}

function CodeSearchCard(props) {
  const s = normalize(props);
  const r = s.result || {};
  const files = Array.isArray(r.files) ? r.files : [];
  // Files start collapsed so a large result never floods the transcript.
  const [open, setOpen] = React.useState(() => new Set());

  const rangesOf = (f) => (Array.isArray(f.ranges) ? f.ranges : []);
  const lineCountOf = (f) =>
    rangesOf(f).reduce((n, rg) => {
      const start = Number(rg && rg.start);
      const end = Number(rg && rg.end);
      return n + (Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start + 1 : 0);
    }, 0);
  const totalLines = files.reduce((n, f) => n + lineCountOf(f), 0);
  const totalRanges = files.reduce((n, f) => n + rangesOf(f).length, 0);

  const toggle = (i) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const head = [
    h("span", { key: "b", style: C.badge }, "Devin 代码检索"),
    h("span", { key: "q", style: C.sub }, String(s.toolArgs?.search_term ?? "")),
    // A count of zero means either "no match" or "the result shape was not understood";
    // say which, so a contract break never looks like an empty search.
    s.structured
      ? h("span", { key: "n", style: C.sub }, `${files.length} 个文件 · ${totalRanges} 段 · ${totalLines} 行`)
      : h("span", { key: "n", style: C.warn }, "未取得结构化结果"),
    hostVersion ? h("span", { key: "v", style: C.ver }, `v${hostVersion}`) : null,
    files.length
      ? h(
          "button",
          {
            key: "t",
            type: "button",
            style: C.btn,
            onClick: () => setOpen((prev) => (prev.size ? new Set() : new Set(files.map((_, i) => i)))),
          },
          open.size ? "全部收起" : "全部展开",
        )
      : null,
  ].filter(Boolean);

  const body =
    files.length === 0
      ? h(FallbackText, { text: r.content, structured: s.structured, shape: s.shape, empty: "无匹配" })
      : h(
          "div",
          null,
          ...files.map((f, i) => {
            const ranges = rangesOf(f);
            const isOpen = open.has(i);
            return h(
              "div",
              { key: i, style: CS.group },
              h(
                "button",
                { type: "button", style: CS.row, onClick: () => toggle(i) },
                h("span", { style: CS.caret }, isOpen ? "▾" : "▸"),
                h("span", { style: C.path }, String(f.path || "")),
                h("span", { style: C.range }, `${ranges.length} 段 · ${lineCountOf(f)} 行`),
              ),
              isOpen ? h("div", null, ...ranges.map((rg, j) => h(CodeRange, { key: j, range: rg }))) : null,
            );
          }),
        );

  return h(Shell, { status: s.toolStatus, error: s.toolError, fallback: s.fallback, meta: { head } }, body);
}

export async function onLoad(pi) {
  hostVersion = pi.plugin?.version ?? "";
  pi.slots.register({ slot: "toolCard", toolName: "web_search", component: WebSearchCard });
  pi.slots.register({ slot: "toolCard", toolName: "code_search", component: CodeSearchCard });
}

export async function onUnload() {
  // Registrations are tracked and disposed by the host.
}
