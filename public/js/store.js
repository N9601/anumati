/*
 * On-device storage for the patient app.
 *
 * The health record lives in localStorage on the patient's phone; it is
 * never uploaded in the clear. The patient signing key lives in
 * IndexedDB as a non-extractable CryptoKey (structured-cloned, so the
 * private bytes are never exposed to JavaScript).
 */

import { generatePatientKey, keyId } from "./crypto.js";

const RECORD_KEY = "anumati.record.v1";
const GRANTS_KEY = "anumati.grants.v1";

const day = 24 * 3600 * 1000;
const ago = (d) => new Date(Date.now() - d * day).toISOString().slice(0, 10);

/* A fictional demo patient. Every name, number and facility is invented. */
export function seedRecord() {
  return {
    patient: {
      name: "Lakshmi Devi",
      age: 58,
      sex: "F",
      bloodGroup: "B+",
      abha: { number: "91-0000-0000-0000", address: "lakshmi.demo@sbx", status: "Demo, not linked to ABDM" },
      emergencyContact: { name: "Ravi (son)", phone: "+91 90000 00001" },
    },
    allergies: [
      { id: "a1", substance: "Penicillin", reaction: "Anaphylaxis", severity: "severe", recorded: ago(2380), source: "District Hospital" },
      { id: "a2", substance: "Sulfonamides (sulfa drugs)", reaction: "Skin rash", severity: "moderate", recorded: ago(1150), source: "Sunrise Family Clinic" },
    ],
    conditions: [
      { id: "c1", name: "Type 2 diabetes mellitus", since: "2016", status: "active", source: "Primary Health Centre, Nizampet" },
      { id: "c2", name: "Hypertension", since: "2018", status: "active", source: "Sunrise Family Clinic" },
      { id: "c3", name: "Chronic kidney disease, stage 2", since: "2025", status: "active", source: "District Hospital" },
    ],
    medications: [
      { id: "m1", name: "Metformin", dose: "500 mg", frequency: "Twice daily after food", since: "2016-05", prescriber: "Primary Health Centre, Nizampet" },
      { id: "m2", name: "Amlodipine", dose: "5 mg", frequency: "Once daily, morning", since: "2018-11", prescriber: "Sunrise Family Clinic" },
      { id: "m3", name: "Atorvastatin", dose: "10 mg", frequency: "Once daily, night", since: "2023-01", prescriber: "District Hospital" },
    ],
    labs: [
      { id: "l1", test: "HbA1c", value: "7.8 %", ref: "below 7.0 %", flag: "high", date: ago(12), facility: "District Hospital" },
      { id: "l2", test: "Serum creatinine", value: "1.3 mg/dL", ref: "0.6 to 1.1", flag: "high", date: ago(12), facility: "District Hospital" },
      { id: "l3", test: "Fasting blood sugar", value: "142 mg/dL", ref: "70 to 100", flag: "high", date: ago(40), facility: "Primary Health Centre, Nizampet" },
      { id: "l4", test: "Lipid profile, LDL", value: "98 mg/dL", ref: "below 100", flag: "normal", date: ago(95), facility: "District Hospital" },
      { id: "l5", test: "ECG", value: "Normal sinus rhythm", ref: "", flag: "normal", date: ago(210), facility: "Sunrise Family Clinic" },
      { id: "l6", test: "Chest X-ray", value: "No active lesion", ref: "", flag: "normal", date: ago(820), facility: "District Hospital" },
    ],
    visits: [
      { id: "v1", date: ago(12), facility: "District Hospital", type: "OP consultation", department: "General Medicine", note: "Diabetes review. HbA1c above target, creatinine mildly raised. Continue metformin, recheck kidney function in 3 months." },
      { id: "v2", date: ago(40), facility: "Primary Health Centre, Nizampet", type: "OP consultation", department: "General OPD", note: "Routine BP and sugar check. BP 138/86 mmHg. Advised diet control." },
      { id: "v3", date: ago(190), facility: "Sunrise Family Clinic", type: "OP consultation", department: "Family Medicine", note: "Viral fever for 2 days. Paracetamol 650 mg for 3 days. Resolved." },
    ],
    immunizations: [
      { id: "i1", vaccine: "Tetanus toxoid", date: ago(400), facility: "Primary Health Centre, Nizampet" },
      { id: "i2", vaccine: "COVID-19, dose 2", date: ago(1550), facility: "Primary Health Centre, Nizampet" },
    ],
  };
}

export function loadRecord() {
  try {
    const raw = localStorage.getItem(RECORD_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  const r = seedRecord();
  saveRecord(r);
  return r;
}

export function saveRecord(r) {
  try { localStorage.setItem(RECORD_KEY, JSON.stringify(r)); } catch {}
}

export function resetRecord() {
  const r = seedRecord();
  saveRecord(r);
  return r;
}

export function loadGrants() {
  try { return JSON.parse(localStorage.getItem(GRANTS_KEY) || "[]"); } catch { return []; }
}

export function saveGrants(list) {
  try { localStorage.setItem(GRANTS_KEY, JSON.stringify(list)); } catch {}
}

/* ---- non-extractable patient key in IndexedDB ---- */

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("anumati", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("keys");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(k) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const r = db.transaction("keys").objectStore("keys").get(k);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbPut(k, v) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("keys", "readwrite");
    tx.objectStore("keys").put(v, k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let cached = null;

export async function patientKey() {
  if (cached) return cached;
  let k = await idbGet("patient").catch(() => null);
  if (!k) {
    const fresh = await generatePatientKey();
    k = { ...fresh, id: await keyId(fresh.publicJwk), createdAt: new Date().toISOString() };
    await idbPut("patient", k).catch(() => {});
  }
  cached = k;
  return k;
}

/* Scope filtering: returns only the categories the patient ticked, and
 * for dated categories only entries on or after `from`. */
export function subsetFor(record, scope, from) {
  const inRange = (d) => !from || !d || d >= from;
  const out = { patient: record.patient };
  if (scope.includes("allergies")) out.allergies = record.allergies;
  if (scope.includes("conditions")) out.conditions = record.conditions;
  if (scope.includes("medications")) out.medications = record.medications;
  if (scope.includes("labs")) out.labs = record.labs.filter((l) => inRange(l.date));
  if (scope.includes("visits")) out.visits = record.visits.filter((v) => inRange(v.date));
  if (scope.includes("immunizations")) out.immunizations = record.immunizations.filter((i) => inRange(i.date));
  return out;
}

export const CATEGORIES = [
  { key: "allergies", label: "Allergies", abdm: "AllergyIntolerance" },
  { key: "medications", label: "Current medicines", abdm: "Prescription" },
  { key: "conditions", label: "Conditions", abdm: "Condition" },
  { key: "labs", label: "Lab reports", abdm: "DiagnosticReport" },
  { key: "visits", label: "Visit notes", abdm: "OPConsultation" },
  { key: "immunizations", label: "Vaccinations", abdm: "ImmunizationRecord" },
];
