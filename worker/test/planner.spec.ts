import { env, SELF } from "cloudflare:test";
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

// ---------------------------------------------------------------------------
// HTTP route tests — /api/planner/*
// ---------------------------------------------------------------------------

const BASE = "https://wall.test";
const OWNER = "test-owner-secret"; // matches PHOTO_OWNER_TOKEN in wrangler.test.toml

describe("POST /api/planner/proposals", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM proposals").run();
  });

  it("returns 403 without owner token", async () => {
    const r = await SELF.fetch(`${BASE}/api/planner/proposals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proposals: [{ title: "Test", pitch: "A test pitch" }] }),
    });
    expect(r.status).toBe(403);
  });

  it("returns 403 with wrong owner token", async () => {
    const r = await SELF.fetch(`${BASE}/api/planner/proposals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Owner-Token": "wrong-token" },
      body: JSON.stringify({ proposals: [{ title: "Test", pitch: "A test pitch" }] }),
    });
    expect(r.status).toBe(403);
  });

  it("returns 400 when body is not valid JSON", async () => {
    const r = await SELF.fetch(`${BASE}/api/planner/proposals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Owner-Token": OWNER },
      body: "not-json",
    });
    expect(r.status).toBe(400);
  });

  it("returns 400 when proposals array is missing", async () => {
    const r = await SELF.fetch(`${BASE}/api/planner/proposals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Owner-Token": OWNER },
      body: JSON.stringify({ not_proposals: [] }),
    });
    expect(r.status).toBe(400);
  });

  it("returns 400 when all items are invalid (missing title/pitch)", async () => {
    const r = await SELF.fetch(`${BASE}/api/planner/proposals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Owner-Token": OWNER },
      body: JSON.stringify({ proposals: [{ title: "", pitch: "" }] }),
    });
    expect(r.status).toBe(400);
  });

  it("creates proposals with owner token and returns {created, pushed}", async () => {
    const r = await SELF.fetch(`${BASE}/api/planner/proposals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Owner-Token": OWNER },
      body: JSON.stringify({
        proposals: [
          { title: "Ramen stop", pitch: "Solo ramen booths", fits_where: "dinner", neighborhood: "East Village" },
          { title: "Coffee break", pitch: "Third-wave pour-overs", fits_where: "morning", neighborhood: "Williamsburg" },
        ],
      }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { created: number; pushed: number };
    expect(body.created).toBe(2);
    expect(typeof body.pushed).toBe("number"); // no subs → 0, but shape is correct
  });

  it("skips invalid items and only counts valid ones", async () => {
    const r = await SELF.fetch(`${BASE}/api/planner/proposals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Owner-Token": OWNER },
      body: JSON.stringify({
        proposals: [
          { title: "Valid stop", pitch: "Good pitch" },
          { title: "", pitch: "No title — skip" },
        ],
      }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { created: number; pushed: number };
    expect(body.created).toBe(1);
  });

  it("stores proposals in DB with status=pending", async () => {
    await SELF.fetch(`${BASE}/api/planner/proposals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Owner-Token": OWNER },
      body: JSON.stringify({
        proposals: [{ title: "Park Slope taco", pitch: "Three taquerias", fits_where: "lunch", neighborhood: "Park Slope" }],
      }),
    });
    const row = await env.DB.prepare("SELECT status FROM proposals WHERE title = 'Park Slope taco'").first<{ status: string }>();
    expect(row).not.toBeNull();
    expect(row!.status).toBe("pending");
  });
});

describe("GET /api/planner/proposals", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM proposals").run();
  });

  it("returns 405 for non-GET methods", async () => {
    const r = await SELF.fetch(`${BASE}/api/planner/proposals`, {
      method: "DELETE",
    });
    expect(r.status).toBe(405);
  });

  it("returns pending proposals by default (no status param)", async () => {
    await SELF.fetch(`${BASE}/api/planner/proposals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Owner-Token": OWNER },
      body: JSON.stringify({
        proposals: [
          { title: "Stop A", pitch: "Pitch A" },
          { title: "Stop B", pitch: "Pitch B" },
        ],
      }),
    });

    const r = await SELF.fetch(`${BASE}/api/planner/proposals`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { proposals: Array<{ title: string; status: string }> };
    expect(body.proposals).toHaveLength(2);
    for (const p of body.proposals) expect(p.status).toBe("pending");
  });

  it("filters by ?status=approved after approving one", async () => {
    await SELF.fetch(`${BASE}/api/planner/proposals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Owner-Token": OWNER },
      body: JSON.stringify({ proposals: [{ title: "Stop A", pitch: "Pitch A" }] }),
    });
    const listed = (await (await SELF.fetch(`${BASE}/api/planner/proposals`)).json()) as { proposals: Array<{ id: string }> };
    const id = listed.proposals[0].id;
    await env.DB.prepare("UPDATE proposals SET status = 'approved' WHERE id = ?").bind(id).run();

    const pending = (await (await SELF.fetch(`${BASE}/api/planner/proposals?status=pending`)).json()) as { proposals: unknown[] };
    expect(pending.proposals).toHaveLength(0);

    const approved = (await (await SELF.fetch(`${BASE}/api/planner/proposals?status=approved`)).json()) as { proposals: Array<{ id: string }> };
    expect(approved.proposals).toHaveLength(1);
    expect(approved.proposals[0].id).toBe(id);
  });
});

describe("POST /api/planner/proposals/{id}/feedback", () => {
  let proposalId: string;

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM proposals").run();
    await env.DB.prepare("DELETE FROM taste_signals").run();
    // Seed one proposal
    await SELF.fetch(`${BASE}/api/planner/proposals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Owner-Token": OWNER },
      body: JSON.stringify({ proposals: [{ title: "Test stop", pitch: "A test pitch" }] }),
    });
    const list = (await (await SELF.fetch(`${BASE}/api/planner/proposals`)).json()) as { proposals: Array<{ id: string }> };
    proposalId = list.proposals[0].id;
  });

  it("returns 404 for unknown proposal id", async () => {
    const r = await SELF.fetch(`${BASE}/api/planner/proposals/doesnotexist/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: "dev-1", verdict: "approve" }),
    });
    expect(r.status).toBe(404);
  });

  it("returns 400 when device_id is missing", async () => {
    const r = await SELF.fetch(`${BASE}/api/planner/proposals/${proposalId}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verdict: "approve" }),
    });
    expect(r.status).toBe(400);
  });

  it("returns 400 for invalid verdict", async () => {
    const r = await SELF.fetch(`${BASE}/api/planner/proposals/${proposalId}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: "dev-1", verdict: "maybe" }),
    });
    expect(r.status).toBe(400);
  });

  it("returns 400 when body is not valid JSON", async () => {
    const r = await SELF.fetch(`${BASE}/api/planner/proposals/${proposalId}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(r.status).toBe(400);
  });

  it("approve → 200 + {ok:true} + status flips to approved", async () => {
    const r = await SELF.fetch(`${BASE}/api/planner/proposals/${proposalId}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: "dev-1", verdict: "approve", note: "love it" }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Verify via GET
    const list = (await (await SELF.fetch(`${BASE}/api/planner/proposals?status=approved`)).json()) as { proposals: Array<{ id: string; status: string }> };
    expect(list.proposals).toHaveLength(1);
    expect(list.proposals[0].id).toBe(proposalId);
    expect(list.proposals[0].status).toBe("approved");
  });

  it("reject → 200 + {ok:true} + status flips to rejected", async () => {
    const r = await SELF.fetch(`${BASE}/api/planner/proposals/${proposalId}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: "dev-2", verdict: "reject", note: "not feeling it" }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const list = (await (await SELF.fetch(`${BASE}/api/planner/proposals?status=rejected`)).json()) as { proposals: Array<{ id: string; status: string }> };
    expect(list.proposals).toHaveLength(1);
    expect(list.proposals[0].status).toBe("rejected");
  });
});

describe("GET /api/push/digest — pending count integration", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM proposals").run();
  });

  it("returns 'see what's new' body when no pending proposals", async () => {
    const r = await SELF.fetch(`${BASE}/api/push/digest`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { title: string; body: string; url: string };
    expect(body.title).toBe("Saturfun");
    expect(body.body).toBe("Open Saturfun to see what's new.");
    expect(body.url).toBe("plan.html");
  });

  it("reflects pending count when proposals exist", async () => {
    await SELF.fetch(`${BASE}/api/planner/proposals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Owner-Token": OWNER },
      body: JSON.stringify({
        proposals: [
          { title: "Stop A", pitch: "Pitch A" },
          { title: "Stop B", pitch: "Pitch B" },
        ],
      }),
    });

    const r = await SELF.fetch(`${BASE}/api/push/digest`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { title: string; body: string; url: string };
    expect(body.title).toBe("Saturfun");
    expect(body.body).toBe("✨ 2 new stop ideas to review");
    expect(body.url).toBe("plan.html");
  });

  it("uses singular 'idea' for exactly 1 pending proposal", async () => {
    await SELF.fetch(`${BASE}/api/planner/proposals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Owner-Token": OWNER },
      body: JSON.stringify({ proposals: [{ title: "Stop A", pitch: "Pitch A" }] }),
    });

    const r = await SELF.fetch(`${BASE}/api/push/digest`);
    const body = (await r.json()) as { body: string };
    expect(body.body).toBe("✨ 1 new stop idea to review");
  });
});
