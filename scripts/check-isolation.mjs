/**
 * §7: "Scripted API authorization regression suite (attempt every endpoint as
 * every role + cross-tenant) runs in CI; a failing case blocks merge."
 *
 * Unlike apps/web/tests/authz.test.ts, which unit-tests the role matrix, this
 * drives the running app over HTTP with real Supabase sessions. It is what
 * catches the two failure modes that unit tests cannot see: an endpoint whose
 * query is not tenant-scoped, and a role check that the route forgot to apply.
 *
 * Requires: the web app on :3000, local Supabase, and `npm run db:mock` plus
 * `npm run db:mock:auth` already run.
 *
 *   npm run test:isolation
 */
const SB = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const APP = process.env.APP_BASE_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.MOCK_USER_PASSWORD ?? 'pratibha123';

const ACME = 'tenant-mock-acme';
const GLOBEX = 'tenant-mock-globex';

async function cookieFor(email) {
  const r = await fetch(`${SB}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`login failed for ${email}: ${JSON.stringify(j)}`);
  const payload = JSON.stringify({
    access_token: j.access_token, refresh_token: j.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + j.expires_in,
    expires_in: j.expires_in, token_type: 'bearer', user: j.user,
  });
  // Matches @supabase/ssr: sb-<first hostname label>-auth-token.
  const ref = new URL(SB).hostname.split('.')[0];
  return `sb-${ref}-auth-token=base64-${Buffer.from(payload).toString('base64')}`;
}

async function call(cookie, method, path, body) {
  const res = await fetch(APP + path, {
    method,
    headers: { cookie, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail && !pass ? ` — ${detail}` : ''}`);
};

const c = {};
for (const e of ['owner@acme.test', 'admin@acme.test', 'reviewer@acme.test', 'viewer@acme.test', 'owner@globex.test']) {
  c[e] = await cookieFor(e);
}

console.log('\nCross-tenant access (must be refused):');
for (const [email, slug] of [['owner@globex.test', 'acme'], ['owner@acme.test', 'globex']]) {
  for (const path of [`/api/${slug}/jobs`, `/api/${slug}/usage`, `/api/${slug}/team`]) {
    const r = await call(c[email], 'GET', path);
    check(`${email.split('@')[0]} -> ${path}`, r.status === 403, `got ${r.status}`);
  }
}

console.log('\nRow scoping (no foreign tenant rows may be returned):');
{
  const r = await call(c['owner@acme.test'], 'GET', '/api/acme/jobs');
  const foreign = (r.json.jobs ?? []).filter((j) => j.tenantId !== ACME);
  check('acme /jobs returns only acme rows', r.status === 200 && foreign.length === 0, `${foreign.length} foreign`);
}
{
  const r = await call(c['owner@globex.test'], 'GET', '/api/globex/jobs');
  const foreign = (r.json.jobs ?? []).filter((j) => j.tenantId !== GLOBEX);
  check('globex /jobs returns only globex rows', r.status === 200 && foreign.length === 0, `${foreign.length} foreign`);
}
{
  // Direct object reference: a valid id belonging to another tenant, requested
  // through the caller's own tenant route. RLS must return nothing.
  const r = await call(c['owner@globex.test'], 'GET', '/api/globex/candidates?jobId=job-mock-backend');
  check('globex cannot read acme candidates by job id', (r.json.candidates ?? []).length === 0, `${(r.json.candidates ?? []).length} rows`);
}
{
  const r = await call(c['owner@acme.test'], 'GET', '/api/acme/team');
  const emails = (r.json.users ?? []).map((u) => u.email);
  check('acme /team excludes globex users', !emails.some((e) => e.endsWith('@globex.test')), emails.join(','));
}

console.log('\nRole gates:');
const roleChecks = [
  ['viewer@acme.test', 'POST', '/api/acme/shortlists/sl-mock-1/approve', 403, 'viewer cannot approve a shortlist'],
  ['viewer@acme.test', 'POST', '/api/acme/jobs/job-mock-backend/generate-jd', 403, 'viewer cannot generate a JD'],
  ['viewer@acme.test', 'POST', '/api/acme/jobs/job-mock-backend/approve-jd', 403, 'viewer cannot approve a JD'],
  ['viewer@acme.test', 'GET', '/api/acme/jobs', 200, 'viewer can read jobs'],
  ['reviewer@acme.test', 'GET', '/api/acme/jobs', 200, 'reviewer can read jobs'],
  ['admin@acme.test', 'GET', '/api/acme/jobs', 200, 'admin can read jobs'],
];
for (const [email, method, path, expect, name] of roleChecks) {
  const r = await call(c[email], method, path, method === 'POST' ? {} : undefined);
  check(name, r.status === expect, `got ${r.status}, want ${expect}`);
}

console.log('\nOutreach gate (§6 — no contact without an approvals row):');
{
  const r = await call(c['owner@acme.test'], 'POST', '/api/acme/shortlists/sl-mock-1/send-invites', { candidateIds: ['cand-mock-9999'] });
  check('cannot invite a candidate outside the approval snapshot', r.status >= 400, `got ${r.status}`);
}

console.log('\nUnauthenticated access:');
for (const path of ['/api/acme/jobs', '/api/acme/team', '/api/acme/usage']) {
  const res = await fetch(APP + path);
  check(`anonymous -> ${path}`, res.status === 401, `got ${res.status}`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) {
  console.error('\nFAILED:');
  failed.forEach((f) => console.error(`  - ${f.name} (${f.detail})`));
  process.exit(1);
}
