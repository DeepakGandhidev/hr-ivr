import { describe, it, expect } from "vitest";
import { GUARDRAIL_ERROR, interviewProtocolSchema, estimatePlan, TRIM_WARNING } from "@pratibha/shared";

/** Batch 6, I14 and I13: what the API refuses, whichever client sent it. */
describe("interview settings guardrail", () => {
  it("refuses a personal question with the exact copy", () => {
    const r = interviewProtocolSchema.safeParse({ customQuestions: ["Are you married?"] });
    expect(r.success).toBe(false);
    expect(r.success ? null : r.error.issues[0].message).toBe(GUARDRAIL_ERROR);
    expect(GUARDRAIL_ERROR).toBe("This question touches personal topics Pratibha does not ask about. Keep questions about the work.");
  });

  it("guards the instructions too", () => {
    const r = interviewProtocolSchema.safeParse({ instructionText: "Ask whether they plan to have children soon." });
    expect(r.success).toBe(false);
  });

  it("lets work questions through", () => {
    const r = interviewProtocolSchema.safeParse({ customQuestions: ["What is the biggest deal you have closed, and what was your exact role in it?"] });
    expect(r.success).toBe(true);
  });

  it("allows three custom questions at most", () => {
    expect(interviewProtocolSchema.safeParse({ customQuestions: ["a?", "b?", "c?"] }).success).toBe(true);
    expect(interviewProtocolSchema.safeParse({ customQuestions: ["a?", "b?", "c?", "d?"] }).success).toBe(false);
  });
});

/** I31: the done-when numbers. */
describe("the interview plan", () => {
  const base = { durationMinutes: 10, minQuestions: 6, maxQuestions: 10, introduceRole: true, candidateQuestions: true, customQuestions: [] as string[] };

  it("changes the total when a screener is toggled", () => {
    const four = estimatePlan({ ...base, screeners: { notice: true, salary: true, reasonLeaving: true, gaps: true } });
    const five = estimatePlan({ ...base, screeners: { notice: true, salary: true, reasonLeaving: true, gaps: true, travel: true } });
    expect(five.total - four.total).toBe(0.5);
  });

  it("warns at a 5 minute length with six screeners", () => {
    const p = estimatePlan({ ...base, durationMinutes: 5, screeners: { notice: true, salary: true, reasonLeaving: true, gaps: true, location: true, travel: true } });
    expect(p.over).toBe(true);
    expect(TRIM_WARNING(p.label, 5)).toBe("Your choices need about 10½ minutes of a 5 minute interview. Add minutes or trim screeners.");
  });
});
