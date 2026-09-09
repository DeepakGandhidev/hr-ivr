import { NextRequest } from "next/server";
import { Action, NotFoundError } from "@pratibha/shared";
import { authorizeTenant } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import {
  extractText,
  isMockMode,
  llmClient,
  llmModel,
  renderTemplate,
  thinkingFor,
} from "@/lib/llm";

/**
 * §5 Stage 3: draft the JD from the structured role brief using the
 * `jd_generation` prompt template. The draft is saved as a new
 * job_descriptions version with generatedBy=ai — it is not approved here.
 * Gate G1 (approve-jd) stays a separate, human action.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { tenant: string; id: string } }
) {
  const { tenant, id } = params;
  return handleApi(async () => {
    const body = await request.json().catch(() => ({}));
    const notes = typeof body?.notes === "string" ? body.notes : "";

    const { tx } = await authorizeTenant(tenant, Action.jobUpdate);

    // 1. Read the brief and the prompt template.
    const { job, promptBody } = await tx(async (db) => {
      const job = await db.job.findFirst({ where: { id, deletedAt: null } });
      if (!job) {
        throw new NotFoundError("Job not found");
      }

      const template = await db.promptTemplate.findFirst({
        where: { key: "jd_generation" as any, active: true },
        orderBy: { version: "desc" },
      });
      if (!template) {
        throw new Error("jd_generation prompt template not found");
      }

      return { job, promptBody: template.body };
    });

    const mustHaves = (job.mustHaves as string[] | null) ?? [];
    const goodToHaves = (job.goodToHaves as string[] | null) ?? [];

    const vars = {
      title: job.title,
      location: job.location ?? "Not specified",
      experienceRange: job.experienceRange ?? "Not specified",
      salaryBand: job.salaryBand ?? "",
      mustHaves: mustHaves.join(", ") || "None",
      goodToHaves: goodToHaves.join(", ") || "None",
      notes,
    };

    // 2. Draft outside the transaction — a JD takes far longer than the 5s
    //    interactive-transaction timeout.
    const bodyMd = isMockMode()
      ? mockJd(job.title, vars.location, vars.experienceRange, job.salaryBand, mustHaves, goodToHaves)
      : await generateJd(renderTemplate(promptBody, vars));

    // 3. Save as a new unapproved version. Gate G1 stays a separate action.
    return tx(async (db) => {
      const latest = await db.jobDescription.findFirst({
        where: { jobId: id },
        orderBy: { version: "desc" },
      });

      const description = await db.jobDescription.create({
        data: {
          jobId: id,
          version: (latest?.version ?? 0) + 1,
          bodyMd,
          generatedBy: "ai",
        },
      });

      return { description };
    });
  });
}

async function generateJd(prompt: string): Promise<string> {
  const model = llmModel();
  const response = await llmClient().messages.create({
    model,
    max_tokens: 2048,
    ...thinkingFor(model),
    messages: [{ role: "user", content: prompt }],
  } as any);
  return extractText(response.content).trim();
}

function mockJd(
  title: string,
  location: string,
  experience: string,
  salaryBand: string | null,
  mustHaves: string[],
  goodToHaves: string[]
): string {
  const bullets = (items: string[]) =>
    items.length ? items.map((i) => `- ${i}`).join("\n") : "- To be defined";

  return `## ${title}

**Location:** ${location}  
**Experience:** ${experience}${salaryBand ? `  \n**Salary band:** ${salaryBand}` : ""}

### About the role

We are hiring a ${title} to join our team in ${location}. You will own significant
parts of our product surface and work closely with engineering, product and design.

### What you will do

- Design, build and ship features end to end
- Partner with product and design on scope and trade-offs
- Raise the bar on code quality, testing and operational health

### Must-haves

${bullets(mustHaves)}

### Good to have

${bullets(goodToHaves)}

### How we hire

Shortlisted candidates will be invited to a short telephonic interview with
Pratibha, our AI recruiter.

_[Draft generated in mock mode — edit before approving.]_`;
}
