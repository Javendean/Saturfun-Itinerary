// Photo Wall — public upload + phone-friendly download.
// Talks to the saturfun Cloudflare Worker (R2 + D1). Frontend ported from the
// Artifact Studio transplant kit; the crown jewel is savePhoto()'s iOS Web Share
// path with an anchor-download fallback. Plain fetch, no framework, no build step.

// ---- Worker origin (cross-origin to the static site) --------------------
const PHOTO_API = (() => {
  const h = location.hostname;
  if (h === "localhost" || h === "127.0.0.1" || h === "") return "http://127.0.0.1:8787";
  return "https://saturfun-worker.javendean.workers.dev";
})();

const OWNER_KEY = "saturfun_photo_owner";
const IMG_RE = /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i;

// Bulk dumps are split into batches kept safely under the Worker's per-request
// limits (server: <=20 files, <=50 MB body). Conservative margins here.
const BATCH_MAX_FILES = 15;
const BATCH_MAX_BYTES = 40 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let PHOTOS = [];
let current = null; // photo open in the lightbox

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---- tiny UI helpers ----------------------------------------------------
let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}
function setProgress(msg) {
  $("uploadProgress").textContent = msg || "";
}
function ownerToken() {
  return localStorage.getItem(OWNER_KEY) || "";
}
function refreshOwnerUI() {
  document.body.classList.toggle("is-owner", !!ownerToken());
}

// ---- the crown jewel: phone-aware save (iOS Web Share → anchor fallback) --
async function savePhoto(p) {
  // iOS Safari ignores <a download>; Web Share opens the native sheet ("Save Image").
  // Desktop / older Android fall back to a direct attachment download.
  const dlUrl = `${PHOTO_API}/api/photos/${p.id}/download`;
  try {
    if (navigator.canShare) {
      const blob = await (await fetch(dlUrl)).blob();
      const file = new File([blob], p.filename, { type: p.content_type });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: p.filename });
        return;
      }
    }
  } catch (e) {
    if (e && e.name === "AbortError") return; // user dismissed the share sheet
  }
  const a = document.createElement("a");
  a.href = dlUrl;
  a.download = p.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---- upload (multipart, image-filtered, batched for bulk dumps) ---------
// Split a (possibly huge) selection into requests that stay under the server caps.
// Any single file too big for one request is left in its own batch and the server
// rejects it cleanly (counted as rejected), so one bad file never blocks the rest.
function makeBatches(files) {
  const batches = [];
  let cur = [];
  let curBytes = 0;
  for (const f of files) {
    if (cur.length && (cur.length >= BATCH_MAX_FILES || curBytes + f.size > BATCH_MAX_BYTES)) {
      batches.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(f);
    curBytes += f.size;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

// Upload one batch; retries on 429 (honoring Retry-After) and transient network errors.
async function uploadBatch(batch) {
  const fd = new FormData();
  for (const f of batch) fd.append("files", f, f.name); // field name MUST be "files"
  for (let attempt = 0; attempt < 6; attempt++) {
    let r;
    try {
      r = await fetch(`${PHOTO_API}/api/photos`, { method: "POST", body: fd });
    } catch (e) {
      if (attempt < 5) {
        await sleep(2000);
        continue;
      }
      return { added: 0, rejected: batch.length };
    }
    if (r.status === 429 && attempt < 5) {
      const wait = parseInt(r.headers.get("Retry-After"), 10) || (attempt + 1) * 4;
      setProgress(`Rate limited — resuming in ${wait}s…`);
      await sleep(wait * 1000);
      continue;
    }
    if (!r.ok) {
      return { added: 0, rejected: batch.length }; // whole batch rejected (e.g. 413); keep going
    }
    const data = await r.json();
    return { added: data.photos.length, rejected: data.errors?.length || 0 };
  }
  return { added: 0, rejected: batch.length };
}

async function uploadFiles(fileList) {
  const files = Array.from(fileList || []).filter(
    (f) => (f.type && f.type.startsWith("image/")) || IMG_RE.test(f.name),
  );
  if (!files.length) return toast("No image files selected.");

  const batches = makeBatches(files);
  let added = 0;
  let rejected = 0;
  let done = 0;
  try {
    for (const batch of batches) {
      setProgress(`Uploading ${done + 1}–${done + batch.length} of ${files.length}…`);
      const res = await uploadBatch(batch);
      added += res.added;
      rejected += res.rejected;
      done += batch.length;
      await loadPhotos(); // grid fills progressively as each batch lands
    }
  } finally {
    setProgress("");
  }
  const summary = files.length > 1 ? `Added ${added} of ${files.length}` : `Added ${added}`;
  toast(summary + (rejected ? `, ${rejected} rejected` : ""));
}

// ---- grid ---------------------------------------------------------------
async function loadPhotos() {
  try {
    const r = await fetch(`${PHOTO_API}/api/photos`);
    const data = await r.json();
    PHOTOS = data.photos || [];
  } catch (e) {
    console.warn("[wall] load failed:", e);
    PHOTOS = [];
  }
  const grid = $("photoGrid");
  const empty = $("photoEmpty");
  $("photoStat").textContent = PHOTOS.length ? `${PHOTOS.length} photo${PHOTOS.length === 1 ? "" : "s"}` : "";
  // #photoEmpty is a SIBLING of the grid — toggle it, never move it into the
  // innerHTML wipe (which would detach it and break the next empty render).
  grid.innerHTML = "";
  if (empty) empty.style.display = PHOTOS.length ? "none" : "";
  if (!PHOTOS.length) return;
  for (const p of PHOTOS) {
    const tile = document.createElement("button");
    tile.className = "tile";
    tile.type = "button";
    tile.innerHTML = `<img src="${PHOTO_API}/api/photos/${esc(p.id)}/thumb" loading="lazy" alt="${esc(p.filename)}">`;
    tile.addEventListener("click", () => openLightbox(p));
    grid.appendChild(tile);
  }
}

// ---- lightbox -----------------------------------------------------------
function openLightbox(p) {
  current = p;
  $("lightboxImg").src = `${PHOTO_API}/api/photos/${p.id}/raw`;
  $("lightboxImg").alt = p.filename;
  $("lightboxName").textContent = p.filename;
  $("lightbox").classList.add("open");
  document.body.style.overflow = "hidden";
}
function closeLightbox() {
  $("lightbox").classList.remove("open");
  document.body.style.overflow = "";
  current = null;
}
async function deleteCurrent() {
  if (!current) return;
  const token = ownerToken();
  if (!token) {
    toast("Owner token required to delete.");
    return;
  }
  if (!confirm(`Delete "${current.filename}"? This removes it for everyone.`)) return;
  try {
    const r = await fetch(`${PHOTO_API}/api/photos/${current.id}`, {
      method: "DELETE",
      headers: { "X-Owner-Token": token },
    });
    if (r.status === 403) {
      toast("Owner token rejected.");
      localStorage.removeItem(OWNER_KEY);
      refreshOwnerUI();
      return;
    }
    if (!r.ok) throw new Error(`${r.status}`);
    toast("Deleted.");
    closeLightbox();
    await loadPhotos();
  } catch (e) {
    toast(`Delete failed: ${e.message}`);
  }
}

// ---- wiring -------------------------------------------------------------
function init() {
  const input = $("photoInput");
  const dz = $("dropzone");

  $("addBtn").addEventListener("click", () => input.click());
  dz.addEventListener("click", () => input.click());
  input.addEventListener("change", (e) => {
    uploadFiles(e.target.files);
    input.value = ""; // allow re-selecting the same file
  });

  // drag + drop
  ["dragenter", "dragover"].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add("drag");
    }),
  );
  ["dragleave", "drop"].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === "dragleave" && dz.contains(e.relatedTarget)) return;
      dz.classList.remove("drag");
    }),
  );
  dz.addEventListener("drop", (e) => uploadFiles(e.dataTransfer.files));

  // lightbox actions
  $("lbSave").addEventListener("click", () => current && savePhoto(current));
  $("lbOpen").addEventListener("click", () => current && window.open(`${PHOTO_API}/api/photos/${current.id}/raw`, "_blank"));
  $("lbDelete").addEventListener("click", deleteCurrent);
  $("lbClose").addEventListener("click", closeLightbox);
  $("lightboxBackdrop").addEventListener("click", closeLightbox);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("lightbox").classList.contains("open")) closeLightbox();
  });

  // owner toggle
  $("ownerBtn").addEventListener("click", () => {
    const cur = ownerToken();
    const next = prompt(cur ? "Owner token (blank to sign out):" : "Enter owner token to enable deleting:", cur);
    if (next === null) return;
    if (next.trim()) {
      localStorage.setItem(OWNER_KEY, next.trim());
      toast("Owner mode on.");
    } else {
      localStorage.removeItem(OWNER_KEY);
      toast("Owner mode off.");
    }
    refreshOwnerUI();
  });

  refreshOwnerUI();
  loadPhotos();
}

init();
