import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
  ASPECTS,
  isValidAspects,
  savePanel,
  listPanels,
  getPanelBytes,
  tagPanel,
  getTaste,
  setTaste,
} from "../src/manga-store";

// 1×1 PNG — same constant used across the test suite
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

const MANGA_MAX_FILES = 20;

// ---------------------------------------------------------------------------
// isValidAspects
// ---------------------------------------------------------------------------
describe("isValidAspects", () => {
  it("keeps only vocab members", () => {
    const result = isValidAspects(["linework", "inking", "notvalid"]);
    expect(result).toEqual(["linework", "inking"]);
  });

  it("deduplicates repeated entries", () => {
    const result = isValidAspects(["linework", "linework", "inking"]);
    expect(result).toEqual(["linework", "inking"]);
  });

  it("caps output at 9 (the full ASPECTS length)", () => {
    // Pass 10 valid entries (repeat first after full set) — should only keep 9
    const input = [...ASPECTS, ASPECTS[0]];
    const result = isValidAspects(input);
    expect(result.length).toBe(9);
  });

  it("returns [] for a non-array input", () => {
    expect(isValidAspects("linework")).toEqual([]);
    expect(isValidAspects(null)).toEqual([]);
    expect(isValidAspects(42)).toEqual([]);
    expect(isValidAspects({ linework: true })).toEqual([]);
  });

  it("returns [] when no array entries match the vocab", () => {
    expect(isValidAspects(["foo", "bar", 123])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// savePanel + getPanelBytes
// ---------------------------------------------------------------------------
describe("savePanel + getPanelBytes", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM manga_panels").run();
  });

  it("stores a panel and getPanelBytes serves the bytes with correct content-type", async () => {
    const { id } = await savePanel(env, "dev-1", PNG);
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(8);

    const result = await getPanelBytes(env, id);
    expect(result).not.toBeNull();
    expect(result!.contentType).toContain("image/png");
    expect(new Uint8Array(result!.body).length).toBe(PNG.length);
  });

  it("throws on a non-image (magic-byte validation)", async () => {
    await expect(
      savePanel(env, "dev-1", Uint8Array.from([1, 2, 3, 4])),
    ).rejects.toBeTruthy();
  });

  it("getPanelBytes returns null for unknown id", async () => {
    expect(await getPanelBytes(env, "doesnotexist")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listPanels — newest-first + device-scoped
// ---------------------------------------------------------------------------
describe("listPanels", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM manga_panels").run();
  });

  it("returns panels newest-first for the requesting device", async () => {
    const a = await savePanel(env, "dev-1", PNG);
    const b = await savePanel(env, "dev-1", PNG);

    const panels = await listPanels(env, "dev-1");
    expect(panels.length).toBe(2);
    // newest-first: b was inserted after a, so b.created >= a.created
    expect(panels[0].id).toBe(b.id);
    expect(panels[1].id).toBe(a.id);
  });

  it("only returns panels belonging to the requesting device", async () => {
    await savePanel(env, "dev-1", PNG);
    await savePanel(env, "dev-2", PNG);

    const dev1Panels = await listPanels(env, "dev-1");
    expect(dev1Panels.length).toBe(1);

    const dev2Panels = await listPanels(env, "dev-2");
    expect(dev2Panels.length).toBe(1);
  });

  it("returns [] when the device has no panels", async () => {
    expect(await listPanels(env, "nobody")).toEqual([]);
  });

  it("panel rows have id, content_type, and created fields", async () => {
    const { id } = await savePanel(env, "dev-1", PNG);
    const [panel] = await listPanels(env, "dev-1");
    expect(panel.id).toBe(id);
    expect(panel.content_type).toBe("image/png");
    expect(typeof panel.created).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// tagPanel — writes a taste_signals row
// ---------------------------------------------------------------------------
describe("tagPanel", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM manga_panels").run();
    await env.DB.prepare("DELETE FROM taste_signals").run();
  });

  it("inserts a taste_signals row with domain='manga', aspects, and note", async () => {
    const { id: panelId } = await savePanel(env, "dev-1", PNG);
    await tagPanel(env, "dev-1", panelId, ["linework", "inking"], "love the cross-hatching");

    const row = await env.DB
      .prepare("SELECT * FROM taste_signals WHERE device_id = ? AND domain = 'manga'")
      .bind("dev-1")
      .first<{ id: string; device_id: string; domain: string; target_ref: string; signal: string; created: number }>();

    expect(row).not.toBeNull();
    expect(row!.domain).toBe("manga");
    expect(row!.target_ref).toBe(panelId);
    expect(row!.device_id).toBe("dev-1");

    const signal = JSON.parse(row!.signal);
    expect(signal.aspects).toEqual(["linework", "inking"]);
    expect(signal.note).toBe("love the cross-hatching");
    expect(typeof row!.created).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// getTaste / setTaste — upsert round-trip
// ---------------------------------------------------------------------------
describe("getTaste / setTaste", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM taste_profiles").run();
  });

  it("returns null when no profile exists", async () => {
    expect(await getTaste(env, "dev-1", "manga")).toBeNull();
  });

  it("round-trips arbitrary JSON via setTaste + getTaste", async () => {
    const data = { favoriteAspects: ["linework", "composition"], threshold: 0.8 };
    await setTaste(env, "dev-1", "manga", data);

    const result = await getTaste(env, "dev-1", "manga");
    expect(result).toEqual(data);
  });

  it("upserts — second setTaste overwrites the first", async () => {
    await setTaste(env, "dev-1", "manga", { v: 1 });
    await setTaste(env, "dev-1", "manga", { v: 2 });

    const result = await getTaste(env, "dev-1", "manga");
    expect(result).toEqual({ v: 2 });

    // Exactly one row in the DB after two upserts
    const count = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM taste_profiles WHERE device_id = ? AND domain = ?")
      .bind("dev-1", "manga")
      .first<number>("n");
    expect(count).toBe(1);
  });

  it("different domains are stored independently", async () => {
    await setTaste(env, "dev-1", "manga", { manga: true });
    await setTaste(env, "dev-1", "photos", { photos: true });

    expect(await getTaste(env, "dev-1", "manga")).toEqual({ manga: true });
    expect(await getTaste(env, "dev-1", "photos")).toEqual({ photos: true });
  });
});

// ---------------------------------------------------------------------------
// HTTP routes via SELF.fetch — manga panels + taste
// ---------------------------------------------------------------------------

const BASE = "https://wall.test";

function panelForm(bytes: Uint8Array | Uint8Array[], deviceId: string): FormData {
  const fd = new FormData();
  fd.append("device_id", deviceId);
  const arr = bytes instanceof Uint8Array ? [bytes] : bytes;
  for (const b of arr) {
    fd.append("panel", new File([b], "panel.png", { type: "image/png" }));
  }
  return fd;
}

describe("manga panel upload routes", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM manga_panels").run();
  });

  it("POST /api/manga/panels uploads one file and returns panels array with id + url", async () => {
    const r = await SELF.fetch(`${BASE}/api/manga/panels`, {
      method: "POST",
      body: panelForm(PNG, "dev-1"),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.panels).toHaveLength(1);
    expect(typeof body.panels[0].id).toBe("string");
    expect(body.panels[0].url).toMatch(/^\/api\/manga\/panels\/.+\/raw$/);
    expect(body.errors).toHaveLength(0);
  });

  it("POST /api/manga/panels with non-multipart body → 400", async () => {
    const r = await SELF.fetch(`${BASE}/api/manga/panels`, {
      method: "POST",
      body: JSON.stringify({ device_id: "dev-1" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(r.status).toBe(400);
    expect(String((await r.json() as any).detail).toLowerCase()).toContain("multipart");
  });

  it("POST /api/manga/panels with non-image bytes → 200 with errors entry", async () => {
    const fd = new FormData();
    fd.append("device_id", "dev-1");
    fd.append("panel", new File([new TextEncoder().encode("not an image")], "bad.png", { type: "image/png" }));
    const r = await SELF.fetch(`${BASE}/api/manga/panels`, { method: "POST", body: fd });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.panels).toHaveLength(0);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].error.toLowerCase()).toContain("image");
  });

  it("POST /api/manga/panels without device_id → 400", async () => {
    const fd = new FormData();
    fd.append("panel", new File([PNG], "panel.png", { type: "image/png" }));
    const r = await SELF.fetch(`${BASE}/api/manga/panels`, { method: "POST", body: fd });
    expect(r.status).toBe(400);
    expect(String((await r.json() as any).detail)).toMatch(/device_id/);
  });

  it("POST /api/manga/panels with 2 valid files → panels.length===2, errors empty", async () => {
    const r = await SELF.fetch(`${BASE}/api/manga/panels`, {
      method: "POST",
      body: panelForm([PNG, PNG], "dev-1"),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.panels).toHaveLength(2);
    for (const p of body.panels) {
      expect(typeof p.id).toBe("string");
      expect(p.url).toMatch(/^\/api\/manga\/panels\/.+\/raw$/);
    }
    expect(body.errors).toHaveLength(0);
  });

  it("POST /api/manga/panels partial batch: 1 valid + 1 bad → panels.length===1, errors.length===1", async () => {
    const fd = new FormData();
    fd.append("device_id", "dev-1");
    fd.append("panel", new File([PNG], "good.png", { type: "image/png" }));
    fd.append("panel", new File([new TextEncoder().encode("not an image")], "bad.png", { type: "image/png" }));
    const r = await SELF.fetch(`${BASE}/api/manga/panels`, { method: "POST", body: fd });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.panels).toHaveLength(1);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].filename).toBe("bad.png");
    expect(body.errors[0].error.toLowerCase()).toContain("image");
  });

  it("POST /api/manga/panels with zero panel files → 400", async () => {
    const fd = new FormData();
    fd.append("device_id", "dev-1");
    const r = await SELF.fetch(`${BASE}/api/manga/panels`, { method: "POST", body: fd });
    expect(r.status).toBe(400);
    expect(String((await r.json() as any).detail).toLowerCase()).toMatch(/panel/);
  });

  it(`POST /api/manga/panels with more than ${MANGA_MAX_FILES} files → 400`, async () => {
    const tooMany = Array.from({ length: MANGA_MAX_FILES + 1 }, () => PNG);
    const r = await SELF.fetch(`${BASE}/api/manga/panels`, {
      method: "POST",
      body: panelForm(tooMany, "dev-1"),
    });
    expect(r.status).toBe(400);
    expect(String((await r.json() as any).detail).toLowerCase()).toContain("too many");
  });

  it("GET /api/manga/panels lists device panels with url field", async () => {
    await SELF.fetch(`${BASE}/api/manga/panels`, { method: "POST", body: panelForm(PNG, "dev-1") });
    await SELF.fetch(`${BASE}/api/manga/panels`, { method: "POST", body: panelForm(PNG, "dev-1") });
    await SELF.fetch(`${BASE}/api/manga/panels`, { method: "POST", body: panelForm(PNG, "dev-2") });
    const r = await SELF.fetch(`${BASE}/api/manga/panels?device=dev-1`);
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.panels).toHaveLength(2);
    for (const p of body.panels) {
      expect(p.url).toMatch(/^\/api\/manga\/panels\/.+\/raw$/);
    }
  });

  it("GET /api/manga/panels/{id}/raw serves image bytes", async () => {
    const up = await (await SELF.fetch(`${BASE}/api/manga/panels`, { method: "POST", body: panelForm(PNG, "dev-1") })).json() as any;
    const r = await SELF.fetch(`${BASE}${up.panels[0].url}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/^image\//);
    expect(new Uint8Array(await r.arrayBuffer()).length).toBe(PNG.length);
  });

  it("GET /api/manga/panels/{id}/raw for unknown id → 404", async () => {
    const r = await SELF.fetch(`${BASE}/api/manga/panels/doesnotexist/raw`);
    expect(r.status).toBe(404);
  });
});

describe("manga tag route", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM manga_panels").run();
    await env.DB.prepare("DELETE FROM taste_signals").run();
  });

  it("POST /api/manga/panels/{id}/tag with valid aspects → 200 + taste_signals row", async () => {
    const { panels } = await (await SELF.fetch(`${BASE}/api/manga/panels`, { method: "POST", body: panelForm(PNG, "dev-1") })).json() as any;
    const id = panels[0].id;
    const r = await SELF.fetch(`${BASE}/api/manga/panels/${id}/tag`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: "dev-1", aspects: ["linework", "inking"], note: "great" }),
    });
    expect(r.status).toBe(200);
    expect((await r.json() as any).ok).toBe(true);
    const row = await env.DB.prepare("SELECT id FROM taste_signals WHERE device_id = ? AND domain = 'manga'").bind("dev-1").first();
    expect(row).not.toBeNull();
  });

  it("POST tag with empty/invalid aspects and no note → 400", async () => {
    const { panels } = await (await SELF.fetch(`${BASE}/api/manga/panels`, { method: "POST", body: panelForm(PNG, "dev-1") })).json() as any;
    const id = panels[0].id;
    const r = await SELF.fetch(`${BASE}/api/manga/panels/${id}/tag`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: "dev-1", aspects: ["notvalid"], note: "" }),
    });
    expect(r.status).toBe(400);
  });

  it("POST tag without device_id → 400", async () => {
    const { panels } = await (await SELF.fetch(`${BASE}/api/manga/panels`, { method: "POST", body: panelForm(PNG, "dev-1") })).json() as any;
    const id = panels[0].id;
    const r = await SELF.fetch(`${BASE}/api/manga/panels/${id}/tag`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aspects: ["linework"] }),
    });
    expect(r.status).toBe(400);
    expect(String((await r.json() as any).detail)).toMatch(/device_id/);
  });
});

describe("taste routes", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM taste_profiles").run();
  });

  it("GET /api/taste/{domain} for unknown device → {data: null}", async () => {
    const r = await SELF.fetch(`${BASE}/api/taste/manga?device=nobody`);
    expect(r.status).toBe(200);
    expect((await r.json() as any).data).toBeNull();
  });

  it("PUT /api/taste/{domain} then GET round-trips the data", async () => {
    const data = { favoriteAspects: ["linework"], threshold: 0.7 };
    const put = await SELF.fetch(`${BASE}/api/taste/manga`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: "dev-1", data }),
    });
    expect(put.status).toBe(200);
    expect((await put.json() as any).ok).toBe(true);
    const get = await SELF.fetch(`${BASE}/api/taste/manga?device=dev-1`);
    expect(get.status).toBe(200);
    expect((await get.json() as any).data).toEqual(data);
  });

  it("PUT /api/taste/{domain} without device_id → 400", async () => {
    const r = await SELF.fetch(`${BASE}/api/taste/manga`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: {} }),
    });
    expect(r.status).toBe(400);
    expect(String((await r.json() as any).detail)).toMatch(/device_id/);
  });
});
