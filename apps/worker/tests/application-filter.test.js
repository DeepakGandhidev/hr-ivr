import { describe, it, expect } from 'vitest';
import { classifyMessage } from '../src/ingestion/applicationFilter.js';

const msg = (over = {}) => ({
  headers: {},
  from: 'someone@example.com',
  subject: '',
  text: '',
  cvAttachment: null,
  ...over,
});

/**
 * Every rejection case below is a real message from the inbox this was built
 * for. Without the filter each one became a Candidate: the Figma newsletter
 * arrived as a person named "Design with community in mind" whose skills were
 * "go, figma", and a recruiter would have had to clear them out by hand.
 */
describe('rejects mail that is not an application', () => {
  it('drops a marketing newsletter with List-Unsubscribe', () => {
    const verdict = classifyMessage(msg({
      headers: { 'list-unsubscribe': '<https://figma.com/unsub>' },
      from: 'announcements@figma.com',
      subject: 'Design with community in mind',
    }));

    expect(verdict.accept).toBe(false);
    expect(verdict.signal).toBe('bulk');
  });

  it('drops an automated sender even without bulk headers', () => {
    const verdict = classifyMessage(msg({
      from: 'no-reply@teams.mail.microsoft',
      subject: 'vishalchaubey0011 sent a message',
    }));

    expect(verdict.accept).toBe(false);
    expect(verdict.signal).toBe('robot');
  });

  it('drops a bulk-mail subdomain sender', () => {
    const verdict = classifyMessage(msg({
      from: 'em@em1.cloudflare.com',
      subject: 'See Fei-Fei Li and Adam Grant live at Cloudflare Connect',
    }));

    expect(verdict.accept).toBe(false);
    expect(verdict.signal).toBe('robot');
  });

  it('drops a vendor update that happens to mention "API"', () => {
    const verdict = classifyMessage(msg({
      from: 'hello@updates.sarvam.ai',
      subject: 'your Sarvam API calls are failing',
      text: 'Your API calls are failing. 6 years of uptime.',
    }));

    expect(verdict.accept).toBe(false);
  });

  it('drops ordinary correspondence with no application wording', () => {
    const verdict = classifyMessage(msg({
      from: 'pedrijodi0@gmail.com',
      subject: 'Quick Response Deepak',
      text: 'Hi Deepak, following up on our chat.',
    }));

    expect(verdict.accept).toBe(false);
    expect(verdict.signal).toBe('off-topic');
  });

  it('drops an out-of-office auto-reply', () => {
    const verdict = classifyMessage(msg({
      headers: { 'auto-submitted': 'auto-replied' },
      subject: 'Re: your application',
      text: 'I am on leave until Monday.',
    }));

    expect(verdict.accept).toBe(false);
    expect(verdict.signal).toBe('bulk');
  });

  it('drops a mailing-list post', () => {
    const verdict = classifyMessage(msg({
      headers: { 'list-id': '<devs.example.com>' },
      text: 'Anyone hiring? I have a resume ready.',
    }));

    expect(verdict.accept).toBe(false);
  });
});

describe('accepts real applications', () => {
  it('accepts a document attachment from a human sender', () => {
    const verdict = classifyMessage(msg({
      from: 'priya.sharma@gmail.com',
      cvAttachment: { filename: 'Priya_Sharma.pdf', content: Buffer.from('x') },
    }));

    expect(verdict.accept).toBe(true);
    expect(verdict.signal).toBe('attachment');
  });

  // A file that names itself a resume is the one thing that outranks a bulk or
  // automated sender — an applicant whose job board mails on their behalf.
  it('accepts an explicitly named resume even from an automated sender', () => {
    const verdict = classifyMessage(msg({
      headers: { 'list-unsubscribe': '<https://example.com/unsub>' },
      from: 'no-reply@naukri.com',
      cvAttachment: { filename: 'Rahul-Resume.pdf', content: Buffer.from('x') },
    }));

    expect(verdict.accept).toBe(true);
  });

  it('accepts a plain-text application with no attachment', () => {
    const verdict = classifyMessage(msg({
      from: 'priya.sharma@gmail.com',
      subject: 'Application for MERN Stack Developer',
      text: 'Please find my details below. 6 years experience.',
    }));

    expect(verdict.accept).toBe(true);
    expect(verdict.signal).toBe('wording');
  });

  it('accepts Indian-market phrasing', () => {
    for (const text of [
      'I am interested in this opening. Notice period 30 days.',
      'Sharing my CV for the QA role.',
      'Applying for the vacancy posted on Naukri.',
      'Current CTC 8 LPA, expected CTC 12 LPA.',
    ]) {
      expect(classifyMessage(msg({ text })).accept).toBe(true);
    }
  });

  it('is case-insensitive about the wording', () => {
    expect(classifyMessage(msg({ subject: 'APPLICATION FOR SEO ROLE' })).accept).toBe(true);
  });
});

describe('requireCv mode', () => {
  it('admits only mail with an attachment', () => {
    const withCv = msg({ cvAttachment: { filename: 'cv.pdf', content: Buffer.from('x') } });
    const without = msg({ subject: 'Application for the role' });

    expect(classifyMessage(withCv, { requireCv: true }).accept).toBe(true);
    expect(classifyMessage(without, { requireCv: true }).accept).toBe(false);
  });
});

/**
 * These are the messages that got through the first version of this filter and
 * became real rows in the database. Each one is here so it cannot come back.
 */
describe('regressions from the first live run', () => {
  it('rejects an invoice PDF from a billing address', () => {
    const verdict = classifyMessage(msg({
      from: 'invoice+statements@mail.anthropic.com',
      subject: 'Your invoice',
      cvAttachment: { filename: 'invoice.pdf', content: Buffer.from('x') },
    }));

    // It became a candidate named "Page 1 of 1".
    expect(verdict.accept).toBe(false);
  });

  it('rejects a Google Docs share, where "noreply" sits mid-address', () => {
    const verdict = classifyMessage(msg({
      from: 'drive-shares-dm-noreply@google.com',
      subject: 'Chetna Kumar shared a document',
    }));

    expect(verdict.accept).toBe(false);
    expect(verdict.signal).toBe('robot');
  });

  it('rejects a Teams notification carrying UUID-named blobs', () => {
    // chooseCvAttachment now returns null for these, so no attachment reaches
    // the filter at all — it became "gdivyank sent a message" when it did.
    const verdict = classifyMessage(msg({
      from: 'no-reply@teams.mail.microsoft',
      subject: 'gdivyank sent a message',
      cvAttachment: null,
    }));

    expect(verdict.accept).toBe(false);
  });

  it('rejects a vendor product announcement', () => {
    const verdict = classifyMessage(msg({
      headers: { 'list-unsubscribe': '<https://telnyx.com/unsub>' },
      from: 'discover@telnyx.com',
      subject: 'Edge Compute, Email, K3 + more',
    }));

    expect(verdict.accept).toBe(false);
  });
});
