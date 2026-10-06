"use strict";

// Compact .gitignore matcher, used to align code_search with upstream's
// recursive .gitignore filtering (upstream uses the `ignore` npm package; the
// plugin stays dependency-free, so this reimplements the common subset:
// comments, `!` negation, trailing `/` directory-only, leading `/` anchoring,
// `**`, `*` and `?`).

function escapeRegex(ch) {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? "\\" + ch : ch;
}

/** Translate one gitignore pattern into an anchored regex over the base-relative path. */
function translate(pattern) {
  let body = pattern;
  let anchored = false;
  if (body.startsWith("/")) {
    anchored = true;
    body = body.slice(1);
  } else if (body.includes("/")) {
    anchored = true;
  }
  let re = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "*") {
      if (body[i + 1] === "*") {
        if (body[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += escapeRegex(ch);
    }
  }
  const prefix = anchored ? "" : "(?:.*/)?";
  return new RegExp(`^${prefix}${re}$`);
}

/** Parse raw .gitignore text into rules bound to a base directory. */
function parseRules(base, text) {
  const rules = [];
  for (const rawLine of String(text).split("\n")) {
    let line = rawLine.replace(/\r$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (!line) continue;
    rules.push({ base, regex: translate(line), negated, dirOnly });
  }
  return rules;
}

/** Whether `rel` (workspace-relative, no leading slash) sits under `base`. */
function relUnder(base, rel) {
  if (!base) return rel;
  if (rel === base) return "";
  if (rel.startsWith(base + "/")) return rel.slice(base.length + 1);
  return null;
}

function isIgnored(rules, rel, isDir = false) {
  let ignored = false;
  for (const rule of rules) {
    const sub = relUnder(rule.base, rel);
    if (sub === null) continue;
    let hit = false;
    if (rule.dirOnly) {
      if (isDir) {
        hit = rule.regex.test(sub);
      } else {
        const parts = sub.split("/");
        for (let i = 1; i < parts.length; i++) {
          if (rule.regex.test(parts.slice(0, i).join("/"))) {
            hit = true;
            break;
          }
        }
      }
    } else {
      hit = rule.regex.test(sub);
    }
    if (hit) ignored = !rule.negated;
  }
  return ignored;
}

/**
 * Build the ignore rule set from the workspace's `.gitignore` files.
 * `listFiles` yields workspace-relative paths; `readText` reads one.
 * Rules are ordered root-first so deeper files win (last match wins).
 */
async function loadIgnoreRules(listFiles, readText) {
  const files = listFiles.filter((rel) => rel === ".gitignore" || rel.endsWith("/.gitignore"));
  files.sort((a, b) => a.split("/").length - b.split("/").length);
  const rules = [];
  for (const file of files) {
    const base = file === ".gitignore" ? "" : file.slice(0, -"/.gitignore".length);
    let text;
    try {
      text = await readText(file);
    } catch {
      continue;
    }
    if (typeof text !== "string" || text.length > 32768) continue;
    rules.push(...parseRules(base, text));
  }
  return rules;
}

module.exports = { loadIgnoreRules, isIgnored, parseRules, translate };
