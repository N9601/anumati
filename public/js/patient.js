import { encryptJson, newGrantKey, randomId, signObject, verifyChain } from "./crypto.js";
import { loadRecord, resetRecord, loadGrants, saveGrants, patientKey, subsetFor, CATEGORIES } from "./store.js";
import { html, raw, render, fmtDate, fmtTime, agoText, countdown, initials, toast, PURPOSE_LABEL, icon } from "./ui.js";
import { importPrescription } from "./ocr-import.js";

let record = loadRecord();
let grants = loadGrants();
let publicUrl = null;
let live = null;
let refresher = null;
const openLogs = new Set();

const view = document.getElementById("view");
const demo = "BroadcastChannel" in window ? new BroadcastChannel("anumati-demo") : null;

fetch("/api/config").then((r) => r.json()).then((c) => { publicUrl = c.publicUrl; }).catch(() => {});

const TABS = [
  ["record", "My record", icon.record],
  ["share", "Share", icon.share],
  ["access", "Access", icon.access],
  ["emergency", "Emergency", icon.emergency],
];

const DURATIONS = [
  [5, "5 min"],
  [60, "1 hour"],
  [1440, "24 hours"],
  [10080, "7 days"],
];

const RANGES = [
  [183, "Last 6 months"],
  [730, "Last 2 years"],
  [0, "All time"],
];

const PURPOSE_PRESET = {
  consultation: ["allergies", "medications", "conditions", "labs", "visits"],
  emergency: ["allergies", "medications", "conditions"],
  "second-opinion": ["allergies", "medications", "conditions", "labs", "visits", "immunizations"],
  pharmacy: ["allergies", "medications"],
};

const catLabel = (k) => CATEGORIES.find((c) => c.key === k)?.label || k;

function linkFor(g) {
  const base = (publicUrl || location.origin).replace(/\/$/, "");
  return `${base}/doctor.html#${g.id}.${g.key}`;
}

function qrSvg(text) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
}

function stopLive() {
  if (live) { live.close(); live = null; }
  clearInterval(refresher);
  refresher = null;
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

function go() {
  stopLive();
  const [tab, arg] = (location.hash.slice(1) || "record").split("/");
  render(document.getElementById("tabs"), html`${TABS.map(([k, label, ic]) => html`<a href="#${k}" class="${k === tab ? "on" : ""}">${ic}<span>${label}</span></a>`)}`);
  window.scrollTo(0, 0);
  if (tab === "share" && arg) return renderGrantScreen(arg);
  if (tab === "share") return renderShareForm();
  if (tab === "access") return renderAccess();
  if (tab === "emergency") return renderEmergency();
  return renderRecord();
}

/* ------------------------------------------------------------------ */
/* My record                                                           */
/* ------------------------------------------------------------------ */

function allergyBanner(allergies) {
  if (!allergies?.length) return html`<div class="allergy-banner none"><div class="label">No known allergies recorded</div></div>`;
  return html`<div class="allergy-banner">
    <div class="label">${icon.alert} Allergies</div>
    <ul>${allergies.map((a) => html`<li>${a.substance} <span>${a.reaction}, ${a.severity}</span></li>`)}</ul>
  </div>`;
}

async function renderRecord() {
  const r = record;
  const k = await patientKey();
  render(view, html`
    <section class="card">
      <div class="patient-head">
        <div class="avatar">${initials(r.patient.name)}</div>
        <div>
          <div class="name">${r.patient.name}</div>
          <div class="meta">${r.patient.age} years · ${r.patient.sex === "F" ? "Female" : "Male"} · Blood group ${r.patient.bloodGroup}</div>
        </div>
      </div>
      <dl class="kv">
        <dt>ABHA</dt><dd>${r.patient.abha.number} <span class="pill warn">${r.patient.abha.status}</span></dd>
        <dt>Device key</dt><dd class="mono">${k.id}</dd>
      </dl>
    </section>

    ${allergyBanner(r.allergies)}

    <section class="card">
      <h2>Current medicines <span class="count">${r.medications.length}</span></h2>
      ${r.medications.map((m) => html`<div class="row"><div class="main"><div class="name">${m.name} ${m.dose}</div><div class="meta">${m.frequency}</div><div class="meta">${m.prescriber}${m.unverified ? " · imported from photo, unverified" : ""}</div></div><div class="side">since ${m.since}</div></div>`)}
      <div class="btn-row" style="margin-top:10px">
        <label class="btn ghost small" for="rx-photo">Add from prescription photo</label>
      </div>
      <input id="rx-photo" type="file" accept="image/*" capture="environment" class="hidden">
      <div id="rx-result"></div>
    </section>

    <section class="card">
      <h2>Conditions <span class="count">${r.conditions.length}</span></h2>
      ${r.conditions.map((c) => html`<div class="row"><div class="main"><div class="name">${c.name}</div><div class="meta">${c.source}</div></div><div class="side">since ${c.since}</div></div>`)}
    </section>

    <section class="card">
      <h2>Lab reports <span class="count">${r.labs.length}</span></h2>
      ${r.labs.map((l) => html`<div class="row"><div class="main"><div class="name">${l.test}</div><div class="meta">${l.facility} · ${fmtDate(l.date)}</div></div><div class="side ${l.flag === "high" ? "flag-high" : ""}">${l.value}</div></div>`)}
    </section>

    <section class="card">
      <h2>Visits <span class="count">${r.visits.length}</span></h2>
      ${r.visits.map((v) => html`<div class="row"><div class="main"><div class="name">${v.facility}</div><div class="meta">${v.department} · ${fmtDate(v.date)}</div><div class="meta">${v.note}</div></div></div>`)}
    </section>

    <section class="card">
      <h2>Vaccinations <span class="count">${r.immunizations.length}</span></h2>
      ${r.immunizations.map((i) => html`<div class="row"><div class="main"><div class="name">${i.vaccine}</div><div class="meta">${i.facility}</div></div><div class="side">${fmtDate(i.date)}</div></div>`)}
    </section>

    <div class="center no-print" style="margin:18px 0 8px">
      <button class="btn ghost small" id="reset">Reset demo record</button>
    </div>
  `);

  document.getElementById("reset").onclick = () => { record = resetRecord(); toast("Demo record restored"); go(); };
  document.getElementById("rx-photo").onchange = (e) => {
    const file = e.target.files?.[0];
    if (file) importPrescription(file, document.getElementById("rx-result"), record, () => go());
  };
}

/* ------------------------------------------------------------------ */
/* Share form                                                          */
/* ------------------------------------------------------------------ */

function countFor(key) {
  const v = record[key];
  return Array.isArray(v) ? v.length : 0;
}

function renderShareForm() {
  render(view, html`
    <form class="card" id="share-form" autocomplete="off">
      <h2>Share with a provider</h2>

      <fieldset>
        <legend>Who is this for</legend>
        <input type="text" name="grantee" maxlength="80" value="Doctor at Primary Health Centre" required>
      </fieldset>

      <fieldset>
        <legend>Purpose</legend>
        <div class="segmented">
          ${Object.entries(PURPOSE_LABEL).map(([k, label], i) => html`<label><input type="radio" name="purpose" value="${k}" ${raw(i === 0 ? "checked" : "")}>${label}</label>`)}
        </div>
      </fieldset>

      <fieldset>
        <legend>What to share</legend>
        ${CATEGORIES.map((c) => html`<label class="check"><input type="checkbox" name="scope" value="${c.key}" ${raw(PURPOSE_PRESET.consultation.includes(c.key) ? "checked" : "")}>${c.label}<span class="n">${countFor(c.key)}</span></label>`)}
      </fieldset>

      <fieldset>
        <legend>Records from</legend>
        <div class="segmented">
          ${RANGES.map(([d, label]) => html`<label><input type="radio" name="range" value="${d}" ${raw(d === 730 ? "checked" : "")}>${label}</label>`)}
        </div>
      </fieldset>

      <fieldset>
        <legend>Access lasts</legend>
        <div class="segmented">
          ${DURATIONS.map(([m, label]) => html`<label><input type="radio" name="duration" value="${m}" ${raw(m === 60 ? "checked" : "")}>${label}</label>`)}
        </div>
      </fieldset>

      <button class="btn block" type="submit" id="create">Create consent QR</button>
      <p class="hint">Only what you tick is encrypted and shared. The key to open it lives inside the QR, never on the server. You can revoke at any time.</p>
    </form>
  `);

  const form = document.getElementById("share-form");
  form.querySelectorAll('input[name="purpose"]').forEach((el) =>
    el.addEventListener("change", () => {
      const preset = PURPOSE_PRESET[el.value];
      form.querySelectorAll('input[name="scope"]').forEach((c) => { c.checked = preset.includes(c.value); });
    })
  );
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = document.getElementById("create");
    btn.disabled = true;
    btn.textContent = "Encrypting and signing...";
    try {
      await createGrant(new FormData(form));
    } catch (err) {
      toast(err.message || "Could not create consent");
    } finally {
      btn.disabled = false;
      btn.textContent = "Create consent QR";
    }
  };
}

async function createGrant(fd) {
  const scope = fd.getAll("scope");
  if (!scope.length) throw new Error("Tick at least one category to share");
  const grantee = String(fd.get("grantee") || "").trim() || "Healthcare provider";
  const purpose = String(fd.get("purpose"));
  const minutes = Number(fd.get("duration"));
  const rangeDays = Number(fd.get("range"));
  const now = new Date();
  const dataFrom = rangeDays ? new Date(now.getTime() - rangeDays * 86400000).toISOString().slice(0, 10) : null;

  const k = await patientKey();
  const id = randomId(16);
  const artifact = {
    v: 1,
    id,
    patient: { key: k.publicJwk, keyId: k.id },
    grantee,
    purpose,
    scope,
    abdmHiTypes: scope.map((s) => CATEGORIES.find((c) => c.key === s).abdm),
    dataFrom,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + minutes * 60000).toISOString(),
  };
  const sig = await signObject(artifact, k.privateKey);
  const { key, raw: rawKey } = await newGrantKey();
  const payload = { ...subsetFor(record, scope, dataFrom), sharedAt: artifact.createdAt };
  const { iv, ct } = await encryptJson(payload, key, id);

  const res = await fetch("/api/grants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ artifact, sig, iv, ct }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Server refused consent (${res.status})`);

  const g = { id, key: rawKey, grantee, purpose, scope, dataFrom, createdAt: artifact.createdAt, expiresAt: artifact.expiresAt };
  grants.unshift(g);
  saveGrants(grants);
  demo?.postMessage({ type: "grant-created", link: linkFor(g) });
  location.hash = "share/" + id;
}

/* ------------------------------------------------------------------ */
/* Live consent QR screen                                              */
/* ------------------------------------------------------------------ */

async function renderGrantScreen(id) {
  const g = grants.find((x) => x.id === id);
  if (!g) { location.hash = "share"; return; }

  const state = await fetch(`/api/grants/${id}/log`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const status = state?.status || "missing";
  const opens = (state?.events || []).filter((e) => e.type === "opened");

  if (status !== "active") return renderEndedGrant(g, status, state);

  render(view, html`
    <section class="card">
      <h2>Consent QR <span class="count"><span class="pill ok"><span class="dot live"></span>Active</span></span></h2>
      <div class="qr-wrap">${raw(qrSvg(linkFor(g)))}</div>
      <div class="qr-caption">Ask the provider to scan this with their phone camera. No app or login needed.</div>

      <div class="status-line ${opens.length ? "opened" : ""}" id="status">
        ${opens.length ? html`${icon.check} Opened on ${opens.at(-1).detail.device} at ${fmtTime(opens.at(-1).at)}` : html`<span class="pill"><span class="dot live"></span></span> Waiting for the provider to scan`}
      </div>

      <dl class="kv">
        <dt>Shared with</dt><dd>${g.grantee}</dd>
        <dt>Purpose</dt><dd>${PURPOSE_LABEL[g.purpose]}</dd>
        <dt>Records from</dt><dd>${g.dataFrom ? fmtDate(g.dataFrom) : "All time"}</dd>
        <dt>Expires in</dt><dd class="countdown" data-expires="${g.expiresAt}">${countdown(Date.parse(g.expiresAt) - Date.now())}</dd>
      </dl>
      <div class="chips" style="margin-top:10px">${g.scope.map((s) => html`<span class="pill brand">${catLabel(s)}</span>`)}</div>

      <div style="margin-top:16px"><button class="btn danger block" id="revoke">Revoke access now</button></div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn ghost small" id="copy">${icon.link} Copy link</button>
        <a class="btn ghost small" href="#access">Done</a>
      </div>
    </section>
  `);

  document.getElementById("revoke").onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = "Revoking...";
    await revoke(g.id);
  };
  document.getElementById("copy").onclick = async () => {
    try { await navigator.clipboard.writeText(linkFor(g)); toast("Link copied"); } catch { toast("Copy not available here"); }
  };

  live = new EventSource(`/api/grants/${id}/events`);
  live.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.kind !== "event") return;
    const ev = msg.event;
    if (ev.type === "opened") {
      const el = document.getElementById("status");
      el.className = "status-line opened";
      render(el, html`${icon.check} Opened on ${ev.detail.device} at ${fmtTime(ev.at)}`);
    }
    if (ev.type === "revoked" || ev.type === "expired") go();
  };
}

function renderEndedGrant(g, status, state) {
  const title = status === "revoked" ? "Access revoked" : status === "expired" ? "Consent expired" : "Consent not found";
  const when = state?.events?.find((e) => e.type === status)?.at;
  render(view, html`
    <section class="card">
      <div class="state-screen ${status === "expired" ? "neutral" : ""}" style="min-height:auto;padding:22px 8px">
        <div>
          <div class="icon">${status === "expired" ? icon.clock : icon.lock}</div>
          <h1>${title}</h1>
          <p>${status === "missing" ? "The server has no record of this consent." : html`${g.grantee} can no longer open your record${when ? html` since ${fmtTime(when)}` : ""}. The encrypted copy was deleted from the server.`}</p>
        </div>
      </div>
      <div class="btn-row">
        <a class="btn ghost small" href="#access">View access history</a>
        <a class="btn small" href="#share">Share again</a>
      </div>
    </section>
  `);
}

async function revoke(id) {
  const k = await patientKey();
  const at = new Date().toISOString();
  const sig = await signObject({ action: "revoke", id, at }, k.privateKey);
  const res = await fetch(`/api/grants/${id}/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ at, sig }),
  });
  if (!res.ok) { toast((await res.json().catch(() => ({}))).error || "Revocation failed"); go(); return; }
  toast("Access revoked");
  go();
}

/* ------------------------------------------------------------------ */
/* Access history                                                      */
/* ------------------------------------------------------------------ */

function eventText(e) {
  const d = e.detail || {};
  switch (e.type) {
    case "granted": return html`<b>Consent granted</b> to ${d.grantee} for ${PURPOSE_LABEL[d.purpose] || d.purpose}: ${(d.scope || []).map(catLabel).join(", ")}`;
    case "opened": return html`<b>Opened</b> on ${d.device}`;
    case "denied": return html`<b>Blocked</b> an attempt to open on ${d.device}. ${d.reason}.`;
    case "revoked": return html`<b>Revoked</b> by you. Encrypted copy deleted from the server.`;
    case "expired": return html`<b>Expired</b>. Encrypted copy deleted from the server.`;
    default: return html`<b>${e.type}</b>`;
  }
}

function statusPill(s, expiresAt) {
  if (s === "active") return html`<span class="pill ok"><span class="dot live"></span>Active · <span class="countdown" data-expires="${expiresAt}">${countdown(Date.parse(expiresAt) - Date.now())}</span></span>`;
  if (s === "revoked") return html`<span class="pill danger">Revoked</span>`;
  if (s === "expired") return html`<span class="pill">Expired</span>`;
  return html`<span class="pill warn">Not on server</span>`;
}

async function renderAccess() {
  if (!grants.length) {
    render(view, html`<section class="card"><h2>Who can see my record</h2><p class="muted">You have not shared your record with anyone yet.</p><a class="btn block" href="#share">Share with a provider</a></section>`);
    return;
  }
  const states = await Promise.all(grants.map((g) => fetch(`/api/grants/${g.id}/log`).then((r) => (r.ok ? r.json() : null)).catch(() => null)));
  const checks = await Promise.all(states.map((s) => (s ? verifyChain(s.events) : null)));
  if (!location.hash.startsWith("#access")) return;

  const activeCount = states.filter((s) => s?.status === "active").length;
  render(view, html`
    <section class="card">
      <h2>Who can see my record <span class="count">${activeCount} active</span></h2>
      ${grants.map((g, i) => {
        const s = states[i];
        const events = s?.events || [];
        const opens = events.filter((e) => e.type === "opened").length;
        const chk = checks[i];
        return html`<div class="grant">
          <div class="grant-head">
            <div class="main">
              <div class="name">${g.grantee}</div>
              <div class="meta">${PURPOSE_LABEL[g.purpose]} · shared ${fmtDate(g.createdAt)} ${fmtTime(g.createdAt)} · opened ${opens} ${opens === 1 ? "time" : "times"}</div>
            </div>
            ${statusPill(s?.status, g.expiresAt)}
          </div>
          ${s?.status === "active" ? html`<div class="btn-row" style="margin-top:8px"><a class="btn ghost small" href="#share/${g.id}">Show QR</a><button class="btn danger small" data-revoke="${g.id}">Revoke</button></div>` : ""}
          ${s ? html`<details data-log="${g.id}" ${raw(openLogs.has(g.id) ? "open" : "")}>
            <summary>Access history, ${events.length} entries</summary>
            <ol class="log">${events.map((e) => html`<li class="t-${e.type}"><time>${fmtTime(e.at)}</time><div>${eventText(e)}<div class="hash">#${e.seq} ${e.hash.slice(0, 20)}</div></div></li>`)}</ol>
            <div class="integrity ${chk?.ok ? "" : "bad"}">${chk?.ok ? html`${icon.check} Log integrity verified on this phone: ${chk.length} linked entries, head ${chk.head.slice(0, 12)}` : html`${icon.alert} Log chain broken at entry ${chk?.brokenAt}. Someone edited this history.`}</div>
          </details>` : ""}
        </div>`;
      })}
    </section>
    <p class="hint center">Every open, block, revoke and expiry is appended to a hash-chained log. Your phone recomputes the chain, so the server cannot quietly rewrite who saw your record.</p>
  `);

  view.querySelectorAll("[data-revoke]").forEach((b) => (b.onclick = async () => { b.disabled = true; await revoke(b.dataset.revoke); }));
  view.querySelectorAll("details[data-log]").forEach((d) => d.addEventListener("toggle", () => { d.open ? openLogs.add(d.dataset.log) : openLogs.delete(d.dataset.log); }));

  if (!refresher) refresher = setInterval(() => { if (location.hash.startsWith("#access")) renderAccess(); }, 5000);
}

/* ------------------------------------------------------------------ */
/* Emergency card                                                      */
/* ------------------------------------------------------------------ */

function emergencyText(r) {
  const p = r.patient;
  const lines = [
    "EMERGENCY HEALTH CARD",
    `${p.name}, ${p.age} ${p.sex}`,
    `Blood group: ${p.bloodGroup}`,
    `ALLERGIES: ${r.allergies.length ? r.allergies.map((a) => `${a.substance} (${a.reaction.toLowerCase()})`).join("; ") : "none known"}`,
    `Conditions: ${r.conditions.map((c) => c.name).join("; ")}`,
    `Medicines: ${r.medications.map((m) => `${m.name} ${m.dose} ${m.frequency.toLowerCase()}`).join("; ")}`,
    `Emergency contact: ${p.emergencyContact.name} ${p.emergencyContact.phone}`,
    `Issued by the patient via Anumati on ${fmtDate(new Date().toISOString())}`,
  ];
  return lines.join("\n");
}

function renderEmergency() {
  const r = record;
  const text = emergencyText(r);
  render(view, html`
    <section class="emergency-card">
      <div class="hdr"><span>Emergency health card</span><span class="blood">${r.patient.bloodGroup}</span></div>
      <div style="font-size:18px;font-weight:650;margin-top:6px">${r.patient.name}</div>
      <div class="muted" style="font-size:13px">${r.patient.age} years · ${r.patient.sex === "F" ? "Female" : "Male"}</div>
      <div style="margin-top:12px">${allergyBanner(r.allergies)}</div>
      <dl class="kv" style="margin-top:0">
        <dt>Conditions</dt><dd>${r.conditions.map((c) => c.name).join(", ")}</dd>
        <dt>Medicines</dt><dd>${r.medications.map((m) => `${m.name} ${m.dose}`).join(", ")}</dd>
        <dt>Contact</dt><dd>${r.patient.emergencyContact.name}, ${r.patient.emergencyContact.phone}</dd>
      </dl>
      <div class="qr-wrap" style="margin-top:12px">${raw(qrSvg(text))}</div>
    </section>
    <p class="hint center">This QR holds plain text, not a link. Any phone camera shows it with no app and no internet, so it works in an ambulance or a basement ward. Keep it on your lock screen or print it for your wallet.</p>
    <div class="center no-print" style="margin:14px 0"><button class="btn ghost small" id="print">Print wallet card</button></div>
  `);
  document.getElementById("print").onclick = () => window.print();
}

/* ------------------------------------------------------------------ */

setInterval(() => {
  document.querySelectorAll("[data-expires]").forEach((el) => {
    el.textContent = countdown(Date.parse(el.dataset.expires) - Date.now());
  });
}, 1000);

render(document.getElementById("mark"), icon.mark);
document.getElementById("who").textContent = record.patient.name;
window.addEventListener("hashchange", go);
patientKey().catch(() => toast("This browser cannot create a secure key. Use HTTPS or localhost."));
go();
