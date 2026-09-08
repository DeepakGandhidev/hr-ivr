/**
 * Mock dataset for the whole §5 pipeline: Register → Connect Email → JD →
 * Post → Screen → Approve → Interview → Report.
 *
 * Two tenants are seeded deliberately. Acme carries the full pipeline; Globex
 * exists so isolation is visible in the UI and provable in tests — a cross-
 * tenant read is a P0 bug (§3), and it cannot be spotted with only one tenant
 * in the database.
 *
 * Idempotent: every write is an upsert on a fixed id, so re-running refreshes
 * rather than duplicates.
 *
 *   node scripts/seed-mock-data.js
 */
import { PrismaClient } from '@pratibha/prisma';

const prisma = new PrismaClient();

const PERIOD = new Date().toISOString().slice(0, 7);
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const minsAfter = (d, n) => new Date(d.getTime() + n * 60000);

// ---------------------------------------------------------------------------
// Candidates. Scores straddle the default threshold of 70 on purpose: the
// shortlist review screen (Gate G2) is only worth looking at when the archived
// list below it has someone in it worth promoting.
// ---------------------------------------------------------------------------
const CANDIDATES = [
  {
    id: 'cand-mock-1', name: 'Rohan Malhotra', email: 'rohan@example.com', phone: '+919876543210',
    cv: { experience: '5 years', skills: ['Node.js', 'PostgreSQL', 'Redis', 'API design'], education: 'B.Tech CS', employers: ['Northline Systems'] },
    score: 85, verdict: 'shortlist',
    matched: ['Node.js', 'API design', 'PostgreSQL'], gaps: ['AWS not evidenced'],
    reason: 'Strong Node.js and API design experience with production PostgreSQL. AWS is a gap.',
  },
  {
    id: 'cand-mock-2', name: 'Priya Sharma', email: 'priya@example.com', phone: '+919812345678',
    cv: { experience: '7 years', skills: ['Node.js', 'PostgreSQL', 'API design', 'AWS', 'Kubernetes'], education: 'M.Tech CS', employers: ['Fintrail', 'Zeta Payments'] },
    score: 92, verdict: 'shortlist',
    matched: ['Node.js', 'API design', 'PostgreSQL'], gaps: [],
    reason: 'Covers every must-have plus AWS and Kubernetes. Seven years across two fintech backends.',
  },
  {
    id: 'cand-mock-3', name: 'Arjun Nair', email: 'arjun@example.com', phone: '+919900112233',
    cv: { experience: '4 years', skills: ['Node.js', 'MongoDB', 'API design'], education: 'B.E. IT', employers: ['Craftbase'] },
    score: 72, verdict: 'shortlist',
    matched: ['Node.js', 'API design'], gaps: ['PostgreSQL — MongoDB only'],
    reason: 'Solid Node.js and API design. Relational depth unproven; document stores only.',
  },
  {
    id: 'cand-mock-4', name: 'Sneha Iyer', email: 'sneha@example.com', phone: '+919845007766',
    cv: { experience: '3 years', skills: ['Python', 'Django', 'PostgreSQL'], education: 'B.Tech IT', employers: ['Datawing'] },
    score: 48, verdict: 'archive',
    matched: ['PostgreSQL'], gaps: ['Node.js', 'API design at scale'],
    reason: 'Strong PostgreSQL but a Python/Django background against a Node.js must-have.',
  },
  {
    id: 'cand-mock-5', name: 'Vikram Desai', email: 'vikram@example.com', phone: '+919701234567',
    cv: { experience: '9 years', skills: ['Java', 'Spring', 'PostgreSQL', 'AWS', 'Kubernetes'], education: 'B.Tech CS', employers: ['Infosys', 'Tata Digital'] },
    score: 61, verdict: 'archive',
    matched: ['PostgreSQL'], gaps: ['Node.js'],
    reason: 'Deep backend and infra experience but on the JVM. Promote if Node.js is negotiable.',
  },
  {
    // Parse failure path (§5 Stage 4): never silently dropped, still screenable.
    id: 'cand-mock-6', name: 'Imran Qureshi', email: 'imran@example.com', phone: null,
    cv: null, parseFailed: true, noPhone: true,
    score: null,
    reason: null,
  },
];


// ---------------------------------------------------------------------------
// A second cohort, approved and not yet interviewed, for repeated call testing.
//
// The CVs are deliberately unalike — different stacks, seniorities, cities and
// gaps against the must-haves — because the interviewer grounds its questions
// in cv_parsed. A row of near-identical candidates would produce a row of
// near-identical interviews and tell you nothing about the questioning.
//
// Emails are kept short and phonetic: on a live call the candidate has to say
// theirs aloud through an 8 kHz line to get past verification.
// ---------------------------------------------------------------------------
const EXTRA_CANDIDATES = [
  {
    id: 'cand-extra-01', name: 'Kabir Shah', email: 'kabir@example.com', phone: '+919600000001',
    cv: { experience: '6 years', skills: ['Node.js', 'PostgreSQL', 'API design', 'Redis', 'AWS'],
          education: 'B.Tech Computer Science, VJTI Mumbai', employers: ['Swiggy', 'Hasura'], location: 'Mumbai' },
    score: 91, verdict: 'shortlist', matched: ['Node.js', 'API design', 'PostgreSQL'], gaps: [],
    reason: 'Every must-have evidenced, plus Redis and AWS. Six years across two high-traffic product teams.',
  },
  {
    id: 'cand-extra-02', name: 'Ananya Bose', email: 'ananya@example.com', phone: '+919600000002',
    cv: { experience: '9 years', skills: ['Java', 'Spring Boot', 'PostgreSQL', 'Kafka', 'Kubernetes'],
          education: 'M.Tech, Jadavpur University', employers: ['Oracle', 'PhonePe'], location: 'Bengaluru' },
    score: 74, verdict: 'shortlist', matched: ['API design', 'PostgreSQL'], gaps: ['Node.js — JVM background'],
    reason: 'Deep backend and distributed systems experience, but on the JVM. Node.js would be a switch.',
  },
  {
    id: 'cand-extra-03', name: 'Farhan Ali', email: 'farhan@example.com', phone: '+919600000003',
    cv: { experience: '4 years', skills: ['Node.js', 'TypeScript', 'React', 'MongoDB', 'GraphQL'],
          education: 'B.E. Information Technology, Pune University', employers: ['Zomato'], location: 'Pune' },
    score: 76, verdict: 'shortlist', matched: ['Node.js', 'API design'], gaps: ['PostgreSQL — document stores only'],
    reason: 'Strong Node.js and GraphQL. Relational depth unproven; MongoDB throughout.',
  },
  {
    id: 'cand-extra-04', name: 'Ishita Rao', email: 'ishita@example.com', phone: '+919600000004',
    cv: { experience: '11 years', skills: ['Node.js', 'Go', 'PostgreSQL', 'Kubernetes', 'Terraform', 'API design'],
          education: 'B.Tech, IIT Madras', employers: ['Amazon', 'Razorpay', 'Freshworks'], location: 'Chennai' },
    score: 95, verdict: 'shortlist', matched: ['Node.js', 'API design', 'PostgreSQL'], gaps: [],
    reason: 'Eleven years, three strong engineering orgs, covers every must-have and most good-to-haves.',
  },
  {
    id: 'cand-extra-05', name: 'Neel Kapoor', email: 'neel@example.com', phone: '+919600000005',
    cv: { experience: '3 years', skills: ['Node.js', 'Express', 'MySQL', 'Docker'],
          education: 'BCA, Delhi University', employers: ['Paytm'], location: 'Delhi NCR' },
    score: 71, verdict: 'shortlist', matched: ['Node.js', 'API design'], gaps: ['PostgreSQL — MySQL only', 'Below the experience band'],
    reason: 'Solid fundamentals but three years against a four-to-seven band. Relational work is MySQL.',
  },
  {
    id: 'cand-extra-06', name: 'Divya Menon', email: 'divya@example.com', phone: '+919600000006',
    cv: { experience: '7 years', skills: ['Python', 'Django', 'PostgreSQL', 'Celery', 'AWS', 'API design'],
          education: 'B.Tech, NIT Calicut', employers: ['Zoho', 'Chargebee'], location: 'Kochi' },
    score: 73, verdict: 'shortlist', matched: ['API design', 'PostgreSQL'], gaps: ['Node.js'],
    reason: 'Excellent PostgreSQL and API design, but a Python/Django career. Promote only if Node.js is negotiable.',
  },
  {
    id: 'cand-extra-07', name: 'Aarav Sethi', email: 'aarav@example.com', phone: '+919600000007',
    cv: { experience: '5 years', skills: ['Node.js', 'NestJS', 'PostgreSQL', 'Redis', 'RabbitMQ', 'API design'],
          education: 'B.Tech, BITS Pilani', employers: ['CRED', 'Jupiter'], location: 'Bengaluru' },
    score: 89, verdict: 'shortlist', matched: ['Node.js', 'API design', 'PostgreSQL'], gaps: ['AWS not evidenced'],
    reason: 'Fintech backend throughout, all must-haves covered. Cloud experience not spelled out on the CV.',
  },
  {
    id: 'cand-extra-08', name: 'Meher Gill', email: 'meher@example.com', phone: '+919600000008',
    cv: { experience: '8 years', skills: ['Node.js', 'PostgreSQL', 'Elasticsearch', 'AWS', 'Kubernetes', 'API design'],
          education: 'M.Sc Computer Science, Panjab University', employers: ['Adobe', 'Innovaccer'], location: 'Chandigarh' },
    score: 87, verdict: 'shortlist', matched: ['Node.js', 'API design', 'PostgreSQL'], gaps: [],
    reason: 'Eight years, search and data-heavy backends. Covers the must-haves and the infra good-to-haves.',
  },
  {
    id: 'cand-extra-09', name: 'Rudra Patel', email: 'rudra@example.com', phone: '+919600000009',
    cv: { experience: '6 years', skills: ['Node.js', 'PostgreSQL', 'React Native', 'Firebase', 'API design'],
          education: 'B.E. Computer Engineering, Gujarat Technological University', employers: ['Meesho'], location: 'Ahmedabad' },
    score: 80, verdict: 'shortlist', matched: ['Node.js', 'API design', 'PostgreSQL'], gaps: ['Mostly mobile-facing backends'],
    reason: 'Meets every must-have, though the backend work has served mobile clients rather than scale-out services.',
  },
  {
    id: 'cand-extra-10', name: 'Tara Nair', email: 'tara@example.com', phone: '+919600000010',
    cv: { experience: '5 years', skills: ['Node.js', 'PostgreSQL', 'dbt', 'Airflow', 'Python', 'API design'],
          education: 'B.Tech, COEP Pune', employers: ['Postman', 'Atlan'], location: 'Remote' },
    score: 84, verdict: 'shortlist', matched: ['Node.js', 'API design', 'PostgreSQL'], gaps: ['Data-platform leaning'],
    reason: 'Strong on all three must-haves; recent work leans toward data platform rather than product APIs.',
  },
];


// ---------------------------------------------------------------------------
// Roles beyond engineering, each with its own candidate.
//
// These get their own jobs rather than being hung off the backend role. The
// interviewer builds its questions from the job's must-haves and the
// candidate's CV, so an SEO specialist attached to a Node.js opening would be
// asked about PostgreSQL — the questions are only as good as the role they are
// grounded in.
//
// One candidate per role, approved and uninterviewed, on a distinct number.
// Emails stay short and phonetic because they have to survive being read aloud
// down an 8 kHz phone line for identity verification.
// ---------------------------------------------------------------------------
const ROLE_COHORT = [
  {
    key: 'seo', title: 'SEO / AEO Specialist', slug: 'seo-aeo-specialist',
    location: 'Remote (India)', band: '₹8–14 LPA', experience: '3–6 years',
    must: ['Technical SEO', 'Answer engine optimisation', 'Content strategy'],
    good: ['Schema markup', 'Google Search Console', 'Ahrefs'],
    summary: 'own organic growth across search and AI answer engines',
    candidate: {
      name: 'Nikhil Verma', email: 'nikhil@example.com', phone: '+919700000001',
      cv: { experience: '5 years', skills: ['Technical SEO', 'Answer engine optimisation', 'Schema markup', 'Ahrefs', 'Content strategy'],
            education: 'BBA Marketing, Symbiosis Pune', employers: ['Zomato', 'Nykaa'], location: 'Remote' },
      score: 88, matched: ['Technical SEO', 'Answer engine optimisation', 'Content strategy'], gaps: [],
      reason: 'Covers technical SEO and AEO with schema depth. Five years across two consumer brands.',
    },
  },
  {
    key: 'ads', title: 'Performance Marketing Manager (Google & Meta)', slug: 'performance-marketing-manager',
    location: 'Gurugram', band: '₹10–18 LPA', experience: '3–7 years',
    must: ['Google Ads', 'Meta Ads', 'Campaign analytics'],
    good: ['Conversion tracking', 'Creative testing', 'Budget forecasting'],
    summary: 'run paid acquisition across Google and Meta',
    candidate: {
      name: 'Ritika Malhotra', email: 'ritika@example.com', phone: '+919700000002',
      cv: { experience: '6 years', skills: ['Google Ads', 'Meta Ads', 'Campaign analytics', 'Conversion tracking', 'GA4'],
            education: 'MBA Marketing, IMT Ghaziabad', employers: ['Dentsu', 'Lenskart'], location: 'Gurugram' },
      score: 90, matched: ['Google Ads', 'Meta Ads', 'Campaign analytics'], gaps: [],
      reason: 'Six years running paid budgets on both platforms, agency and in-house.',
    },
  },
  {
    key: 'mern', title: 'MERN Stack Developer', slug: 'mern-stack-developer',
    location: 'Bengaluru', band: '₹12–22 LPA', experience: '3–6 years',
    must: ['React', 'Node.js', 'MongoDB'],
    good: ['Express', 'TypeScript', 'Redux'],
    summary: 'build product features end to end on the MERN stack',
    candidate: {
      name: 'Sahil Bhat', email: 'sahil@example.com', phone: '+919700000003',
      cv: { experience: '4 years', skills: ['React', 'Node.js', 'MongoDB', 'Express', 'Redux', 'TypeScript'],
            education: 'B.Tech IT, NIT Srinagar', employers: ['Unacademy'], location: 'Bengaluru' },
      score: 86, matched: ['React', 'Node.js', 'MongoDB'], gaps: [],
      reason: 'Full MERN coverage with TypeScript. Four years on a high-traffic edtech product.',
    },
  },
  {
    key: 'qa', title: 'QA Engineer', slug: 'qa-engineer',
    location: 'Pune', band: '₹8–15 LPA', experience: '2–5 years',
    must: ['Test automation', 'API testing', 'Regression strategy'],
    good: ['Cypress', 'Playwright', 'CI integration'],
    summary: 'own automated test coverage and release quality',
    candidate: {
      name: 'Pooja Deshmukh', email: 'pooja@example.com', phone: '+919700000004',
      cv: { experience: '4 years', skills: ['Test automation', 'API testing', 'Cypress', 'Playwright', 'Postman'],
            education: 'B.E. Computer Science, PICT Pune', employers: ['Persistent Systems'], location: 'Pune' },
      score: 84, matched: ['Test automation', 'API testing'], gaps: ['Regression strategy not evidenced'],
      reason: 'Strong automation tooling. Ownership of a regression strategy is not spelled out.',
    },
  },
  {
    key: 'uiux', title: 'UI/UX Designer', slug: 'ui-ux-designer',
    location: 'Remote (India)', band: '₹9–16 LPA', experience: '3–6 years',
    must: ['Figma', 'Design systems', 'User research'],
    good: ['Prototyping', 'Accessibility', 'Usability testing'],
    summary: 'own the product experience from research through to shipped interface',
    candidate: {
      name: 'Aditi Sharma', email: 'aditi@example.com', phone: '+919700000005',
      cv: { experience: '5 years', skills: ['Figma', 'Design systems', 'User research', 'Prototyping', 'Accessibility'],
            education: 'B.Des, NID Ahmedabad', employers: ['Cred', 'Groww'], location: 'Remote' },
      score: 91, matched: ['Figma', 'Design systems', 'User research'], gaps: [],
      reason: 'Design systems work at two fintech products, with research practice evidenced.',
    },
  },
  {
    key: 'fullstack', title: 'Full Stack Developer', slug: 'full-stack-developer',
    location: 'Hyderabad', band: '₹14–24 LPA', experience: '4–8 years',
    must: ['React', 'Node.js', 'PostgreSQL', 'API design'],
    good: ['AWS', 'Docker', 'CI/CD'],
    summary: 'work across the stack, from database to interface',
    candidate: {
      name: 'Varun Reddy', email: 'varun@example.com', phone: '+919700000006',
      cv: { experience: '7 years', skills: ['React', 'Node.js', 'PostgreSQL', 'API design', 'AWS', 'Docker'],
            education: 'B.Tech, IIIT Hyderabad', employers: ['Darwinbox', 'Skyflow'], location: 'Hyderabad' },
      score: 93, matched: ['React', 'Node.js', 'PostgreSQL', 'API design'], gaps: [],
      reason: 'Seven years genuinely across the stack, with infra exposure on top.',
    },
  },
  {
    key: 'bdm', title: 'Business Development Manager', slug: 'business-development-manager',
    location: 'Mumbai', band: '₹12–20 LPA + incentives', experience: '4–8 years',
    must: ['B2B sales', 'Pipeline ownership', 'Client negotiation'],
    good: ['CRM discipline', 'Partnerships', 'Enterprise deals'],
    summary: 'own new business from first conversation to signed contract',
    candidate: {
      name: 'Rohit Khanna', email: 'rohit@example.com', phone: '+919700000007',
      cv: { experience: '8 years', skills: ['B2B sales', 'Pipeline ownership', 'Client negotiation', 'Enterprise deals', 'Salesforce'],
            education: 'MBA, NMIMS Mumbai', employers: ['Freshworks', 'Zoho'], location: 'Mumbai' },
      score: 89, matched: ['B2B sales', 'Pipeline ownership', 'Client negotiation'], gaps: [],
      reason: 'Eight years of SaaS B2B with enterprise deal ownership.',
    },
  },
  {
    key: 'leadgen', title: 'Lead Generation Specialist', slug: 'lead-generation-specialist',
    location: 'Remote (India)', band: '₹6–11 LPA', experience: '2–5 years',
    must: ['Outbound prospecting', 'Lead qualification', 'CRM hygiene'],
    good: ['LinkedIn Sales Navigator', 'Email sequencing', 'Apollo'],
    summary: 'build and qualify the top of the sales pipeline',
    candidate: {
      name: 'Sneha Kulkarni', email: 'sneha.k@example.com', phone: '+919700000008',
      cv: { experience: '3 years', skills: ['Outbound prospecting', 'Lead qualification', 'LinkedIn Sales Navigator', 'Apollo', 'HubSpot'],
            education: 'BBA, Pune University', employers: ['LeadSquared'], location: 'Remote' },
      score: 80, matched: ['Outbound prospecting', 'Lead qualification'], gaps: ['CRM hygiene not evidenced'],
      reason: 'Good prospecting tooling and qualification practice. CRM discipline unproven.',
    },
  },
  {
    key: 'sales', title: 'Sales Executive', slug: 'sales-executive',
    location: 'Delhi NCR', band: '₹5–9 LPA + incentives', experience: '1–4 years',
    must: ['Inside sales', 'Cold calling', 'Target achievement'],
    good: ['Demo delivery', 'Objection handling', 'CRM'],
    summary: 'close inbound and outbound opportunities against a monthly target',
    candidate: {
      name: 'Amit Chauhan', email: 'amit@example.com', phone: '+919700000009',
      cv: { experience: '3 years', skills: ['Inside sales', 'Cold calling', 'Target achievement', 'Demo delivery', 'Zoho CRM'],
            education: 'B.Com, Delhi University', employers: ['BYJUS', 'UpGrad'], location: 'Delhi NCR' },
      score: 78, matched: ['Inside sales', 'Cold calling', 'Target achievement'], gaps: ['High-churn edtech background'],
      reason: 'Meets every must-have. Both employers are high-churn edtech sales floors.',
    },
  },
  {
    key: 'datasci', title: 'Data Scientist', slug: 'data-scientist',
    location: 'Bengaluru', band: '₹18–30 LPA', experience: '3–7 years',
    must: ['Python', 'Machine learning', 'Statistics'],
    good: ['NLP', 'Experiment design', 'MLOps'],
    summary: 'turn product data into models that ship',
    candidate: {
      name: 'Kavya Iyer', email: 'kavya@example.com', phone: '+919700000010',
      cv: { experience: '6 years', skills: ['Python', 'Machine learning', 'Statistics', 'NLP', 'PyTorch', 'Experiment design'],
            education: 'M.Sc Statistics, ISI Kolkata', employers: ['Flipkart', 'Meesho'], location: 'Bengaluru' },
      score: 94, matched: ['Python', 'Machine learning', 'Statistics'], gaps: [],
      reason: 'Formal statistics training with six years of applied ML in production.',
    },
  },
  {
    key: 'dataeng', title: 'Data Engineer', slug: 'data-engineer',
    location: 'Remote (India)', band: '₹16–28 LPA', experience: '3–7 years',
    must: ['SQL', 'Data pipelines', 'Python'],
    good: ['Airflow', 'dbt', 'Snowflake'],
    summary: 'build the pipelines everything else depends on',
    candidate: {
      name: 'Imran Sheikh', email: 'imran.s@example.com', phone: '+919700000011',
      cv: { experience: '5 years', skills: ['SQL', 'Data pipelines', 'Python', 'Airflow', 'dbt', 'Snowflake'],
            education: 'B.Tech, VIT Vellore', employers: ['Dream11', 'Atlan'], location: 'Remote' },
      score: 90, matched: ['SQL', 'Data pipelines', 'Python'], gaps: [],
      reason: 'Every must-have plus the full modern pipeline stack.',
    },
  },
];

// Shortlisted candidates who were invited and called in.
const CALLS = [
  {
    id: 'call-mock-1', candidateId: 'cand-mock-2', phone: '+919812345678',
    recognised: true, language: 'en', status: 'completed', durationMins: 12,
    report: {
      id: 'rep-mock-1', overallScore: 8.4, recommendation: 'strong_yes',
      dimensions: { communication: 8.5, domain_fit: 9.0, experience_depth: 8.5, red_flags: 0 },
      strengths: [
        'Explained an idempotent payment-retry design without prompting',
        'Concrete numbers on a PostgreSQL migration: 40M rows, zero downtime',
        'Clear ownership language about on-call and incident response',
      ],
      concerns: [
        'Kubernetes exposure is via a platform team, not hands-on',
        'Has not led a team; role expects mentoring two juniors',
      ],
      quotes: [
        { at: '03:12', text: 'We moved to a dual-write with a backfill job, then flipped reads once lag was under a second.' },
        { at: '07:45', text: 'I would rather ship the boring version and measure it than guess at the clever one.' },
        { at: '10:20', text: 'On-call taught me more about our architecture than any design doc.' },
      ],
    },
  },
  {
    id: 'call-mock-2', candidateId: 'cand-mock-1', phone: '+919876543210',
    recognised: true, language: 'hinglish', status: 'completed', durationMins: 10,
    report: {
      id: 'rep-mock-2', overallScore: 6.8, recommendation: 'yes',
      dimensions: { communication: 7.0, domain_fit: 7.0, experience_depth: 6.5, red_flags: 0 },
      strengths: [
        'Comfortable switching between Hindi and English while staying precise',
        'Good instincts on API versioning and backward compatibility',
        'Honest about the limits of his AWS exposure',
      ],
      concerns: [
        'Scale described is modest relative to the role',
        'Caching strategy answers stayed general',
      ],
      quotes: [
        { at: '02:40', text: 'Humne versioning URL mein rakha, kyunki mobile clients purane build pe atke rehte hain.' },
        { at: '06:15', text: 'I have used AWS, but honestly the infra was set up by someone else.' },
      ],
    },
  },
  {
    // Mid-call drop (§5 Stage 8 failure path): partial transcript kept, not billed.
    id: 'call-mock-3', candidateId: 'cand-mock-3', phone: '+919900112233',
    recognised: true, language: 'hi', status: 'dropped', durationMins: 3, report: null,
  },
  {
    // Unknown caller (§5 Stage 8): never interviewed, never billed.
    id: 'call-mock-4', candidateId: 'cand-mock-4', phone: '+917000000000',
    recognised: false, language: null, status: 'unknown_caller', durationMins: 1, report: null,
  },
];

async function main() {
  // -------------------------------------------------------------------------
  // Stage 0 — clear anything an earlier simulator run left behind.
  //
  // `npm run simulate` writes real interview_calls and assessment_reports, so
  // without this a demo database drifts: extra dropped calls pile up and the
  // usage meter keeps climbing. Only rows this script does not own are removed,
  // and only for the mock tenants.
  // -------------------------------------------------------------------------
  const KNOWN_CALL_IDS = CALLS.map((c) => c.id);
  const strays = await prisma.interviewCall.findMany({
    where: {
      id: { notIn: KNOWN_CALL_IDS },
      candidate: { tenant: { slug: { in: ['acme', 'globex'] } } },
    },
    select: { id: true },
  });
  if (strays.length) {
    const ids = strays.map((s) => s.id);
    // Reports cascade from interview_calls, but delete explicitly so the count
    // reported below is honest.
    await prisma.assessmentReport.deleteMany({ where: { interviewCallId: { in: ids } } });
    await prisma.interviewCall.deleteMany({ where: { id: { in: ids } } });
    console.log(`Cleared ${ids.length} interview call(s) left by earlier simulator runs.\n`);
  }

  // -------------------------------------------------------------------------
  // Stage 1 — Register & workspace setup
  // -------------------------------------------------------------------------
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'acme' },
    update: { name: 'Acme Corp', planId: 'scale', status: 'active' },
    create: { id: 'tenant-mock-acme', name: 'Acme Corp', slug: 'acme', planId: 'scale', status: 'active' },
  });

  const users = {};
  for (const u of [
    { key: 'owner', id: 'user-mock-owner', email: 'owner@acme.test', name: 'Anita Rao', role: 'owner' },
    { key: 'admin', id: 'user-mock-admin', email: 'admin@acme.test', name: 'Dev Menon', role: 'admin' },
    { key: 'reviewer', id: 'user-mock-reviewer', email: 'reviewer@acme.test', name: 'Kavya Pillai', role: 'reviewer' },
    { key: 'viewer', id: 'user-mock-viewer', email: 'viewer@acme.test', name: 'Sam Fernandes', role: 'viewer' },
  ]) {
    // Keyed on (tenant, email), not authProviderId: seed-mock-auth.js rewrites
    // authProviderId to the real Supabase user id, so keying on the placeholder
    // would make every re-seed create a duplicate user instead of updating.
    users[u.key] = await prisma.user.upsert({
      where: { tenantId_email: { tenantId: tenant.id, email: u.email } },
      update: { name: u.name, role: u.role },
      create: {
        id: u.id, tenantId: tenant.id, email: u.email, name: u.name,
        role: u.role, authProviderId: `auth-mock-${u.key}`,
      },
    });
  }
  const owner = users.owner;

  // -------------------------------------------------------------------------
  // Stage 2 — Connect hiring email
  // -------------------------------------------------------------------------
  await prisma.emailConnection.upsert({
    where: { id: 'ec-mock-1' },
    update: { status: 'connected', lastPollAt: new Date() },
    create: {
      id: 'ec-mock-1', tenantId: tenant.id, provider: 'forward_alias',
      address: 'acme@in.pratibha.tech', status: 'connected', lastPollAt: new Date(),
    },
  });

  // A broken connection so the Settings → Email error banner has something to
  // render (§5 Stage 2 failure path).
  await prisma.emailConnection.upsert({
    where: { id: 'ec-mock-2' },
    update: { status: 'error', errorDetail: 'OAuth token revoked by workspace admin. Reconnect required.' },
    create: {
      id: 'ec-mock-2', tenantId: tenant.id, provider: 'gmail',
      address: 'hr@acme.test', status: 'error',
      errorDetail: 'OAuth token revoked by workspace admin. Reconnect required.',
      lastPollAt: daysAgo(2),
    },
  });

  // -------------------------------------------------------------------------
  // Stage 3 — Role → JD → publish
  // -------------------------------------------------------------------------
  const job = await prisma.job.upsert({
    where: { id: 'job-mock-backend' },
    update: { status: 'open' },
    create: {
      id: 'job-mock-backend', tenantId: tenant.id, slug: 'senior-backend-engineer',
      title: 'Senior Backend Engineer', status: 'open', location: 'Bangalore',
      salaryBand: '₹25–40 LPA', experienceRange: '4–7 years',
      mustHaves: ['Node.js', 'API design', 'PostgreSQL'],
      goodToHaves: ['AWS', 'Redis', 'Kubernetes'],
      createdBy: owner.id,
    },
  });

  // A second, draft role — unapproved JD, so Gate G1 is visibly holding.
  const draftJob = await prisma.job.upsert({
    where: { id: 'job-mock-frontend' },
    update: {},
    create: {
      id: 'job-mock-frontend', tenantId: tenant.id, slug: 'frontend-engineer',
      title: 'Frontend Engineer', status: 'draft', location: 'Remote (India)',
      salaryBand: '₹18–28 LPA', experienceRange: '3–6 years',
      mustHaves: ['React', 'TypeScript', 'CSS architecture'],
      goodToHaves: ['Next.js', 'Accessibility', 'Design systems'],
      createdBy: users.admin.id,
    },
  });

  await prisma.jobDescription.upsert({
    where: { id: 'jd-mock-draft' },
    update: {},
    create: {
      id: 'jd-mock-draft', jobId: draftJob.id, version: 1, generatedBy: 'ai',
      bodyMd: `## Frontend Engineer\n\nWe are looking for a Frontend Engineer to own our customer-facing surface.\n\n**Must-haves:** React, TypeScript, CSS architecture  \n**Good-to-haves:** Next.js, Accessibility, Design systems\n\n_Awaiting review — this draft has not been approved._`,
    },
  });

  // v1 human draft, superseded by the approved v2 — gives the version history
  // on the JD Studio screen something real to show.
  await prisma.jobDescription.upsert({
    where: { id: 'jd-mock-1' },
    update: {},
    create: {
      id: 'jd-mock-1', jobId: job.id, version: 1, generatedBy: 'ai',
      bodyMd: `## Senior Backend Engineer\n\nFirst draft. Own API design and backend services.\n\n**Must-haves:** Node.js, API design, PostgreSQL`,
    },
  });

  const approvedJd = await prisma.jobDescription.upsert({
    where: { id: 'jd-mock-2' },
    update: { approvedBy: owner.id, approvedAt: daysAgo(12) },
    create: {
      id: 'jd-mock-2', jobId: job.id, version: 2, generatedBy: 'human',
      approvedBy: owner.id, approvedAt: daysAgo(12),
      bodyMd: `## Senior Backend Engineer

**Location:** Bangalore  
**Experience:** 4–7 years  
**Salary band:** ₹25–40 LPA

### About the role

We are looking for a Senior Backend Engineer to own API design and the services
behind our payments surface. You will work with a small team that ships often.

### What you will do

- Design and own backend services end to end
- Shape our API contracts and keep them backward compatible
- Share the on-call rota and drive down recurring incidents

### Must-haves

- Node.js in production
- API design
- PostgreSQL

### Good to have

- AWS
- Redis
- Kubernetes

Shortlisted candidates will be invited to a short telephonic interview with
Pratibha, our AI recruiter.`,
    },
  });

  for (const post of [
    { id: 'jp-mock-1', channel: 'careers_page', status: 'posted', ref: '/j/senior-backend-engineer', postedAt: daysAgo(12) },
    { id: 'jp-mock-2', channel: 'linkedin', status: 'pending', ref: null, postedAt: null },
    { id: 'jp-mock-3', channel: 'naukri', status: 'failed', ref: null, postedAt: null, error: 'No self-serve posting API. Use the copy pack.' },
  ]) {
    await prisma.jobPost.upsert({
      where: { id: post.id },
      update: { status: post.status },
      create: {
        id: post.id, jobId: job.id, channel: post.channel, status: post.status,
        externalRef: post.ref, postedAt: post.postedAt, includesPratibhaNumber: true,
        errorDetail: post.error ?? null,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Tenant-tunable settings (§9)
  // -------------------------------------------------------------------------
  await prisma.outreachTemplate.upsert({
    where: { id: 'tpl-mock-invite' },
    update: {},
    create: {
      id: 'tpl-mock-invite', tenantId: tenant.id, type: 'interview_invite', isDefault: true,
      subject: 'Interview invitation for {{job_title}}',
      bodyMd: `Hi {{candidate_name}},

You have been shortlisted for the {{job_title}} role at {{company_name}}.

Please call Pratibha, our AI recruiter, at {{pratibha_number}} during {{call_window}}.
The call takes about 10–15 minutes.

Your reference code is {{reference_code}}.

Best,  
{{company_name}}`,
    },
  });

  await prisma.outreachTemplate.upsert({
    where: { id: 'tpl-mock-rejection' },
    update: {},
    create: {
      id: 'tpl-mock-rejection', tenantId: tenant.id, type: 'rejection', isDefault: true,
      subject: 'Update on your application for {{job_title}}',
      bodyMd: `Hi {{candidate_name}},

Thank you for your interest in the {{job_title}} role. We have decided not to
move forward at this time, and we wish you well with your search.

Best,  
{{company_name}}`,
    },
  });

  await prisma.outreachTemplate.upsert({
    where: { id: 'tpl-mock-reminder' },
    update: {},
    create: {
      id: 'tpl-mock-reminder', tenantId: tenant.id, type: 'reminder', isDefault: true,
      subject: 'Reminder: your Pratibha interview for {{job_title}}',
      bodyMd: `Hi {{candidate_name}},

A quick reminder that you can call Pratibha at {{pratibha_number}} during
{{call_window}} to complete your interview for the {{job_title}} role.

Best,  
{{company_name}}`,
    },
  });

  await prisma.interviewProtocol.upsert({
    where: { id: 'proto-mock-default' },
    update: {},
    create: {
      id: 'proto-mock-default', tenantId: tenant.id, jobId: null, version: 1, updatedBy: owner.id,
      instructionText: 'Keep the tone warm and unhurried. Do not ask about age, gender, religion, caste, marital status, or institution. Never discuss salary, offers, or timelines — defer to the company.',
    },
  });

  await prisma.interviewProtocol.upsert({
    where: { id: 'proto-mock-job' },
    update: {},
    create: {
      id: 'proto-mock-job', tenantId: tenant.id, jobId: job.id, version: 1, updatedBy: users.admin.id,
      instructionText: 'Probe depth in Node.js, API design and PostgreSQL against what is actually on the CV. Ask for one concrete production incident and what changed afterwards. Push past generic answers once, politely.',
    },
  });

  // Open around the clock for the demo tenant. A realistic Mon-Sat 10:00-18:00
  // window means any test call outside office hours is answered with "our lines
  // are closed" and hangs up — which reads as a broken agent rather than the
  // rule working. Narrow it per job in Settings when going live.
  const demoWindow = { days: [0, 1, 2, 3, 4, 5, 6], startTime: '00:00', endTime: '23:59' };
  await prisma.callWindow.upsert({
    where: { id: 'cw-mock-1' },
    update: demoWindow,
    create: { id: 'cw-mock-1', jobId: job.id, timezone: 'Asia/Kolkata', ...demoWindow },
  });

  // -------------------------------------------------------------------------
  // Stages 4 & 5 — Ingest, parse, screen
  // -------------------------------------------------------------------------
  const candidates = {};
  for (const [i, c] of CANDIDATES.entries()) {
    candidates[c.id] = await prisma.candidate.upsert({
      where: { id: c.id },
      update: {},
      create: {
        id: c.id, tenantId: tenant.id, jobId: job.id,
        name: c.name, email: c.email, phoneE164: c.phone,
        cvParsed: c.cv ? { name: c.name, email: c.email, phone: c.phone, ...c.cv } : null,
        cvFileRef: `mock://cv/${c.id}.pdf`,
        sourceEmailMsgId: `<mock-${c.id}@mail.acme.test>`,
        parseFailed: Boolean(c.parseFailed),
        noPhone: Boolean(c.noPhone),
        createdAt: daysAgo(10 - i),
      },
    });

    if (c.score !== null) {
      await prisma.screening.upsert({
        where: { id: `screen-${c.id}` },
        update: {
          score: c.score, matchedMustHaves: c.matched, gaps: c.gaps,
          verdict: c.verdict, reasonSummary: c.reason, model: 'kimi-k2.6',
        },
        create: {
          id: `screen-${c.id}`, candidateId: c.id, score: c.score,
          matchedMustHaves: c.matched, gaps: c.gaps,
          model: 'kimi-k2.6', tokensIn: 1180 + i * 40, tokensOut: 160 + i * 12,
          costUsd: Number((((1180 + i * 40) * 0.6e-6) + ((160 + i * 12) * 2.5e-6)).toFixed(6)),
          verdict: c.verdict, reasonSummary: c.reason, createdAt: daysAgo(9 - i),
        },
      });
    }
  }

  // The second cohort: screened, approved, and deliberately left with no
  // interview calls so each one can be rung in fresh.
  for (const [i, c] of EXTRA_CANDIDATES.entries()) {
    candidates[c.id] = await prisma.candidate.upsert({
      where: { id: c.id },
      update: { name: c.name, email: c.email, phoneE164: c.phone, cvParsed: { name: c.name, email: c.email, phone: c.phone, ...c.cv } },
      create: {
        id: c.id, tenantId: tenant.id, jobId: job.id,
        name: c.name, email: c.email, phoneE164: c.phone,
        cvParsed: { name: c.name, email: c.email, phone: c.phone, ...c.cv },
        cvFileRef: `mock://cv/${c.id}.pdf`,
        sourceEmailMsgId: `<mock-${c.id}@mail.acme.test>`,
        createdAt: daysAgo(8 - (i % 6)),
      },
    });

    await prisma.screening.upsert({
      where: { id: `screen-${c.id}` },
      update: { score: c.score, matchedMustHaves: c.matched, gaps: c.gaps, verdict: c.verdict, reasonSummary: c.reason },
      create: {
        id: `screen-${c.id}`, candidateId: c.id, score: c.score,
        matchedMustHaves: c.matched, gaps: c.gaps,
        model: 'kimi-k2.6', tokensIn: 1200 + i * 30, tokensOut: 170 + i * 8,
        costUsd: Number((((1200 + i * 30) * 0.6e-6) + ((170 + i * 8) * 2.5e-6)).toFixed(6)),
        verdict: c.verdict, reasonSummary: c.reason, createdAt: daysAgo(7 - (i % 5)),
      },
    });
  }

  // -------------------------------------------------------------------------
  // Stage 6 — Gate G2: shortlist approval
  // -------------------------------------------------------------------------
  const shortlist = await prisma.shortlist.upsert({
    where: { id: 'sl-mock-1' },
    update: { status: 'approved' },
    create: { id: 'sl-mock-1', jobId: job.id, status: 'approved', createdAt: daysAgo(7) },
  });

  // Three AI picks stay; the fourth was removed by a human — the audit trail
  // the approval screen is meant to produce.
  const items = [
    { id: 'sli-mock-1', candidateId: 'cand-mock-2', addedBy: 'ai', finalState: 'approved' },
    { id: 'sli-mock-2', candidateId: 'cand-mock-1', addedBy: 'ai', finalState: 'approved' },
    { id: 'sli-mock-3', candidateId: 'cand-mock-3', addedBy: 'ai', finalState: 'approved' },
    { id: 'sli-mock-4', candidateId: 'cand-mock-5', addedBy: users.reviewer.id, finalState: 'removed', removedBy: users.reviewer.id },
    ...EXTRA_CANDIDATES.map((c, i) => ({
      id: `sli-extra-${String(i + 1).padStart(2, '0')}`,
      candidateId: c.id,
      addedBy: 'ai',
      finalState: 'approved',
    })),
  ];
  for (const it of items) {
    // Keyed on (shortlist, candidate) rather than a fixed id: that pair is the
    // real unique constraint, so a re-seed that reshuffles ids still converges.
    await prisma.shortlistItem.upsert({
      where: { shortlistId_candidateId: { shortlistId: shortlist.id, candidateId: it.candidateId } },
      update: { addedBy: it.addedBy, finalState: it.finalState, removedBy: it.removedBy ?? null },
      create: {
        shortlistId: shortlist.id, candidateId: it.candidateId,
        addedBy: it.addedBy, finalState: it.finalState, removedBy: it.removedBy ?? null,
      },
    });
  }

  const approvedIds = items.filter((i) => i.finalState === 'approved').map((i) => i.candidateId);

  // The snapshot is what caller recognition checks at call time (§6), so it has
  // to be rewritten on every seed — an `update: {}` here leaves a stale list
  // behind and approved candidates silently fail to be recognised on the phone.
  const snapshot = approvedIds.map((id) => ({
    candidateId: id,
    name: candidates[id].name,
    email: candidates[id].email,
    phoneE164: candidates[id].phoneE164,
  }));

  const approval = await prisma.approval.upsert({
    where: { id: 'approval-mock-1' },
    update: { snapshot, approvedBy: users.reviewer.id, approvedAt: daysAgo(6) },
    create: {
      id: 'approval-mock-1', shortlistId: shortlist.id,
      approvedBy: users.reviewer.id, approvedAt: daysAgo(6),
      snapshot,
    },
  });

  // -------------------------------------------------------------------------
  // Stage 7 — Outreach (only for candidates inside the approval snapshot)
  // -------------------------------------------------------------------------
  for (const [i, candidateId] of approvedIds.entries()) {
    const c = candidates[candidateId];
    await prisma.outreachEmail.upsert({
      where: { id: `oe-mock-${i + 1}` },
      update: {},
      create: {
        id: `oe-mock-${i + 1}`, candidateId, templateId: 'tpl-mock-invite',
        approvalId: approval.id, status: 'sent', sentAt: daysAgo(6),
        renderedBody: `Hi ${c.name},\n\nYou have been shortlisted for the Senior Backend Engineer role at Acme Corp.\n\nPlease call Pratibha, our AI recruiter, at +918031705255 during Mon–Sat, 10:00–18:00 IST.\nThe call takes about 10–15 minutes.\n\nYour reference code is ACME-${1000 + i}.\n\nBest,  \nAcme Corp`,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Stages 8 & 9 — Interview calls and assessment reports
  // -------------------------------------------------------------------------
  for (const [i, call] of CALLS.entries()) {
    const startedAt = daysAgo(5 - i);
    await prisma.interviewCall.upsert({
      where: { id: call.id },
      update: {},
      create: {
        id: call.id, candidateId: call.candidateId, callerNumber: call.phone,
        recognised: call.recognised, language: call.language, status: call.status,
        startedAt, endedAt: minsAfter(startedAt, call.durationMins),
        recordingRef: call.status === 'completed' ? `mock://recordings/${call.id}.wav` : null,
        transcriptRef: `mock://transcripts/${call.id}.json`,
        telephonyCost: Number((call.durationMins * 0.6).toFixed(2)),
        llmCostUsd: Number((call.durationMins * 0.0032).toFixed(5)),
        ttsCostUsd: Number((call.durationMins * 0.0018).toFixed(5)),
        sttCostUsd: Number((call.durationMins * 0.0011).toFixed(5)),
      },
    });

    if (call.report) {
      const r = call.report;
      await prisma.assessmentReport.upsert({
        where: { id: r.id },
        update: {},
        create: {
          id: r.id, interviewCallId: call.id, overallScore: r.overallScore,
          recommendation: r.recommendation, dimensions: r.dimensions,
          strengths: r.strengths, concerns: r.concerns, notableQuotes: r.quotes,
          generatedAt: minsAfter(startedAt, call.durationMins + 3),
        },
      });
    }
  }

  // Leave the second cohort uninterviewed, even across re-seeds: a completed
  // call would short-circuit them into the repeat-caller path.
  const extraCalls = await prisma.interviewCall.findMany({
    where: { candidateId: { in: EXTRA_CANDIDATES.map((c) => c.id) } },
    select: { id: true },
  });
  if (extraCalls.length) {
    const ids = extraCalls.map((c) => c.id);
    await prisma.assessmentReport.deleteMany({ where: { interviewCallId: { in: ids } } });
    await prisma.interviewCall.deleteMany({ where: { id: { in: ids } } });
  }


  // -------------------------------------------------------------------------
  // The wider role cohort. Each gets a complete pipeline of its own — job,
  // approved JD, call window, candidate, screening, shortlist and approval —
  // because caller recognition resolves a candidate to THEIR job, and the
  // interviewer takes its questions from that job's must-haves.
  // -------------------------------------------------------------------------
  for (const [i, role] of ROLE_COHORT.entries()) {
    const roleJob = await prisma.job.upsert({
      where: { id: `job-role-${role.key}` },
      update: { status: 'open', title: role.title, mustHaves: role.must, goodToHaves: role.good },
      create: {
        id: `job-role-${role.key}`, tenantId: tenant.id, slug: role.slug,
        title: role.title, status: 'open', location: role.location,
        salaryBand: role.band, experienceRange: role.experience,
        mustHaves: role.must, goodToHaves: role.good, createdBy: owner.id,
        createdAt: daysAgo(14),
      },
    });

    const bullets = (items) => items.map((x) => `- ${x}`).join('\n');
    await prisma.jobDescription.upsert({
      where: { id: `jd-role-${role.key}` },
      update: { approvedBy: owner.id, approvedAt: daysAgo(13) },
      create: {
        id: `jd-role-${role.key}`, jobId: roleJob.id, version: 1,
        generatedBy: 'ai', approvedBy: owner.id, approvedAt: daysAgo(13),
        bodyMd: `## ${role.title}\n\n**Location:** ${role.location}  \n**Experience:** ${role.experience}  \n**Salary band:** ${role.band}\n\n### About the role\n\nWe are hiring a ${role.title} to ${role.summary}.\n\n### Must-haves\n\n${bullets(role.must)}\n\n### Good to have\n\n${bullets(role.good)}\n\nShortlisted candidates will be invited to a short telephonic interview with\nPratibha, our AI recruiter.`,
      },
    });

    await prisma.callWindow.upsert({
      where: { id: `cw-role-${role.key}` },
      update: demoWindow,
      create: { id: `cw-role-${role.key}`, jobId: roleJob.id, timezone: 'Asia/Kolkata', ...demoWindow },
    });

    const c = role.candidate;
    const roleCandidate = await prisma.candidate.upsert({
      where: { id: `cand-role-${role.key}` },
      update: { name: c.name, email: c.email, phoneE164: c.phone, cvParsed: { name: c.name, email: c.email, phone: c.phone, ...c.cv } },
      create: {
        id: `cand-role-${role.key}`, tenantId: tenant.id, jobId: roleJob.id,
        name: c.name, email: c.email, phoneE164: c.phone,
        cvParsed: { name: c.name, email: c.email, phone: c.phone, ...c.cv },
        cvFileRef: `mock://cv/cand-role-${role.key}.pdf`,
        sourceEmailMsgId: `<mock-role-${role.key}@mail.acme.test>`,
        createdAt: daysAgo(11 - (i % 7)),
      },
    });

    await prisma.screening.upsert({
      where: { id: `screen-role-${role.key}` },
      update: { score: c.score, matchedMustHaves: c.matched, gaps: c.gaps, reasonSummary: c.reason },
      create: {
        id: `screen-role-${role.key}`, candidateId: roleCandidate.id, score: c.score,
        matchedMustHaves: c.matched, gaps: c.gaps, model: 'kimi-k2.6',
        tokensIn: 1150 + i * 25, tokensOut: 165 + i * 6,
        costUsd: Number((((1150 + i * 25) * 0.6e-6) + ((165 + i * 6) * 2.5e-6)).toFixed(6)),
        verdict: 'shortlist', reasonSummary: c.reason, createdAt: daysAgo(10 - (i % 6)),
      },
    });

    const roleShortlist = await prisma.shortlist.upsert({
      where: { id: `sl-role-${role.key}` },
      update: { status: 'approved' },
      create: { id: `sl-role-${role.key}`, jobId: roleJob.id, status: 'approved', createdAt: daysAgo(9) },
    });

    await prisma.shortlistItem.upsert({
      where: { shortlistId_candidateId: { shortlistId: roleShortlist.id, candidateId: roleCandidate.id } },
      update: { finalState: 'approved', removedBy: null },
      create: { shortlistId: roleShortlist.id, candidateId: roleCandidate.id, addedBy: 'ai', finalState: 'approved' },
    });

    const roleSnapshot = [{
      candidateId: roleCandidate.id, name: roleCandidate.name,
      email: roleCandidate.email, phoneE164: roleCandidate.phoneE164,
    }];
    await prisma.approval.upsert({
      where: { id: `approval-role-${role.key}` },
      update: { snapshot: roleSnapshot, approvedBy: users.reviewer.id, approvedAt: daysAgo(8) },
      create: {
        id: `approval-role-${role.key}`, shortlistId: roleShortlist.id,
        approvedBy: users.reviewer.id, approvedAt: daysAgo(8), snapshot: roleSnapshot,
      },
    });
  }

  // Keep this cohort uninterviewed across re-seeds, as with the extras above.
  const roleCalls = await prisma.interviewCall.findMany({
    where: { candidateId: { in: ROLE_COHORT.map((r) => `cand-role-${r.key}`) } },
    select: { id: true },
  });
  if (roleCalls.length) {
    const ids = roleCalls.map((c) => c.id);
    await prisma.assessmentReport.deleteMany({ where: { interviewCallId: { in: ids } } });
    await prisma.interviewCall.deleteMany({ where: { id: { in: ids } } });
  }

  // -------------------------------------------------------------------------
  // Metering (§6) — only the two completed calls are billable (§2.8)
  // -------------------------------------------------------------------------
  const billable = CALLS.filter((c) => c.status === 'completed').length;
  const screened = CANDIDATES.filter((c) => c.score !== null).length + EXTRA_CANDIDATES.length;

  await prisma.usageMeter.upsert({
    where: { id: 'um-mock-1' },
    update: { period: PERIOD, interviewsUsed: billable, screeningsUsed: screened },
    create: {
      id: 'um-mock-1', tenantId: tenant.id, period: PERIOD,
      interviewsUsed: billable, screeningsUsed: screened,
      overageInterviews: 0, overageScreenings: 0,
    },
  });

  // -------------------------------------------------------------------------
  // Audit + violation log (§8)
  // -------------------------------------------------------------------------
  const auditRows = [
    { id: 'al-mock-1', actor: owner.id, action: 'job.jd_approved', entity: 'job_description', entityId: approvedJd.id, reason: null },
    { id: 'al-mock-2', actor: users.reviewer.id, action: 'shortlist.approved', entity: 'shortlist', entityId: shortlist.id, reason: 'Reviewed all five; dropped the JVM profile.' },
    { id: 'al-mock-3', actor: 'system', action: 'outreach.sent', entity: 'approval', entityId: approval.id, reason: null },
    { id: 'al-mock-4', actor: users.viewer.id, action: 'authz.denied', entity: 'shortlist', entityId: shortlist.id, reason: 'viewer attempted shortlist.approve — 403' },
    { id: 'al-mock-5', actor: 'system', action: 'call.unknown_caller', entity: 'interview_call', entityId: 'call-mock-4', reason: 'Caller +917000000000 not on any approved shortlist; not interviewed.' },
  ];
  for (const row of auditRows) {
    await prisma.auditLog.upsert({
      where: { id: row.id },
      update: {},
      create: { ...row, tenantId: tenant.id, createdAt: daysAgo(4) },
    });
  }

  // -------------------------------------------------------------------------
  // Second tenant — isolation is only observable with two of them
  // -------------------------------------------------------------------------
  const other = await prisma.tenant.upsert({
    where: { slug: 'globex' },
    update: {},
    create: {
      id: 'tenant-mock-globex', name: 'Globex Industries', slug: 'globex',
      planId: 'starter', status: 'trial',
      trialEndsAt: new Date(Date.now() + 15 * 86400000),
    },
  });

  const otherOwner = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: other.id, email: 'owner@globex.test' } },
    update: { name: 'Ravi Krishnan', role: 'owner' },
    create: {
      id: 'user-mock-globex', tenantId: other.id, email: 'owner@globex.test',
      name: 'Ravi Krishnan', role: 'owner', authProviderId: 'auth-mock-globex-owner',
    },
  });

  const otherJob = await prisma.job.upsert({
    where: { id: 'job-mock-globex' },
    update: {},
    create: {
      id: 'job-mock-globex', tenantId: other.id, slug: 'data-analyst',
      title: 'Data Analyst', status: 'open', location: 'Pune',
      salaryBand: '₹12–18 LPA', experienceRange: '2–4 years',
      mustHaves: ['SQL', 'Python', 'Dashboarding'], goodToHaves: ['dbt', 'Airflow'],
      createdBy: otherOwner.id,
    },
  });

  await prisma.candidate.upsert({
    where: { id: 'cand-mock-globex-1' },
    update: {},
    create: {
      id: 'cand-mock-globex-1', tenantId: other.id, jobId: otherJob.id,
      name: 'Meera Joshi', email: 'meera@example.com', phoneE164: '+919888777666',
      sourceEmailMsgId: '<mock-globex-1@mail.globex.test>',
      cvParsed: { name: 'Meera Joshi', experience: '3 years', skills: ['SQL', 'Python', 'Looker'] },
    },
  });

  await prisma.usageMeter.upsert({
    where: { id: 'um-mock-globex' },
    update: { period: PERIOD },
    create: {
      id: 'um-mock-globex', tenantId: other.id, period: PERIOD,
      interviewsUsed: 0, screeningsUsed: 1, overageInterviews: 0, overageScreenings: 0,
    },
  });

  // -------------------------------------------------------------------------
  console.log('Mock data seeded.\n');
  console.log(`  Tenant   : ${tenant.name} (/${tenant.slug}) — plan ${tenant.planId}`);
  console.log(`  Users    : ${Object.values(users).map((u) => `${u.name} [${u.role}]`).join(', ')}`);
  console.log(`  Jobs     : ${job.title} (open), ${draftJob.title} (draft, JD unapproved)`);
  console.log(`  Careers  : /j/${job.slug}`);
  console.log(`  Candidates: ${CANDIDATES.length + EXTRA_CANDIDATES.length + ROLE_COHORT.length} (${screened + ROLE_COHORT.length} screened, 1 parse-failed)`);
  console.log(`  Ready to call: ${EXTRA_CANDIDATES.length + ROLE_COHORT.length} approved, none interviewed yet`);
  console.log(`  Roles       : ${ROLE_COHORT.length + 2} open (backend, frontend draft, + ${ROLE_COHORT.length} non-engineering)`);
  console.log(`  Shortlist : ${approvedIds.length} approved, 1 removed by reviewer`);
  console.log(`  Outreach  : ${approvedIds.length} invites sent under approval ${approval.id}`);
  console.log(`  Calls     : ${CALLS.length} (${billable} completed → reports, 1 dropped, 1 unknown caller)`);
  console.log(`  Usage     : ${billable} interviews, ${screened} screenings in ${PERIOD}`);
  console.log(`\n  Isolation : ${other.name} (/${other.slug}) — separate tenant, must never be visible from /${tenant.slug}`);
  console.log('\nSimulate a call:  npm run simulate -w @pratibha/worker');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
