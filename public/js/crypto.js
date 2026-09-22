/*
 * Anumati cryptographic primitives. Shared verbatim by the browser apps
 * and the Node server, so the bytes that get signed are defined once.
 *
 * Patient identity: an ECDSA P-256 keypair generated on the patient's
 * phone with extractable=false. The private key can sign consents and
 * revocations but can never be read out, even by this code.
 *
 * Each consent grant encrypts the shared subset of the record with a
 * fresh AES-256-GCM key. That key travels only inside the QR link's
 * URL fragment, which browsers never send to a server, so the server
 * stores ciphertext it cannot read. The grant id is bound in as
 * additional authenticated data, so ciphertexts cannot be swapped
 * between grants.
 */

const te = new TextEncoder();
const td = new TextDecoder();

export const GENESIS = "0".repeat(64);

export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64url(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export function randomId(bytes = 16) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/* Deterministic JSON with recursively sorted keys, so any verifier can
 * reproduce the exact byte sequence that was signed. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}

export async function generatePatientKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { privateKey: pair.privateKey, publicJwk: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y } };
}

/* Short stable identifier for a public key: first 16 hex chars of the
 * SHA-256 of its canonical JWK. */
export async function keyId(publicJwk) {
  const { kty, crv, x, y } = publicJwk;
  return hex(await sha256(te.encode(canonicalJson({ crv, kty, x, y })))).slice(0, 16);
}

export async function signObject(obj, privateKey) {
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, te.encode(canonicalJson(obj)));
  return b64url(new Uint8Array(sig));
}

export async function verifyObject(obj, sig, publicJwk) {
  try {
    const pub = await crypto.subtle.importKey("jwk", { ...publicJwk, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, unb64url(sig), te.encode(canonicalJson(obj)));
  } catch {
    return false;
  }
}

export async function newGrantKey() {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  return { key, raw: b64url(raw) };
}

export async function encryptJson(obj, key, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad) }, key, te.encode(JSON.stringify(obj)));
  return { iv: b64url(iv), ct: b64url(new Uint8Array(ct)) };
}

export async function decryptJson({ iv, ct }, rawKey, aad) {
  const key = await crypto.subtle.importKey("raw", unb64url(rawKey), { name: "AES-GCM" }, false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64url(iv), additionalData: te.encode(aad) }, key, unb64url(ct));
  return JSON.parse(td.decode(pt));
}

/* Access log entries form a hash chain:
 *   hash_n = SHA-256(hash_{n-1} || canonicalJson({seq, type, at, detail}))
 * Editing, removing or reordering any entry breaks every later hash. */
export async function chainHash(prev, entry) {
  const { seq, type, at, detail } = entry;
  return hex(await sha256(te.encode(prev + canonicalJson({ at, detail, seq, type }))));
}

export async function verifyChain(events) {
  let prev = GENESIS;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.seq !== i || e.prev !== prev || e.hash !== (await chainHash(prev, e))) return { ok: false, brokenAt: i };
    prev = e.hash;
  }
  return { ok: true, head: prev, length: events.length };
}
