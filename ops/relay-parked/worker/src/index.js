// Josi relay: forwards ciphertext between one Josi server and its devices.
//
// Adapted from bananana's relay, with the part that could read traffic removed.
// There is no HTTP tunnelling here at all. A request to https://<name>.heyjosi.com
// gets one fixed loader page, the same for everyone; after that the browser's
// traffic is Noise frames on a WebSocket, like any other device's.
//
//   POST /v1/sites {grant}                    register a server -> { site, secret, name }
//   POST /v1/sites/:site/grant {grant}        renew. Bearer secret
//   DELETE /v1/sites/:site/name               release the name. Bearer secret
//   GET  /v1/sites/:site/server  (WebSocket)  the server. Bearer secret
//   GET  /v1/sites/:site/peer    (WebSocket)  a device
//   PUT|DELETE /v1/sites/:site/invites/:id    a sealed pairing box. Bearer secret
//   GET  /v1/invites/:id                      look one up (rate-limited per IP)
//   POST /v1/names/revoke {revoke}            hosted accounts takes a name back
//   https://<name>.heyjosi.com/__josi/connect (WebSocket) a device, by name
//   https://<name>.heyjosi.com/__josi/invite/:id          as /v1/invites/:id
//   https://<name>.heyjosi.com/*              the loader, nothing else
//
// Device ids here are random per connection, made by the relay. So the relay can
// count connections, but it can't tell which device is which, or link one
// connection to the next except by address and timing.
//
// Server socket frames are binary: 16-byte peer id + payload. Device frames are
// the payload alone. The relay sends JSON text: to the server {type:"peer-open"
// |"peer-close", peer}, to devices {type:"server-online"|"server-offline"}. The
// server may send {type:"kick", peer}.
import { ASSETS } from "./assets.generated.js";

const SITE_RE = /^[0-9a-f]{32}$/;
const PEER_RE = /^[0-9a-f]{32}$/;
const INVITE_RE = /^[0-9a-f]{32}$/;
const NAME_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const MAX_FRAME = 70 * 1024;              // one Noise message (65535) plus the peer id, with room to spare
const MAX_PEERS = 200;                     // connections per server; a household, generously
const PEER_CONNECTS_PER_HOUR = 2000;       // per IP and server: service workers reconnect often
const REGISTRATIONS_PER_HOUR = 10;
const INVITE_LOOKUPS_PER_HOUR = 30;        // per IP; codes hold 160 bits, so this is only about load
const MAX_INVITE_BOX = 4096;
const MAX_INVITE_SECONDS = 3600;           // pairing codes live ten minutes; this is the ceiling
const MAX_INVITE_LOOKUPS = 20;
const LAPSED = 4402;                       // close code: the plan behind this address ended

// Names that are ours, and pass through to their own origin or never exist.
export const RESERVED = new Set(["www", "relay", "ce", "get", "help", "api", "ai", "app", "admin", "account", "accounts", "auth", "billing", "mail", "smtp", "imap", "status", "docs", "blog", "support", "cdn", "assets", "static", "dev", "staging", "test", "root", "josi", "hey", "login", "signup", "pay", "stripe", "google", "oauth"]);

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function page(status, title, text, domain) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f5f0;color:#1d1b18;font:16px/1.6 system-ui,sans-serif}main{max-width:440px;padding:24px}h1{font-size:26px;margin:0 0 8px}p{margin:0 0 16px;color:#5b5750}@media(prefers-color-scheme:dark){body{background:#16150f;color:#f3f0e8}p{color:#b3aea3}}</style>
<main><h1>${esc(title)}</h1><p>${esc(text)}</p><a href="https://${esc(domain)}">${esc(domain)}</a></main>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" } });
}

function hex(bytes) { return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(""); }
function unhex(s) { const out = new Uint8Array(s.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return out; }
async function sha256(text) { return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))); }
function random(n) { return crypto.getRandomValues(new Uint8Array(n)); }
function b64url(bytes) { return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""); }
function unb64(s) { const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/")); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }

const validName = (name) => typeof name === "string" && NAME_RE.test(name) && !name.includes("--") && !RESERVED.has(name);
const siteStub = (env, site) => env.SITES.get(env.SITES.idFromName(site));
const nameStub = (env, name) => env.NAMES.get(env.NAMES.idFromName(name));
const domainOf = (env) => env.PUBLIC_DOMAIN || "heyjosi.com";
const openRelay = (env) => env.OPEN_RELAY === "1";
const accountKeys = (env) => String(env.ACCOUNTS_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
const clientIp = (request) => request.headers.get("cf-connecting-ip") || "local";
const nameCache = new Map();               // name -> { site, until }: saves a Durable Object round trip per connect

async function hit(env, key, max) {
  return (await (await env.LIMITS.get(env.LIMITS.idFromName(key)).fetch("https://limit/hit?max=" + max)).json()).ok;
}

async function authorized(env, site, request) {
  const auth = await siteStub(env, site).fetch("https://site/auth", { headers: { Authorization: request.headers.get("Authorization") || "" } });
  return auth.status === 200;
}

// A grant is base64url(JSON claims) "." base64url(Ed25519 signature of the first part), from the accounts service.
async function verifySigned(token, keys) {
  const [body, sig, extra] = String(token).split(".");
  if (!body || !sig || extra !== undefined) return null;
  for (const k of keys) {
    try {
      const key = await crypto.subtle.importKey("raw", unb64(k), { name: "Ed25519" }, false, ["verify"]);
      if (await crypto.subtle.verify({ name: "Ed25519" }, key, unb64(sig), new TextEncoder().encode(body))) return JSON.parse(new TextDecoder().decode(unb64(body)));
    } catch {}
  }
  return null;
}

async function readGrant(env, grant) {
  const claims = await verifySigned(grant || "", accountKeys(env));
  if (!claims || typeof claims !== "object") return { error: json({ error: "bad grant signature" }, 403) };
  if (claims.typ !== "relay-grant" || !SITE_RE.test(claims.site || "") || !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) || !validName(claims.name)) return { error: json({ error: "bad grant" }, 400) };
  if (!(claims.exp * 1000 > Date.now())) return { error: json({ error: "grant expired" }, 403) };
  return { claims };
}

async function claimName(env, name, site, iat) {
  const claim = await nameStub(env, name).fetch("https://name/claim", { method: "POST", body: JSON.stringify({ name, site, iat }) });
  if (claim.status !== 200) return { error: json({ error: (await claim.json()).error === "revoked" ? "this name was taken back; ask for a new grant" : "that name belongs to another server" }, 409) };
  const { moved } = await claim.json();    // the site that held it before: a re-link with a newer grant
  if (moved) await siteStub(env, moved).fetch("https://site/set", { method: "POST", body: JSON.stringify({ only: name }) });
  nameCache.delete(name);
  return {};
}

async function register(request, env) {
  if (!(await hit(env, "register:" + clientIp(request), REGISTRATIONS_PER_HOUR))) return json({ error: "too many registrations, try again later" }, 429);
  let body = {}; try { body = await request.json(); } catch {}
  let site, name = null, exp = null, iat = Math.floor(Date.now() / 1000);
  if (body.grant) {
    const { claims, error } = await readGrant(env, body.grant);
    if (error) return error;
    ({ site, name, exp, iat } = claims);
  } else if (openRelay(env)) {
    site = hex(random(16));
    if (body.name !== undefined) { if (!validName(body.name)) return json({ error: "bad name" }, 400); name = body.name; }
  } else return json({ error: accountKeys(env).length ? "a grant is required" : "this relay isn't set up for registration" }, 403);
  const stub = siteStub(env, site);
  const secret = b64url(random(32));
  const made = await stub.fetch("https://site/register", { method: "POST", body: JSON.stringify({ site, secretHash: await sha256(secret), name, exp }) });
  if (made.status !== 200) return made;
  if (name) { const { error } = await claimName(env, name, site, iat); if (error) return error; }
  return json({ site, secret, name, address: name ? `${name}.${domainOf(env)}` : null }, 201);
}

async function renew(request, env, site) {
  if (!(await authorized(env, site, request))) return json({ error: "unauthorized" }, 401);
  let body; try { body = await request.json(); } catch { return json({ error: "bad request" }, 400); }
  const { claims, error } = await readGrant(env, body.grant);
  if (error) return error;
  if (claims.site !== site) return json({ error: "that grant is for another server" }, 403);
  const claimed = await claimName(env, claims.name, site, claims.iat);
  if (claimed.error) return claimed.error;
  const res = await siteStub(env, site).fetch("https://site/set", { method: "POST", body: JSON.stringify({ name: claims.name, exp: claims.exp }) });
  const { previous } = await res.json();
  if (previous && previous !== claims.name) { nameCache.delete(previous); await nameStub(env, previous).fetch("https://name/release", { method: "POST", body: JSON.stringify({ site }) }); }
  return json({ ok: true, name: claims.name, address: `${claims.name}.${domainOf(env)}`, exp: claims.exp });
}

async function releaseName(request, env, site) {
  if (!(await authorized(env, site, request))) return json({ error: "unauthorized" }, 401);
  const { previous } = await (await siteStub(env, site).fetch("https://site/set", { method: "POST", body: JSON.stringify({ name: null }) })).json();
  if (previous) { nameCache.delete(previous); await nameStub(env, previous).fetch("https://name/release", { method: "POST", body: JSON.stringify({ site }) }); }
  return json({ ok: true });
}

// The accounts service takes a name back (an account was deleted or suspended) with a short-lived signed revocation:
// {"typ":"relay-revoke","name":"…","iat":s,"exp":s}. The name stops answering at once, and older grants can't bind it again.
async function revokeName(request, env) {
  let body; try { body = await request.json(); } catch { return json({ error: "bad request" }, 400); }
  const claims = await verifySigned(body.revoke || "", accountKeys(env));
  if (!claims || claims.typ !== "relay-revoke" || !validName(claims.name) || !Number.isInteger(claims.iat)) return json({ error: "bad revocation" }, 403);
  if (!(claims.exp * 1000 > Date.now()) || claims.exp - claims.iat > 900) return json({ error: "revocation expired" }, 403);
  const { site } = await (await nameStub(env, claims.name).fetch("https://name/revoke", { method: "POST", body: JSON.stringify({ iat: claims.iat }) })).json();
  nameCache.delete(claims.name);
  if (site) await siteStub(env, site).fetch("https://site/set", { method: "POST", body: JSON.stringify({ only: claims.name, lapse: true }) });
  return json({ ok: true, revoked: claims.name, was: site ? "bound" : "unbound" });
}

async function invite(request, env, id) {
  if (!INVITE_RE.test(id)) return json({ error: "no such code, or it expired" }, 404);
  if (!(await hit(env, "lookup:" + clientIp(request), INVITE_LOOKUPS_PER_HOUR))) return json({ error: "too many attempts from this network, try again in an hour" }, 429);
  return env.INVITES.get(env.INVITES.idFromName(id)).fetch("https://invite/get");
}

async function putInvite(request, env, site, id) {
  if (!INVITE_RE.test(id)) return json({ error: "bad invite id" }, 400);
  if (!(await authorized(env, site, request))) return json({ error: "unauthorized" }, 401);
  const stub = env.INVITES.get(env.INVITES.idFromName(id));
  if (request.method === "DELETE") return stub.fetch("https://invite/delete", { method: "POST", body: JSON.stringify({ site }) });
  let body; try { body = await request.json(); } catch { return json({ error: "bad request" }, 400); }
  const box = String(body.box || ""), expires = Number(body.expires) || 0, lookups = Math.floor(Number(body.lookups) || 0);
  if (!box || box.length > MAX_INVITE_BOX || !/^[A-Za-z0-9_-]+$/.test(box)) return json({ error: "bad box" }, 400);
  if (expires * 1000 <= Date.now() || expires * 1000 > Date.now() + MAX_INVITE_SECONDS * 1000) return json({ error: "bad expiry" }, 400);
  if (lookups < 1 || lookups > MAX_INVITE_LOOKUPS) return json({ error: "bad lookups" }, 400);
  return stub.fetch("https://invite/put", { method: "POST", body: JSON.stringify({ site, box, expires, lookups }) });
}

async function connectPeer(request, env, site) {
  if (!(await hit(env, "peer:" + site + ":" + clientIp(request), PEER_CONNECTS_PER_HOUR))) return json({ error: "too many connections from this network, try again later" }, 429);
  return siteStub(env, site).fetch(new Request("https://site/peer", request));
}

function asset(path, host, secure = true) {
  const file = ASSETS[path];
  if (!file) return null;
  const headers = { "content-type": file.type, "cache-control": "no-cache", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
  if (path === "/__josi/sw.js") headers["service-worker-allowed"] = "/";
  if (file.type.startsWith("text/html")) headers["content-security-policy"] = `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ${secure ? "wss" : "ws"}://${host}; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  return new Response(file.body, { headers });
}

// https://<name>.heyjosi.com. Nothing from the person's server ever comes through here as a request or a response.
async function address(request, env, url, name, host) {
  const domain = domainOf(env);
  const missing = () => page(404, "No Josi here", `Nothing answers at ${name}.${domain}. Check the address.`, domain);
  if (!validName(name)) return missing();
  let entry = nameCache.get(name);
  if (!entry || entry.until < Date.now()) {
    const found = await nameStub(env, name).fetch("https://name/get");
    if (found.status !== 200) return missing();
    if (nameCache.size > 5000) nameCache.clear();
    nameCache.set(name, entry = { site: (await found.json()).site, until: Date.now() + 15000 });
  }
  if (url.pathname === "/__josi/connect") {
    if (request.headers.get("Upgrade") !== "websocket") return json({ error: "websocket expected" }, 426);
    return connectPeer(request, env, entry.site);
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "__josi" && parts[1] === "invite" && parts.length === 3 && request.method === "GET") return invite(request, env, parts[2]);
  // The web client registers its own worker at /sw.js. That would evict the tunnel, so it must fail here.
  if (url.pathname === "/sw.js") return new Response("", { status: 404 });
  if (url.pathname.startsWith("/__josi/")) return asset(url.pathname, host, url.protocol === "https:") || new Response("", { status: 404 });
  const state = await (await siteStub(env, entry.site).fetch("https://site/state")).json();
  if (!state.active) return page(402, "This address is paused", "The plan behind this address has ended. Its owner can renew it from their Hey Josi account.", domain);
  return asset("/__josi/loader.html", host, url.protocol === "https:");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const testHost = env.ALLOW_TEST_HOST === "1" && request.headers.get("x-josi-test-host");   // wrangler dev only sees 127.0.0.1
    const host = (testHost || url.hostname).toLowerCase().split(":")[0];
    const domain = domainOf(env);
    const relayHost = env.RELAY_HOST || "relay." + domain;
    if (host !== relayHost && host.endsWith("." + domain)) {
      const name = host.slice(0, -domain.length - 1);
      if (RESERVED.has(name)) return fetch(request);
      return address(request, env, url, name, host);
    }
    if (host === domain) return fetch(request);

    const parts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/" || url.pathname === "/v1/health") return json({ ok: true, service: "josi relay" });
    if (parts[0] !== "v1") return json({ error: "not found" }, 404);
    if (parts[1] === "invites" && parts.length === 3 && request.method === "GET") return invite(request, env, parts[2]);
    if (parts[1] === "names" && parts[2] === "revoke" && parts.length === 3 && request.method === "POST") return revokeName(request, env);
    if (parts[1] !== "sites") return json({ error: "not found" }, 404);
    if (parts.length === 2 && request.method === "POST") return register(request, env);
    const site = parts[2];
    if (!site || !SITE_RE.test(site)) return json({ error: "bad site" }, 400);
    if (parts.length === 5 && parts[3] === "invites" && (request.method === "PUT" || request.method === "DELETE")) return putInvite(request, env, site, parts[4]);
    if (parts.length === 4 && parts[3] === "grant" && request.method === "POST") return renew(request, env, site);
    if (parts.length === 4 && parts[3] === "name" && request.method === "DELETE") return releaseName(request, env, site);
    if (request.headers.get("Upgrade") !== "websocket") return json({ error: "websocket expected" }, 426);
    if (parts.length === 4 && parts[3] === "server") return siteStub(env, site).fetch(new Request("https://site/server", request));
    if (parts.length === 4 && parts[3] === "peer") return connectPeer(request, env, site);
    return json({ error: "not found" }, 404);
  },
};

// Connection events for troubleshooting: the site id, close codes and counts. Never content, keys or addresses.
function event(site, ev, extra = {}) { console.log(JSON.stringify({ relay: ev, site: site || "?", ...extra })); }

// One per server. Uses the hibernation API, so idle connections cost nothing.
export class Site {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  active(record) { return openRelay(this.env) || (!!record.exp && record.exp * 1000 > Date.now() && !record.lapsed); }

  async fetch(request) {
    const op = new URL(request.url).pathname;
    if (op === "/register") {
      const { site, secretHash, name, exp } = await request.json();
      if (await this.ctx.storage.get("record")) return json({ error: "this server is already registered" }, 409);
      await this.ctx.storage.put("record", { site, secretHash, name, exp, created: Date.now() });
      if (exp) await this.ctx.storage.setAlarm(exp * 1000);
      return json({ ok: true });
    }
    const record = await this.ctx.storage.get("record");
    if (!record) return json({ error: "unknown site" }, 404);
    if (op === "/auth") {
      const auth = request.headers.get("Authorization") || "";
      return auth.startsWith("Bearer ") && (await sha256(auth.slice(7))) === record.secretHash ? json({ ok: true }) : json({ error: "unauthorized" }, 401);
    }
    if (op === "/state") return json({ active: this.active(record) });
    if (op === "/set") return this.set(record, await request.json());
    if (request.headers.get("Upgrade") !== "websocket") return json({ error: "not found" }, 404);
    if (!this.active(record)) return json({ error: "the plan behind this server has ended" }, 402);
    const [client, server] = Object.values(new WebSocketPair());

    if (op === "/server") {
      const auth = request.headers.get("Authorization") || "";
      if (!auth.startsWith("Bearer ") || (await sha256(auth.slice(7))) !== record.secretHash) return json({ error: "unauthorized" }, 401);
      const old = this.ctx.getWebSockets("server");
      for (const ws of old) { try { ws.close(4001, "replaced by a new server connection"); } catch {} }
      this.ctx.acceptWebSocket(server, ["server"]);
      this.broadcast({ type: "server-online" });
      for (const peer of this.peers()) this.sendText(server, { type: "peer-open", peer: this.peerOf(peer) });
      event(record.site, "server-connected", { replaced: old.length, devices: this.peers().length });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (op === "/peer") {
      const limit = (this.env.ALLOW_TEST_HOST === "1" && Number(this.env.TEST_MAX_PEERS)) || MAX_PEERS;
      if (this.peers().length >= limit) return json({ error: "too many devices connected to this server" }, 403);
      const peer = hex(random(16));
      this.ctx.acceptWebSocket(server, ["peer", "peer:" + peer]);
      const target = this.server();
      if (target) this.sendText(target, { type: "peer-open", peer });
      this.sendText(server, { type: target ? "server-online" : "server-offline" });
      return new Response(null, { status: 101, webSocket: client });
    }
    return json({ error: "not found" }, 404);
  }

  async set(record, { name, exp, only, lapse }) {
    const previous = record.name || null;
    if (only !== undefined && only !== previous) return json({ ok: true, previous });   // clear it only if it is still this name
    const next = { ...record };
    if (only !== undefined || name === null) next.name = null; else if (name) next.name = name;
    if (exp) { next.exp = exp; next.lapsed = false; await this.ctx.storage.setAlarm(exp * 1000); }
    if (lapse) next.lapsed = true;
    await this.ctx.storage.put("record", next);
    if (lapse) this.closeAll("this address was taken back");
    return json({ ok: true, previous });
  }

  // A grant ran out and wasn't renewed. Nothing is deleted; a new grant brings the address back.
  async alarm() {
    const record = await this.ctx.storage.get("record");
    if (record && !this.active(record)) { this.closeAll("the plan behind this server has ended"); event(record.site, "lapsed"); }
  }

  closeAll(reason) { for (const ws of this.ctx.getWebSockets()) { try { ws.close(LAPSED, reason); } catch {} } }
  server() { return this.ctx.getWebSockets("server")[0] || null; }
  peers() { return this.ctx.getWebSockets("peer"); }
  peerOf(ws) { const tag = this.ctx.getTags(ws).find((t) => t.startsWith("peer:")); return tag ? tag.slice(5) : null; }
  sendText(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
  broadcast(obj) { for (const p of this.peers()) this.sendText(p, obj); }

  async webSocketMessage(ws, message) {
    const tags = this.ctx.getTags(ws);
    if (tags.includes("server")) {
      if (typeof message === "string") {
        let msg; try { msg = JSON.parse(message); } catch { return; }
        if (msg && msg.type === "kick" && PEER_RE.test(msg.peer || "")) for (const p of this.ctx.getWebSockets("peer:" + msg.peer)) { try { p.close(4003, "refused by the server"); } catch {} }
        return;
      }
      const data = new Uint8Array(message);
      if (data.length < 16 || data.length > MAX_FRAME) return;
      const target = this.ctx.getWebSockets("peer:" + hex(data.subarray(0, 16)))[0];
      if (target) { try { target.send(data.subarray(16)); } catch {} }
      return;
    }
    if (typeof message === "string") return;   // devices have nothing to say to the relay itself
    const data = new Uint8Array(message);
    if (data.length > MAX_FRAME - 16) { ws.close(1009, "frame too large"); return; }
    const target = this.server();
    if (!target) return;
    const out = new Uint8Array(16 + data.length);
    out.set(unhex(this.peerOf(ws)), 0);
    out.set(data, 16);
    try { target.send(out); } catch {}
  }

  async webSocketClose(ws, code) { await this.gone(ws, code); }
  async webSocketError(ws) { await this.gone(ws, 1006); }
  async gone(ws, code) {
    const tags = this.ctx.getTags(ws);
    if (tags.includes("server")) {
      if (!this.ctx.getWebSockets("server").some((s) => s !== ws)) this.broadcast({ type: "server-offline" });
      event((await this.ctx.storage.get("record") || {}).site, "server-closed", { code });
      return;
    }
    const target = this.server(), peer = this.peerOf(ws);
    if (target && peer) this.sendText(target, { type: "peer-close", peer });
  }
}

// One per name: which site holds it. A newer grant moves it (a re-link), an older one for another site gets 409.
export class Name {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    const op = new URL(request.url).pathname;
    const rec = await this.ctx.storage.get("name");
    if (op === "/get") return rec ? json({ site: rec.site }) : json({ error: "no such name" }, 404);
    const body = await request.json();
    if (op === "/revoke") {
      const was = rec ? rec.site : null;
      await this.ctx.storage.delete("name");
      await this.ctx.storage.put("revoked", Math.max(body.iat, (await this.ctx.storage.get("revoked")) || 0));
      return json({ ok: true, site: was });
    }
    if (op === "/claim") {
      if (body.iat <= ((await this.ctx.storage.get("revoked")) || 0)) return json({ error: "revoked" }, 409);
      if (rec && rec.site !== body.site && !(body.iat > (rec.iat || 0))) return json({ error: "taken" }, 409);
      await this.ctx.storage.put("name", { site: body.site, iat: body.iat, since: Date.now() });
      return json({ ok: true, moved: rec && rec.site !== body.site ? rec.site : null });
    }
    if (op === "/release" && rec && rec.site === body.site) await this.ctx.storage.delete("name");   // keeps any revocation mark
    return json({ ok: true });
  }
}

// One per invite id. Holds the sealed box until it expires or its lookups run out; an alarm deletes it afterwards.
export class Invite {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    const op = new URL(request.url).pathname;
    const rec = await this.ctx.storage.get("invite");
    const live = rec && rec.expires * 1000 > Date.now() && rec.left > 0;
    if (op === "/put") {
      const { site, box, expires, lookups } = await request.json();
      if (live && rec.site !== site) return json({ error: "code already in use" }, 409);
      await this.ctx.storage.put("invite", { site, box, expires, left: lookups });
      await this.ctx.storage.setAlarm(expires * 1000 + 60000);
      return json({ ok: true }, 201);
    }
    if (op === "/delete") {
      const { site } = await request.json();
      if (rec && rec.site === site) await this.ctx.storage.deleteAll();
      return json({ ok: true });
    }
    if (!live) return json({ error: "no such code, or it expired" }, 404);
    rec.left--;
    if (rec.left > 0) await this.ctx.storage.put("invite", rec); else await this.ctx.storage.deleteAll();
    return json({ box: rec.box, expires: rec.expires });
  }
  async alarm() { await this.ctx.storage.deleteAll(); }
}

// Fixed-window counter used for registration, invite-lookup and device connection rate limits.
export class Limit {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    const max = Number(new URL(request.url).searchParams.get("max") || 10);
    const hour = Math.floor(Date.now() / 3600000);
    const state = (await this.ctx.storage.get("state")) || { hour, count: 0 };
    if (state.hour !== hour) { state.hour = hour; state.count = 0; }
    if (state.count >= max) return json({ ok: false });
    state.count++;
    await this.ctx.storage.put("state", state);
    return json({ ok: true });
  }
}
