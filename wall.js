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

// ---- upload (multipart, image-filtered, partial-batch aware) ------------
async function uploadFiles(fileList) {
  const files = Array.from(fileList || []).filter(
    (f) => (f.type && f.type.startsWith("image/")) || IMG_RE.test(f.name),
  );
  if (!files.length) return toast("No image files selected.");
  setProgress(`Uploading ${files.length} photo${files.length === 1 ? "" : "s"}…`);

  const fd = new FormData();
  for (const f of files) fd.append("files", f, f.name); // field name MUST be "files"

  try {
    const r = await fetch(`${PHOTO_API}/api/photos`, { method: "POST", body: fd });
    if (!r.ok) {
      let d = r.statusText;
      try {
        d = (await r.json()).detail || d;
      } catch {}
      throw new Error(d);
    }
    const data = await r.json();
    toast(`Added ${data.photos.length}` + (data.errors?.length ? `, ${data.errors.length} rejected` : ""));
    await loadPhotos();
  } catch (e) {
    toast(`Upload failed: ${e.message}`);
  } finally {
    setProgress("");
  }
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
