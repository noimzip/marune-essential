/**
 * Date and channel name utility functions for disposable channels management.
 * All operations are normalized to JST (Asia/Tokyo, UTC+9).
 */

export interface JSTDateParts {
  year: number;
  month: number;
  day: number;
}

type MonthDay = Pick<JSTDateParts, 'month' | 'day'>;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// Before resolving a year, allow February 29 as a possible channel date.
function isValidMonthDay({ month, day }: MonthDay, year = 2000): boolean {
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day)) {
    return false;
  }
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = month === 2 && leapYear ? 29 : MONTH_LENGTHS[month - 1];
  return day >= 1 && day <= daysInMonth;
}

function getCalendarDay({ year, month, day }: JSTDateParts): number {
  return Date.UTC(year, month - 1, day) / MILLISECONDS_PER_DAY;
}

/**
 * Returns year, month, and day in JST (Asia/Tokyo) for a given Date.
 */
export function getJSTParts(date: Date = new Date()): JSTDateParts {
  const formatter = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const year = parseInt(parts.find((p) => p.type === 'year')!.value, 10);
  const month = parseInt(parts.find((p) => p.type === 'month')!.value, 10);
  const day = parseInt(parts.find((p) => p.type === 'day')!.value, 10);
  return { year, month, day };
}

/**
 * Formats a channel name in standard format: 使い捨て会話_MM月DD日
 * Example: 使い捨て会話_11月12日, 使い捨て会話_01月05日
 */
export function formatChannelName(date: Date = new Date()): string {
  const { month, day } = getJSTParts(date);
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `使い捨て会話_${mm}月${dd}日`;
}

/**
 * Parses channel name to extract month and day.
 * Matches:
 *  - 使い捨て会話_MM月DD日 or 使い捨て会話-MM月DD日 (e.g. 使い捨て会話_11月12日, 使い捨て会話_01月05日)
 *  - 使い捨て会話_M月D日 or 使い捨て会話-M月D日 (e.g. 使い捨て会話_1月5日)
 * Returns null if the name does not match or represents an invalid month/day.
 */
export function parseChannelName(channelName: string): MonthDay | null {
  const match = channelName.match(/^使い捨て会話[_-](\d{1,2})月(\d{1,2})日$/);
  if (!match) {
    return null;
  }

  const parts = { month: Number(match[1]), day: Number(match[2]) };
  return isValidMonthDay(parts) ? parts : null;
}

/**
 * Calculates the elapsed days between the channel's date and the reference date (in JST).
 *
 * Examples:
 *  - Same calendar day: 0
 *  - Yesterday: 1
 *  - 6 days ago: 6
 *  - 7 days ago: 7
 *  - Future dates: negative (e.g. -1)
 *
 * Supports optional channelCreatedAt to resolve the exact year directly from Discord channel metadata.
 * Handles year boundaries (e.g. Reference is Jan 2027, channel is Dec 31).
 * Returns null if the name cannot be parsed or the resulting date does not exist.
 */
export function calculateDiffDays(
  channelInput: string | MonthDay,
  referenceDate: Date = new Date(),
  channelCreatedAt?: Date
): number | null {
  const parsed = typeof channelInput === 'string' ? parseChannelName(channelInput) : channelInput;
  if (!parsed || !isValidMonthDay(parsed)) {
    return null;
  }

  const refParts = getJSTParts(referenceDate);
  const refDay = getCalendarDay(refParts);
  let candidateYear = refParts.year;

  if (channelCreatedAt) {
    const createdParts = getJSTParts(channelCreatedAt);
    if (createdParts.month === 12 && parsed.month === 1) {
      candidateYear = createdParts.year + 1;
    } else if (createdParts.month === 1 && parsed.month === 12) {
      candidateYear = createdParts.year - 1;
    } else {
      candidateYear = createdParts.year;
    }
  } else {
    // Without metadata, use the previous year if February 29 is unavailable or
    // the named date in the reference year is at least 14 days ahead.
    if (
      !isValidMonthDay(parsed, candidateYear) ||
      getCalendarDay({ ...parsed, year: candidateYear }) - refDay >= 14
    ) {
      candidateYear -= 1;
    }
  }

  if (!isValidMonthDay(parsed, candidateYear)) {
    return null;
  }

  return refDay - getCalendarDay({ ...parsed, year: candidateYear });
}

/**
 * Formats a Date into YYYY/MM/DD in JST (Asia/Tokyo).
 */
export function formatJSTDateSlash(date: Date): string {
  const { year, month, day } = getJSTParts(date);
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}/${mm}/${dd}`;
}

/**
 * Calculates elapsed calendar days in JST between targetDate and referenceDate.
 * Same JST calendar day -> 0, yesterday -> 1, 21 days ago -> 21.
 */
export function calculateElapsedDays(
  targetDate: Date,
  referenceDate: Date = new Date()
): number {
  const targetParts = getJSTParts(targetDate);
  const refParts = getJSTParts(referenceDate);

  const targetMid = Date.UTC(targetParts.year, targetParts.month - 1, targetParts.day);
  const refMid = Date.UTC(refParts.year, refParts.month - 1, refParts.day);

  return (refMid - targetMid) / MILLISECONDS_PER_DAY;
}
