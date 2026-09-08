import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractText, chooseCvAttachment } from '../src/ingestion/extractText.js';
import { parseCvAttachment } from '../src/ingestion/parser.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name) => readFileSync(join(fixtures, name));

describe('extractText', () => {
  it('reads the text layer out of a real PDF', async () => {
    const result = await extractText(read('resume.pdf'), 'resume.pdf');

    expect(result.ok).toBe(true);
    expect(result.kind).toBe('pdf');
    expect(result.text).toContain('Priya Sharma');
    expect(result.text).toContain('priya.sharma@example.com');
  });

  // The regression this whole module exists for: the old binary sweep returned
  // compression noise for a PDF, which the field pickers then mined for a
  // "name" and "skills" that were never in the document.
  it('does not leak PDF structure keywords into the text', async () => {
    const result = await extractText(read('resume.pdf'), 'resume.pdf');
    for (const marker of ['endstream', '/Type', 'xref', '%PDF']) {
      expect(result.text).not.toContain(marker);
    }
  });

  it('strips the page-number banner pdf-parse inserts by default', async () => {
    const result = await extractText(read('resume.pdf'), 'resume.pdf');
    expect(result.text).not.toMatch(/--\s*\d+\s*of\s*\d+\s*--/);
  });

  it('flags a PDF with no text layer as needing OCR rather than failing to parse', async () => {
    const result = await extractText(read('scanned.pdf'), 'scan.pdf');

    expect(result.ok).toBe(false);
    expect(result.needsOcr).toBe(true);
    expect(result.reason).toMatch(/scanned/i);
  });

  it('trusts magic bytes over the filename', async () => {
    // A PDF that a recruiter renamed to .docx still has to parse.
    const result = await extractText(read('resume.pdf'), 'Priya Resume.docx');
    expect(result.kind).toBe('pdf');
    expect(result.ok).toBe(true);
  });

  it('reports docx as unsupported instead of returning zip noise', async () => {
    const zip = Buffer.concat([Buffer.from('PK', 'latin1'), Buffer.alloc(200, 7)]);
    const result = await extractText(zip, 'resume.docx');

    expect(result.ok).toBe(false);
    expect(result.kind).toBe('unsupported');
    expect(result.text).toBe('');
  });

  it('reads plain text attachments', async () => {
    const result = await extractText(Buffer.from('Ravi Kumar\nravi@example.com\n'), 'cv.txt');
    expect(result.ok).toBe(true);
    expect(result.text).toContain('ravi@example.com');
  });

  it('rejects an empty attachment', async () => {
    const result = await extractText(Buffer.alloc(0), 'empty.pdf');
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('empty');
  });
});

describe('chooseCvAttachment', () => {
  const att = (filename, extra = {}) => ({ filename, content: Buffer.from('x'), ...extra });

  it('prefers a PDF over an inline signature image', () => {
    const picked = chooseCvAttachment([att('logo.png', { contentDisposition: 'inline' }), att('resume.pdf')]);
    expect(picked.filename).toBe('resume.pdf');
  });

  it('prefers the file that names itself a CV', () => {
    const picked = chooseCvAttachment([att('offer-letter.pdf'), att('Priya-CV.pdf')]);
    expect(picked.filename).toBe('Priya-CV.pdf');
  });

  it('returns null when there is nothing with content', () => {
    expect(chooseCvAttachment([])).toBeNull();
    expect(chooseCvAttachment([{ filename: 'x.pdf', content: Buffer.alloc(0) }])).toBeNull();
  });
});

describe('parseCvAttachment', () => {
  it('pulls contact details and skills out of a PDF', async () => {
    const { parsed, extraction } = await parseCvAttachment(read('resume.pdf'), 'resume.pdf');

    expect(extraction.ok).toBe(true);
    expect(parsed.email).toBe('priya.sharma@example.com');
    expect(parsed.phone).toBe('+919876543210');
    expect(parsed.experience).toBe('6 years');
    expect(parsed.skills).toEqual(expect.arrayContaining(['react', 'postgresql']));
  });

  // A scan is common in Indian hiring, and the body text is then the only
  // thing we have. Losing it would mean no phone number and no callable lead.
  it('falls back to the email body when the attachment is a scan', async () => {
    const body = 'Hi, I am Anil Verma, anil@example.com, 9876501234. 3 years of experience.';
    const { parsed, extraction } = await parseCvAttachment(read('scanned.pdf'), 'scan.pdf', body);

    expect(extraction.needsOcr).toBe(true);
    expect(parsed.source).toBe('email_body');
    expect(parsed.email).toBe('anil@example.com');
    expect(parsed.phone).toBe('+919876501234');
  });
});
