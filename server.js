/*
 * Anumati relay server. Zero dependencies, Node 20+.
 *
 * The server is deliberately blind: it holds ciphertext, the signed
 * consent artifact and the access log, never a decryption key. It
 * enforces consent (serves ciphertext only while a grant is active and
 * unexpired) and revocation (deletes the ciphertext and pushes a live
 * event to every open provider screen).
 */

import http from "node:http";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyObject, chainHash, keyId, GENESIS } from "./public/js/crypto.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const STORE = path.join(DATA_DIR, "store.json");
const PORT = Number(process.env.PORT || 8093);
const PUBLIC_URL = process.env.PUBLIC_URL || null;

const MAX_BODY = 2 * 1024 * 1024;
const MAX_GRANT_MS = 7 * 24 * 3600 * 1000;
const CLOCK_SKEW_MS = 10 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const SCOPES = new Set(["allergies", "conditions", "medications", "labs", "visits", "immunizations"]);
const PURPOSES = new Set(["consultation", "emergency", "second-opinion", "pharmacy"]);

/** @type {Map<string, any>} */
let grants = new Map();
/** @type {Map<string, Set<http.ServerResponse>>} */
const streams = new Map();

async function load() {
  if (!existsSync(STORE)) return;
  const raw = JSON.parse(await readFile(STORE, "utf8"));
  grants = new Map(Object.entries(raw));
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    const tmp = STORE + ".tmp";
    await writeFile(tmp, JSON.stringify(Object.fromEntries(grants)));
    await rename(tmp, STORE);
  }, 150);
}

async function appendEvent(g, type, detail = {}) {
  const prev = g.events.length ? g.events[g.events.length - 1].hash : GENESIS;
  const entry = { seq: g.events.length, type, at: new Date().toISOString(), detail };
  entry.prev = prev;
  entry.hash = await chainHash(prev, entry);
  g.events.push(entry);
  save();
  broadcast(g.artifact.id, { kind: "event", status: g.status, event: entry });
  return entry;
}

function broadcast(id, msg) {
  const set = streams.get(id);
  if (!set) return;
  const frame = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of set) res.write(frame);
}

function destroyData(g) {
  delete g.iv;
  delete g.ct;
}

async function expireIfDue(g) {
  if (g.status === "active" && Date.parse(g.artifact.expiresAt) <= Date.now()) {
    g.status = "expired";
    destroyData(g);
    await appendEvent(g, "expired", { reason: "Consent period ended" });
  }
}

function device(req) {
  const ua = req.headers["user-agent"] || "";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "Unknown OS";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${os} · ${browser}`;
}

function send(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error("Body too large"), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(Object.assign(new Error("Invalid JSON"), { code: 400 })); }
    });
    req.on("error", reject);
  });
}

function validArtifact(a) {
  if (!a || a.v !== 1 || !ID_RE.test(a.id || "")) return "Malformed consent artifact";
  const k = a.patient?.key;
  if (!k || k.kty !== "EC" || k.crv !== "P-256" || typeof k.x !== "string" || typeof k.y !== "string") return "Patient key must be an EC P-256 JWK";
  if (!PURPOSES.has(a.purpose)) return "Unknown purpose";
  if (!Array.isArray(a.scope) || a.scope.length === 0 || !a.scope.every((s) => SCOPES.has(s))) return "Scope must list known record categories";
  if (typeof a.grantee !== "string" || a.grantee.length > 120) return "Grantee label missing or too long";
  const created = Date.parse(a.createdAt);
  const expires = Date.parse(a.expiresAt);
  if (!Number.isFinite(created) || Math.abs(created - Date.now()) > CLOCK_SKEW_MS) return "createdAt is not close to server time";
  if (!Number.isFinite(expires) || expires <= Date.now() || expires - created > MAX_GRANT_MS) return "expiresAt must be in the future and within 7 days";
  return null;
}

async function createGrant(req, res) {
  const { artifact, sig, iv, ct } = await readBody(req);
  const problem = validArtifact(artifact);
  if (problem) return send(res, 400, { error: problem });
  if (typeof iv !== "string" || typeof ct !== "string") return send(res, 400, { error: "Missing ciphertext" });
  if (grants.has(artifact.id)) return send(res, 409, { error: "Grant id already used" });
  if (artifact.patient.keyId !== (await keyId(artifact.patient.key))) return send(res, 400, { error: "keyId does not match patient key" });
  if (!(await verifyObject(artifact, sig, artifact.patient.key))) return send(res, 403, { error: "Consent signature does not verify against the patient key" });

  const g = { artifact, sig, iv, ct, status: "active", events: [] };
  grants.set(artifact.id, g);
  await appendEvent(g, "granted", { grantee: artifact.grantee, purpose: artifact.purpose, scope: artifact.scope, expiresAt: artifact.expiresAt });
  send(res, 201, { id: artifact.id, status: g.status });
}

async function openGrant(req, res, g) {
  await expireIfDue(g);
  if (g.status !== "active") {
    await appendEvent(g, "denied", { device: device(req), reason: g.status === "revoked" ? "Consent revoked" : "Consent expired" });
    const last = g.events.find((e) => e.type === g.status);
    return send(res, 410, { status: g.status, at: last?.at || null });
  }
  await appendEvent(g, "opened", { device: device(req) });
  send(res, 200, { artifact: g.artifact, sig: g.sig, iv: g.iv, ct: g.ct, status: g.status });
}

async function revokeGrant(req, res, g) {
  const { at, sig } = await readBody(req);
  const t = Date.parse(at);
  if (!Number.isFinite(t) || Math.abs(t - Date.now()) > 5 * 60 * 1000) return send(res, 400, { error: "Revocation timestamp missing or stale" });
  const statement = { action: "revoke", id: g.artifact.id, at };
  if (!(await verifyObject(statement, sig, g.artifact.patient.key))) return send(res, 403, { error: "Revocation must be signed by the patient who granted consent" });
  if (g.status === "revoked") return send(res, 200, { status: g.status });
  await expireIfDue(g);
  if (g.status === "expired") return send(res, 200, { status: g.status });
  g.status = "revoked";
  destroyData(g);
  await appendEvent(g, "revoked", { by: "patient", signature: sig.slice(0, 16) });
  send(res, 200, { status: g.status });
}

function openStream(req, res, g) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write(`data: ${JSON.stringify({ kind: "hello", status: g.status, expiresAt: g.artifact.expiresAt })}\n\n`);
  const id = g.artifact.id;
  if (!streams.has(id)) streams.set(id, new Set());
  streams.get(id).add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 20000);
  req.on("close", () => { clearInterval(ping); streams.get(id)?.delete(res); });
}

function publicView(g) {
  return { artifact: g.artifact, status: g.status, events: g.events };
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};

const DOCTOR_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";

async function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const file = path.normalize(path.join(PUBLIC, decodeURIComponent(rel)));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: "Forbidden" });
  try {
    const body = await readFile(file);
    const headers = {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    };
    if (path.basename(file) === "doctor.html") headers["Content-Security-Policy"] = DOCTOR_CSP;
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    send(res, 404, { error: "Not found" });
  }
}

async function route(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  if (p === "/api/config" && req.method === "GET") return send(res, 200, { publicUrl: PUBLIC_URL });
  if (p === "/api/grants" && req.method === "POST") return createGrant(req, res);

  const m = p.match(/^\/api\/grants\/([A-Za-z0-9_-]{22})(\/[a-z]+)?$/);
  if (m) {
    const g = grants.get(m[1]);
    if (!g) return send(res, 404, { error: "No such consent" });
    const sub = m[2] || "";
    if (sub === "" && req.method === "GET") return openGrant(req, res, g);
    if (sub === "/revoke" && req.method === "POST") return revokeGrant(req, res, g);
    if (sub === "/events" && req.method === "GET") return openStream(req, res, g);
    if (sub === "/log" && req.method === "GET") { await expireIfDue(g); return send(res, 200, publicView(g)); }
    return send(res, 405, { error: "Method not allowed" });
  }

  if (p.startsWith("/api/")) return send(res, 404, { error: "Unknown endpoint" });
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method not allowed" });
  return serveStatic(req, res, p);
}

await load();

setInterval(async () => {
  for (const g of grants.values()) await expireIfDue(g);
}, 1000);

http
  .createServer((req, res) => {
    route(req, res).catch((err) => send(res, err.code >= 400 && err.code < 600 ? err.code : 500, { error: err.message || "Server error" }));
  })
  .listen(PORT, () => {
    console.log(`Anumati running at http://localhost:${PORT}`);
    console.log(`  patient app   http://localhost:${PORT}/`);
    console.log(`  stage demo    http://localhost:${PORT}/demo.html`);
    if (PUBLIC_URL) console.log(`  QR links use  ${PUBLIC_URL}`);
  });
