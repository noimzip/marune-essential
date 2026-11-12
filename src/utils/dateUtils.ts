/**
 * Date and channel name utility functions for disposable channels management.
 * All operations are normalized to JST (Asia/Tokyo, UTC+9).
 */

export interface JSTDateParts {
  year: number;
  month: number;
  day: number;
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
 *  - 使い捨て会話_MM月DD日 (e.g. 使い捨て会話_11月12日, 使い捨て会話_01月05日)
 *  - 使い捨て会話_M月D日 (e.g. 使い捨て会話_1月5日)
 * Returns null if the name does not match or represents an invalid month/day.
 */
export function parseChannelName(channelName: string): { month: number; day: number } | null {
  const match = channelName.match(/^使い捨て会話_(\d{1,2})月(\d{1,2})日$/);
  if (!match) {
    return null;
  }

  const month = parseInt(match[1], 10);
  const day = parseInt(match[2], 10);

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  return { month, day };
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
 * Handles year boundaries (e.g. Reference is Jan 2027, channel is Dec 31).
 * Returns null if channel name cannot be parsed.
 */
export function calculateDiffDays(
  channelInput: string | { month: number; day: number },
  referenceDate: Date = new Date()
): number | null {
  let parsed: { month: number; day: number } | null;
  if (typeof channelInput === 'string') {
    parsed = parseChannelName(channelInput);
  } else {
    parsed = channelInput;
  }

  if (!parsed) {
    return null;
  }

  const { month, day } = parsed;
  const refParts = getJSTParts(referenceDate);

  // Check candidate year in reference year
  let candidateYear = refParts.year;

  // Handle year-boundary rollover (e.g. today is January/February, channel was created in November/December of previous year)
  if (refParts.month <= 2 && month >= 11) {
    candidateYear = refParts.year - 1;
  }

  // Handle leap year check: if Feb 29 in a non-leap candidate year, it might be from a leap year
  const isLeapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  if (month === 2 && day === 29 && !isLeapYear(candidateYear) && isLeapYear(candidateYear - 1)) {
    candidateYear -= 1;
  }

  const refMid = Date.UTC(refParts.year, refParts.month - 1, refParts.day);
  const candMid = Date.UTC(candidateYear, month - 1, day);

  const diffMs = refMid - candMid;
  return Math.round(diffMs / (24 * 60 * 60 * 1000));
}
