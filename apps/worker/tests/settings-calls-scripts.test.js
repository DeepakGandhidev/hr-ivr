import { afterEach, describe, expect, it } from 'vitest';
import { startSettings, __resetSettingsRuntime } from '@pratibha/shared/settings-runtime';
import { SETTINGS_BY_KEY } from '@pratibha/shared/settings-registry';
import { DISCLOSURE, agentNameFor, closingMatcher, disclosureText, isClosingRemark, makeDisclosure } from '../src/lib/screening.js';
import { escalationLine } from '../src/lib/toolExecutor.js';
import { PAUSED_REFUSAL, pausedRefusal } from '../src/lib/callSession.js';
import { busyXml, closedXml } from '../src/lib/plivoXml.js';

const quiet = { warn: () => {}, info: () => {} };
const withSettings = (rows) => startSettings({ app: 'worker', load: async () => rows, logger: quiet, intervalMs: 1e9 });
const defaultOf = (key) => SETTINGS_BY_KEY[key].default;

const config = { operatingHours: { label: 'Monday to Saturday, 10 a.m. to 7 p.m.' } };

afterEach(() => __resetSettingsRuntime());

// The registry defaults were copied from these files. If the two drift, a fresh
// deploy starts saying something nobody chose.
describe('with nothing saved, the agent says what it always said', () => {
  it('uses wording identical to the registry defaults', () => {
    expect(disclosureText()).toBe(DISCLOSURE);
    expect(DISCLOSURE).toBe(defaultOf('scripts.disclosure'));
    expect(pausedRefusal()).toBe(PAUSED_REFUSAL);
    expect(PAUSED_REFUSAL).toBe(defaultOf('scripts.paused'));
    expect(agentNameFor({})).toBe('Pratibha');

    expect(escalationLine('asked_for_human')).toBe(defaultOf('scripts.escalate_human'));
    expect(escalationLine('hostile_or_distressed')).toBe(defaultOf('scripts.escalate_hostile'));
    expect(escalationLine('line_quality')).toBe(defaultOf('scripts.escalate_line'));
    expect(escalationLine('identity_mismatch')).toBe(defaultOf('scripts.escalate_identity'));
    expect(escalationLine('other')).toBe(defaultOf('scripts.escalate_other'));
  });

  it('answers closed and busy calls with the built-in text in en-IN', () => {
    const closed = closedXml(config);
    expect(closed).toContain('<Speak language="en-IN">');
    expect(closed).toContain(
      "Thanks for calling. Our first round calls are answered Monday to Saturday, 10 a.m. to 7 p.m., India time. " +
        "Please call back during those hours, and we'll be glad to speak with you."
    );
    expect(closed).toContain(defaultOf('scripts.closed').replace('{hours}', config.operatingHours.label));
    expect(busyXml(config)).toContain(`<Speak language="en-IN">${defaultOf('scripts.busy')}</Speak>`);
  });
});

describe('fixed lines follow the admin panel', () => {
  it('speaks a saved escalation line, and falls back to "other" for an unknown category', async () => {
    await withSettings([
      { key: 'scripts.escalate_human', value: 'Sure, a person from the team will email you.' },
      { key: 'scripts.escalate_other', value: 'We will stop here; the team will email you.' },
    ]);
    expect(escalationLine('asked_for_human')).toBe('Sure, a person from the team will email you.');
    expect(escalationLine('something_new')).toBe('We will stop here; the team will email you.');
    // Untouched categories keep their built-in line.
    expect(escalationLine('line_quality')).toBe(defaultOf('scripts.escalate_line'));
  });

  it('never goes silent when a line is emptied in the panel', async () => {
    await withSettings([
      { key: 'scripts.escalate_hostile', value: '' },
      { key: 'scripts.disclosure', value: '   ' },
      { key: 'scripts.busy', value: '' },
    ]);
    expect(escalationLine('hostile_or_distressed')).toBe(defaultOf('scripts.escalate_hostile'));
    expect(disclosureText()).toBe(DISCLOSURE);
    expect(busyXml(config)).toContain('All our lines are busy');
  });

  it('fills {hours} into a saved closed message and escapes it for XML', async () => {
    await withSettings([
      { key: 'scripts.closed', value: 'We are closed. Call {hours} & ask for <Pratibha>. Again: {hours}.' },
      { key: 'scripts.speak_language', value: 'hi-IN' },
    ]);
    const xml = closedXml({ operatingHours: { label: 'daily, $& 9 to 5' } });
    expect(xml).toContain('<Speak language="hi-IN">');
    expect(xml).toContain('We are closed. Call daily, $&amp; 9 to 5 &amp; ask for &lt;Pratibha&gt;. Again: daily, $&amp; 9 to 5.');
  });

  it('speaks a saved busy message', async () => {
    await withSettings([{ key: 'scripts.busy', value: 'Every line is taken. Try again shortly.' }]);
    expect(busyXml(config)).toContain('>Every line is taken. Try again shortly.</Speak>');
  });

  it('uses the saved disclosure, paused refusal and agent name', async () => {
    await withSettings([
      { key: 'scripts.disclosure', value: "Hi, I'm Asha, an AI assistant — not a human. This call may be recorded." },
      { key: 'scripts.paused', value: 'Interviews are on hold today.' },
      { key: 'scripts.agent_name', value: 'Asha' },
    ]);
    expect(makeDisclosure({})).toMatch(/^Hi, I'm Asha, an AI assistant/);
    expect(pausedRefusal()).toBe('Interviews are on hold today.');
    expect(agentNameFor({})).toBe('Asha');
    expect(makeDisclosure({ tenant: { name: 'Acme' } })).toContain('My name is Asha');
    // A job's own interviewer name still wins.
    expect(agentNameFor({ interviewProtocol: { agentName: 'Meera' } })).toBe('Meera');
  });
});

describe('goodbye phrases', () => {
  const defaults = defaultOf('calls.closing_phrases');

  it('with nothing saved, hears every default phrase and the variants it always did', () => {
    for (const phrase of defaults) {
      expect(isClosingRemark(`Okay. ${phrase[0].toUpperCase()}${phrase.slice(1)}!`), phrase).toBe(true);
    }
    for (const line of ["That's all from my side.", 'That’s all for now', 'That is everything from my side', 'Have a great evening', 'Have a good one']) {
      expect(isClosingRemark(line), line).toBe(true);
    }
    expect(isClosingRemark('Could you tell me about your last role?')).toBe(false);
  });

  it('builds a matcher from the default list that hears each phrase in any case, spacing or apostrophe', () => {
    const matcher = closingMatcher(defaults);
    for (const phrase of defaults) expect(matcher.test(phrase.toUpperCase()), phrase).toBe(true);
    expect(matcher.test("That's all from my side")).toBe(true);
    expect(matcher.test('That’s all from my side')).toBe(true);
    expect(matcher.test('That is all for now')).toBe(true);
    expect(matcher.test('Thank   you for\nyour time')).toBe(true);
    expect(matcher.test('Tell me about your time at Infosys')).toBe(false);
  });

  it('treats an admin phrase literally, not as a pattern', () => {
    const matcher = closingMatcher(['bye (for now)', 'c.u']);
    expect(matcher.test('OK, bye (for now)')).toBe(true);
    expect(matcher.test('OK, bye for now')).toBe(false);
    expect(matcher.test('cxu')).toBe(false);
    expect(closingMatcher([])).toBeNull();
  });

  it('applies a saved list in place of the built-in one', async () => {
    await withSettings([{ key: 'calls.closing_phrases', value: ['see you soon', 'phir milenge'] }]);
    expect(isClosingRemark('Great talking to you, see you soon.')).toBe(true);
    expect(isClosingRemark('Phir   milenge!')).toBe(true);
    expect(isClosingRemark('Have a good day!')).toBe(false);
  });

  it('hears no goodbye at all when the list is emptied', async () => {
    await withSettings([{ key: 'calls.closing_phrases', value: [] }]);
    expect(isClosingRemark('Goodbye!')).toBe(false);
  });
});
