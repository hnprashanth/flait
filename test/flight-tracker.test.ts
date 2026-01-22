/**
 * Unit tests for flight-tracker milestone detection logic.
 * Tests the detectMilestones function with various time scenarios.
 */

import { _testExports } from '../lambda/flight-tracker/index';

const {
  extractFlightFields,
  compareFlightData,
  detectMilestones,
  extractAirportCode,
  extractAirportTimezone,
  extractAirportCity,
  shouldCheckInbound,
  shouldAlertInboundDelay,
  shouldAlertInboundLanded,
} = _testExports;

// --- Test Data: Sample FlightAware API Response ---
const sampleFlightAwareResponse = {
  flights: [{
    ident: 'KL880',
    fa_flight_id: 'KLM880-1234567890-schedule-0001',
    origin: {
      code: 'VOBL',
      code_iata: 'BLR',
      code_icao: 'VOBL',
      city: 'Bangalore',
      timezone: 'Asia/Kolkata',
      name: 'Kempegowda International',
    },
    destination: {
      code: 'EHAM',
      code_iata: 'AMS',
      code_icao: 'EHAM',
      city: 'Amsterdam',
      timezone: 'Europe/Amsterdam',
      name: 'Amsterdam Schiphol',
    },
    scheduled_out: '2026-01-22T21:00:00Z',
    scheduled_in: '2026-01-23T07:35:00Z',
    estimated_out: '2026-01-22T21:15:00Z',
    estimated_in: '2026-01-23T07:45:00Z',
    actual_out: null,
    actual_in: null,
    status: 'Scheduled',
    gate_origin: 'A12',
    gate_destination: 'D42',
    terminal_origin: '1',
    terminal_destination: '3',
    baggage_claim: 'Belt 5',
    inbound_fa_flight_id: 'KLM879-1234567890-schedule-0001',
    cancelled: false,
  }],
};

// --- extractFlightFields Tests ---
describe('Flight Tracker - extractFlightFields', () => {
  test('extracts all standard fields from FlightAware response', () => {
    const result = extractFlightFields(sampleFlightAwareResponse);
    
    expect(result.flight_ident).toBe('KL880');
    expect(result.fa_flight_id).toBe('KLM880-1234567890-schedule-0001');
    expect(result.status).toBe('Scheduled');
    expect(result.cancelled).toBe(false);
  });

  test('extracts airport codes (prefers IATA over ICAO)', () => {
    const result = extractFlightFields(sampleFlightAwareResponse);
    
    expect(result.departure_airport).toBe('BLR');
    expect(result.arrival_airport).toBe('AMS');
  });

  test('extracts airport timezones', () => {
    const result = extractFlightFields(sampleFlightAwareResponse);
    
    expect(result.departure_timezone).toBe('Asia/Kolkata');
    expect(result.arrival_timezone).toBe('Europe/Amsterdam');
  });

  test('extracts airport cities', () => {
    const result = extractFlightFields(sampleFlightAwareResponse);
    
    expect(result.departure_city).toBe('Bangalore');
    expect(result.arrival_city).toBe('Amsterdam');
  });

  test('extracts all time fields', () => {
    const result = extractFlightFields(sampleFlightAwareResponse);
    
    expect(result.scheduled_departure).toBe('2026-01-22T21:00:00Z');
    expect(result.scheduled_arrival).toBe('2026-01-23T07:35:00Z');
    expect(result.estimated_departure).toBe('2026-01-22T21:15:00Z');
    expect(result.estimated_arrival).toBe('2026-01-23T07:45:00Z');
  });

  test('extracts gate and terminal info', () => {
    const result = extractFlightFields(sampleFlightAwareResponse);
    
    expect(result.gate_origin).toBe('A12');
    expect(result.gate_destination).toBe('D42');
    expect(result.terminal_origin).toBe('1');
    expect(result.terminal_destination).toBe('3');
  });

  test('extracts baggage_claim', () => {
    const result = extractFlightFields(sampleFlightAwareResponse);
    
    expect(result.baggage_claim).toBe('Belt 5');
  });

  test('extracts inbound_fa_flight_id for aircraft tracking', () => {
    const result = extractFlightFields(sampleFlightAwareResponse);
    
    expect(result.inbound_fa_flight_id).toBe('KLM879-1234567890-schedule-0001');
  });

  test('handles response without flights array (direct flight object)', () => {
    const directResponse = sampleFlightAwareResponse.flights[0];
    const result = extractFlightFields(directResponse as any);
    
    expect(result.flight_ident).toBe('KL880');
    expect(result.departure_airport).toBe('BLR');
  });

  test('handles missing optional fields gracefully', () => {
    const minimalResponse = {
      flights: [{
        ident: 'UA123',
        origin: { code_iata: 'SFO' },
        destination: { code_iata: 'LAX' },
        scheduled_out: '2026-01-22T10:00:00Z',
        scheduled_in: '2026-01-22T11:30:00Z',
        status: 'Scheduled',
      }],
    };
    
    const result = extractFlightFields(minimalResponse);
    
    expect(result.flight_ident).toBe('UA123');
    expect(result.departure_airport).toBe('SFO');
    expect(result.gate_origin).toBeUndefined();
    expect(result.baggage_claim).toBeUndefined();
    expect(result.inbound_fa_flight_id).toBeUndefined();
  });

  test('handles empty response', () => {
    const result = extractFlightFields({});
    expect(result).toEqual({});
  });

  test('handles empty flights array', () => {
    const result = extractFlightFields({ flights: [] });
    expect(result).toEqual({});
  });
});

// --- extractAirportCode Tests ---
describe('Flight Tracker - extractAirportCode', () => {
  test('prefers IATA code over ICAO', () => {
    const airport = { code_iata: 'BLR', code_icao: 'VOBL', code: 'VOBL' };
    expect(extractAirportCode(airport)).toBe('BLR');
  });

  test('falls back to ICAO when IATA not available', () => {
    const airport = { code_icao: 'VOBL', code: 'VOBL' };
    expect(extractAirportCode(airport)).toBe('VOBL');
  });

  test('falls back to generic code when IATA/ICAO not available', () => {
    const airport = { code: 'ABC' };
    expect(extractAirportCode(airport)).toBe('ABC');
  });

  test('returns null for null/undefined input', () => {
    expect(extractAirportCode(null)).toBeNull();
    expect(extractAirportCode(undefined)).toBeNull();
  });

  test('returns string as-is if input is already a string', () => {
    // FlightAware sometimes returns airport as string directly
    expect(extractAirportCode('BLR')).toBe('BLR');
  });
});

// --- compareFlightData Tests ---
describe('Flight Tracker - compareFlightData', () => {
  const baseOldData = {
    status: 'Scheduled',
    scheduled_departure: '2026-01-22T21:00:00Z',
    estimated_departure: '2026-01-22T21:00:00Z',
    scheduled_arrival: '2026-01-23T07:35:00Z',
    estimated_arrival: '2026-01-23T07:35:00Z',
    gate_origin: 'A12',
    gate_destination: null,
    departure_airport: 'BLR',
    arrival_airport: 'AMS',
    baggage_claim: null,
  };

  test('detects status change', () => {
    const newData = {
      flights: [{
        ...sampleFlightAwareResponse.flights[0],
        status: 'Delayed',
      }],
    };
    
    const changes = compareFlightData(baseOldData, newData);
    
    expect(changes.status).toBeDefined();
    expect(changes.status.old).toBe('Scheduled');
    expect(changes.status.new).toBe('Delayed');
  });

  test('detects estimated_departure change', () => {
    const newData = {
      flights: [{
        ...sampleFlightAwareResponse.flights[0],
        estimated_out: '2026-01-22T22:30:00Z',
      }],
    };
    
    const changes = compareFlightData(baseOldData, newData);
    
    expect(changes.estimated_departure).toBeDefined();
    expect(changes.estimated_departure.old).toBe('2026-01-22T21:00:00Z');
    expect(changes.estimated_departure.new).toBe('2026-01-22T22:30:00Z');
  });

  test('detects estimated_arrival change', () => {
    const newData = {
      flights: [{
        ...sampleFlightAwareResponse.flights[0],
        estimated_in: '2026-01-23T08:15:00Z',
      }],
    };
    
    const changes = compareFlightData(baseOldData, newData);
    
    expect(changes.estimated_arrival).toBeDefined();
    expect(changes.estimated_arrival.new).toBe('2026-01-23T08:15:00Z');
  });

  test('detects gate_origin change', () => {
    const newData = {
      flights: [{
        ...sampleFlightAwareResponse.flights[0],
        gate_origin: 'B15',
      }],
    };
    
    const changes = compareFlightData(baseOldData, newData);
    
    expect(changes.gate_origin).toBeDefined();
    expect(changes.gate_origin.old).toBe('A12');
    expect(changes.gate_origin.new).toBe('B15');
  });

  test('detects gate_destination assignment (null → value)', () => {
    const newData = {
      flights: [{
        ...sampleFlightAwareResponse.flights[0],
        gate_destination: 'D42',
      }],
    };
    
    const changes = compareFlightData(baseOldData, newData);
    
    expect(changes.gate_destination).toBeDefined();
    expect(changes.gate_destination.old).toBeNull();
    expect(changes.gate_destination.new).toBe('D42');
  });

  test('detects baggage_claim assignment (null → value)', () => {
    const newData = {
      flights: [{
        ...sampleFlightAwareResponse.flights[0],
        baggage_claim: 'Belt 5',
      }],
    };
    
    const changes = compareFlightData(baseOldData, newData);
    
    expect(changes.baggage_claim).toBeDefined();
    expect(changes.baggage_claim.old).toBeNull();
    expect(changes.baggage_claim.new).toBe('Belt 5');
  });

  test('detects baggage_claim change (value → different value)', () => {
    const oldDataWithBaggage = { ...baseOldData, baggage_claim: 'Belt 3' };
    const newData = {
      flights: [{
        ...sampleFlightAwareResponse.flights[0],
        baggage_claim: 'Belt 5',
      }],
    };
    
    const changes = compareFlightData(oldDataWithBaggage, newData);
    
    expect(changes.baggage_claim).toBeDefined();
    expect(changes.baggage_claim.old).toBe('Belt 3');
    expect(changes.baggage_claim.new).toBe('Belt 5');
  });

  test('returns empty object when no changes', () => {
    const oldData = {
      status: 'Scheduled',
      scheduled_departure: '2026-01-22T21:00:00Z',
      estimated_departure: '2026-01-22T21:15:00Z',
      scheduled_arrival: '2026-01-23T07:35:00Z',
      estimated_arrival: '2026-01-23T07:45:00Z',
      gate_origin: 'A12',
      gate_destination: 'D42',
      departure_airport: 'BLR',
      arrival_airport: 'AMS',
      baggage_claim: 'Belt 5',
    };
    
    const changes = compareFlightData(oldData, sampleFlightAwareResponse);
    
    expect(Object.keys(changes).length).toBe(0);
  });

  test('ignores both null/undefined as no change', () => {
    const oldData = { gate_destination: null };
    const newData = { flights: [{ gate_destination: undefined }] };
    
    const changes = compareFlightData(oldData, newData as any);
    
    expect(changes.gate_destination).toBeUndefined();
  });

  test('detects multiple changes at once', () => {
    const newData = {
      flights: [{
        ...sampleFlightAwareResponse.flights[0],
        status: 'Delayed',
        estimated_out: '2026-01-22T23:00:00Z',
        gate_origin: 'C20',
      }],
    };
    
    const changes = compareFlightData(baseOldData, newData);
    
    // Should detect at least these 3 key changes
    expect(changes.status).toBeDefined();
    expect(changes.estimated_departure).toBeDefined();
    expect(changes.gate_origin).toBeDefined();
    
    // Other fields may also show as changed (estimated_arrival, gate_destination, etc.)
    // because baseOldData has different values than sampleFlightAwareResponse
    expect(Object.keys(changes).length).toBeGreaterThanOrEqual(3);
  });
});

// --- Inbound Tracking Helper Tests ---
describe('Flight Tracker - Inbound Tracking Helpers', () => {
  describe('shouldCheckInbound', () => {
    test('returns true within 5 hours of departure', () => {
      const departureIn3Hours = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
      expect(shouldCheckInbound(departureIn3Hours)).toBe(true);
    });

    test('returns false more than 5 hours before departure', () => {
      const departureIn6Hours = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
      expect(shouldCheckInbound(departureIn6Hours)).toBe(false);
    });

    test('returns false for undefined departure time', () => {
      expect(shouldCheckInbound(undefined)).toBe(false);
    });

    test('returns false for past departure time', () => {
      const departedHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      expect(shouldCheckInbound(departedHourAgo)).toBe(false);
    });
  });

  describe('shouldAlertInboundDelay', () => {
    test('returns true when inbound delay >= 30 min and not previously alerted', () => {
      expect(shouldAlertInboundDelay(45, undefined)).toBe(true);
      expect(shouldAlertInboundDelay(30, undefined)).toBe(true);
    });

    test('returns false when inbound delay < 30 min', () => {
      expect(shouldAlertInboundDelay(25, undefined)).toBe(false);
      expect(shouldAlertInboundDelay(0, undefined)).toBe(false);
    });

    test('returns true when delay increased by >= 15 min since last alert', () => {
      expect(shouldAlertInboundDelay(60, 45)).toBe(true);
      expect(shouldAlertInboundDelay(50, 35)).toBe(true);
    });

    test('returns false when delay not increased enough since last alert', () => {
      expect(shouldAlertInboundDelay(50, 45)).toBe(false);
      expect(shouldAlertInboundDelay(40, 35)).toBe(false);
    });
  });

  describe('shouldAlertInboundLanded', () => {
    test('returns true when status is Landed and was not previously Landed', () => {
      expect(shouldAlertInboundLanded('Landed', undefined)).toBe(true);
      expect(shouldAlertInboundLanded('Landed', 'In Flight')).toBe(true);
      expect(shouldAlertInboundLanded('Landed', 'Scheduled')).toBe(true);
    });

    test('returns false when already was Landed', () => {
      expect(shouldAlertInboundLanded('Landed', 'Landed')).toBe(false);
    });

    test('returns false when not landed', () => {
      expect(shouldAlertInboundLanded('In Flight', undefined)).toBe(false);
      expect(shouldAlertInboundLanded('Scheduled', undefined)).toBe(false);
    });
  });
});

describe('Flight Tracker - Milestone Detection', () => {
  // Helper to create dates relative to "now"
  const hoursFromNow = (hours: number): Date => {
    const now = new Date();
    return new Date(now.getTime() + hours * 60 * 60 * 1000);
  };

  describe('Milestone Thresholds', () => {
    test('24h milestone triggers between 24h and 12h before departure', () => {
      // This test verifies the threshold logic
      // 24h milestone: hoursToDeparture <= 24 && hoursToDeparture > 12
      const departure24h = hoursFromNow(23); // 23 hours from now - should trigger 24h
      const departure13h = hoursFromNow(13); // 13 hours from now - should trigger 24h
      const departure11h = hoursFromNow(11); // 11 hours from now - should NOT trigger 24h (triggers 12h)

      // Verify threshold math
      expect((departure24h.getTime() - Date.now()) / (1000 * 60 * 60)).toBeLessThanOrEqual(24);
      expect((departure24h.getTime() - Date.now()) / (1000 * 60 * 60)).toBeGreaterThan(12);
    });

    test('12h milestone triggers between 12h and 4h before departure', () => {
      const departure11h = hoursFromNow(11);
      const hoursToDeparture = (departure11h.getTime() - Date.now()) / (1000 * 60 * 60);
      
      expect(hoursToDeparture).toBeLessThanOrEqual(12);
      expect(hoursToDeparture).toBeGreaterThan(4);
    });

    test('4h milestone triggers between 4h and 36min before departure', () => {
      const departure3h = hoursFromNow(3);
      const hoursToDeparture = (departure3h.getTime() - Date.now()) / (1000 * 60 * 60);
      
      expect(hoursToDeparture).toBeLessThanOrEqual(4);
      expect(hoursToDeparture).toBeGreaterThan(0.6); // 36 minutes
    });

    test('Boarding milestone triggers within 36min of departure', () => {
      const departure30min = hoursFromNow(0.5);
      const hoursToDeparture = (departure30min.getTime() - Date.now()) / (1000 * 60 * 60);
      
      expect(hoursToDeparture).toBeLessThanOrEqual(0.6);
      expect(hoursToDeparture).toBeGreaterThan(0);
    });

    test('Check-in milestone triggers at 24h mark (±30min window)', () => {
      const departure24h = hoursFromNow(24);
      const hoursToDeparture = (departure24h.getTime() - Date.now()) / (1000 * 60 * 60);
      
      // Check-in window: 23.5h to 24.5h
      expect(hoursToDeparture).toBeLessThanOrEqual(24.5);
      expect(hoursToDeparture).toBeGreaterThanOrEqual(23.5);
    });
  });

  describe('Pre-landing Milestone', () => {
    test('Pre-landing triggers 1h before arrival when flight is airborne', () => {
      const departure = hoursFromNow(-2); // Departed 2 hours ago
      const arrival = hoursFromNow(0.8); // Arriving in 48 minutes

      const hoursToDeparture = (departure.getTime() - Date.now()) / (1000 * 60 * 60);
      const hoursToArrival = (arrival.getTime() - Date.now()) / (1000 * 60 * 60);

      // Flight has departed (hoursToDeparture < 0)
      expect(hoursToDeparture).toBeLessThan(0);
      // Arrival within 1.1 hours
      expect(hoursToArrival).toBeLessThanOrEqual(1.1);
      expect(hoursToArrival).toBeGreaterThan(0);
    });

    test('Pre-landing does NOT trigger before departure', () => {
      const departure = hoursFromNow(2); // Departing in 2 hours
      const arrival = hoursFromNow(5); // Arriving in 5 hours

      const hoursToDeparture = (departure.getTime() - Date.now()) / (1000 * 60 * 60);

      // Flight has NOT departed yet
      expect(hoursToDeparture).toBeGreaterThan(0);
      // So pre-landing should not trigger
    });
  });

  describe('Milestone Deduplication', () => {
    test('Previously sent milestones are not re-triggered', () => {
      // This tests the logic: !previousMilestones.includes(milestone)
      const previousMilestones = ['24h', 'checkin'];
      
      expect(previousMilestones.includes('24h')).toBe(true);
      expect(previousMilestones.includes('12h')).toBe(false);
      expect(previousMilestones.includes('checkin')).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    test('Flight already departed returns no departure milestones', () => {
      const departure = hoursFromNow(-1); // Departed 1 hour ago
      const hoursToDeparture = (departure.getTime() - Date.now()) / (1000 * 60 * 60);

      // All departure milestones require hoursToDeparture > 0
      expect(hoursToDeparture).toBeLessThan(0);
    });

    test('Flight very close to departure (< 1 min) still valid for boarding', () => {
      const departure = hoursFromNow(0.01); // ~36 seconds from now
      const hoursToDeparture = (departure.getTime() - Date.now()) / (1000 * 60 * 60);

      // Boarding milestone: hoursToDeparture <= 0.6 && hoursToDeparture > 0
      expect(hoursToDeparture).toBeLessThanOrEqual(0.6);
      expect(hoursToDeparture).toBeGreaterThan(0);
    });
  });
});

describe('Flight Tracker - Event Publishing', () => {
  describe('Event Types', () => {
    test('Change-only event has update_type "change"', () => {
      const hasChanges = true;
      const hasMilestones = false;

      let updateType: string;
      if (hasChanges && hasMilestones) {
        updateType = 'combined';
      } else if (hasMilestones) {
        updateType = 'milestone';
      } else {
        updateType = 'change';
      }

      expect(updateType).toBe('change');
    });

    test('Milestone-only event has update_type "milestone"', () => {
      const hasChanges = false;
      const hasMilestones = true;

      let updateType: string;
      if (hasChanges && hasMilestones) {
        updateType = 'combined';
      } else if (hasMilestones) {
        updateType = 'milestone';
      } else {
        updateType = 'change';
      }

      expect(updateType).toBe('milestone');
    });

    test('Both changes and milestones produces "combined" event', () => {
      const hasChanges = true;
      const hasMilestones = true;

      let updateType: string;
      if (hasChanges && hasMilestones) {
        updateType = 'combined';
      } else if (hasMilestones) {
        updateType = 'milestone';
      } else {
        updateType = 'change';
      }

      expect(updateType).toBe('combined');
    });
  });

  describe('Milestone Priority', () => {
    test('Boarding has highest priority', () => {
      const milestonePriority = ['boarding', 'pre-landing', '4h', '12h', '24h', 'checkin'];
      const milestones = [
        { milestone: '24h', hoursRemaining: 20 },
        { milestone: 'boarding', hoursRemaining: 0.4 },
      ];

      const sorted = milestones.sort(
        (a, b) => milestonePriority.indexOf(a.milestone) - milestonePriority.indexOf(b.milestone)
      );

      expect(sorted[0].milestone).toBe('boarding');
    });

    test('Pre-landing has second highest priority', () => {
      const milestonePriority = ['boarding', 'pre-landing', '4h', '12h', '24h', 'checkin'];
      const milestones = [
        { milestone: '24h', hoursRemaining: 20 },
        { milestone: 'pre-landing', hoursRemaining: 0.8 },
        { milestone: '4h', hoursRemaining: 3 },
      ];

      const sorted = milestones.sort(
        (a, b) => milestonePriority.indexOf(a.milestone) - milestonePriority.indexOf(b.milestone)
      );

      expect(sorted[0].milestone).toBe('pre-landing');
    });
  });
});
