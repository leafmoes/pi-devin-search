"use strict";

// Cloud completion client over raw node:https.
//
// The Windsurf/Devin endpoints speak Connect + protobuf, which needs BINARY
// request and response bodies. PI-Desktop's `pi.net.fetch` only returns text
// (`bodyText`) and only accepts string bodies, so it cannot carry these frames.
// This module therefore uses node:https directly. Everything else in the plugin
// (login token exchange, web_search) keeps using the fenced `pi.net.fetch`.
const https = require("node:https");
const {
  chatRequest,
  gzipFrame,
  JWT_PATH,
  jwtRequest,
  jwtResponse,
  MODEL,
  STREAM_PATH,
  streamText,
} = require("./protocol");
const { check, expiry, fail, redact } = require("./core");

const DEFAULT_BASE = "https://server.self-serve.windsurf.com";
const DEFAULT_TIMEOUT_MS = 30000;
const JWT_CACHE_MS = 5 * 60 * 1000;

function postBinary(base, pathName, body, framed, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(base + pathName);
    } catch {
      return reject(new Error("bad url"));
    }
    const headers = {
      "content-type": framed ? "application/connect+proto" : "application/proto",
      "connect-protocol-version": "1",
      "content-length": body.length,
    };
    if (framed) {
      headers["connect-accept-encoding"] = "gzip";
      headers["connect-content-encoding"] = "gzip";
      headers["connect-timeout-ms"] = String(timeoutMs);
    }
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: "POST",
        headers,
        timeout: timeoutMs,
        ...(signal ? { signal } : {}),
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

class WindsurfCompletion {
  /**
   * @param access async () => ({ token })  — resolves the current session token, or throws login error.
   * @param options { base?, timeoutMs?, onAuthRejected? }
   */
  constructor(access, options = {}) {
    this.access = access;
    this.options = options;
    this.cached = undefined;
    this.version = 0;
    this.model = MODEL;
  }

  invalidate() {
    this.version++;
    this.cached = undefined;
  }

  async complete(system, messages, tools, caller) {
    check(caller);
    const session = await this.access();
    const token = session.token;
    const version = this.version;
    const base = this.options.base || DEFAULT_BASE;
    const timeoutMs = this.options.timeoutMs || DEFAULT_TIMEOUT_MS;

    const post = async (pathName, body, framed) => {
      let res;
      try {
        res = await postBinary(base, pathName, body, framed, timeoutMs, caller);
      } catch {
        fail("network", "Devin completion request failed.");
      }
      if (res.status === 401 || res.status === 403) {
        this.invalidate();
        if (this.options.onAuthRejected) await this.options.onAuthRejected(token);
        fail("login", "Devin session rejected; please log in again from the Devin Search panel.");
      }
      if (res.status < 200 || res.status >= 300) fail("network", "Devin completion request failed.");
      return res.body;
    };

    let jwt;
    if (this.cached && this.cached.token === token && this.cached.until > Date.now()) {
      jwt = this.cached.jwt;
    } else {
      jwt = jwtResponse(await post(JWT_PATH, jwtRequest(token), false)) || "";
      if (!jwt || jwt.length > 16384) fail("protocol", "Devin returned no valid search JWT.");
      if (version !== this.version) fail("cancelled", "Devin credentials changed during search.");
      this.cached = {
        token,
        jwt,
        until: Math.min(expiry(jwt).expiresAt, Date.now() + JWT_CACHE_MS),
      };
    }

    check(caller);
    const raw = await post(STREAM_PATH, gzipFrame(chatRequest(token, jwt, system, messages, tools)), true);
    if (version !== this.version) fail("cancelled", "Devin credentials changed during search.");
    return redact(streamText(raw), [token, jwt]);
  }
}

module.exports = { WindsurfCompletion, DEFAULT_BASE };
