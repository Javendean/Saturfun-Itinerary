import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
  createProposals,
  listProposals,
  pendingCount,
  getProposal,
  setFeedback,
} from "../src/planner-store";

const ITEM_A = {
  title: "Ramen at Ichiran",
  pitch: "Solo ramen booths for focused slurping",
  fits_where: "dinner",
  neighborhood: "East Village",
  needs_verifying: 0,
};

const ITEM_B = {
  title: "Taco tour",
  pitch: "Three taquerias in a row",
  fits_where: "lunch",
  neighborhood: "Bushwick",
  needs_verifying: 1,
};

// ---------------------------------------------------------------------------
// createProposals
// ---------------------------------------------------------------------------
describe("createProposals", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM proposals").run();
  });

  it("bulk-inserts items and returns the inserted count", async () => {
    const count = await createProposals(env, [ITEM_A, ITEM_B]);
    expect(count).toBe(2);
    const dbCount = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM proposals")
      .first<number>("n");
    expect(dbCount).toBe(2);
  });

  it("sets status='pending' on all inserted rows", async () => {
    await createProposals(env, [ITEM_A, ITEM_B]);
    const pending = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM proposals WHERE status = 'pending'")
      .first<number>("n");
    expect(pending).toBe(2);
  });

  it("assigns unique string ids to each row", async () => {
    await createProposals(env, [ITEM_A, ITEM_B]);
    const rows = await env.DB
      .prepare("SELECT id FROM proposals")
      .all<{ id: string }>();
    expect(rows.results.length).toBe(2);
    const ids = rows.results.map((r) => r.id);
    expect(ids[0]).not.toBe(ids[1]);
    for (const id of ids) {
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(8);
    }
  });

  it("returns 0 when given an empty array", async () => {
    const count = await createProposals(env, []);
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// listProposals
// ---------------------------------------------------------------------------
describe("listProposals", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM proposals").run();
  });

  it("returns proposals newest-first", async () => {
    await createProposals(env, [ITEM_A]);
    await createProposals(env, [ITEM_B]);

    const all = await listProposals(env);
    expect(all.length).toBe(2);
    // newest first: ITEM_B was inserted after ITEM_A
    expect(all[0].title).toBe(ITEM_B.title);
    expect(all[1].title).toBe(ITEM_A.title);
  });

  it("filters by status when provided", async () => {
    await createProposals(env, [ITEM_A]);
    // Approve one to change its status
    const all = await listProposals(env);
    await env.DB
      .prepare("UPDATE proposals SET status = 'approved' WHERE id = ?")
      .bind(all[0].id)
      .run();
    await createProposals(env, [ITEM_B]);

    const pending = await listProposals(env, "pending");
    expect(pending.length).toBe(1);
    expect(pending[0].title).toBe(ITEM_B.title);

    const approved = await listProposals(env, "approved");
    expect(approved.length).toBe(1);
    expect(approved[0].title).toBe(ITEM_A.title);
  });

  it("returns all when no status filter given", async () => {
    await createProposals(env, [ITEM_A, ITEM_B]);
    const all = await listProposals(env);
    expect(all.length).toBe(2);
  });

  it("returns [] when table is empty", async () => {
    expect(await listProposals(env)).toEqual([]);
  });

  it("returned rows have all Proposal fields", async () => {
    await createProposals(env, [ITEM_A]);
    const [p] = await listProposals(env);
    expect(typeof p.id).toBe("string");
    expect(p.title).toBe(ITEM_A.title);
    expect(p.pitch).toBe(ITEM_A.pitch);
    expect(p.fits_where).toBe(ITEM_A.fits_where);
    expect(p.neighborhood).toBe(ITEM_A.neighborhood);
    expect(p.needs_verifying).toBe(ITEM_A.needs_verifying);
    expect(p.status).toBe("pending");
    expect(typeof p.created).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// pendingCount
// ---------------------------------------------------------------------------
describe("pendingCount", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM proposals").run();
  });

  it("returns 0 when table is empty", async () => {
    expect(await pendingCount(env)).toBe(0);
  });

  it("counts only rows with status='pending'", async () => {
    await createProposals(env, [ITEM_A, ITEM_B]);
    expect(await pendingCount(env)).toBe(2);

    const all = await listProposals(env);
    await env.DB
      .prepare("UPDATE proposals SET status = 'approved' WHERE id = ?")
      .bind(all[0].id)
      .run();
    expect(await pendingCount(env)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// getProposal
// ---------------------------------------------------------------------------
describe("getProposal", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM proposals").run();
  });

  it("returns null for an unknown id", async () => {
    expect(await getProposal(env, "doesnotexist")).toBeNull();
  });

  it("returns the correct proposal by id", async () => {
    await createProposals(env, [ITEM_A]);
    const [inserted] = await listProposals(env);
    const found = await getProposal(env, inserted.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(inserted.id);
    expect(found!.title).toBe(ITEM_A.title);
  });
});

// ---------------------------------------------------------------------------
// setFeedback
// ---------------------------------------------------------------------------
describe("setFeedback", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM proposals").run();
    await env.DB.prepare("DELETE FROM taste_signals").run();
  });

  it("approve → sets status to 'approved'", async () => {
    await createProposals(env, [ITEM_A]);
    const [p] = await listProposals(env);

    await setFeedback(env, p.id, "dev-1", "approve", "looks great");

    const updated = await getProposal(env, p.id);
    expect(updated!.status).toBe("approved");
  });

  it("reject → sets status to 'rejected'", async () => {
    await createProposals(env, [ITEM_B]);
    const [p] = await listProposals(env);

    await setFeedback(env, p.id, "dev-2", "reject", "not my vibe");

    const updated = await getProposal(env, p.id);
    expect(updated!.status).toBe("rejected");
  });

  it("inserts a taste_signals row with domain='itinerary' on approve", async () => {
    await createProposals(env, [ITEM_A]);
    const [p] = await listProposals(env);

    await setFeedback(env, p.id, "dev-1", "approve", "perfect stop");

    const row = await env.DB
      .prepare(
        "SELECT * FROM taste_signals WHERE device_id = ? AND domain = 'itinerary'",
      )
      .bind("dev-1")
      .first<{
        id: string;
        device_id: string;
        domain: string;
        target_ref: string;
        signal: string;
        created: number;
      }>();

    expect(row).not.toBeNull();
    expect(row!.domain).toBe("itinerary");
    expect(row!.target_ref).toBe(p.id);
    expect(row!.device_id).toBe("dev-1");

    const signal = JSON.parse(row!.signal);
    expect(signal.verdict).toBe("approve");
    expect(signal.note).toBe("perfect stop");
    expect(typeof row!.created).toBe("number");
  });

  it("inserts a taste_signals row with domain='itinerary' on reject", async () => {
    await createProposals(env, [ITEM_B]);
    const [p] = await listProposals(env);

    await setFeedback(env, p.id, "dev-3", "reject", "too far");

    const row = await env.DB
      .prepare(
        "SELECT * FROM taste_signals WHERE device_id = ? AND domain = 'itinerary'",
      )
      .bind("dev-3")
      .first<{ signal: string; target_ref: string }>();

    expect(row).not.toBeNull();
    expect(row!.target_ref).toBe(p.id);
    const signal = JSON.parse(row!.signal);
    expect(signal.verdict).toBe("reject");
    expect(signal.note).toBe("too far");
  });

  it("taste_signals row has a unique non-null id", async () => {
    await createProposals(env, [ITEM_A]);
    const [p] = await listProposals(env);
    await setFeedback(env, p.id, "dev-1", "approve", "nice");

    const row = await env.DB
      .prepare("SELECT id FROM taste_signals WHERE device_id = 'dev-1'")
      .first<{ id: string }>();
    expect(row).not.toBeNull();
    expect(typeof row!.id).toBe("string");
    expect(row!.id.length).toBeGreaterThan(8);
  });
});
