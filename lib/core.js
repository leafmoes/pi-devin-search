"use strict";

/** Shared primitives for the Devin Search plugin (ported from dsh-devin-search, MIT). */

const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$";
const FALLBACK_EXPIRES_MS = 365 * 24 * 60 * 60 * 1000;

class DevinError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DevinError";
    this.code = code;
  }
}
function fail(code, message) {
  throw new DevinError(code, message);
}
function safeError(error) {
  return error instanceof DevinError ? error.message : "Devin 操作失败，未保留任何提供商细节。";
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function json(buffer) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return fail("protocol", "Invalid Devin JSON response.");
  }
}

/** Windsurf metadata wants `devin-session-token$<jwt>`; the OAuth endpoint returns a bare JWT. */
function toDevinSessionToken(token) {
  const raw = String(token || "").trim();
  if (!raw) return raw;
  if (raw.startsWith(DEVIN_SESSION_TOKEN_PREFIX) || raw.startsWith("sk-ws-")) return raw;
  return DEVIN_SESSION_TOKEN_PREFIX + raw;
}

/** Bare JWT -> exp based; opaque/session tokens -> 365-day fallback (matches upstream). */
function expiry(token, now = Date.now()) {
  try {
    const segment = String(token).split(".")[1];
    if (segment) {
      const body = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
      if (typeof body.exp === "number" && Number.isFinite(body.exp) && body.exp > 0) {
        return { expiresAt: body.exp * 1000 - 60000, expirySource: "jwt" };
      }
    }
  } catch {
    /* opaque sessions are not refresh grants */
  }
  return { expiresAt: now + FALLBACK_EXPIRES_MS, expirySource: "fallback" };
}

function sessionSecrets(token) {
  const out = new Set();
  const raw = String(token || "").trim();
  if (!raw) return [];
  out.add(raw);
  out.add(toDevinSessionToken(raw));
  if (raw.startsWith(DEVIN_SESSION_TOKEN_PREFIX)) {
    out.add(raw.slice(DEVIN_SESSION_TOKEN_PREFIX.length));
  }
  return [...out].filter(Boolean);
}

/** Keep session tokens (and JWTs) out of anything that reaches the model. */
function redact(text, secrets) {
  const all = new Set();
  for (const secret of secrets) for (const part of sessionSecrets(secret)) all.add(part);
  let out = String(text);
  for (const secret of [...all].sort((a, b) => b.length - a.length)) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out;
}

/** Fail with `cancelled` when the (possibly undefined) signal is already aborted. */
function check(signal) {
  if (signal && signal.aborted) fail("cancelled", "Devin 操作已取消或超时。");
}

/** Combine a caller signal with a timeout into one abort signal. */
function deadline(signal, ms) {
  const parts = [];
  if (signal) parts.push(signal);
  if (typeof AbortSignal.timeout === "function") parts.push(AbortSignal.timeout(ms));
  if (!parts.length) return new AbortController().signal;
  return parts.length === 1 ? parts[0] : AbortSignal.any(parts);
}

module.exports = {
  DEVIN_SESSION_TOKEN_PREFIX,
  FALLBACK_EXPIRES_MS,
  DevinError,
  fail,
  safeError,
  object,
  json,
  toDevinSessionToken,
  expiry,
  sessionSecrets,
  redact,
  check,
  deadline,
};
