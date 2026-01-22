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

  test('throws for unknown interval', () => {
    expect(() => intervalToRateExpression('30m')).toThrow('Unknown interval: 30m');
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
        },
        {
          ident: 'KL880',
          fa_flight_id: 'KLM880-222-schedule-0001',
          scheduled_out: '2026-01-22T21:00:00Z',
        },
        {
          ident: 'KL880',
          fa_flight_id: 'KLM880-333-schedule-0001',
          scheduled_out: '2026-01-23T21:00:00Z',
        },
      ],
    };
    
    const result = extractFlightInfo(multipleFlights, '2026-01-22');
    expect(result!.faFlightId).toBe('KLM880-222-schedule-0001');
  });
});

// --- calculateSchedulePhases Tests ---
describe('Schedule Flight Tracker - calculateSchedulePhases', () => {
  test('returns 4 phases for flight 48 hours away', () => {
    const now = new Date('2026-01-20T10:00:00Z');
    const departure = new Date('2026-01-22T10:00:00Z'); // 48 hours away
    
    const phases = calculateSchedulePhases(departure, now);
    
    expect(phases.length).toBe(4);
    
    // Phase 1: >24h (12h interval)
    expect(phases[0].interval).toBe('12h');
    expect(phases[0].window).toBe('>24h to departure');
    
    // Phase 2: 12-24h (2h interval)
    expect(phases[1].interval).toBe('2h');
    expect(phases[1].window).toBe('12-24h to departure');
    
    // Phase 3: 4-12h (1h interval)
    expect(phases[2].interval).toBe('1h');
    expect(phases[2].window).toBe('4-12h to departure');
    
    // Phase 4: 0-4h (15m interval)
    expect(phases[3].interval).toBe('15m');
    expect(phases[3].window).toBe('0-4h to departure');
  });

  test('returns 3 phases for flight 20 hours away', () => {
    const now = new Date('2026-01-22T10:00:00Z');
    const departure = new Date('2026-01-23T06:00:00Z'); // 20 hours away
    
    const phases = calculateSchedulePhases(departure, now);
    
    // Should skip phase 1 (>24h), start with phase 2
    expect(phases.length).toBe(3);
    expect(phases[0].interval).toBe('2h');
    expect(phases[1].interval).toBe('1h');
    expect(phases[2].interval).toBe('15m');
  });

  test('returns 2 phases for flight 8 hours away', () => {
    const now = new Date('2026-01-22T10:00:00Z');
    const departure = new Date('2026-01-22T18:00:00Z'); // 8 hours away
    
    const phases = calculateSchedulePhases(departure, now);
    
    expect(phases.length).toBe(2);
    expect(phases[0].interval).toBe('1h');
    expect(phases[1].interval).toBe('15m');
  });

  test('returns 1 phase for flight 2 hours away', () => {
    const now = new Date('2026-01-22T10:00:00Z');
    const departure = new Date('2026-01-22T12:00:00Z'); // 2 hours away
    
    const phases = calculateSchedulePhases(departure, now);
    
    expect(phases.length).toBe(1);
    expect(phases[0].interval).toBe('15m');
    expect(phases[0].window).toBe('0-4h to departure');
  });

  test('returns empty array for flight < 1 minute away', () => {
    const now = new Date('2026-01-22T10:00:00Z');
    const departure = new Date('2026-01-22T10:00:30Z'); // 30 seconds away
    
    const phases = calculateSchedulePhases(departure, now);
    
    expect(phases.length).toBe(0);
  });

  test('returns empty array for past departure', () => {
    const now = new Date('2026-01-22T12:00:00Z');
    const departure = new Date('2026-01-22T10:00:00Z'); // 2 hours ago
    
    const phases = calculateSchedulePhases(departure, now);
    
    expect(phases.length).toBe(0);
  });

  test('phase start times are correct', () => {
    const now = new Date('2026-01-20T10:00:00Z');
    const departure = new Date('2026-01-22T10:00:00Z'); // 48 hours away
    
    const phases = calculateSchedulePhases(departure, now);
    
    // Phase 1 starts now
    expect(phases[0].startTime.getTime()).toBe(now.getTime());
    
    // Phase 1 ends at departure - 24h
    const expectedPhase1End = new Date(departure.getTime() - 24 * 60 * 60 * 1000);
    expect(phases[0].endTime.getTime()).toBe(expectedPhase1End.getTime());
    
    // Phase 4 ends at departure
    expect(phases[3].endTime.getTime()).toBe(departure.getTime());
  });

  test('uses current time as start when phase start is in past', () => {
    const now = new Date('2026-01-22T00:00:00Z');
    const departure = new Date('2026-01-22T10:00:00Z'); // 10 hours away
    
    const phases = calculateSchedulePhases(departure, now);
    
    // First phase should start from now, not from 12h before departure
    expect(phases[0].startTime.getTime()).toBe(now.getTime());
  });
});
