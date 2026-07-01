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
const NAME_KEY = "saturfun_name";
function deviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) { id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()); localStorage.setItem(DEVICE_KEY, id); }
  return id;
}
function myName() { return localStorage.getItem(NAME_KEY) || ""; }
function timeAgo(sec) { const s = Date.now() / 1000 - sec; if (s < 60) return "now"; if (s < 3600) return Math.floor(s / 60) + "m"; if (s < 86400) return Math.floor(s / 3600) + "h"; return Math.floor(s / 86400) + "d"; }
const QUICK_EMOJI = ["❤️", "😂", "‼️", "👍", "😮", "😢"];

// ---- haptics + visual pop -----------------------------------------------
function haptic(ms = 12) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch {} }
function popTile(el) { if (!el) return; el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop"); }

// ---- react menu (long-press / right-click from grid) --------------------
let reactMenuPhoto = null;
function openReactMenu(photoId) {
  reactMenuPhoto = photoId;
  const quick = $("reactMenuQuick");
  quick.innerHTML = QUICK_EMOJI.map((em) => `<button type="button" class="rm-q" data-emoji="${esc(em)}">${esc(em)}</button>`).join("")
    + `<button type="button" class="rm-q rm-more" id="reactMenuMore" aria-label="Any emoji">➕</button>`;
  $("reactMenuInput").hidden = true;
  $("reactMenuInput").value = "";
  $("reactMenu").hidden = false;
}
function closeReactMenu() { $("reactMenu").hidden = true; reactMenuPhoto = null; }
function setupReactMenu() {
  $("reactMenuBackdrop").addEventListener("click", closeReactMenu);
  $("reactMenuQuick").addEventListener("click", (e) => {
    const b = e.target.closest(".rm-q");
    if (!b) return;
    if (b.id === "reactMenuMore") { $("reactMenuInput").hidden = false; $("reactMenuInput").focus(); return; }
    const pid = reactMenuPhoto;
    closeReactMenu();
    if (pid && b.dataset.emoji) reactOn(pid, b.dataset.emoji);
  });
  $("reactMenuInput").addEventListener("input", (e) => {
    const v = e.target.value.trim(); e.target.value = "";
    const pid = reactMenuPhoto;
    closeReactMenu();
    if (pid && v) reactOn(pid, Array.from(v).slice(0, 8).join(""));
  });
}

async function postReaction(photoId, emoji) {
  const r = await fetch(`${PHOTO_API}/api/photos/${photoId}/react`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_id: deviceId(), emoji }),
  });
  if (!r.ok) throw new Error(String(r.status));
  return (await r.json()).reactions; // [{emoji,count,mine}]
}

// Display-only reaction row under a tile: "❤️ 2" chips (not interactive).
function tileReactionsHTML(reactions) {
  if (!reactions || !reactions.length) return "";
  return reactions.map((r) => `<span class="tr-chip${r.mine ? " mine" : ""}">${esc(r.emoji)} ${r.count}</span>`).join("");
}
function renderTileMeta(photoId) {
  const card = document.querySelector(`#photoGrid .tile-card[data-id="${photoId}"]`);
  if (!card) return;
  const p = PHOTOS.find((x) => x.id === photoId);
  let row = card.querySelector(".tile-meta");
  const rxHTML = tileReactionsHTML(p ? p.reactions : []);
  const countHTML = (p && p.comment_count) ? `<span class="tr-chip">💬 ${parseInt(p.comment_count, 10) || 0}</span>` : "";
  const html = rxHTML + countHTML;
  if (!html) { if (row) row.remove(); return; }
  if (!row) { row = document.createElement("div"); row.className = "tile-meta"; card.appendChild(row); }
  row.innerHTML = html;
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
  renderTileMeta(photoId);
  lastSig = PHOTOS.map((x) => `${x.id}:${(x.reactions || []).map((r) => r.emoji + r.count).join("")}:${x.comment_count || 0}`).join(",");
}

async function loadComments(photoId) {
  const wrap = $("lbComments");
  wrap.innerHTML = `<div class="lc-empty">Loading…</div>`;
  let list = [];
  try { list = (await (await fetch(`${PHOTO_API}/api/photos/${photoId}/comments?device=${encodeURIComponent(deviceId())}`)).json()).comments || []; } catch { wrap.innerHTML = ""; return; }
  if (!list.length) { wrap.innerHTML = `<div class="lc-empty">No comments yet.</div>`; return; }
  const canOwner = document.body.classList.contains("is-owner");
  wrap.innerHTML = list.map((c) => {
    const del = (canOwner || c.mine) ? `<button class="lc-del" data-id="${esc(String(c.id))}" aria-label="Delete">✕</button>` : "";
    const av = c.avatar_url ? `<img class="lc-avatar" src="${esc(PHOTO_API + c.avatar_url)}" alt="">` : `<span class="lc-avatar lc-avatar-none" aria-hidden="true"></span>`;
    return `<div class="lc-item">${av}<span class="lc-name">${esc(c.name || "")}</span> <span class="lc-body">${esc(c.body || "")}</span> <span class="lc-time">${timeAgo(c.created)}</span>${del}</div>`;
  }).join("");
}
async function postComment(photoId, body) {
  const r = await fetch(`${PHOTO_API}/api/photos/${photoId}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_id: deviceId(), body }) });
  if (r.status === 429) { toast("Slow down a moment."); return false; }
  if (!r.ok) { toast("Couldn't post."); return false; }
  return true;
}

let rxChain = Promise.resolve();
function reactOn(photoId, emoji) {
  rxChain = rxChain.then(async () => {
    try { applyReactions(photoId, await postReaction(photoId, emoji)); haptic(10); }
    catch (e) { toast("Couldn't react."); }
  });
}
function toggleReaction(emoji) { if (current) reactOn(current.id, emoji); }
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
    const newSig = data.map((p) => `${p.id}:${(p.reactions || []).map((r) => r.emoji + r.count).join("")}:${p.comment_count || 0}`).join(",");
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
          const card = document.createElement("div");
          card.className = "tile-card";
          card.dataset.id = p.id;
          const tile = document.createElement("button");
          tile.className = "tile" + (selected.has(p.id) ? " selected" : "");
          tile.type = "button";
          tile.dataset.id = p.id;
          tile.innerHTML =
            `<img src="${PHOTO_API}/api/photos/${esc(p.id)}/thumb" loading="lazy" draggable="false" alt="${esc(p.filename)}">` +
            `<span class="check" aria-hidden="true">✓</span>`;
          let lpTimer = null, lpFired = false;
          const startLP = () => { lpFired = false; lpTimer = setTimeout(() => { if (selectMode) return; lpFired = true; haptic(15); popTile(tile); openReactMenu(p.id); }, 450); };
          const cancelLP = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
          tile.addEventListener("touchstart", startLP, { passive: true });
          tile.addEventListener("touchend", cancelLP);
          tile.addEventListener("touchmove", cancelLP, { passive: true });
          tile.addEventListener("touchcancel", cancelLP);
          tile.addEventListener("contextmenu", (e) => { e.preventDefault(); if (!selectMode) openReactMenu(p.id); }); // desktop right-click
          tile.addEventListener("click", (e) => {
            if (lpFired) { lpFired = false; e.preventDefault(); return; }
            if (selectMode) toggleTile(p, tile);
            else openLightbox(p);
          });
          card.appendChild(tile);
          const rxHTML = tileReactionsHTML(p.reactions);
          const countHTML = p.comment_count ? `<span class="tr-chip">💬 ${parseInt(p.comment_count, 10) || 0}</span>` : "";
          const metaHTML = rxHTML + countHTML;
          if (metaHTML) { const row = document.createElement("div"); row.className = "tile-meta"; row.innerHTML = metaHTML; card.appendChild(row); }
          grid.appendChild(card);
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
  $("lbCommentInput").value = "";
  loadComments(p.id);
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

// ---- avatar helpers -----------------------------------------------------
function downscaleImage(file, max = 256) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(max / img.width, max / img.height, 1);
      const w = Math.round(img.width * s), h = Math.round(img.height * s);
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      cv.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      cv.toBlob((b) => (b ? resolve(b) : reject(new Error("encode"))), "image/jpeg", 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode")); };
    img.src = url;
  });
}
async function uploadAvatar(blob) {
  const fd = new FormData();
  fd.append("device_id", deviceId());
  fd.append("avatar", blob, "avatar.jpg");
  const r = await fetch(`${PHOTO_API}/api/profile/avatar`, { method: "POST", body: fd });
  if (!r.ok) { toast("Couldn't upload the picture."); return null; }
  const url = (await r.json()).avatar_url;
  localStorage.setItem("saturfun_avatar", url);
  return url;
}

// ---- comment wiring + name sheet ----------------------------------------
let pendingComment = null; // {photoId, body} awaiting a name decision
let pendingAvatarBlob = null;
let avatarPreviewUrl = null;
function openNameSheet() {
  $("nameSheetInput").value = myName();
  if (avatarPreviewUrl) { URL.revokeObjectURL(avatarPreviewUrl); avatarPreviewUrl = null; }
  $("nameAvatarPreview").removeAttribute("src");
  $("nameAvatarInput").value = "";
  pendingAvatarBlob = null;
  $("nameSheet").hidden = false;
  $("nameSheetInput").focus();
}
function closeNameSheet() { $("nameSheet").hidden = true; if (avatarPreviewUrl) { URL.revokeObjectURL(avatarPreviewUrl); avatarPreviewUrl = null; } }
async function saveName(name) {
  const n = (name || "").trim().slice(0, 40);
  if (n) { localStorage.setItem(NAME_KEY, n); try { await fetch(`${PHOTO_API}/api/profile`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_id: deviceId(), name: n }) }); } catch {} }
}
function setupComments() {
  $("lbCommentForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("lbCommentInput"); const body = input.value.trim();
    if (!body || !current) return;
    if (!myName()) { pendingComment = { photoId: current.id, body }; input.value = ""; openNameSheet(); return; }
    input.value = "";
    if (await postComment(current.id, body)) { await loadComments(current.id); bumpCommentCount(current.id, 1); }
  });
  $("lbComments").addEventListener("click", async (e) => {
    const b = e.target.closest(".lc-del"); if (!b || !current) return;
    if (!confirm("Delete this comment?")) return;
    const r = await fetch(`${PHOTO_API}/api/photos/${current.id}/comments/${encodeURIComponent(b.dataset.id)}`, { method: "DELETE", headers: { "Content-Type": "application/json", ...(ownerToken() ? { "X-Owner-Token": ownerToken() } : {}) }, body: JSON.stringify({ device_id: deviceId() }) });
    if (r.ok) { await loadComments(current.id); bumpCommentCount(current.id, -1); } else toast("Couldn't delete.");
  });
  const finish = async () => { pendingAvatarBlob = null; closeNameSheet(); if (pendingComment) { const pc = pendingComment; pendingComment = null; if (await postComment(pc.photoId, pc.body)) { if (current && current.id === pc.photoId) await loadComments(pc.photoId); bumpCommentCount(pc.photoId, 1); } } };
  $("nameSave").addEventListener("click", async () => {
    await saveName($("nameSheetInput").value);
    if (pendingAvatarBlob) { await uploadAvatar(pendingAvatarBlob); pendingAvatarBlob = null; }
    await finish();
  });
  $("nameSkip").addEventListener("click", finish);
  $("nameSheetBackdrop").addEventListener("click", () => { closeNameSheet(); pendingComment = null; pendingAvatarBlob = null; });
  $("nameAvatarInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      pendingAvatarBlob = await downscaleImage(file);
      if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl);
      avatarPreviewUrl = URL.createObjectURL(pendingAvatarBlob);
      $("nameAvatarPreview").src = avatarPreviewUrl;
    } catch { toast("Couldn't process that image."); }
  });
}
function bumpCommentCount(photoId, delta) {
  const p = PHOTOS.find((x) => x.id === photoId); if (!p) return;
  p.comment_count = Math.max(0, (p.comment_count || 0) + delta);
  renderTileMeta(photoId);
  lastSig = PHOTOS.map((x) => `${x.id}:${(x.reactions || []).map((r) => r.emoji + r.count).join("")}:${x.comment_count || 0}`).join(",");
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

// ---- whirlwind opening reveal -------------------------------------------
const SEEN_KEY = "saturfun_seen";
let _whirlRunning = false;

async function maybePlayWhirlwind() {
  let act;
  try { act = await (await fetch(`${PHOTO_API}/api/activity`)).json(); } catch { return; }
  if (!act || !act.latest) return;
  const seen = parseFloat(localStorage.getItem(SEEN_KEY) || "0");
  localStorage.setItem(SEEN_KEY, String(act.latest)); // always advance the marker
  if (!seen) return;                 // first visit: mark, don't play
  if (act.latest <= seen) return;    // nothing new
  const newCounts = {
    photos:    (act.photos    || []).filter((p) => p.uploaded > seen).length,
    reactions: (act.reactions || []).filter((r) => r.created  > seen).length,
    comments:  (act.comments  || []).filter((c) => c.created  > seen).length,
  };
  if (newCounts.photos + newCounts.reactions + newCounts.comments === 0) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  playWhirlwind(act, newCounts);
}

function playWhirlwind(act, newCounts) {
  if (_whirlRunning) return;
  _whirlRunning = true;

  const overlay = $("whirl");
  const stage   = $("whirlStage");
  const recap   = $("whirlRecap");

  overlay.hidden = false;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cx = vw / 2;
  const cy = vh / 2;

  // Timings (ms) — total 3 s
  const T_VORTEX      = 1600; // 0 → 1600 ms
  const T_ASSEMBLE    = 1000; // 1600 → 2600 ms
  const T_TOTAL       = 3000; // animation ends here
  const T_RECAP_START = 2200; // recap fades in from here
  const T_RECAP_IN    = 200;
  const T_RECAP_HOLD  = 280;
  const T_RECAP_OUT   = 320;  // 2200+200+280+320 = 3000 = T_TOTAL

  const rBig = Math.max(vw, vh) * 0.55;

  // ---- Build nodes (≤ 10 photos + ≤ 20 embers + ≤ 4 ghosts = ≤ 34 nodes) ----
  const photos    = (act.photos    || []).slice(0, 10);
  const reactions = (act.reactions || []).slice(0, 20);
  const comments  = (act.comments  || []).slice(0, 4);

  const photoItems = photos.map((p, i) => {
    const el = document.createElement("img");
    el.className = "whirl-photo";
    el.src = `${PHOTO_API}/api/photos/${esc(p.id)}/thumb`;
    el.alt = "";
    el.draggable = false;
    el.style.opacity = "0";
    stage.appendChild(el);
    return {
      el, id: p.id,
      θ:         (i / Math.max(photos.length, 1)) * Math.PI * 2,
      r:         rBig * (0.72 + Math.random() * 0.32),
      rotSpeed:  0.5 + Math.random() * 0.9,
      rotDir:    Math.random() < 0.5 ? 1 : -1,
      selfRot0:  Math.random() * 360,
      selfSpeed: (12 + Math.random() * 28) * (Math.random() < 0.5 ? 1 : -1),
    };
  });

  const emojis = reactions.map((r) => r.emoji).filter(Boolean);
  while (emojis.length < 12) emojis.push(["✦","★","♥","✿","◆"][emojis.length % 5]);
  const emberItems = emojis.slice(0, 20).map((emoji, i) => {
    const el = document.createElement("span");
    el.className = "whirl-ember";
    el.textContent = emoji;
    el.style.opacity = "0";
    stage.appendChild(el);
    return {
      el,
      θ:         (i / 20) * Math.PI * 2 + Math.random() * 0.5,
      r:         rBig * (0.48 + Math.random() * 0.57),
      rotSpeed:  1.0 + Math.random() * 1.3,
      rotDir:    Math.random() < 0.5 ? 1 : -1,
      selfSpeed: (25 + Math.random() * 55) * (Math.random() < 0.5 ? 1 : -1),
    };
  });

  const ghostItems = comments.map((c, i) => {
    const el = document.createElement("span");
    el.className = "whirl-ghost";
    el.textContent = String(c.name || "?").slice(0, 20) + ": " + String(c.body || "").slice(0, 60);
    const startX = vw * (0.08 + Math.random() * 0.5);
    const y      = vh * (0.18 + i * 0.21);
    el.style.transform = `translate3d(${startX}px,${y}px,0)`;
    el.style.opacity = "0";
    stage.appendChild(el);
    return { el, startX, y, speed: 45 + Math.random() * 35 };
  });

  // Recap text
  const parts = [];
  if (newCounts.reactions) parts.push(`${newCounts.reactions} reaction${newCounts.reactions === 1 ? "" : "s"}`);
  if (newCounts.comments)  parts.push(`${newCounts.comments} comment${newCounts.comments === 1 ? "" : "s"}`);
  if (newCounts.photos)    parts.push(`${newCounts.photos} photo${newCounts.photos === 1 ? "" : "s"}`);
  recap.textContent = parts.length ? `✶ ${parts.join(" · ")} since you were here` : "";
  recap.style.opacity = "0";

  // Easing helpers
  function easeOut(t)   { return 1 - (1 - t) * (1 - t); }
  function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

  // Tile rects — read once when assemble phase begins
  let assembleRects = null;
  function readRects() {
    if (assembleRects) return assembleRects;
    assembleRects = {};
    photoItems.forEach(({ id }) => {
      const tile = document.querySelector(`#photoGrid .tile-card[data-id="${id}"]`);
      if (tile) assembleRects[id] = tile.getBoundingClientRect();
    });
    return assembleRects;
  }

  let rafId     = null;
  let startTime = null;
  let skipped   = false;

  function finish() {
    overlay.removeEventListener("pointerdown", onSkip);
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    overlay.hidden = true;
    overlay.style.background = "";
    recap.style.opacity = "0";
    recap.textContent = "";
    stage.innerHTML = "";
    _whirlRunning = false;
  }

  function onSkip() {
    if (skipped) return;
    skipped = true;
    finish();
  }

  overlay.addEventListener("pointerdown", onSkip);

  function tick(ts) {
    if (skipped) return;
    if (!startTime) startTime = ts;
    const elapsed = ts - startTime;

    if (elapsed >= T_TOTAL) { finish(); return; }

    if (elapsed < T_VORTEX) {
      // === VORTEX (0 – 1.6 s): spiral inward ===
      const tv = elapsed / T_VORTEX; // 0→1

      photoItems.forEach(({ el, θ, r, rotSpeed, rotDir, selfRot0, selfSpeed }) => {
        const angle  = θ + tv * rotSpeed * rotDir * Math.PI * 2;
        const radius = r * Math.pow(1 - tv, 1.5); // r→0 smoothly at tv=1
        const x = cx + Math.cos(angle) * radius - 46;
        const y = cy + Math.sin(angle) * radius - 46;
        const scale = 0.5 + easeOut(tv) * 0.5;
        el.style.transform = `translate3d(${x}px,${y}px,0) rotate(${selfRot0 + tv * selfSpeed}deg) scale(${scale})`;
        el.style.opacity = String(Math.min(0.96, tv * 5));
      });

      emberItems.forEach(({ el, θ, r, rotSpeed, rotDir, selfSpeed }) => {
        const angle  = θ + tv * rotSpeed * rotDir * Math.PI * 2;
        const radius = r * Math.pow(1 - tv, 1.5);
        const x = cx + Math.cos(angle) * radius - 14;
        const y = cy + Math.sin(angle) * radius - 14;
        el.style.transform = `translate3d(${x}px,${y}px,0) rotate(${tv * selfSpeed}deg)`;
        el.style.opacity = String(Math.min(0.85, tv * 3.5));
      });

      ghostItems.forEach(({ el, startX, y, speed }) => {
        const gx = startX - elapsed * speed / 1000;
        el.style.transform = `translate3d(${gx}px,${y}px,0)`;
        el.style.opacity = String(Math.min(0.14, tv * 0.22));
      });

    } else if (elapsed < T_VORTEX + T_ASSEMBLE) {
      // === ASSEMBLE (1.6 – 2.6 s): photos → tile rects; overlay fades out ===
      const ta = (elapsed - T_VORTEX) / T_ASSEMBLE; // 0→1
      const rects = readRects();

      photoItems.forEach(({ el, id }) => {
        const rect = rects[id];
        if (rect) {
          const destX = rect.left + rect.width  / 2 - 46;
          const destY = rect.top  + rect.height / 2 - 46;
          const x     = (cx - 46) + (destX - (cx - 46)) * easeInOut(ta);
          const y     = (cy - 46) + (destY - (cy - 46)) * easeInOut(ta);
          const scale = 1 + (rect.width / 92 - 1) * easeInOut(ta);
          // fade out as it lands (last 35% of assemble)
          const fadeOut = ta > 0.65 ? 1 - (ta - 0.65) / 0.35 : 1;
          el.style.transform = `translate3d(${x}px,${y}px,0) scale(${scale})`;
          el.style.opacity = String(Math.max(0, 0.96 * fadeOut));
        } else {
          el.style.opacity = String(Math.max(0, 0.96 * (1 - easeOut(ta))));
        }
      });

      emberItems.forEach(({ el }, i) => {
        const outR = easeOut(ta) * rBig * 1.35;
        const outA = (i / emberItems.length) * Math.PI * 2;
        const x = cx + Math.cos(outA) * outR - 14;
        const y = cy + Math.sin(outA) * outR - 14;
        el.style.transform = `translate3d(${x}px,${y}px,0) scale(${1 + ta * 0.35})`;
        el.style.opacity = String(Math.max(0, 0.85 * (1 - easeOut(ta))));
      });

      ghostItems.forEach(({ el, startX, y, speed }) => {
        const gx = startX - elapsed * speed / 1000;
        el.style.transform = `translate3d(${gx}px,${y}px,0)`;
        el.style.opacity = String(Math.max(0, 0.14 * (1 - easeOut(ta))));
      });

      // Fade the ink background to reveal the real grid beneath
      const bgAlpha = (0.96 * (1 - easeInOut(ta))).toFixed(3);
      overlay.style.background = `rgba(14,14,16,${bgAlpha})`;
    }
    // else: post-assemble hold (2.6 – 3 s) — overlay transparent, recap floating above grid

    // === RECAP (2.2 – 3 s): fade in → hold → fade out ===
    if (elapsed >= T_RECAP_START && recap.textContent) {
      const tr = elapsed - T_RECAP_START;
      let op;
      if      (tr < T_RECAP_IN)                      op = tr / T_RECAP_IN;
      else if (tr < T_RECAP_IN + T_RECAP_HOLD)       op = 1;
      else op = Math.max(0, 1 - (tr - T_RECAP_IN - T_RECAP_HOLD) / T_RECAP_OUT);
      recap.style.opacity = String(op);
    }

    rafId = requestAnimationFrame(tick);
  }

  rafId = requestAnimationFrame(tick);
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
  setupReactMenu();
  setupComments();
  $("setNameBtn").addEventListener("click", openNameSheet);
  $("lbSave").addEventListener("click", () => current && savePhoto(current));
  $("lbOpen").addEventListener("click", () => current && window.open(`${PHOTO_API}/api/photos/${current.id}/raw`, "_blank"));
  $("lbDelete").addEventListener("click", deleteCurrent);
  $("lbClose").addEventListener("click", closeLightbox);
  $("lightboxBackdrop").addEventListener("click", closeLightbox);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("nameSheet").hidden) { closeNameSheet(); pendingComment = null; pendingAvatarBlob = null; }
    else if (!$("reactMenu").hidden) closeReactMenu();
    else if ($("lightbox").classList.contains("open")) closeLightbox();
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
  loadPhotos().then(() => { maybePlayWhirlwind().catch(() => {}); });
}

init();
