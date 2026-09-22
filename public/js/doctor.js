/*
 * Provider view. Opened by scanning the patient's consent QR:
 *   /doctor.html#<grantId>.<aesKey>
 * The fragment never reaches the server. This page fetches the
 * ciphertext, verifies the patient's signature on the consent, decrypts
 * locally, and wipes everything the moment the patient revokes.
 */

import { decryptJson, verifyObject, keyId } from "./crypto.js";
import { CATEGORIES } from "./store.js";
import { html, render, fmtDate, fmtTime, agoText, daysSince, countdown, initials, PURPOSE_LABEL, icon } from "./ui.js";

const RECENT_DAYS = 90;
const view = document.getElementById("view");
const [id, key] = location.hash.slice(1).split(".");

let payload = null;
let artifact = null;
let stream = null;
let ended = false;
let ticker = null;

function stateScreen(tone, ic, title, body) {
  render(view, html`<div class="state-screen ${tone}"><div><div class="icon">${ic}</div><h1>${title}</h1><p>${body}</p></div></div>`);
}

function end(status, at) {
  if (ended) return;
  ended = true;
  payload = null;
  artifact = null;
  stream?.close();
  clearInterval(ticker);
  history.replaceState(null, "", location.pathname);
  const when = at ? ` at ${fmtTime(at)}` : "";
  if (status === "revoked") {
    stateScreen("", icon.lock, "Access revoked by the patient", `The patient withdrew consent${when}. The shared record has been removed from this screen and this link can no longer open it.`);
  } else {
    stateScreen("neutral", icon.clock, "Consent period ended", `This consent expired${when}. Ask the patient to share again if you still need their history.`);
  }
}

function recentNote(dateIso, facility) {
  const n = daysSince(dateIso);
  if (n > RECENT_DAYS) return "";
  return html`<div class="recent">Done ${agoText(dateIso)} at ${facility}. Check before ordering again.</div>`;
}

function section(title, items, row) {
  return html`<section class="card"><h2>${title} <span class="count">${items.length}</span></h2>${items.length ? items.map(row) : html`<p class="muted" style="margin:0">None in the shared period.</p>`}</section>`;
}

async function showRecord(sigOk) {
  const p = payload.patient;
  const scope = artifact.scope;
  const has = (k) => scope.includes(k);
  const notShared = CATEGORIES.filter((c) => !has(c.key));
  const recentLabs = (payload.labs || []).filter((l) => daysSince(l.date) <= RECENT_DAYS).length;

  render(view, html`
    <div class="consent-strip">
      <span><b>Consent from patient</b> for ${PURPOSE_LABEL[artifact.purpose] || artifact.purpose}</span>
      <span>Expires in <span class="countdown" id="left">${countdown(Date.parse(artifact.expiresAt) - Date.now())}</span></span>
      ${sigOk
        ? html`<span class="pill ok">${icon.check} Signed by patient key ${artifact.patient.keyId.slice(0, 8)}</span>`
        : html`<span class="pill danger">${icon.alert} Signature invalid</span>`}
    </div>

    <section class="card">
      <div class="patient-head">
        <div class="avatar">${initials(p.name)}</div>
        <div>
          <div class="name">${p.name}</div>
          <div class="meta">${p.age} years · ${p.sex === "F" ? "Female" : "Male"} · Blood group ${p.bloodGroup}</div>
        </div>
      </div>
      <dl class="kv">
        <dt>ABHA</dt><dd>${p.abha.number} <span class="pill warn">${p.abha.status}</span></dd>
        <dt>Shared with</dt><dd>${artifact.grantee}</dd>
        <dt>Records from</dt><dd>${artifact.dataFrom ? fmtDate(artifact.dataFrom) : "All time"}</dd>
      </dl>
    </section>

    ${has("allergies")
      ? payload.allergies.length
        ? html`<div class="allergy-banner"><div class="label">${icon.alert} Allergies</div><ul>${payload.allergies.map((a) => html`<li>${a.substance} <span>${a.reaction}, ${a.severity} · recorded ${fmtDate(a.recorded)}, ${a.source}</span></li>`)}</ul></div>`
        : html`<div class="allergy-banner none"><div class="label">No known allergies recorded</div></div>`
      : html`<div class="allergy-banner none"><div class="label">Allergies were not shared by the patient</div></div>`}

    ${has("medications") ? section("Current medicines", payload.medications, (m) => html`<div class="row"><div class="main"><div class="name">${m.name} ${m.dose}</div><div class="meta">${m.frequency}</div><div class="meta">${m.prescriber}${m.unverified ? " · patient-imported, unverified" : ""}</div></div><div class="side">since ${m.since}</div></div>`) : ""}

    ${has("conditions") ? section("Conditions", payload.conditions, (c) => html`<div class="row"><div class="main"><div class="name">${c.name}</div><div class="meta">${c.source}</div></div><div class="side">since ${c.since}</div></div>`) : ""}

    ${has("labs") ? html`<section class="card">
      <h2>Lab reports <span class="count">${payload.labs.length}${recentLabs ? html` · ${recentLabs} recent` : ""}</span></h2>
      ${payload.labs.length ? payload.labs.map((l) => html`<div class="row"><div class="main"><div class="name">${l.test}</div><div class="meta">${l.facility} · ${fmtDate(l.date)}${l.ref ? html` · ref ${l.ref}` : ""}</div>${recentNote(l.date, l.facility)}</div><div class="side ${l.flag === "high" ? "flag-high" : ""}">${l.value}</div></div>`) : html`<p class="muted" style="margin:0">None in the shared period.</p>`}
    </section>` : ""}

    ${has("visits") ? section("Visit notes", payload.visits, (v) => html`<div class="row"><div class="main"><div class="name">${v.facility}</div><div class="meta">${v.department} · ${fmtDate(v.date)}</div><div style="margin-top:3px">${v.note}</div></div></div>`) : ""}

    ${has("immunizations") ? section("Vaccinations", payload.immunizations, (i) => html`<div class="row"><div class="main"><div class="name">${i.vaccine}</div><div class="meta">${i.facility}</div></div><div class="side">${fmtDate(i.date)}</div></div>`) : ""}

    ${notShared.length ? html`<div class="card not-shared">Not shared by the patient: ${notShared.map((c) => html`<span class="pill">${c.label}</span>`)}</div>` : ""}

    <p class="hint center">This view was recorded in the patient's access history. Nothing is stored on this device. The patient can revoke consent at any time and this screen will clear.</p>
  `);

  ticker = setInterval(() => {
    const left = Date.parse(artifact?.expiresAt) - Date.now();
    const el = document.getElementById("left");
    if (el) el.textContent = countdown(left);
    if (left <= 0) end("expired", new Date().toISOString());
  }, 1000);
}

function listen() {
  stream = new EventSource(`/api/grants/${id}/events`);
  stream.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.kind === "hello" && msg.status !== "active") return end(msg.status);
    if (msg.kind === "event" && (msg.event.type === "revoked" || msg.event.type === "expired")) end(msg.event.type, msg.event.at);
  };
}

async function main() {
  render(document.getElementById("mark"), icon.mark);
  if (!/^[A-Za-z0-9_-]{22}$/.test(id || "") || !key) {
    return stateScreen("neutral", icon.lock, "Invalid consent link", "This link is incomplete. Ask the patient to show their consent QR again.");
  }
  if (!window.crypto?.subtle) {
    return stateScreen("neutral", icon.lock, "Secure connection required", "Open this link over HTTPS so the record can be decrypted on this device.");
  }

  let res;
  try {
    res = await fetch(`/api/grants/${id}`, { cache: "no-store" });
  } catch {
    return stateScreen("neutral", icon.lock, "No connection", "Could not reach the server. Check the internet connection and scan again.");
  }
  if (res.status === 404) return stateScreen("neutral", icon.lock, "Consent not found", "This consent does not exist or has been removed.");
  if (res.status === 410) {
    const b = await res.json();
    return end(b.status, b.at);
  }

  const body = await res.json();
  artifact = body.artifact;
  const sigOk =
    artifact.id === id &&
    artifact.patient.keyId === (await keyId(artifact.patient.key)) &&
    (await verifyObject(artifact, body.sig, artifact.patient.key));

  try {
    payload = await decryptJson(body, key, id);
  } catch {
    artifact = null;
    return stateScreen("", icon.lock, "Could not open the record", "The key in this link does not match. It may have been altered. Ask the patient to show their QR again.");
  }
  await showRecord(sigOk);
  listen();
}

main();
