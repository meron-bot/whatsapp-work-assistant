import { isWithinActiveHours, isWorkday } from '../src/scheduler/quiet-hours';

// All dates are constructed in UTC; June 2026 Israel is UTC+3 (IDT), so Israel
// local = UTC + 3h. Anchor weekdays: 2026-06-08 is a Monday.
const TZ = 'Asia/Jerusalem';

describe('quiet-hours gate', () => {
  describe('isWithinActiveHours', () => {
    it('is true on a workday inside 08:00–19:00 (Mon 10:00 Israel)', () => {
      expect(isWithinActiveHours(new Date('2026-06-08T07:00:00Z'), TZ)).toBe(true);
    });

    it('is false before 08:00 (Mon 07:30 Israel)', () => {
      expect(isWithinActiveHours(new Date('2026-06-08T04:30:00Z'), TZ)).toBe(false);
    });

    it('is false at/after 19:00 (Mon 19:00 Israel)', () => {
      expect(isWithinActiveHours(new Date('2026-06-08T16:00:00Z'), TZ)).toBe(false);
    });

    it('is false on Friday even inside working hours', () => {
      // 2026-06-12 is a Friday.
      expect(isWithinActiveHours(new Date('2026-06-12T07:00:00Z'), TZ)).toBe(false);
    });

    it('is false on Saturday even inside working hours', () => {
      // 2026-06-13 is a Saturday.
      expect(isWithinActiveHours(new Date('2026-06-13T07:00:00Z'), TZ)).toBe(false);
    });
  });

  describe('isWorkday', () => {
    it('is true Sunday–Thursday', () => {
      expect(isWorkday(new Date('2026-06-07T07:00:00Z'), TZ)).toBe(true); // Sun
      expect(isWorkday(new Date('2026-06-11T07:00:00Z'), TZ)).toBe(true); // Thu
    });

    it('is false Friday/Saturday regardless of hour', () => {
      expect(isWorkday(new Date('2026-06-12T04:00:00Z'), TZ)).toBe(false); // Fri 07:00
      expect(isWorkday(new Date('2026-06-13T20:00:00Z'), TZ)).toBe(false); // Sat 23:00
    });
  });
});
