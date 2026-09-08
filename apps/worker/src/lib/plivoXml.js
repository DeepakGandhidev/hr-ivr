const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "10 a.m." / "7 p.m." / "1.30 p.m." - spoken, not printed. */
function spokenHour(hour) {
  const suffix = hour < 12 || hour === 24 ? 'a.m.' : 'p.m.';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve} ${suffix}`;
}

/**
 * Describe the operating hours from the hours themselves.
 *
 * These used to be two independent settings - the window the code enforces, and
 * the sentence read to callers. Changing one and forgetting the other tells
 * every out-of-hours caller to ring back at a time the line will not answer,
 * and nothing in the system notices. Deriving the sentence removes the gap;
 * OPERATING_HOURS_LABEL still overrides it when the wording needs to differ.
 */
export function describeHours(hours) {
  const days = [...new Set(hours.days)].sort((a, b) => a - b);
  // A window that covers the whole day has no start or end to read out, and
  // "12 a.m. to 12 a.m." would tell callers the line is never open.
  const allDay = hours.startHour <= 0 && hours.endHour >= 24;
  const window = allDay
    ? 'twenty four hours a day'
    : `${spokenHour(hours.startHour)} to ${spokenHour(hours.endHour)}`;

  if (days.length === 0) return `by appointment only`;
  if (days.length === 1) return `on ${DAY_NAMES[days[0]]}s, ${window}`;

  // Contiguous runs read as a range; anything else gets listed.
  const contiguous = days.every((day, i) => i === 0 || day === days[i - 1] + 1);
  const label = contiguous
    ? `${DAY_NAMES[days[0]]} to ${DAY_NAMES[days[days.length - 1]]}`
    : days.map(d => `${DAY_NAMES[d]}`).join(', ');

  return `${label}, ${window}`;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 4.3 - is the line open right now, in IST regardless of where the server runs.
 * Intl is used rather than a UTC offset because it is the only thing that stays
 * correct if the configured timezone is ever changed to one with DST.
 */
export function isWithinOperatingHours(hours, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: hours.timezone,
    weekday: 'short',
    hour: 'numeric',
    hour12: false
  }).formatToParts(now);

  const weekday = parts.find(p => p.type === 'weekday')?.value;
  const hour = Number(parts.find(p => p.type === 'hour')?.value);
  const dayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);

  if (!hours.days.includes(dayIndex)) return false;
  return hour >= hours.startHour && hour < hours.endHour;
}

/**
 * The answer document. audioTrack is inbound on purpose: Pratibha's own voice
 * must never come back up the stream, or she transcribes herself and the
 * barge-in detector fires on her own audio.
 */
export function streamXml(config, callUUID, from) {
  const url = new URL(config.publicWsUrl);
  if (callUUID) url.searchParams.set('callUUID', callUUID);
  // Plivo's WebSocket `start` payload carries streamId, callId and callUUID —
  // but NOT the caller's number. The answer webhook is the only place it is
  // given to us, so it is passed forward here. Without it every caller reaches
  // the stream anonymous and is treated as unknown, which silently disables
  // caller recognition on every real call.
  if (from) url.searchParams.set('from', from);

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream
    bidirectional="true"
    audioTrack="inbound"
    contentType="audio/x-mulaw;rate=8000"
    keepCallAlive="true"
    statusCallbackUrl="${escapeXml(`${config.publicBaseUrl}/pratibha/stream-status`)}"
    statusCallbackMethod="POST">${escapeXml(url.toString())}</Stream>
</Response>`;
}

/** 4.3 / 10 - outside hours the line answers and says when to call back. */
export function closedXml(config) {
  const message =
    `Thanks for calling. Our first round calls are answered ` +
    `${config.operatingHours.label}, India time. Please call back during those hours, ` +
    `and we'll be glad to speak with you.`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak language="en-IN">${escapeXml(message)}</Speak>
  <Hangup/>
</Response>`;
}

/** 4.4 - every line busy. Say so rather than letting it ring out. */
export function busyXml(_config) {
  const message =
    `Thanks for calling. All our lines are busy at the moment. ` +
    `Please call back in a few minutes.`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak language="en-IN">${escapeXml(message)}</Speak>
  <Hangup/>
</Response>`;
}
