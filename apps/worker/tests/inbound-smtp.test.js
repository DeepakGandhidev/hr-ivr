import net from 'node:net';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// The receiver looks connections up and records outcomes through Prisma, and
// hands accepted mail to the poller's shared ingestMessage. Both are stubbed so
// this exercises the SMTP conversation and the routing decisions only.
const findUnique = vi.fn();
const update = vi.fn().mockResolvedValue({});

vi.mock('@pratibha/prisma', () => ({
  prisma: { emailConnection: { findUnique: (...a) => findUnique(...a), update: (...a) => update(...a) } },
}));

const ingestMessage = vi.fn().mockResolvedValue('ingested');
vi.mock('../src/ingestion/poller.js', () => ({
  ingestMessage: (...a) => ingestMessage(...a),
  loadOpenJobs: vi.fn().mockResolvedValue([]),
}));

const { startInboundSmtp, deliverToConnection } = await import('../src/ingestion/inboundSmtp.js');

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const forward = {
  id: 'fwd1',
  tenantId: 't1',
  provider: 'forward_alias',
  status: 'connected',
  address: 'hr@acme.com',
  forwardToken: 'acme.k3x9q2m7wd',
  defaultJobId: 'job1',
  autoRoute: false,
};

function raw({ from = 'Priya <priya@example.com>', subject = 'Application for Sales', body = 'Please find my CV.' } = {}) {
  return Buffer.from(
    [`From: ${from}`, 'To: hr@acme.com', `Subject: ${subject}`, 'Message-ID: <abc123@example.com>', '', body, ''].join('\r\n')
  );
}

describe('deliverToConnection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('files an application through the shared ingestion path', async () => {
    await expect(deliverToConnection(forward, raw(), quiet)).resolves.toBe('ingested');
    const [, message] = ingestMessage.mock.calls[0];
    expect(message).toMatchObject({ from: 'priya@example.com', subject: 'Application for Sales', messageId: '<abc123@example.com>' });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'connected', forwardVerifyCode: null }) })
    );
  });

  it('unwraps a rule forward sent from the recruiter’s own address', async () => {
    const mail = raw({ from: 'HR <hr@acme.com>', subject: 'FW: CV', body: 'From: Rahul <rahul@example.in>\r\nSent: today' });
    await deliverToConnection(forward, mail, quiet);
    expect(ingestMessage.mock.calls[0][1]).toMatchObject({ from: 'rahul@example.in', subject: 'CV' });
  });

  it('stores a Gmail confirmation instead of creating a candidate', async () => {
    const mail = raw({
      from: 'Gmail Team <forwarding-noreply@google.com>',
      subject: '(#987654321) Gmail Forwarding Confirmation - Receive Mail from hr@acme.com',
      body: 'Confirmation code: 987654321\r\nhttps://mail-settings.google.com/mail/vf-abc',
    });
    await expect(deliverToConnection(forward, mail, quiet)).resolves.toBe('confirmation');
    expect(ingestMessage).not.toHaveBeenCalled();
    expect(update.mock.calls[0][0].data).toMatchObject({ forwardVerifyCode: '987654321' });
  });

  it('drops mail for a paused address without bouncing it', async () => {
    await expect(deliverToConnection({ ...forward, status: 'revoked' }, raw(), quiet)).resolves.toBe('paused');
    expect(ingestMessage).not.toHaveBeenCalled();
  });
});

/** Just enough of an SMTP client to drive a conversation line by line. */
function smtpSession(port) {
  const socket = net.connect(port, '127.0.0.1');
  let buffer = '';
  const waiters = [];
  socket.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    // A reply is complete at a line whose 4th char is a space ("250 ok").
    while ((idx = buffer.search(/^\d{3} .*\r\n/m)) !== -1) {
      const end = buffer.indexOf('\r\n', idx) + 2;
      const reply = buffer.slice(0, end);
      buffer = buffer.slice(end);
      waiters.shift()?.(reply);
    }
  });
  const next = () => new Promise((resolve) => waiters.push(resolve));
  return {
    greeting: next(),
    async send(line) {
      const reply = next();
      socket.write(`${line}\r\n`);
      return reply;
    },
    close: () => socket.end(),
  };
}

describe('inbound SMTP server', () => {
  const port = 40000 + Math.floor(Math.random() * 10000);
  const server = startInboundSmtp(quiet, { INBOUND_SMTP_PORT: String(port), INBOUND_SMTP_HOST: '127.0.0.1', INBOUND_EMAIL_DOMAIN: 'in.pratibha.tech' });
  afterAll(() => server.stop());

  it('accepts mail for a known forwarding address and refuses everything else', async () => {
    findUnique.mockImplementation(({ where }) => (where.forwardToken === forward.forwardToken ? forward : null));
    await new Promise((r) => setTimeout(r, 50));

    const smtp = smtpSession(port);
    expect(await smtp.greeting).toMatch(/^220 /);
    expect(await smtp.send('EHLO sender.example')).toMatch(/^250[ -]/);
    expect(await smtp.send('MAIL FROM:<priya@example.com>')).toMatch(/^250 /);

    // Not a relay: another domain, and an unknown token, are both refused at RCPT.
    expect(await smtp.send('RCPT TO:<someone@gmail.com>')).toMatch(/^550 /);
    expect(await smtp.send('RCPT TO:<acme.zzzzzzzzzz@in.pratibha.tech>')).toMatch(/^550 /);
    expect(await smtp.send('RCPT TO:<acme.k3x9q2m7wd@in.pratibha.tech>')).toMatch(/^250 /);

    expect(await smtp.send('DATA')).toMatch(/^354 /);
    const reply = await smtp.send(`${raw().toString().replace(/\r\n$/, '')}\r\n.`);
    expect(reply).toMatch(/^250 /);
    smtp.close();

    expect(ingestMessage).toHaveBeenCalledTimes(1);
  });

  it('asks the sender to retry when ingestion fails', async () => {
    findUnique.mockResolvedValue(forward);
    ingestMessage.mockRejectedValueOnce(new Error('database down'));

    const smtp = smtpSession(port);
    await smtp.greeting;
    await smtp.send('EHLO sender.example');
    await smtp.send('MAIL FROM:<priya@example.com>');
    await smtp.send('RCPT TO:<acme.k3x9q2m7wd@in.pratibha.tech>');
    await smtp.send('DATA');
    expect(await smtp.send(`${raw().toString().replace(/\r\n$/, '')}\r\n.`)).toMatch(/^451 /);
    smtp.close();
  });
});
