import { describe, it, expect } from 'vitest';
import { forwardTokenFromRecipient, parseGmailForwardingConfirmation, unwrapForward } from '../src/ingestion/forwarding.js';
import { newForwardToken } from '@pratibha/shared/mail-oauth';
import crypto from 'node:crypto';

describe('Gmail forwarding confirmation', () => {
  const confirmation = {
    from: 'forwarding-noreply@google.com',
    subject: '(#123456789) Gmail Forwarding Confirmation - Receive Mail from hr.acme@gmail.com',
    text: [
      'hr.acme@gmail.com has requested to automatically forward mail to your email address',
      'acme.k3x9q2m7wd@in.pratibha.tech.',
      'Confirmation code: 123456789',
      'To allow hr.acme@gmail.com to automatically forward mail to your address, please click the link below to confirm the request:',
      'https://mail-settings.google.com/mail/vf-%5BANGjdJ_abc%5D-xyz',
    ].join('\n'),
  };

  it('lifts the code, the Google link and the requesting mailbox', () => {
    expect(parseGmailForwardingConfirmation(confirmation)).toEqual({
      code: '123456789',
      url: 'https://mail-settings.google.com/mail/vf-%5BANGjdJ_abc%5D-xyz',
      requestedBy: 'hr.acme@gmail.com',
    });
  });

  it('never surfaces a link that is not on a Google host', () => {
    const fake = { ...confirmation, text: 'Confirmation code: 111222333\nhttps://evil.example/mail/vf-steal' };
    expect(parseGmailForwardingConfirmation(fake)).toMatchObject({ code: '111222333', url: null });
  });

  it('ignores ordinary mail', () => {
    expect(parseGmailForwardingConfirmation({ from: 'a@b.com', subject: 'Application for Sales', text: 'CV attached' })).toBeNull();
  });
});

describe('unwrapForward', () => {
  it('recovers the applicant from a Gmail-style forward', () => {
    const message = {
      from: 'hr@acme.com',
      fromName: 'HR',
      subject: 'Fwd: Application for Sales Executive',
      text: '---------- Forwarded message ---------\nFrom: Priya Sharma <priya.s@example.com>\nDate: Mon, 12 Oct 2026\nSubject: Application',
    };
    expect(unwrapForward(message)).toMatchObject({
      from: 'priya.s@example.com',
      fromName: 'Priya Sharma',
      subject: 'Application for Sales Executive',
    });
  });

  it('recovers the applicant from an Outlook [mailto:] forward', () => {
    const message = {
      from: 'hr@acme.com',
      subject: 'FW: CV - Accountant',
      text: '________________________________\nFrom: Rahul Verma [mailto:rahul@example.in]\nSent: Monday\nTo: hr@acme.com',
    };
    expect(unwrapForward(message)).toMatchObject({ from: 'rahul@example.in', fromName: 'Rahul Verma', subject: 'CV - Accountant' });
  });

  it('handles a bare address', () => {
    const message = { from: 'hr@acme.com', subject: 'Fwd: hi', text: 'From: anil@example.com\nDate: today' };
    expect(unwrapForward(message)).toMatchObject({ from: 'anil@example.com', fromName: null });
  });

  it('leaves non-forwards and self-quotes alone', () => {
    expect(unwrapForward({ from: 'hr@acme.com', subject: 'Application', text: 'From: x@y.com' })).toBeNull();
    expect(unwrapForward({ from: 'hr@acme.com', subject: 'Fwd: x', text: 'From: HR <hr@acme.com>' })).toBeNull();
  });
});

describe('forwardTokenFromRecipient', () => {
  const domain = 'in.pratibha.tech';

  it('accepts the private address, case-insensitively and with plus-addressing', () => {
    expect(forwardTokenFromRecipient('acme.k3x9q2m7wd@in.pratibha.tech', domain)).toBe('acme.k3x9q2m7wd');
    expect(forwardTokenFromRecipient('ACME.K3X9Q2M7WD@IN.PRATIBHA.TECH', domain)).toBe('acme.k3x9q2m7wd');
    expect(forwardTokenFromRecipient('acme.k3x9q2m7wd+jobs@in.pratibha.tech', domain)).toBe('acme.k3x9q2m7wd');
  });

  it('refuses other domains and malformed local parts', () => {
    expect(forwardTokenFromRecipient('acme.k3x9q2m7wd@gmail.com', domain)).toBeNull();
    expect(forwardTokenFromRecipient('acme@in.pratibha.tech', domain)).toBeNull();
    expect(forwardTokenFromRecipient('postmaster@in.pratibha.tech', domain)).toBeNull();
    expect(forwardTokenFromRecipient('', domain)).toBeNull();
  });

  it('accepts every token the web app generates', () => {
    for (const slug of ['acme', 'big-co-hiring', 'X_Y!', 'a'.repeat(60)]) {
      const token = newForwardToken(slug, () => crypto.randomBytes(16));
      expect(forwardTokenFromRecipient(`${token}@${domain}`, domain)).toBe(token);
    }
  });
});
