// Local time helpers for America/Boise (Mountain Time, with DST).

export const TIME_ZONE = 'America/Boise'

const parts = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
})

function wallClock(date) {
  const p = Object.fromEntries(parts.formatToParts(date).map((x) => [x.type, x.value]))
  return { y: +p.year, m: +p.month, d: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second }
}

// Offset of Boise wall-clock time from UTC at `date`, in minutes (e.g. -360).
function offsetMinutes(date) {
  const w = wallClock(date)
  const asUTC = Date.UTC(w.y, w.m - 1, w.d, w.hour, w.minute, w.second)
  return Math.round((asUTC - date.getTime()) / 60000)
}

export function localHours(date) {
  const w = wallClock(date)
  return w.hour + w.minute / 60
}

// Same Boise calendar day as `date`, at `hours` local time.
export function atLocalHours(date, hours) {
  const w = wallClock(date)
  const guess = Date.UTC(w.y, w.m - 1, w.d, 0, 0, 0) + hours * 3600000
  return new Date(guess - offsetMinutes(new Date(guess)) * 60000)
}

const display = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short'
})

export function formatLocal(date) {
  return display.format(date)
}
