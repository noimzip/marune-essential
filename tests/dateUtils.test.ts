import { describe, it, expect } from 'vitest';
import {
  formatChannelName,
  parseChannelName,
  calculateDiffDays,
  getJSTParts,
  formatJSTDateSlash,
  calculateElapsedDays,
} from '../src/utils/dateUtils.js';

describe('dateUtils', () => {
  describe('formatChannelName', () => {
    it('should format channel name with 2-digit zero-padding in JST', () => {
      // 2026-11-12 12:00:00 JST is 2026-11-12T03:00:00Z
      const date1 = new Date('2026-11-12T03:00:00Z');
      expect(formatChannelName(date1)).toBe('使い捨て会話_11月12日');

      // 2026-01-05 09:00:00 JST is 2026-01-05T00:00:00Z
      const date2 = new Date('2026-01-05T00:00:00Z');
      expect(formatChannelName(date2)).toBe('使い捨て会話_01月05日');
    });

    it('should correctly handle JST midnight rollover', () => {
      // 2026-11-12 23:59:00 JST -> 2026-11-12T14:59:00Z
      const dateBefore = new Date('2026-11-12T14:59:00Z');
      expect(formatChannelName(dateBefore)).toBe('使い捨て会話_11月12日');

      // 2026-11-13 00:00:00 JST -> 2026-11-12T15:00:00Z
      const dateAfter = new Date('2026-11-12T15:00:00Z');
      expect(formatChannelName(dateAfter)).toBe('使い捨て会話_11月13日');
    });
  });

  describe('parseChannelName', () => {
    it('should parse valid channel names with 2 digits', () => {
      expect(parseChannelName('使い捨て会話_11月12日')).toEqual({ month: 11, day: 12 });
      expect(parseChannelName('使い捨て会話_01月05日')).toEqual({ month: 1, day: 5 });
    });

    it('should parse valid channel names with hyphen instead of underscore', () => {
      expect(parseChannelName('使い捨て会話-11月12日')).toEqual({ month: 11, day: 12 });
      expect(parseChannelName('使い捨て会話-01月05日')).toEqual({ month: 1, day: 5 });
    });

    it('should parse valid channel names with 1 digit', () => {
      expect(parseChannelName('使い捨て会話_1月5日')).toEqual({ month: 1, day: 5 });
      expect(parseChannelName('使い捨て会話-1月5日')).toEqual({ month: 1, day: 5 });
    });

    it('should return null for non-matching or invalid channel names', () => {
      expect(parseChannelName('general')).toBeNull();
      expect(parseChannelName('使い捨て会話_')).toBeNull();
      expect(parseChannelName('使い捨て会話_abc')).toBeNull();
      expect(parseChannelName('使い捨て会話_13月01日')).toBeNull(); // month > 12
      expect(parseChannelName('使い捨て会話_00月01日')).toBeNull(); // month 0
      expect(parseChannelName('使い捨て会話_01月32日')).toBeNull(); // day > 31
    });
  });

  describe('calculateDiffDays', () => {
    // Reference date: 2026-11-12 12:00:00 JST (2026-11-12T03:00:00Z)
    const refDate = new Date('2026-11-12T03:00:00Z');

    it('should return 0 for the same day', () => {
      expect(calculateDiffDays('使い捨て会話_11月12日', refDate)).toBe(0);
    });

    it('should return 1 to 6 for 1 to 6 days ago', () => {
      expect(calculateDiffDays('使い捨て会話_11月11日', refDate)).toBe(1);
      expect(calculateDiffDays('使い捨て会話_11月10日', refDate)).toBe(2);
      expect(calculateDiffDays('使い捨て会話_11月09日', refDate)).toBe(3);
      expect(calculateDiffDays('使い捨て会話_11月08日', refDate)).toBe(4);
      expect(calculateDiffDays('使い捨て会話_11月07日', refDate)).toBe(5);
      expect(calculateDiffDays('使い捨て会話_11月06日', refDate)).toBe(6);
    });

    it('should return 7 for 7 days ago', () => {
      expect(calculateDiffDays('使い捨て会話_11月05日', refDate)).toBe(7);
    });

    it('should return > 7 for channels older than 7 days', () => {
      expect(calculateDiffDays('使い捨て会話_11月01日', refDate)).toBe(11);
    });

    it('should handle month boundaries correctly', () => {
      // Reference: 2026-11-02 00:00:00 JST
      const earlyNov = new Date('2026-11-01T15:00:00Z');
      expect(calculateDiffDays('使い捨て会話_10月31日', earlyNov)).toBe(2);
      expect(calculateDiffDays('使い捨て会話_10月25日', earlyNov)).toBe(8);
    });

    it('should handle year boundary rollover (December to January)', () => {
      // Reference: 2027-01-02 00:00:00 JST (2027-01-01T15:00:00Z)
      const jan2 = new Date('2027-01-01T15:00:00Z');

      expect(calculateDiffDays('使い捨て会話_01月02日', jan2)).toBe(0);
      expect(calculateDiffDays('使い捨て会話_01月01日', jan2)).toBe(1);
      expect(calculateDiffDays('使い捨て会話_12月31日', jan2)).toBe(2); // previous year
      expect(calculateDiffDays('使い捨て会話_12月30日', jan2)).toBe(3);
      expect(calculateDiffDays('使い捨て会話_12月26日', jan2)).toBe(7);
    });

    it('should handle leap years properly', () => {
      // 2024 is a leap year (Feb 29 exists)
      // Reference: 2024-03-01 00:00:00 JST
      const leapRef = new Date('2024-02-29T15:00:00Z');

      expect(calculateDiffDays('使い捨て会話_03月01日', leapRef)).toBe(0);
      expect(calculateDiffDays('使い捨て会話_02月29日', leapRef)).toBe(1);
      expect(calculateDiffDays('使い捨て会話_02月28日', leapRef)).toBe(2);

      // 2025 is NOT a leap year
      // Reference: 2025-03-01 00:00:00 JST
      const nonLeapRef = new Date('2025-02-28T15:00:00Z');
      expect(calculateDiffDays('使い捨て会話_03月01日', nonLeapRef)).toBe(0);
      expect(calculateDiffDays('使い捨て会話_02月28日', nonLeapRef)).toBe(1);
    });

    it('should handle year boundary rollover across multiple months without arbitrary cutoffs', () => {
      // Reference: 2026-03-01 00:00:00 JST
      const march1 = new Date('2026-02-28T15:00:00Z');
      expect(calculateDiffDays('使い捨て会話_12月28日', march1)).toBe(63);

      // Reference: 2026-01-05 00:00:00 JST
      const jan5 = new Date('2026-01-04T15:00:00Z');
      expect(calculateDiffDays('使い捨て会話_10月30日', jan5)).toBe(67);
    });

    it('should accurately resolve channel year when channelCreatedAt is provided', () => {
      // Reference: 2026-11-12 12:00:00 JST
      // Channel named 11月10日, but created 1 year ago (2025-11-10)
      const createdAtOneYearAgo = new Date('2025-11-10T03:00:00Z');
      expect(calculateDiffDays('使い捨て会話_11月10日', refDate, createdAtOneYearAgo)).toBe(367);

      // Channel created on Dec 31, 2025 for Jan 1, 2026
      const createdDec31 = new Date('2025-12-31T15:00:00Z');
      const jan2Ref = new Date('2026-01-02T03:00:00Z');
      expect(calculateDiffDays('使い捨て会話_01月01日', jan2Ref, createdDec31)).toBe(1);
    });

    it('should return negative values for future dates', () => {
      expect(calculateDiffDays('使い捨て会話_11月13日', refDate)).toBe(-1);
      expect(calculateDiffDays('使い捨て会話_11月20日', refDate)).toBe(-8);
    });

    it('should return null for invalid channel name', () => {
      expect(calculateDiffDays('random-channel', refDate)).toBeNull();
    });
  });

  describe('formatJSTDateSlash', () => {
    it('should format date as YYYY/MM/DD in JST', () => {
      // 2026-11-12T15:00:00Z is 2026-11-13 00:00:00 JST
      const jstMidnight = new Date('2026-11-12T15:00:00Z');
      expect(formatJSTDateSlash(jstMidnight)).toBe('2026/11/13');

      const earlyYear = new Date('2026-01-05T03:00:00Z');
      expect(formatJSTDateSlash(earlyYear)).toBe('2026/01/05');
    });
  });

  describe('calculateElapsedDays', () => {
    it('should calculate exact calendar day differences in JST', () => {
      const ref = new Date('2026-11-12T15:00:00Z'); // 2026-11-13 00:00:00 JST

      // Same JST calendar day (2026-11-13 00:05:00 JST)
      expect(calculateElapsedDays(new Date('2026-11-12T15:05:00Z'), ref)).toBe(0);

      // Previous JST calendar day (2026-11-12 23:59:00 JST -> 2026-11-12T14:59:00Z)
      expect(calculateElapsedDays(new Date('2026-11-12T14:59:00Z'), ref)).toBe(1);

      // 21 days ago (2026-10-23 JST)
      expect(calculateElapsedDays(new Date('2026-10-23T12:00:00Z'), ref)).toBe(21);
    });

    it('should handle year and leap-year boundaries', () => {
      const march1NonLeap = new Date('2025-02-28T15:00:00Z'); // 2025-03-01 JST
      const feb8 = new Date('2025-02-08T00:00:00Z'); // 2025-02-08 JST
      expect(calculateElapsedDays(feb8, march1NonLeap)).toBe(21);

      const march1Leap = new Date('2024-02-29T15:00:00Z'); // 2024-03-01 JST
      const feb9Leap = new Date('2024-02-09T00:00:00Z'); // 2024-02-09 JST
      expect(calculateElapsedDays(feb9Leap, march1Leap)).toBe(21);
    });
  });
});
