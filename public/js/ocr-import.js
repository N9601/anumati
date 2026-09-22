/*
 * Import medicines from a photo of a printed prescription or pharmacy
 * bill. OCR runs on the phone (Tesseract.js, loaded on first use); the
 * image never leaves the device. Every imported line is marked
 * unverified and must be confirmed by the patient before it is saved.
 */

import { saveRecord } from "./store.js";
import { html, render, toast } from "./ui.js";

const TESSERACT = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";

/* Drug families that trigger a documented allergy. Deliberately small
 * and explicit: this is a visibility aid, not a clinical decision tool. */
const CROSS_REACTIVE = {
  penicillin: ["penicillin", "amoxicillin", "amoxycillin", "ampicillin", "cloxacillin", "piperacillin", "augmentin", "amoxyclav", "mox"],
  sulfonamides: ["sulfamethoxazole", "cotrimoxazole", "co-trimoxazole", "septran", "bactrim", "sulfasalazine", "sulfadiazine"],
};

const FREQ = [
  [/\b1\s*-\s*0\s*-\s*1\b|\bBD\b|\bBID\b|twice/i, "Twice daily"],
  [/\b1\s*-\s*1\s*-\s*1\b|\bTDS\b|\bTID\b|thrice/i, "Three times daily"],
  [/\b1\s*-\s*0\s*-\s*0\b|\bOD\b|once/i, "Once daily"],
  [/\b0\s*-\s*0\s*-\s*1\b|\bHS\b|night|bedtime/i, "Once daily, night"],
  [/\bSOS\b|as needed|prn/i, "When needed"],
];

const LINE = /^(?:\d+[.)]\s*)?(?:tab|tablet|cap|capsule|syp|syrup|inj|t|c)?[.\s]*([A-Za-z][A-Za-z-]{2,}(?:\s+[A-Za-z][A-Za-z-]{2,})?)\s*[-:]?\s*(\d+(?:\.\d+)?\s?(?:mg|mcg|g|ml|iu))\b(.*)$/i;

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = TESSERACT;
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => reject(new Error("Could not load the OCR engine. Check the internet connection."));
    document.head.appendChild(s);
  });
}

export function parseMedicines(text) {
  const out = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/[|_]/g, " ").replace(/\s+/g, " ").trim();
    const m = line.match(LINE);
    if (!m) continue;
    const name = m[1].replace(/\b(tab|cap|syp|inj)\b/i, "").trim();
    const rest = m[3] || "";
    const freq = FREQ.find(([re]) => re.test(rest))?.[1] || "As prescribed";
    out.push({ name: name[0].toUpperCase() + name.slice(1).toLowerCase(), dose: m[2].replace(/\s+/g, " "), frequency: freq, source: line });
  }
  return out;
}

export function allergyConflict(drugName, allergies) {
  const n = drugName.toLowerCase();
  for (const a of allergies) {
    const sub = a.substance.toLowerCase();
    for (const [family, members] of Object.entries(CROSS_REACTIVE)) {
      if (sub.includes(family.slice(0, 5)) && members.some((d) => n.includes(d))) return a;
    }
    const word = sub.split(/\s|\(/)[0];
    if (word.length >= 4 && n.includes(word)) return a;
  }
  return null;
}

export async function importPrescription(file, mount, record, done) {
  render(mount, html`<p class="hint">Reading the prescription on this phone...</p>`);
  let text = "";
  try {
    const T = await loadTesseract();
    const worker = await T.createWorker("eng");
    const { data } = await worker.recognize(file);
    text = data.text || "";
    await worker.terminate();
  } catch (err) {
    render(mount, html`<p class="hint flag-high">${err.message || "OCR failed"}</p>`);
    return;
  }

  const found = parseMedicines(text);
  if (!found.length) {
    render(mount, html`<p class="hint">No medicine lines recognised. Try a sharper photo of a printed prescription.</p>`);
    return;
  }

  const current = new Set(record.medications.map((m) => m.name.toLowerCase()));
  render(mount, html`
    <div style="margin-top:12px">
      <div class="hint" style="margin-bottom:6px">Found ${found.length} ${found.length === 1 ? "medicine" : "medicines"}. Confirm before saving.</div>
      ${found.map((f, i) => {
        const clash = allergyConflict(f.name, record.allergies);
        const dup = current.has(f.name.toLowerCase());
        return html`<label class="check" style="align-items:flex-start">
          <input type="checkbox" data-i="${i}" ${dup || clash ? "" : "checked"}>
          <div>
            <div><b>${f.name} ${f.dose}</b> · ${f.frequency}</div>
            ${clash ? html`<div class="flag-high" style="font-size:13px">Conflicts with recorded allergy: ${clash.substance} (${clash.reaction})</div>` : ""}
            ${dup ? html`<div class="muted" style="font-size:13px">Already on your medicine list</div>` : ""}
          </div>
        </label>`;
      })}
      <button class="btn small block" id="rx-save">Add selected to my record</button>
    </div>
  `);

  mount.querySelector("#rx-save").onclick = () => {
    const month = new Date().toISOString().slice(0, 7);
    mount.querySelectorAll("input[data-i]:checked").forEach((el) => {
      const f = found[Number(el.dataset.i)];
      record.medications.push({ id: "m" + Date.now() + el.dataset.i, name: f.name, dose: f.dose, frequency: f.frequency, since: month, prescriber: "Imported from photo", unverified: true });
    });
    saveRecord(record);
    toast("Medicines added");
    done();
  };
}
