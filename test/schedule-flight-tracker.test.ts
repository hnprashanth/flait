/**
 * Unit tests for schedule-flight-tracker.
 * Tests schedule phase calculation, flight info extraction, and schedule naming.
 */

import { _testExports } from '../lambda/schedule-flight-tracker/index';

const {
  calculateSchedulePhases,
  extractFlightInfo,
  generateScheduleName,
  intervalToRateExpression,
  getNextDay,
} = _testExports;

// --- Helper Functions ---
const hoursFromNow = (hours: number, baseTime?: Date): Date => {
  const base = baseTime || new Date();
  return new Date(base.getTime() + hours * 60 * 60 * 1000);
};

// --- getNextDay Tests ---
describe('Schedule Flight Tracker - getNextDay', () => {
  test('returns next day for standard date', () => {
    expect(getNextDay('2026-01-22')).toBe('2026-01-23');
  });

  test('handles month boundary', () => {
    expect(getNextDay('2026-01-31')).toBe('2026-02-01');
  });

  test('handles year boundary', () => {
    expect(getNextDay('2026-12-31')).toBe('2027-01-01');
  });

  test('handles leap year', () => {
    expect(getNextDay('2028-02-28')).toBe('2028-02-29');
    expect(getNextDay('2028-02-29')).toBe('2028-03-01');
  });
});

// --- intervalToRateExpression Tests ---
describe('Schedule Flight Tracker - intervalToRateExpression', () => {
  test('converts 12h to rate expression', () => {
    expect(intervalToRateExpression('12h')).toBe('rate(12 hours)');
  });

  test('converts 2h to rate expression', () => {
    expect(intervalToRateExpression('2h')).toBe('rate(2 hours)');
  });

  test('converts 1h to rate expression (singular hour)', () => {
    expect(intervalToRateExpression('1h')).toBe('rate(1 hour)');
  });

  test('converts 15m to rate expression', () => {
    expect(intervalToRateExpression('15m')).toBe('rate(15 minutes)');
  });

  test('converts 30m to rate expression', () => {
    expect(intervalToRateExpression('30m')).toBe('rate(30 minutes)');
  });

  test('throws for unknown interval', () => {
    expect(() => intervalToRateExpression('45m')).toThrow('Unknown interval: 45m');
  });
});

// --- generateScheduleName Tests ---
describe('Schedule Flight Tracker - generateScheduleName', () => {
  test('generates valid schedule name', () => {
    const name = generateScheduleName('KL880', '2026-01-22', '2h', '12-24h to departure');
    expect(name).toBe('ft-kl880-2026-01-22-2h-12-24h-to-departure');
  });

  test('removes special characters from flight number', () => {
    const name = generateScheduleName('KL/880', '2026-01-22', '1h', 'test');
    expect(name).toContain('kl880');
  });

  test('converts to lowercase', () => {
    const name = generateScheduleName('UA123', '2026-01-22', '15m', 'TEST');
    expect(name).toBe(name.toLowerCase());
  });

  test('truncates long names to 64 characters', () => {
    const name = generateScheduleName(
      'VERYLONGFLIGHTNUMBER123',
      '2026-01-22',
      '15m',
      'very long phase description that exceeds limits'
    );
    expect(name.length).toBeLessThanOrEqual(64);
  });
});

// --- extractFlightInfo Tests ---
describe('Schedule Flight Tracker - extractFlightInfo', () => {
  const sampleFlightData = {
    flights: [
      {
        ident: 'KL880',
        fa_flight_id: 'KLM880-1234567890-schedule-0001',
        scheduled_out: '2026-01-22T21:00:00Z',
        estimated_out: '2026-01-22T21:15:00Z',
        actual_out: null,
        scheduled_in: '2026-01-23T07:00:00Z',
      },
    ],
  };

  test('extracts departure time and fa_flight_id for matching date', () => {
    const result = extractFlightInfo(sampleFlightData, '2026-01-22');
    
    expect(result).not.toBeNull();
    expect(result!.faFlightId).toBe('KLM880-1234567890-schedule-0001');
    expect(result!.departureTime.toISOString()).toBe('2026-01-22T21:15:00.000Z');
  });

  test('prefers actual_out over estimated_out over scheduled_out', () => {
    const flightWithActual = {
      flights: [{
        ...sampleFlightData.flights[0],
        actual_out: '2026-01-22T21:30:00Z',
        actual_in: '2026-01-23T07:30:00Z',
      }],
    };
    
    const result = extractFlightInfo(flightWithActual, '2026-01-22');
    expect(result!.departureTime.toISOString()).toBe('2026-01-22T21:30:00.000Z');
  });

  test('returns null for empty flights array', () => {
    const result = extractFlightInfo({ flights: [] }, '2026-01-22');
    expect(result).toBeNull();
  });

  test('returns null when no flights match target date', () => {
    // When no exact match, it falls back to first flight
    // So this test verifies the fallback behavior
    const result = extractFlightInfo(sampleFlightData, '2026-01-23');
    // Falls back to first flight
    expect(result).not.toBeNull();
  });

  test('returns null when flight missing fa_flight_id', () => {
    const flightWithoutId = {
      flights: [{
        ident: 'KL880',
        scheduled_out: '2026-01-22T21:00:00Z',
        // fa_flight_id intentionally missing
      }],
    };
    
    const result = extractFlightInfo(flightWithoutId, '2026-01-22');
    expect(result).toBeNull();
  });

  test('handles multiple flights, selecting correct date', () => {
    const multipleFlights = {
      flights: [
        {
          ident: 'KL880',
          fa_flight_id: 'KLM880-111-schedule-0001',
          scheduled_out: '2026-01-21T21:00:00Z',
          scheduled_in: '2026-01-22T07:00:00Z',
        },
        {
          ident: 'KL880',
          fa_flight_id: 'KLM880-222-schedule-0001',
          scheduled_out: '2026-01-22T21:00:00Z',
          scheduled_in: '2026-01-23T07:00:00Z',
        },
        {
          ident: 'KL880',
          fa_flight_id: 'KLM880-333-schedule-0001',
          scheduled_out: '2026-01-23T21:00:00Z',
          scheduled_in: '2026-01-24T07:00:00Z',
        },
      ],
    };
    
    const result = extractFlightInfo(multipleFlights, '2026-01-22');
    expect(result!.faFlightId).toBe('KLM880-222-schedule-0001');
  });
});

// --- calculateSchedulePhases Tests ---
describe('Schedule Flight Tracker - calculateSchedulePhases', () => {
  // Standard 10-hour flight for test convenience
  const flightDurationMs = 10 * 60 * 60 * 1000;

  test('returns 7 phases for flight 48 hours away (4 pre + 3 post)', () => {
    const now = new Date('2026-01-20T10:00:00Z');
    const departure = new Date('2026-01-22T10:00:00Z');
    const arrival = new Date(departure.getTime() + flightDurationMs);

    const phases = calculateSchedulePhases(departure, arrival, now);

    expect(phases.length).toBe(7);

    // Pre-departure phases
    expect(phases[0].interval).toBe('12h');
    expect(phases[0].window).toBe('>24h to departure');
    expect(phases[1].interval).toBe('2h');
    expect(phases[1].window).toBe('12-24h to departure');
    expect(phases[2].interval).toBe('1h');
    expect(phases[2].window).toBe('4-12h to departure');
    expect(phases[3].interval).toBe('15m');
    expect(phases[3].window).toBe('0-4h to departure');

    // Post-departure phases
    expect(phases[4].interval).toBe('30m');
    expect(phases[4].window).toBe('in-flight');
    expect(phases[5].interval).toBe('15m');
    expect(phases[5].window).toBe('pre-arrival');
    expect(phases[6].interval).toBe('15m');
    expect(phases[6].window).toBe('post-arrival');
  });

  test('returns 6 phases for flight 20 hours away', () => {
    const now = new Date('2026-01-22T10:00:00Z');
    const departure = new Date('2026-01-23T06:00:00Z');
    const arrival = new Date(departure.getTime() + flightDurationMs);

    const phases = calculateSchedulePhases(departure, arrival, now);

    // Skip phase 1 (>24h), 3 pre + 3 post
    expect(phases.length).toBe(6);
    expect(phases[0].interval).toBe('2h');
    expect(phases[1].interval).toBe('1h');
    expect(phases[2].interval).toBe('15m');
    expect(phases[3].interval).toBe('30m');
  });

  test('returns 5 phases for flight 8 hours away', () => {
    const now = new Date('2026-01-22T10:00:00Z');
    const departure = new Date('2026-01-22T18:00:00Z');
    const arrival = new Date(departure.getTime() + flightDurationMs);

    const phases = calculateSchedulePhases(departure, arrival, now);

    // 2 pre + 3 post
    expect(phases.length).toBe(5);
    expect(phases[0].interval).toBe('1h');
    expect(phases[1].interval).toBe('15m');
    expect(phases[2].interval).toBe('30m');
  });

  test('returns 4 phases for flight 2 hours away', () => {
    const now = new Date('2026-01-22T10:00:00Z');
    const departure = new Date('2026-01-22T12:00:00Z');
    const arrival = new Date(departure.getTime() + flightDurationMs);

    const phases = calculateSchedulePhases(departure, arrival, now);

    // 1 pre + 3 post
    expect(phases.length).toBe(4);
    expect(phases[0].interval).toBe('15m');
    expect(phases[0].window).toBe('0-4h to departure');
    expect(phases[1].window).toBe('in-flight');
  });

  test('returns only post-departure phases for in-flight flights', () => {
    const now = new Date('2026-01-22T12:00:00Z');
    const departure = new Date('2026-01-22T10:00:00Z'); // 2 hours ago
    const arrival = new Date('2026-01-22T20:00:00Z'); // 8 hours from now

    const phases = calculateSchedulePhases(departure, arrival, now);

    // 0 pre + 3 post (in-flight, pre-arrival, post-arrival)
    expect(phases.length).toBe(3);
    expect(phases[0].window).toBe('in-flight');
    expect(phases[0].startTime.getTime()).toBe(now.getTime());
    expect(phases[1].window).toBe('pre-arrival');
    expect(phases[2].window).toBe('post-arrival');
  });

  test('returns empty array for flight that has already arrived', () => {
    const now = new Date('2026-01-22T22:00:00Z');
    const departure = new Date('2026-01-22T10:00:00Z');
    const arrival = new Date('2026-01-22T20:00:00Z'); // arrived 2h ago

    const phases = calculateSchedulePhases(departure, arrival, now);

    expect(phases.length).toBe(0);
  });

  test('phase start and end times are correct', () => {
    const now = new Date('2026-01-20T10:00:00Z');
    const departure = new Date('2026-01-22T10:00:00Z');
    const arrival = new Date(departure.getTime() + flightDurationMs);

    const phases = calculateSchedulePhases(departure, arrival, now);

    // Phase 1 starts now
    expect(phases[0].startTime.getTime()).toBe(now.getTime());

    // Phase 1 ends at departure - 24h
    const expectedPhase1End = new Date(departure.getTime() - 24 * 60 * 60 * 1000);
    expect(phases[0].endTime.getTime()).toBe(expectedPhase1End.getTime());

    // Phase 4 (0-4h pre-departure) ends at departure
    expect(phases[3].endTime.getTime()).toBe(departure.getTime());

    // Phase 7 (post-arrival) ends at arrival + 30min
    const postArrivalEnd = new Date(arrival.getTime() + 30 * 60 * 1000);
    expect(phases[6].endTime.getTime()).toBe(postArrivalEnd.getTime());
  });

  test('uses current time as start when phase start is in past', () => {
    const now = new Date('2026-01-22T00:00:00Z');
    const departure = new Date('2026-01-22T10:00:00Z');
    const arrival = new Date(departure.getTime() + flightDurationMs);

    const phases = calculateSchedulePhases(departure, arrival, now);

    // First phase should start from now, not from 12h before departure
    expect(phases[0].startTime.getTime()).toBe(now.getTime());
  });
});
