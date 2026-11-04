import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';

process.env.EMAIL_SECRET_KEY ??= 'a'.repeat(64);

// A host that stops answering makes ImapFlow emit 'error' ("Socket timeout")
// and then fail the pending call. An EventEmitter with no 'error' listener
// throws on emit, which in production was an uncaught exception that
// restarted the whole worker every minute.
vi.mock('imapflow', () => ({
  ImapFlow: class extends EventEmitter {
    async connect() {
      const err = Object.assign(new Error('Socket timeout'), { code: 'ETIMEOUT' });
      this.emit('error', err);
      throw err;
    }
    async logout() {}
  },
}));
vi.mock('@pratibha/prisma', () => ({ prisma: {} }));

const { sealSecret } = await import('@pratibha/shared/crypto');
const { fetchNewMessages, verifyConnection } = await import('../src/ingestion/imapClient.js');

const quiet = { info: () => {}, warn: vi.fn(), error: () => {} };
const connection = {
  id: 'c1',
  provider: 'imap',
  address: 'hr@acme.com',
  imapHost: 'mail.acme.com',
  imapSecret: sealSecret('pw'),
};

describe('IMAP socket errors', () => {
  it('reject the poll instead of crashing the process', async () => {
    await expect(fetchNewMessages(connection, { logger: quiet })).rejects.toThrow('Socket timeout');
    expect(quiet.warn).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'c1' }), 'IMAP connection error');
  });

  it('come back as a failed check from verifyConnection', async () => {
    await expect(verifyConnection(connection, quiet)).resolves.toMatchObject({ ok: false, error: 'Socket timeout' });
  });
});
