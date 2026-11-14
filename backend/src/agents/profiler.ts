import { resolveTopic, type LearnerSkillState } from "../core/path.js";
import type { Agent, LearnerProfile } from "./types.js";

export interface ProfilerInput {
  profile: LearnerProfile;
}
export interface ProfilerOutput {
  /** Declared topics only (self-reported, so never verified here). */
  states: LearnerSkillState[];
  /** Names the learner typed that did not match any known topic, so the UI can say so instead of silently dropping them. */
  unrecognized: string[];
}

const clean = (xs: readonly string[]): string[] => [...new Set(xs.map((s) => s.trim()).filter(Boolean))];

/**
 * Normalizes what the learner entered. Skills they list and the skills of their projects both count as DECLARED
 * evidence (capped at 40% until verified). Certifications are kept on the profile but do not add skills.
 */
export const profilerAgent: Agent<ProfilerInput, ProfilerOutput> = {
  name: "profiler",
  async run({ profile }, ctx) {
    const typed = clean([...profile.skills, ...profile.projects.flatMap((p) => p.skills)]);
    const topics = new Set<string>();
    const unrecognized: string[] = [];
    for (const name of typed) {
      const topic = resolveTopic(name, ctx.graph);
      if (topic) topics.add(topic);
      else unrecognized.push(name);
    }
    const states = [...topics].sort().map((skill_id) => ({ skill_id, declared: true, verified_proficiency: null }));
    return {
      output: { states, unrecognized },
      handoff: `${states.length} declared skill(s)`,
      log: [
        {
          agent: "profiler",
          action: "normalize_profile",
          summary: `Matched ${states.length} declared skill(s) from ${typed.length} entered${profile.projects.length > 0 ? ` (including ${profile.projects.length} project(s))` : ""}${unrecognized.length > 0 ? `; could not match: ${unrecognized.join(", ")}` : ""}.`,
          decided_by: "deterministic",
          inputs_ref: "learner profile",
          outputs_ref: "declared skill states",
        },
      ],
    };
  },
};
