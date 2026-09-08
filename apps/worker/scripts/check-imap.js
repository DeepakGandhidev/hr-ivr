/**
 * Dry-runs the whole email ingestion chain against a real mailbox, without
 * touching the database, the web app, or Supabase.
 *
 * It connects over IMAP, reads the most recent messages, picks the attachment
 * that looks like a CV, extracts its text, and prints the fields that would
 * have been written to the Candidate row. Nothing is saved and nothing is
 * marked as read.
 *
 * Run this before wiring the mailbox up in the UI. It separates "the mail
 * credentials are wrong" from "the CV did not parse", which otherwise look
 * identical from the outside: no candidates appear either way.
 *
 *   node scripts/check-imap.js --host mail.promonkey.tech --user hr@promonkey.tech
 *
 * The password is read from IMAP_PASSWORD, or prompted for if that is unset, so
 * it never lands in your shell history.
 */
import 'dotenv/config';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import readline from 'node:readline';
import { Writable } from 'node:stream';

import { chooseCvAttachment, extractText } from '../src/ingestion/extractText.js';
import { parseCvAttachment } from '../src/ingestion/parser.js';
import { classifyMessage } from '../src/ingestion/applicationFilter.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

/** Read a password without echoing it to the terminal. */
function promptPassword(question) {
  return new Promise((resolve) => {
    let muted = false;
    const mutedOut = new Writable({
      write(chunk, encoding, callback) {
        if (!muted) process.stdout.write(chunk, encoding);
        callback();
      },
    });

    const rl = readline.createInterface({ input: process.stdin, output: mutedOut, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log('usage: node scripts/check-imap.js --host <imap host> --user <address> [--port 993] [--folder INBOX] [--limit 5]');
  process.exit(0);
}

const user = args.user || process.env.IMAP_USER;
const host = args.host || process.env.IMAP_HOST || (user?.includes('@') ? `mail.${user.split('@')[1]}` : null);
const port = Number(args.port || process.env.IMAP_PORT || 993);
const folder = args.folder || process.env.IMAP_FOLDER || 'INBOX';
const limit = Number(args.limit || 5);

if (!user || !host) {
  console.error('Need at least --user (and --host, unless it can be guessed from the address).');
  console.error('usage: node scripts/check-imap.js --host mail.example.com --user hr@example.com');
  process.exit(1);
}

const password = process.env.IMAP_PASSWORD || (await promptPassword(`Password for ${user}: `));
if (!password) {
  console.error('No password supplied.');
  process.exit(1);
}

console.log(`\nConnecting to ${host}:${port} as ${user} ...`);

const client = new ImapFlow({
  host,
  port,
  secure: port !== 143,
  auth: { user, pass: password },
  connectionTimeout: 20_000,
  greetingTimeout: 20_000,
  socketTimeout: 60_000,
  logger: false,
});

let exitCode = 0;

try {
  await client.connect();
  console.log('Connected and authenticated.\n');
} catch (err) {
  console.error(`FAILED to connect: ${err.message}\n`);
  console.error('Common causes:');
  console.error('  - Wrong password, or the username needs to be the FULL address');
  console.error('  - Port 993 blocked by a firewall on the machine running this');
  console.error('  - Host is not the mail server (cPanel is usually mail.<yourdomain>)');
  process.exit(1);
}

try {
  const lock = await client.getMailboxLock(folder);
  try {
    const total = client.mailbox.exists;
    console.log(`Folder ${folder}: ${total} message(s), UIDVALIDITY ${client.mailbox.uidValidity}\n`);

    if (total === 0) {
      console.log('Mailbox is empty — send yourself a test email with a PDF attached and re-run.');
    }

    const first = Math.max(1, total - limit + 1);
    const seqRange = `${first}:${total}`;

    if (total > 0) {
      console.log(`Reading the last ${Math.min(limit, total)} message(s)\n${'='.repeat(60)}`);
    }

    let importedCount = 0;
    let skippedCount = 0;

    for await (const message of client.fetch(seqRange, { source: true, uid: true })) {
      const mail = await simpleParser(message.source);

      const attachments = (mail.attachments ?? []).map((a) => ({
        filename: a.filename ?? 'attachment',
        contentType: a.contentType ?? null,
        contentDisposition: a.contentDisposition ?? null,
        content: a.content,
      }));

      console.log(`\nUID ${message.uid}`);
      console.log(`  From:    ${mail.from?.text ?? '(none)'}`);
      console.log(`  Subject: ${mail.subject ?? '(none)'}`);
      console.log(`  Date:    ${mail.date?.toISOString() ?? '(none)'}`);
      console.log(`  Attachments: ${attachments.length ? attachments.map((a) => a.filename).join(', ') : '(none)'}`);

      const wanted = ['list-unsubscribe', 'list-id', 'precedence', 'auto-submitted', 'x-autoreply', 'x-autorespond'];
      const headers = {};
      for (const name of wanted) {
        const value = mail.headers?.get(name);
        if (value) headers[name] = typeof value === 'string' ? value : String(value.value ?? value);
      }

      const cv = chooseCvAttachment(attachments);

      const verdict = classifyMessage({
        headers,
        from: mail.from?.value?.[0]?.address ?? null,
        subject: mail.subject ?? '',
        text: mail.text ?? '',
        cvAttachment: cv,
      });

      if (!verdict.accept) {
        console.log(`  -> SKIPPED — ${verdict.reason}`);
        console.log('     No candidate would be created.');
        skippedCount += 1;
        continue;
      }

      console.log(`  -> IMPORTED — ${verdict.reason}`);
      importedCount += 1;

      if (!cv) {
        console.log('  -> No CV attachment; the email body would be parsed instead.');
      } else {
        console.log(`  -> Treating "${cv.filename}" as the CV`);
        const probe = await extractText(cv.content, cv.filename);
        console.log(`     type=${probe.kind} readable=${probe.ok}${probe.pages ? ` pages=${probe.pages}` : ''}`);
        if (!probe.ok) console.log(`     reason: ${probe.reason}`);
        if (probe.needsOcr) console.log('     (this is a scan — text would come from the email body)');
      }

      const { parsed } = await parseCvAttachment(
        cv?.content ?? Buffer.alloc(0),
        cv?.filename ?? '',
        [mail.subject, mail.from?.value?.[0]?.name, mail.text].filter(Boolean).join('\n')
      );

      console.log('     Would create candidate:');
      console.log(`       name:       ${parsed.name ?? '(not found)'}`);
      console.log(`       email:      ${mail.from?.value?.[0]?.address ?? parsed.email ?? '(not found)'}`);
      console.log(`       phone:      ${parsed.phone ?? '(not found)  <-- not callable without this'}`);
      console.log(`       experience: ${parsed.experience ?? '(not found)'}`);
      console.log(`       skills:     ${parsed.skills?.length ? parsed.skills.join(', ') : '(none matched)'}`);
      console.log(`       education:  ${parsed.education?.length ? parsed.education.join(' | ') : '(none matched)'}`);
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Would import ${importedCount}, skip ${skippedCount} of ${importedCount + skippedCount} read.`);
    console.log('Nothing was saved and no message was marked as read.');
  } finally {
    lock.release();
  }
} catch (err) {
  console.error(`\nFailed while reading ${folder}: ${err.message}`);
  exitCode = 1;
} finally {
  await client.logout().catch(() => {});
}

process.exit(exitCode);
