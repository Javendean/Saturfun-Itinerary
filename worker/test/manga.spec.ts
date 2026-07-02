import { env } from "cloudflare:test";
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
