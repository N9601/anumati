/* Stage demo: when the patient frame creates a consent, load the
 * doctor frame with the same link, as if the QR had been scanned. */

const phone = document.getElementById("doctor-phone");
const channel = new BroadcastChannel("anumati-demo");

channel.onmessage = ({ data }) => {
  if (data?.type !== "grant-created") return;
  const frame = document.createElement("iframe");
  frame.title = "Doctor phone";
  frame.src = data.link.replace(/^https?:\/\/[^/]+/, location.origin);
  phone.replaceChildren(frame);
};

document.getElementById("reset").onclick = () => {
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.textContent = "Waiting for the patient to create a consent QR.";
  phone.replaceChildren(empty);
  document.getElementById("patient").src = "index.html#share";
};
