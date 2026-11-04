import { afterEach, describe, expect, it } from 'vitest';
import { startSettings, __resetSettingsRuntime } from '@pratibha/shared/settings-runtime';
import { classifyMessage } from '../src/ingestion/applicationFilter.js';
import { matchJobFromMessage } from '../src/ingestion/jobRouter.js';
import { extractText } from '../src/ingestion/extractText.js';

const quiet = { warn: () => {}, info: () => {} };
const withSettings = (rows) => startSettings({ app: 'worker', load: async () => rows, logger: quiet, intervalMs: 1e9 });

const msg = (over = {}) => ({ headers: {}, from: 'priya@example.com', subject: '', text: '', cvAttachment: null, ...over });

afterEach(() => __resetSettingsRuntime());

describe('spam filter extras from the admin panel', () => {
  it('skips an extra robot domain and its subdomains, and nothing else', async () => {
    const fromAts = msg({ from: 'priya@ats-vendor.io', subject: 'Application for QA Engineer' });
    expect(classifyMessage(fromAts).accept).toBe(true);

    await withSettings([{ key: 'email.robot_domains', value: ['ATS-Vendor.io'] }]);
    expect(classifyMessage(fromAts)).toMatchObject({ accept: false, signal: 'robot' });
    expect(classifyMessage({ ...fromAts, from: 'priya@eu.ats-vendor.io' }).accept).toBe(false);
    // A domain that merely ends in the same letters is someone else's.
    expect(classifyMessage({ ...fromAts, from: 'priya@notats-vendor.io' }).accept).toBe(true);
  });

  it('skips an extra sender name the way the built-in names match', async () => {
    await withSettings([{ key: 'email.robot_senders', value: ['digest'] }]);
    const subject = 'Application for QA Engineer';
    expect(classifyMessage(msg({ from: 'digest@acme.com', subject })).accept).toBe(false);
    expect(classifyMessage(msg({ from: 'digest+weekly@acme.com', subject })).accept).toBe(false);
    expect(classifyMessage(msg({ from: 'digestive@acme.com', subject })).accept).toBe(true);
  });

  it('accepts mail carrying an extra application term, as a whole word', async () => {
    const biodata = msg({ subject: 'My biodata', text: 'Please find my details below.' });
    expect(classifyMessage(biodata).accept).toBe(false);

    await withSettings([{ key: 'email.application_terms', value: ['Biodata', 'naukri.com profile'] }]);
    expect(classifyMessage(biodata)).toMatchObject({ accept: true, signal: 'wording' });
    expect(classifyMessage(msg({ subject: 'Biodatabase export' })).accept).toBe(false);
    expect(classifyMessage(msg({ text: 'see my naukri.com  profile' })).accept).toBe(true);
  });

  it('treats a typed term literally rather than as a pattern', async () => {
    await withSettings([{ key: 'email.application_terms', value: ['c++ (hons)'] }]);
    expect(classifyMessage(msg({ subject: 'C++ (Hons) graduate' })).accept).toBe(true);
    expect(classifyMessage(msg({ subject: 'cc (hons) graduate' })).accept).toBe(false);
  });
});

describe('job routing threshold', () => {
  const jobs = [{ id: 'j-qa', title: 'QA Engineer', slug: 'qa-engineer' }];
  // Half the title in the subject scores 35: under the default of 45.
  const borderline = { subject: 'QA tester here' };

  it('follows email.route_threshold', async () => {
    expect(matchJobFromMessage(borderline, jobs).jobId).toBeNull();

    await withSettings([{ key: 'email.route_threshold', value: 30 }]);
    expect(matchJobFromMessage(borderline, jobs)).toMatchObject({ jobId: 'j-qa', confidence: 35 });
  });
});

describe('CV size limit', () => {
  it('follows limits.cv_max_mb', async () => {
    const twoMb = Buffer.alloc(2 * 1024 * 1024, 'a');
    expect((await extractText(twoMb, 'cv.txt')).kind).toBe('text');

    await withSettings([{ key: 'limits.cv_max_mb', value: 1 }]);
    expect(await extractText(twoMb, 'cv.txt')).toMatchObject({ ok: false, kind: 'unsupported' });
  });
});
