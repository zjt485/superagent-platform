/**
 * Zero-dependency 5-field standard Cron parser and next-occurrence calculator.
 * Format: `minute hour dayOfMonth month dayOfWeek`
 * Supports `*`, `*\/n`, `a`, `a-b`, `a-b/n`, and comma-separated lists.
 * Day of week accepts 0-7 (0 and 7 both mean Sunday).
 */

export interface ParsedCron {
  minutes: Set<number>
  hours: Set<number>
  daysOfMonth: Set<number>
  months: Set<number>
  daysOfWeek: Set<number>
  domWildcard: boolean
  dowWildcard: boolean
}

function parseField(field: string, min: number, max: number, normalizeDow = false): Set<number> {
  const result = new Set<number>()
  const parts = field.split(',')
  for (const rawPart of parts) {
    const part = rawPart.trim()
    if (!part) throw new Error(`empty cron segment in "${field}"`)
    const [rangeSpec, stepSpec] = part.split('/')
    if (!rangeSpec) throw new Error(`invalid cron segment "${part}"`)
    const step = stepSpec !== undefined ? Number(stepSpec) : 1
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`invalid cron step "${stepSpec}" in "${field}"`)
    }

    let start: number
    let end: number
    if (rangeSpec === '*') {
      start = min
      end = max
    } else if (rangeSpec.includes('-')) {
      const [a, b] = rangeSpec.split('-').map(Number)
      if (!Number.isInteger(a) || !Number.isInteger(b) || a! > b!) {
        throw new Error(`invalid cron range "${rangeSpec}"`)
      }
      start = a!
      end = b!
    } else {
      const val = Number(rangeSpec)
      if (!Number.isInteger(val)) throw new Error(`invalid cron value "${rangeSpec}"`)
      start = val
      end = stepSpec !== undefined ? max : val
    }

    const maxAllowed = normalizeDow ? 7 : max
    if (start < min || end > maxAllowed) {
      throw new Error(`cron value out of bounds [${min}-${maxAllowed}] in "${part}"`)
    }
    for (let v = start; v <= end; v += step) {
      result.add(normalizeDow && v === 7 ? 0 : v)
    }
  }
  if (result.size === 0) throw new Error(`cron field "${field}" matched no values`)
  return result
}

export function parseCronExpression(expr: string): ParsedCron {
  const trimmed = expr.trim()
  const fields = trimmed.split(/\s+/)
  if (fields.length !== 5) {
    throw new Error(`Cron 表达式必须包含 5 段（分 时 日 月 周），收到：${expr}`)
  }
  const [minF, hourF, domF, monF, dowF] = fields as [string, string, string, string, string]
  return {
    minutes: parseField(minF, 0, 59),
    hours: parseField(hourF, 0, 23),
    daysOfMonth: parseField(domF, 1, 31),
    months: parseField(monF, 1, 12),
    daysOfWeek: parseField(dowF, 0, 6, true),
    domWildcard: domF === '*',
    dowWildcard: dowF === '*',
  }
}

interface LocalDateParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  dow: number
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

function getDateParts(date: Date, timeZone: string): LocalDateParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hourCycle: 'h23',
  })
  const parts = fmt.formatToParts(date)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const rawHour = Number(get('hour'))
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: rawHour === 24 ? 0 : rawHour,
    minute: Number(get('minute')),
    dow: WEEKDAY_MAP[get('weekday')] ?? 0,
  }
}

function validateTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return timeZone
  } catch {
    return 'UTC'
  }
}

/**
 * Compute the next UTC `Date` strictly after `fromDate` that matches `expr` in
 * `timeZone` (defaults to `Asia/Shanghai`). Searches up to 366 days ahead.
 */
export function nextCronDate(expr: string, fromDate: Date, timeZone = 'Asia/Shanghai'): Date {
  const parsed = parseCronExpression(expr)
  const tz = validateTimeZone(timeZone)
  // Start at the beginning of the next whole minute.
  let cursorMs = (Math.floor(fromDate.getTime() / 60_000) + 1) * 60_000
  const maxMs = cursorMs + 366 * 24 * 60 * 60_000

  while (cursorMs <= maxMs) {
    const candidate = new Date(cursorMs)
    const p = getDateParts(candidate, tz)

    if (!parsed.months.has(p.month)) {
      // Skip ahead 1 day (minus current hour/minute).
      cursorMs += (24 - p.hour) * 3_600_000 - p.minute * 60_000
      continue
    }

    const domMatch = parsed.daysOfMonth.has(p.day)
    const dowMatch = parsed.daysOfWeek.has(p.dow)
    const dayMatches =
      parsed.domWildcard && parsed.dowWildcard
        ? true
        : parsed.domWildcard
          ? dowMatch
          : parsed.dowWildcard
            ? domMatch
            : domMatch || dowMatch

    if (!dayMatches) {
      cursorMs += (24 - p.hour) * 3_600_000 - p.minute * 60_000
      continue
    }

    if (!parsed.hours.has(p.hour)) {
      cursorMs += (60 - p.minute) * 60_000
      continue
    }

    if (parsed.minutes.has(p.minute)) {
      return candidate
    }

    cursorMs += 60_000
  }

  throw new Error(`Cron 表达式 "${expr}" 在未来一年内没有匹配的执行时间`)
}
