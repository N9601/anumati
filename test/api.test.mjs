import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  generatePatientKey, keyId, signObject, newGrantKey, encryptJson, decryptJson, randomId, verifyChain,
} from "../public/js/crypto.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8199;
const BASE = `http://localhost:${PORT}`;
let server;
let dataDir;

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "anumati-"));
  server = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir } });
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (d) => String(d).includes("running") && resolve());
    server.on("exit", (c) => reject(new Error("server exited " + c)));
  });
});

after(async () => {
  server.kill();
  await rm(dataDir, { recursive: true, force: true });
});

async function makeGrant(patient, { expiresInMs = 3600_000, scope = ["allergies", "medications"], tamper } = {}) {
  const id = randomId(16);
  const now = new Date();
  const artifact = {
    v: 1, id,
    patient: { key: patient.publicJwk, keyId: await keyId(patient.publicJwk) },
    grantee: "Test doctor", purpose: "consultation", scope,
    abdmHiTypes: ["AllergyIntolerance", "Prescription"], dataFrom: null,
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + expiresInMs).toISOString(),
  };
  const sig = await signObject(artifact, patient.privateKey);
  const { key, raw } = await newGrantKey();
  const record = { patient: { name: "Test Patient" }, allergies: [{ substance: "Penicillin" }] };
  const { iv, ct } = await encryptJson(record, key, id);
  if (tamper) tamper(artifact);
  const res = await fetch(`${BASE}/api/grants`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ artifact, sig, iv, ct }) });
  return { res, id, raw, ct, artifact };
}

async function revoke(signer, id) {
  const at = new Date().toISOString();
  const sig = await signObject({ action: "revoke", id, at }, signer.privateKey);
  return fetch(`${BASE}/api/grants/${id}/revoke`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ at, sig }) });
}

test("patient grants consent and provider decrypts only with the QR key", async () => {
  const patient = await generatePatientKey();
  const { res, id, raw } = await makeGrant(patient);
  assert.equal(res.status, 201);

  const open = await fetch(`${BASE}/api/grants/${id}`);
  assert.equal(open.status, 200);
  const body = await open.json();
  const record = await decryptJson(body, raw, id);
  assert.equal(record.allergies[0].substance, "Penicillin");

  const wrong = await newGrantKey();
  await assert.rejects(decryptJson(body, wrong.raw, id), "a different key must not decrypt");
  await assert.rejects(decryptJson(body, raw, randomId(16)), "ciphertext must be bound to its grant id");
});

test("server rejects a consent edited after the patient signed it", async () => {
  const patient = await generatePatientKey();
  const { res } = await makeGrant(patient, { tamper: (a) => a.scope.push("labs") });
  assert.equal(res.status, 403);
});

test("server rejects a consent whose key id does not match its key", async () => {
  const patient = await generatePatientKey();
  const { res } = await makeGrant(patient, { tamper: (a) => { a.patient.keyId = "0000000000000000"; } });
  assert.equal(res.status, 400);
});

test("only the granting patient can revoke", async () => {
  const patient = await generatePatientKey();
  const attacker = await generatePatientKey();
  const { id } = await makeGrant(patient);
  const r = await revoke(attacker, id);
  assert.equal(r.status, 403);
  assert.equal((await fetch(`${BASE}/api/grants/${id}`)).status, 200, "grant must still be active");
});

test("revocation deletes the ciphertext, blocks reopening, and pushes a live event", async () => {
  const patient = await generatePatientKey();
  const { id, ct } = await makeGrant(patient);
  assert.equal((await fetch(`${BASE}/api/grants/${id}`)).status, 200);

  const sse = await fetch(`${BASE}/api/grants/${id}/events`);
  const reader = sse.body.getReader();
  const seen = (async () => {
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      buf += new TextDecoder().decode(value);
      const m = buf.match(/data: (\{.*"revoked".*\})\n/);
      if (m) return JSON.parse(m[1]);
    }
  })();

  assert.equal((await revoke(patient, id)).status, 200);
  const ev = await seen;
  assert.equal(ev.event.type, "revoked");
  reader.cancel();

  const again = await fetch(`${BASE}/api/grants/${id}`);
  assert.equal(again.status, 410);
  assert.equal((await again.json()).status, "revoked");

  await new Promise((r) => setTimeout(r, 400));
  const stored = await readFile(path.join(dataDir, "store.json"), "utf8");
  assert.ok(!stored.includes(ct), "ciphertext must be gone from disk after revocation");

  const log = await (await fetch(`${BASE}/api/grants/${id}/log`)).json();
  assert.deepEqual(log.events.map((e) => e.type), ["granted", "opened", "revoked", "denied"]);
  assert.equal((await verifyChain(log.events)).ok, true);
});

test("an edited access log fails verification", async () => {
  const patient = await generatePatientKey();
  const { id } = await makeGrant(patient);
  await fetch(`${BASE}/api/grants/${id}`);
  const log = await (await fetch(`${BASE}/api/grants/${id}/log`)).json();
  log.events[1].detail.device = "Someone else";
  const check = await verifyChain(log.events);
  assert.equal(check.ok, false);
  assert.equal(check.brokenAt, 1);
});

test("consent expires on its own and the ciphertext is purged", async () => {
  const patient = await generatePatientKey();
  const { id } = await makeGrant(patient, { expiresInMs: 1500 });
  assert.equal((await fetch(`${BASE}/api/grants/${id}`)).status, 200);
  await new Promise((r) => setTimeout(r, 2600));
  const r = await fetch(`${BASE}/api/grants/${id}`);
  assert.equal(r.status, 410);
  assert.equal((await r.json()).status, "expired");
});
