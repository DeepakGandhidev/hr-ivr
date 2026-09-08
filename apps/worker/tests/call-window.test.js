import { describe, it, expect } from 'vitest';
import { isWithinCallWindow } from '../src/lib/callSession.js';

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** A time on a known weekday, expressed in Asia/Kolkata. */
function istAt(day, hhmm) {
  // 2026-09-06 is a Sunday, so adding `day` lands on that weekday index.
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 8, 6 + day, h - 5, m - 30));
}

const win = (over = {}) => ({
  timezone: 'Asia/Kolkata',
  days: ALL_DAYS,
  startTime: '09:00',
  endTime: '18:00',
  ...over,
});

describe('no window configured', () => {
  it('allows calls when there are no windows at all', () => {
    expect(isWithinCallWindow([], istAt(3, '03:00'))).toBe(true);
    expect(isWithinCallWindow(null, istAt(3, '03:00'))).toBe(true);
  });
});

describe('an ordinary daytime window', () => {
  const windows = [win()];

  it('accepts a call inside the window', () => {
    expect(isWithinCallWindow(windows, istAt(1, '10:30'))).toBe(true);
  });

  it('accepts the opening minute and rejects the closing one', () => {
    expect(isWithinCallWindow(windows, istAt(1, '09:00'))).toBe(true);
    // Half-open: an 18:00 finish means calls stop at 18:00, not after it.
    expect(isWithinCallWindow(windows, istAt(1, '18:00'))).toBe(false);
  });

  it('rejects a call outside the window', () => {
    expect(isWithinCallWindow(windows, istAt(1, '08:59'))).toBe(false);
    expect(isWithinCallWindow(windows, istAt(1, '23:00'))).toBe(false);
  });

  it('rejects a day that is not selected', () => {
    const weekdaysOnly = [win({ days: [1, 2, 3, 4, 5] })];
    expect(isWithinCallWindow(weekdaysOnly, istAt(0, '10:30'))).toBe(false); // Sunday
    expect(isWithinCallWindow(weekdaysOnly, istAt(1, '10:30'))).toBe(true);  // Monday
  });
});

/**
 * The regression this file exists for. A user setting "24/7" reached for
 * 00:00-23:59, which left the final minute of every day closed — and there was
 * no way to express a genuinely open day at all.
 */
describe('24/7 availability', () => {
  const alwaysOn = [win({ startTime: '00:00', endTime: '00:00' })];

  it.each(['00:00', '03:15', '12:00', '18:45', '23:59'])('accepts a call at %s', (time) => {
    expect(isWithinCallWindow(alwaysOn, istAt(2, time))).toBe(true);
  });

  it('is open on every day of the week', () => {
    for (const day of ALL_DAYS) {
      expect(isWithinCallWindow(alwaysOn, istAt(day, '23:59'))).toBe(true);
    }
  });

  it('still honours the day selection', () => {
    const sundaysOnly = [win({ days: [0], startTime: '00:00', endTime: '00:00' })];
    expect(isWithinCallWindow(sundaysOnly, istAt(0, '23:59'))).toBe(true);
    expect(isWithinCallWindow(sundaysOnly, istAt(1, '12:00'))).toBe(false);
  });
});

/**
 * An end earlier than the start used to match nothing, so a night-shift window
 * left the line apparently dead for the entire shift it was meant to cover.
 */
describe('a window that crosses midnight', () => {
  const nightShift = [win({ startTime: '18:00', endTime: '09:00' })];

  it('accepts the evening side', () => {
    expect(isWithinCallWindow(nightShift, istAt(2, '18:00'))).toBe(true);
    expect(isWithinCallWindow(nightShift, istAt(2, '23:59'))).toBe(true);
  });

  it('accepts the early-morning side', () => {
    expect(isWithinCallWindow(nightShift, istAt(2, '00:30'))).toBe(true);
    expect(isWithinCallWindow(nightShift, istAt(2, '08:59'))).toBe(true);
  });

  it('rejects the middle of the day', () => {
    expect(isWithinCallWindow(nightShift, istAt(2, '12:00'))).toBe(false);
    expect(isWithinCallWindow(nightShift, istAt(2, '09:00'))).toBe(false);
  });
});

describe('multiple windows', () => {
  it('accepts a call matching any one of them', () => {
    const split = [
      win({ startTime: '09:00', endTime: '12:00' }),
      win({ startTime: '15:00', endTime: '18:00' }),
    ];
    expect(isWithinCallWindow(split, istAt(1, '10:00'))).toBe(true);
    expect(isWithinCallWindow(split, istAt(1, '16:00'))).toBe(true);
    expect(isWithinCallWindow(split, istAt(1, '13:00'))).toBe(false);
  });
});
