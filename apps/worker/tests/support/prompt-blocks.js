// The interviewer block library exactly as the migration ships it, so tests
// exercise the real wording rather than a copy that could drift from it.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const migrations = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../packages/prisma/migrations');

export function shippedPromptBlocks() {
  // The newest migration that writes a block library wins, like the newest
  // active version does in the database.
  const dirs = readdirSync(migrations).filter((d) => !d.endsWith('.toml')).sort().reverse();
  for (const dir of dirs) {
    const sql = readFileSync(path.join(migrations, dir, 'migration.sql'), 'utf8');
    const m = /\$blocks\$([\s\S]*?)\$blocks\$/.exec(sql);
    if (m) return { version: dir, ...JSON.parse(m[1]) };
  }
  throw new Error('No migration ships an interviewer block library');
}
