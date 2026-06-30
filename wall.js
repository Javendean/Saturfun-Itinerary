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
const DEVICE_KEY = "saturfun_device_id";
function deviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) { id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()); localStorage.setItem(DEVICE_KEY, id); }
  return id;
}
const QUICK_EMOJI = ["❤️", "😂", "‼️", "👍", "😮", "😢"];

async function postReaction(photoId, emoji) {
  const r = await fetch(`${PHOTO_API}/api/photos/${photoId}/react`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_id: deviceId(), emoji }),
  });
  if (!r.ok) throw new Error(String(r.status));
  return (await r.json()).reactions; // [{emoji,count,mine}]
}

// compact tile summary: up to 3 emojis + total count, e.g. "❤️😂 5"
function tileReactionHTML(reactions) {
  if (!reactions || !reactions.length) return "";
  const top = reactions.slice(0, 3).map((r) => esc(r.emoji)).join("");
  const total = reactions.reduce((n, r) => n + r.count, 0);
  return `<span class="tile-react">${top} ${total}</span>`;
}

function renderLightboxReactions(p) {
  const wrap = $("lbReactions");
  if (!wrap) return;
  const chips = (p.reactions || [])
    .map((r) => `<button type="button" class="rx-chip${r.mine ? " mine" : ""}" data-emoji="${esc(r.emoji)}">${esc(r.emoji)} <span class="rx-n">${r.count}</span></button>`)
    .join("");
  wrap.innerHTML = chips + `<button type="button" class="rx-chip rx-add" id="lbReactAdd" aria-label="Add a reaction">➕</button>`;
}

function applyReactions(photoId, reactions) {
  if (current && current.id === photoId) { current.reactions = reactions; renderLightboxReactions(current); }
  const inList = PHOTOS.find((x) => x.id === photoId);
  if (inList) inList.reactions = reactions;
  const tile = document.querySelector(`#photoGrid .tile[data-id="${photoId}"]`);
  if (tile) {
    let s = tile.querySelector(".tile-react");
    const html = tileReactionHTML(reactions);
    if (html) { if (!s) { tile.insertAdjacentHTML("beforeend", html); } else { s.outerHTML = html; } }
    else if (s) s.remove();
  }
  lastSig = PHOTOS.map((p) => `${p.id}:${(p.reactions || []).map((r) => r.emoji + r.count).join("")}`).join(",");
}

let rxChain = Promise.resolve();
function toggleReaction(emoji) {
  if (!current) return;
  const photoId = current.id;
  rxChain = rxChain.then(async () => {
    try { applyReactions(photoId, await postReaction(photoId, emoji)); }
    catch (e) { toast("Couldn't react."); }
  });
}
const IMG_RE = /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i;

// Bulk dumps are split into batches kept safely under the Worker's per-request
// limits (server: <=20 files, <=50 MB body). Conservative margins here.
const BATCH_MAX_FILES = 15;
const BATCH_MAX_BYTES = 40 * 1024 * 1024;
// Multi-file save (Web Share) is chunked to bound memory + per-share-sheet size.
const SHARE_MAX_FILES = 10;
const SHARE_MAX_BYTES = 45 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let PHOTOS = [];
let current = null; // photo open in the lightbox
let selectMode = false;
const selected = new Set(); // photo ids selected in select mode
let lastSig = ""; // signature of the last-rendered photo set (change detection)
let loading = false; // guard against concurrent loadPhotos
const AUTO_REFRESH_MS = 20000; // poll for others' uploads while the tab is visible

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
// Works for one photo, a selection, or the whole wall. On iOS/Android the Web Share
// API takes a files[] array and the native sheet offers "Save N Images" → Photos.
// Desktop (no Web Share files) falls back to direct attachment downloads.

// Chunk a save by count + total bytes so a share sheet / memory stays bounded.
function chunkPhotos(photos, maxCount, maxBytes) {
  const chunks = [];
  let cur = [];
  let bytes = 0;
  for (const p of photos) {
    const sz = p.size || 0;
    if (cur.length && (cur.length >= maxCount || bytes + sz > maxBytes)) {
      chunks.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(p);
    bytes += sz;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// Fetch each photo's bytes as a File (limited concurrency to bound memory).
async function fetchAsFiles(photos) {
  const files = new Array(photos.length);
  let idx = 0;
  async function worker() {
    while (idx < photos.length) {
      const i = idx++;
      const p = photos[i];
      const blob = await (await fetch(`${PHOTO_API}/api/photos/${p.id}/raw`)).blob();
      files[i] = new File([blob], p.filename, { type: p.content_type || blob.type });
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, photos.length) }, worker));
  return files;
}

// Desktop / no-Web-Share fallback: download each as an attachment, lightly staggered.
async function downloadFallback(photos) {
  for (const p of photos) {
    const a = document.createElement("a");
    a.href = `${PHOTO_API}/api/photos/${p.id}/download`;
    a.download = p.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (photos.length > 1) await sleep(400);
  }
  if (photos.length > 1) toast(`Downloading ${photos.length}…`);
}

// share() consumes the tap's transient activation, so it can be called only ONCE per
// user gesture. Large saves therefore advance one batch per tap (the Save tap shares
// the first batch; a "Save the next N" button drives each subsequent batch).
let shareQueue = null;

async function savePhotos(photos) {
  if (!photos || !photos.length) return toast("Nothing to save.");
  // Cheap probe: does this platform share image files at all? (avoids fetching
  // every blob on desktop only to discard it.) Per-chunk canShare still re-checks.
  const probe = new File([new Uint8Array([255, 216, 255])], "p.jpg", { type: "image/jpeg" });
  if (typeof navigator.canShare !== "function" || !navigator.canShare({ files: [probe] })) {
    return downloadFallback(photos);
  }
  shareQueue = {
    chunks: chunkPhotos(photos, SHARE_MAX_FILES, SHARE_MAX_BYTES),
    index: 0,
    total: photos.length,
  };
  await runShareBatch(); // this user tap shares the first batch
}

// Shares the current batch. MUST run inside a user gesture (the Save tap or the
// "Save the next N" tap). Falls back to downloads when sharing isn't possible.
async function runShareBatch() {
  if (!shareQueue) return;
  hideShareNext();
  const { chunks, index } = shareQueue;
  const chunk = chunks[index];

  setProgress(chunks.length > 1 ? `Preparing ${index + 1} of ${chunks.length}…` : "Preparing…");
  let files = null;
  try {
    files = await fetchAsFiles(chunk);
  } catch {
    files = null;
  }
  setProgress("");

  if (!files || !navigator.canShare({ files })) {
    const rest = chunks.slice(index).flat();
    shareQueue = null;
    return downloadFallback(rest); // unsupported file types / no file sharing
  }

  try {
    await navigator.share({ files }); // ONLY files — no title/text (iOS would share text)
  } catch (e) {
    const rest = chunks.slice(index).flat();
    shareQueue = null;
    if (e && e.name === "AbortError") return; // user cancelled the sheet
    return downloadFallback(rest); // activation lost / target rejected → download
  }

  shareQueue.index++;
  if (shareQueue.index >= chunks.length) {
    const total = shareQueue.total;
    shareQueue = null;
    if (total > chunk.length) toast(`Saved all ${total}. Choose “Save Images” on each sheet.`);
  } else {
    const remaining = chunks.slice(shareQueue.index).flat().length;
    showShareNext(remaining);
  }
}

function showShareNext(remaining) {
  const b = $("shareNext");
  if (!b) return;
  b.textContent = `Save the next ${remaining} →`;
  b.hidden = false;
}
function hideShareNext() {
  const b = $("shareNext");
  if (b) b.hidden = true;
}

// Lightbox single-save reuses the same path.
const savePhoto = (p) => savePhotos([p]);

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
// Fetches the wall; rebuilds the grid ONLY when the photo set changed (so auto-refresh
// is a cheap no-op when nothing's new). Returns { ok, changed, delta }.
async function loadPhotos() {
  loading = true;
  try {
    let data;
    try {
      const r = await fetch(`${PHOTO_API}/api/photos?device=${encodeURIComponent(deviceId())}`);
      data = (await r.json()).photos || [];
    } catch (e) {
      console.warn("[wall] load failed:", e);
      return { ok: false, delta: 0 };
    }

    const delta = data.length - PHOTOS.length;
    const newSig = data.map((p) => `${p.id}:${(p.reactions || []).map((r) => r.emoji + r.count).join("")}`).join(",");
    const changed = newSig !== lastSig;
    PHOTOS = data;

    // drop any selected ids that no longer exist
    const ids = new Set(data.map((p) => p.id));
    for (const id of Array.from(selected)) if (!ids.has(id)) selected.delete(id);

    const empty = $("photoEmpty");
    const has = data.length > 0;
    $("photoStat").textContent = has ? `${data.length} photo${data.length === 1 ? "" : "s"}` : "";
    $("saveAllBtn").hidden = !has;
    $("selectBtn").hidden = !has;
    // #photoEmpty is a SIBLING of the grid — toggle it, never move it into the innerHTML wipe.
    if (empty) empty.style.display = has ? "none" : "";

    if (changed) {
      lastSig = newSig;
      const grid = $("photoGrid");
      grid.innerHTML = "";
      if (has) {
        for (const p of data) {
          const tile = document.createElement("button");
          tile.className = "tile" + (selected.has(p.id) ? " selected" : "");
          tile.type = "button";
          tile.dataset.id = p.id;
          tile.innerHTML =
            `<img src="${PHOTO_API}/api/photos/${esc(p.id)}/thumb" loading="lazy" alt="${esc(p.filename)}">` +
            `<span class="check" aria-hidden="true">✓</span>` +
            tileReactionHTML(p.reactions);
          tile.addEventListener("click", () => {
            if (selectMode) toggleTile(p, tile);
            else openLightbox(p);
          });
          grid.appendChild(tile);
        }
      } else if (selectMode) {
        exitSelectMode();
      }
      if (current) {
        const u = PHOTOS.find((p) => p.id === current.id);
        if (u) { current.reactions = u.reactions; renderLightboxReactions(current); }
      }
    }
    updateSelUI();
    return { ok: true, changed, delta };
  } finally {
    loading = false;
  }
}

// Manual "Refresh" button — guaranteed fresh: waits out any in-flight auto-load
// (so it's serialized + authoritative), then reports the result.
async function manualRefresh() {
  const btn = $("refreshBtn");
  btn.classList.add("spinning");
  btn.disabled = true;
  for (let i = 0; i < 25 && loading; i++) await sleep(100);
  const res = await loadPhotos();
  btn.classList.remove("spinning");
  btn.disabled = false;
  if (!res || res.ok === false) return toast("Couldn't reach the wall.");
  if (res.delta > 0) toast(`${res.delta} new photo${res.delta === 1 ? "" : "s"}.`);
  else if (res.delta < 0) toast(`Updated — ${PHOTOS.length} now.`);
  else toast("Up to date.");
}

// Auto-refresh tick — silent; skipped when it would disrupt or waste requests.
function autoRefresh() {
  if (document.hidden || selectMode || shareQueue || loading) return;
  loadPhotos();
}

// ---- multi-select (public: select + save; Delete is owner-only) ---------
function selectedPhotos() {
  return PHOTOS.filter((p) => selected.has(p.id));
}
function updateSelUI() {
  const c = $("selCount");
  if (c) c.textContent = `${selected.size} selected`;
  const save = $("selSaveBtn");
  const del = $("selDeleteBtn");
  if (save) save.disabled = selected.size === 0;
  if (del) del.disabled = selected.size === 0;
}
function enterSelectMode() {
  selectMode = true;
  $("photoGrid").classList.add("selecting");
  $("selectBar").hidden = false;
  $("selectBtn").textContent = "Cancel";
  updateSelUI();
}
function exitSelectMode() {
  selectMode = false;
  selected.clear();
  shareQueue = null;
  hideShareNext();
  $("photoGrid").classList.remove("selecting");
  $("selectBar").hidden = true;
  $("selectBtn").textContent = "Select";
  document.querySelectorAll("#photoGrid .tile.selected").forEach((t) => t.classList.remove("selected"));
  updateSelUI();
}
function toggleSelectMode() {
  if (selectMode) exitSelectMode();
  else enterSelectMode();
}
function toggleTile(p, tile) {
  if (selected.has(p.id)) {
    selected.delete(p.id);
    tile.classList.remove("selected");
  } else {
    selected.add(p.id);
    tile.classList.add("selected");
  }
  updateSelUI();
}
function selectAll() {
  PHOTOS.forEach((p) => selected.add(p.id));
  document.querySelectorAll("#photoGrid .tile").forEach((t) => t.classList.add("selected"));
  updateSelUI();
}
async function deleteSelected() {
  const token = ownerToken();
  if (!token) return toast("Owner token required to delete.");
  const ps = selectedPhotos();
  if (!ps.length) return;
  if (!confirm(`Delete ${ps.length} photo${ps.length === 1 ? "" : "s"}? This removes them for everyone.`)) return;
  setProgress(`Deleting ${ps.length}…`);
  let ok = 0;
  let rejected = false;
  let idx = 0;
  async function worker() {
    while (idx < ps.length) {
      const p = ps[idx++];
      try {
        const r = await fetch(`${PHOTO_API}/api/photos/${p.id}`, {
          method: "DELETE",
          headers: { "X-Owner-Token": token },
        });
        if (r.status === 403) rejected = true;
        else if (r.ok) ok++;
      } catch {}
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, ps.length) }, worker));
  setProgress("");
  if (rejected) {
    toast("Owner token rejected.");
    localStorage.removeItem(OWNER_KEY);
    refreshOwnerUI();
  } else {
    toast(`Deleted ${ok}.`);
  }
  exitSelectMode();
  await loadPhotos();
}

// ---- lightbox -----------------------------------------------------------
function openLightbox(p) {
  current = p;
  $("rxPicker").hidden = true;
  renderLightboxReactions(p);
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

// ---- PWA app-version update prompt --------------------------------------
// Polls the deployed SW cache-version string; offers "tap to update" only when a newer
// version shipped than the one THIS (warm) page is running. Cold launches load the
// latest already (network-first), so no prompt fires on a fresh open.
function setupAppUpdate() {
  let loadedVersion = null;
  let updating = false;
  const fetchVersion = async () => {
    try {
      const txt = await (await fetch(`wall-sw.js?t=${Date.now()}`, { cache: "no-store" })).text();
      const m = txt.match(/saturfun-wall-v\d+/);
      return m ? m[0] : null;
    } catch {
      return null;
    }
  };
  const check = async () => {
    if (updating) return;
    const v = await fetchVersion();
    if (!v) return;
    if (loadedVersion === null) {
      loadedVersion = v; // the version this page launched with
      return;
    }
    if (v !== loadedVersion) {
      const btn = $("updateBtn");
      btn.hidden = false;
      btn.onclick = () => {
        updating = true;
        location.reload();
      };
    }
  };
  check();
  setInterval(check, 60000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) check();
  });
}

// ---- reactions wiring ---------------------------------------------------
function setupReactions() {
  // chip clicks (existing emoji) + add-button → quick row + emoji keyboard
  $("lbReactions").addEventListener("click", (e) => {
    const chip = e.target.closest(".rx-chip");
    if (!chip) return;
    if (chip.id === "lbReactAdd") { $("rxPicker").hidden = !$("rxPicker").hidden; return; }
    const emoji = chip.dataset.emoji;
    if (emoji) toggleReaction(emoji);
  });
  // quick row
  $("rxQuick").innerHTML = QUICK_EMOJI.map((em) => `<button type="button" class="rx-q" data-emoji="${esc(em)}">${esc(em)}</button>`).join("");
  $("rxQuick").addEventListener("click", (e) => {
    const b = e.target.closest(".rx-q");
    if (b) { $("rxPicker").hidden = true; toggleReaction(b.dataset.emoji); }
  });
  // any-emoji input: typing/pasting an emoji (phone emoji keyboard) toggles it
  $("rxInput").addEventListener("input", (e) => {
    const v = e.target.value.trim();
    e.target.value = "";
    $("rxPicker").hidden = true;
    if (v) toggleReaction(Array.from(v).slice(0, 8).join(""));
  });
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
  setupReactions();
  $("lbSave").addEventListener("click", () => current && savePhoto(current));
  $("lbOpen").addEventListener("click", () => current && window.open(`${PHOTO_API}/api/photos/${current.id}/raw`, "_blank"));
  $("lbDelete").addEventListener("click", deleteCurrent);
  $("lbClose").addEventListener("click", closeLightbox);
  $("lightboxBackdrop").addEventListener("click", closeLightbox);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if ($("lightbox").classList.contains("open")) closeLightbox();
    else if (selectMode) exitSelectMode();
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

  // multi-select + bulk save (public; Delete in the bar is owner-only via CSS)
  $("selectBtn").addEventListener("click", toggleSelectMode);
  $("selDoneBtn").addEventListener("click", exitSelectMode);
  $("selAllBtn").addEventListener("click", selectAll);
  $("saveAllBtn").addEventListener("click", () => savePhotos(PHOTOS));
  $("selSaveBtn").addEventListener("click", () => savePhotos(selectedPhotos()));
  $("selDeleteBtn").addEventListener("click", deleteSelected);
  $("shareNext").addEventListener("click", runShareBatch);

  // refresh: manual button + auto-poll (paused when hidden) + catch-up on focus
  $("refreshBtn").addEventListener("click", manualRefresh);
  setInterval(autoRefresh, AUTO_REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) autoRefresh();
  });

  // PWA: register the wall's service worker. scope "wall" narrows control to the wall's
  // own assets only (prefix /…/wall*) — index.html and the rest of the site are never
  // controlled. (Narrowing needs no Service-Worker-Allowed header; see wall-sw.js.)
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("wall-sw.js", { scope: "wall" }).catch((e) => console.warn("[wall] SW registration failed:", e));
  }
  setupAppUpdate();

  refreshOwnerUI();
  loadPhotos();
}

init();
