import request from "supertest";
import { describe, expect, it } from "vitest";
import { bearer, countingProvider, testApp } from "./app.js";

/**
 * Efficiency guarantee for SkillForge: every decision (profile, analysis, matching, planning, adaptation) is
 * deterministic and makes no language-model call; the Mentor makes at most one call per event, only to word its
 * message, and falls back to a template when that call fails. These counts are enforced here.
 */
const as = { Authorization: bearer("budget") };
const PS = { role_id: "fullstack_developer", skills: ["Python", "SQL", "HTML"] };

function setup(coach: (() => Promise<string | null>) | undefined) {
  const provider = countingProvider();
  let coachCalls = 0;
  const app = testApp({
    autoAuth: false,
    llm: provider.llm,
    coach: coach ? async () => { coachCalls++; return coach(); } : undefined,
  });
  return { app, providerCalls: provider.total, coachCalls: () => coachCalls };
}

async function runScenario(app: ReturnType<typeof testApp>) {
  const created = await request(app).post("/api/learning-path").set(as).send(PS).expect(201);
  const id = created.body.id as string;
  await request(app).post(`/api/learning-path/${id}/assessment`).set(as).send({ source: "simulation", skill: "JavaScript", score: 40 }).expect(200);
  await request(app).post(`/api/learning-path/${id}/assessment`).set(as).send({ source: "simulation", skill: "JavaScript", score: 90 }).expect(200);
  await request(app).post(`/api/learning-path/${id}/goal`).set(as).send({ role_id: "data_analyst" }).expect(200);
  await request(app).get(`/api/learning-path/${id}`).set(as).expect(200);
  await request(app).get(`/api/learning-path/${id}/agent-log`).set(as).expect(200);
  return id;
}

describe("language-model calls per SkillForge event", () => {
  it("makes no model call at all in mock mode (template mentor), across create, two assessments and a goal change", async () => {
    const { app, providerCalls, coachCalls } = setup(undefined);
    await runScenario(app);
    expect(providerCalls()).toBe(0);
    expect(coachCalls()).toBe(0);
  });

  it("with a live mentor: exactly one call per event (4 events), none for reads, and no other model call", async () => {
    const { app, providerCalls, coachCalls } = setup(async () => "Keep going.");
    await runScenario(app);
    expect(coachCalls()).toBe(4); // create, assessment, assessment, goal change
    expect(providerCalls()).toBe(0); // no extraction, grading or planning call anywhere in the flow
  });

  it("still one attempt per event when the model fails, and the template is used instead", async () => {
    const { app, coachCalls } = setup(async () => { throw new Error("quota"); });
    const created = await request(app).post("/api/learning-path").set(as).send(PS).expect(201);
    expect(created.body.mentor.source).toBe("template");
    const after = await request(app).post(`/api/learning-path/${created.body.id}/assessment`).set(as).send({ source: "simulation", skill: "JavaScript", score: 40 }).expect(200);
    expect(after.body.mentor.source).toBe("template");
    expect(coachCalls()).toBe(2);
  });
});
