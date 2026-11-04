import { vi } from 'vitest';
import { shippedPromptBlocks } from './prompt-blocks.js';

// Calls read the library from prompt_templates; tests without a database get
// the shipped one. Production never sets this.
globalThis.__PRATIBHA_TEST_PROMPT_BLOCKS__ = shippedPromptBlocks();

// The same library in place of the database read, so a test that never
// configured a database does not sit waiting for one before the first turn.
vi.mock('../../src/db/index.js', async (importOriginal) => ({
  ...(await importOriginal()),
  activePromptBlocks: async () => globalThis.__PRATIBHA_TEST_PROMPT_BLOCKS__,
}));
