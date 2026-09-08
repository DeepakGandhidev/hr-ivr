import { PrismaClient } from '../src/index.js';

const prisma = new PrismaClient();

const PLANS = [
  {
    id: 'starter',
    name: 'Starter',
    priceInr: 4999,
    limits: { roles: 2, interviews: 15, screenings: 100 },
    features: {},
  },
  {
    id: 'growth',
    name: 'Growth',
    priceInr: 12999,
    limits: { roles: 6, interviews: 60, screenings: 400 },
    features: { portalAutoPosting: true, protocolTuning: true },
  },
  {
    id: 'scale',
    name: 'Scale',
    priceInr: 29999,
    limits: { roles: null, interviews: 200, screenings: 1500 },
    features: { portalAutoPosting: true, protocolTuning: true, dedicatedDid: true, apiAccess: true },
  },
];

async function main() {
  for (const plan of PLANS) {
    await prisma.plan.upsert({
      where: { name: plan.name },
      update: {
        priceInr: plan.priceInr,
        limits: plan.limits,
        features: plan.features,
      },
      create: {
        id: plan.id,
        name: plan.name,
        priceInr: plan.priceInr,
        limits: plan.limits,
        features: plan.features,
      },
    });
  }

  const defaults = [
    {
      key: 'jd_generation',
      body: `You are a hiring copywriter. Given a structured role brief, write a clear, inclusive job description in Markdown.

Role brief:
- Title: {{title}}
- Location: {{location}}
- Experience: {{experienceRange}}
- Salary band: {{salaryBand}}
- Must-haves: {{mustHaves}}
- Good-to-haves: {{goodToHaves}}
- Notes: {{notes}}

Output only the job description body in Markdown. Do not include salary figures if the band is empty. Keep it concise and professional.`,
    },
    {
      key: 'cv_screening',
      body: `You are screening a candidate's CV against a job description.

Job title: {{jobTitle}}
Must-haves: {{mustHaves}}
Good-to-haves: {{goodToHaves}}

Candidate CV parsed:
{{cvParsed}}

Score the candidate 0-100. Return a JSON object with:
- score (integer 0-100)
- matchedMustHaves (array of strings from the must-haves that are clearly evidenced)
- gaps (array of strings where evidence is weak or missing)
- verdict: "shortlist" if score >= {{threshold}}, else "archive"
- reasonSummary: one concise paragraph explaining the verdict

Be evidence-based and conservative. Do not infer skills not stated in the CV.`,
    },
    {
      key: 'interviewer_system',
      body: `You are Pratibha, an AI hiring assistant for {{companyName}}.
You run first-round screening conversations with candidates who call you. You never call anyone.

HOW YOU SPEAK
- Plain spoken sentences only: no markdown, no bullet points, no headings.
- Warm, professional, concise. One or two sentences per turn.
- Ask one question at a time and let them finish.

WHAT YOU MUST NEVER DO
- Never state salary, joining date, or that an offer will follow.
- Never tell the candidate they passed or failed.
- Never evaluate an answer out loud.
- Never discuss other candidates or internal timelines.
- If asked something you cannot answer, say the team will follow up.

ROLE: {{jobTitle}}
JD SUMMARY: {{jdSummary}}
CANDIDATE: {{candidateName}}
CV: {{cvSummary}}

INTERVIEW PROTOCOL (set by hiring team):
{{protocolText}}`,
    },
    {
      key: 'report_generation',
      body: `You are assessing a completed first-round screening call for {{companyName}}.

Role: {{jobTitle}}
JD: {{jdSummary}}
Candidate CV: {{cvSummary}}

Transcript:
{{transcript}}

Produce an assessment report with:
- overallScore: 0-10, one decimal
- recommendation: one of strong_yes, yes, maybe, no
- dimensions: JSON object with scores 0-10 for communication, domain_fit, experience_depth, red_flags
- strengths: at least 3 strings when content allows
- concerns: at least 2 strings when content allows
- notableQuotes: 2-4 objects with text and approximate timestamp

Be evidence-based. Scores must be grounded in the transcript.`,
    },
  ];

  for (const tmpl of defaults) {
    const existing = await prisma.promptTemplate.findFirst({
      where: { key: tmpl.key, active: true },
    });
    if (!existing) {
      const latest = await prisma.promptTemplate.findFirst({
        where: { key: tmpl.key },
        orderBy: { version: 'desc' },
      });
      await prisma.promptTemplate.create({
        data: {
          key: tmpl.key,
          version: (latest?.version ?? 0) + 1,
          body: tmpl.body,
          active: true,
        },
      });
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
