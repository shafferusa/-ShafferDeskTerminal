// Clock abstraction. Everything in the server asks this module for "now" so
// that tests and the demo (simulated-feed) mode can move time forward.
// In live mode the offset is always zero and this is just the system clock.

const TZ = 'America/New_York'; // the Terminal's business-date timezone

/**
 * @typedef {Object} Clock
 * @property {() => Date} now          current instant
 * @property {() => number} ms         current instant, epoch ms
 * @property {(tz?: string) => string} today   business date 'YYYY-MM-DD' in tz (default New York)
 * @property {(ms: number) => void} advance    move the clock forward (test/demo only)
 * @property {(d: Date|string|number) => void} set   pin the clock to an instant, then keep ticking (test/demo only)
 * @property {(d: Date|string|number) => void} freeze pin the clock and stop it (tests only)
 * @property {boolean} simulated       true once the clock has been moved
 */

/** @returns {Clock} */
export function createClock() {
  let offset = 0;
  let frozen = null;
  return {
    simulated: false,
    now() {
      return new Date(this.ms());
    },
    ms() {
      return frozen !== null ? frozen : Date.now() + offset;
    },
    today(tz = TZ) {
      return dateInTz(this.now(), tz);
    },
    advance(ms) {
      this.simulated = true;
      if (frozen !== null) frozen += ms;
      else offset += ms;
    },
    set(d) {
      this.simulated = true;
      frozen = null;
      offset = new Date(d).getTime() - Date.now();
    },
    freeze(d) {
      this.simulated = true;
      frozen = new Date(d).getTime();
    },
  };
}

const fmtCache = new Map();
function partsFormatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of an instant in a timezone. */
export function partsInTz(date, tz = TZ) {
  const out = {};
  for (const p of partsFormatter(tz).formatToParts(date)) out[p.type] = p.value;
  const hour = Number(out.hour) % 24;
  return {
    date: `${out.year}-${out.month}-${out.day}`,
    year: Number(out.year), month: Number(out.month), day: Number(out.day),
    hour, minute: Number(out.minute), second: Number(out.second),
    minutes: hour * 60 + Number(out.minute),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(out.weekday),
  };
}

/** 'YYYY-MM-DD' of an instant in a timezone. */
export function dateInTz(date, tz = TZ) {
  return partsInTz(date, tz).date;
}

/** The instant at which wall-clock `hh:mm` occurs on `iso` date in `tz`. */
export function instantInTz(iso, hhmm = '00:00', tz = TZ) {
  const [h, m] = hhmm.split(':').map(Number);
  // Start from the UTC guess and correct by the zone offset at that instant (two passes handle DST edges).
  let guess = Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)), h, m);
  for (let i = 0; i < 2; i++) {
    const p = partsInTz(new Date(guess), tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const want = Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)), h, m);
    guess += want - asUtc;
  }
  return new Date(guess);
}

export const BUSINESS_TZ = TZ;
export const clock = createClock();
