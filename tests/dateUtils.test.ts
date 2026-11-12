import { describe, it, expect } from 'vitest';
import {
  formatChannelName,
  parseChannelName,
  calculateDiffDays,
  getJSTParts,
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

    it('should parse valid channel names with 1 digit', () => {
      expect(parseChannelName('使い捨て会話_1月5日')).toEqual({ month: 1, day: 5 });
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

    it('should return negative values for future dates', () => {
      expect(calculateDiffDays('使い捨て会話_11月13日', refDate)).toBe(-1);
      expect(calculateDiffDays('使い捨て会話_11月20日', refDate)).toBe(-8);
    });

    it('should return null for invalid channel name', () => {
      expect(calculateDiffDays('random-channel', refDate)).toBeNull();
    });
  });
});
