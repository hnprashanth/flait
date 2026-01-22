import { handler, _testExports } from '../lambda/notification-dispatcher/index';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const {
  generateMilestoneMessage,
  generateChangeMessage,
  generateCombinedMessage,
  generateInboundDelayMessage,
  generateInboundLandedMessage,
  formatTime,
  formatDateTime,
  formatTimeDiff,
  formatConnectionInfo,
  calculateConnectionRisk,
  analyzeConnections,
  getMilestoneHeader,
} = _testExports;

// Mock DynamoDB
jest.mock('@aws-sdk/lib-dynamodb', () => {
  const originalModule = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...originalModule,
    DynamoDBDocumentClient: {
      from: jest.fn().mockReturnValue({
        send: jest.fn(),
      }),
    },
  };
});

// Mock Twilio
const mockCreate = jest.fn().mockResolvedValue({ sid: 'SM123' });
jest.mock('twilio', () => {
  const mock = jest.fn().mockImplementation(() => ({
    messages: {
      create: mockCreate,
    },
  }));
  return {
    __esModule: true,
    default: mock,
  };
});

describe('Notification Dispatcher', () => {
  const mockDbSend = DynamoDBDocumentClient.from({} as any).send as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.APP_TABLE_NAME = 'AppTable';
    process.env.FLIGHT_TABLE_NAME = 'FlightTable';
    process.env.TWILIO_ACCOUNT_SID = 'ACxxx';
    process.env.TWILIO_AUTH_TOKEN = 'token';
    process.env.TWILIO_FROM_NUMBER = 'whatsapp:+12345';
  });

  describe('Change Events', () => {
    test('Sends notification for status change', async () => {
      // 1. Mock GSI Query (Subscribers)
      mockDbSend.mockResolvedValueOnce({
        Items: [{ PK: 'USER#+19998887777', GSI1PK: 'FLIGHT#UA123#2025-01-01' }],
      });

      // 2. Mock User Subscriptions
      mockDbSend.mockResolvedValueOnce({
        Items: [{ PK: 'USER#+19998887777', SK: 'SUB#2025-01-01#UA123' }],
      });

      // 3. Mock Flight Data (for the subscribed flight)
      mockDbSend.mockResolvedValueOnce({
        Items: [{
          flight_number: 'UA123',
          date: '2025-01-01',
          status: 'Delayed',
          scheduled_departure: '2025-01-01T10:00:00Z',
        }],
      });

      const event = {
        detail: {
          flight_number: 'UA123',
          date: '2025-01-01',
          update_type: 'change',
          changes: {
            status: { old: 'Scheduled', new: 'Delayed' },
          },
          current_status: {
            status: 'Delayed',
            scheduled_departure: '2025-01-01T10:00:00Z',
          },
        },
      } as any;

      await handler(event);

      expect(mockDbSend).toHaveBeenCalledTimes(3);
      expect(mockCreate).toHaveBeenCalledWith({
        body: expect.stringContaining('*Flight Update: UA123*'),
        from: 'whatsapp:+12345',
        to: 'whatsapp:+19998887777',
      });
      expect(mockCreate).toHaveBeenCalledWith({
        body: expect.stringContaining('Scheduled'),
        from: expect.any(String),
        to: expect.any(String),
      });
    });
  });

  describe('Milestone Events', () => {
    test('Sends 24h milestone notification', async () => {
      mockDbSend.mockResolvedValueOnce({
        Items: [{ PK: 'USER#+19998887777', GSI1PK: 'FLIGHT#UA123#2025-01-01' }],
      });

      mockDbSend.mockResolvedValueOnce({
        Items: [{ PK: 'USER#+19998887777', SK: 'SUB#2025-01-01#UA123' }],
      });

      mockDbSend.mockResolvedValueOnce({
        Items: [{
          flight_number: 'UA123',
          scheduled_departure: '2025-01-02T10:00:00Z',
        }],
      });

      const event = {
        detail: {
          flight_number: 'UA123',
          date: '2025-01-01',
          update_type: 'milestone',
          milestone: '24h',
          current_status: {
            status: 'On Time',
            scheduled_departure: '2025-01-02T10:00:00Z',
            departure_airport: 'SFO',
          },
        },
      } as any;

      await handler(event);

      expect(mockCreate).toHaveBeenCalledWith({
        body: expect.stringContaining('24 Hours to Departure'),
        from: 'whatsapp:+12345',
        to: 'whatsapp:+19998887777',
      });
    });

    test('Sends check-in reminder notification', async () => {
      mockDbSend.mockResolvedValueOnce({
        Items: [{ PK: 'USER#+19998887777', GSI1PK: 'FLIGHT#UA123#2025-01-01' }],
      });

      mockDbSend.mockResolvedValueOnce({
        Items: [{ PK: 'USER#+19998887777', SK: 'SUB#2025-01-01#UA123' }],
      });

      mockDbSend.mockResolvedValueOnce({ Items: [] });

      const event = {
        detail: {
          flight_number: 'UA123',
          date: '2025-01-01',
          update_type: 'milestone',
          milestone: 'checkin',
          current_status: {
            scheduled_departure: '2025-01-02T10:00:00Z',
            gate_origin: 'B12',
          },
        },
      } as any;

      await handler(event);

      expect(mockCreate).toHaveBeenCalledWith({
        body: expect.stringContaining('Check-in Open'),
        from: 'whatsapp:+12345',
        to: 'whatsapp:+19998887777',
      });
    });

    test('Sends boarding soon notification', async () => {
      mockDbSend.mockResolvedValueOnce({
        Items: [{ PK: 'USER#+19998887777', GSI1PK: 'FLIGHT#UA123#2025-01-01' }],
      });

      mockDbSend.mockResolvedValueOnce({
        Items: [{ PK: 'USER#+19998887777', SK: 'SUB#2025-01-01#UA123' }],
      });

      mockDbSend.mockResolvedValueOnce({ Items: [] });

      const event = {
        detail: {
          flight_number: 'UA123',
          date: '2025-01-01',
          update_type: 'milestone',
          milestone: 'boarding',
          current_status: {
            scheduled_departure: '2025-01-01T10:30:00Z',
            gate_origin: 'B12',
            terminal_origin: 'Terminal 2',
          },
        },
      } as any;

      await handler(event);

      expect(mockCreate).toHaveBeenCalledWith({
        body: expect.stringContaining('Boarding Soon'),
        from: 'whatsapp:+12345',
        to: 'whatsapp:+19998887777',
      });
    });

    test('Sends pre-landing notification', async () => {
      mockDbSend.mockResolvedValueOnce({
        Items: [{ PK: 'USER#+19998887777', GSI1PK: 'FLIGHT#UA123#2025-01-01' }],
      });

      mockDbSend.mockResolvedValueOnce({
        Items: [{ PK: 'USER#+19998887777', SK: 'SUB#2025-01-01#UA123' }],
      });

      mockDbSend.mockResolvedValueOnce({ Items: [] });

      const event = {
        detail: {
          flight_number: 'UA123',
          date: '2025-01-01',
          update_type: 'milestone',
          milestone: 'pre-landing',
          current_status: {
            arrival_airport: 'LAX',
            estimated_arrival: '2025-01-01T12:00:00Z',
          },
        },
      } as any;

      await handler(event);

      expect(mockCreate).toHaveBeenCalledWith({
        body: expect.stringContaining('Landing in ~1 Hour'),
        from: 'whatsapp:+12345',
        to: 'whatsapp:+19998887777',
      });
    });
  });

  describe('Combined Events', () => {
    test('Sends combined milestone + change notification', async () => {
      mockDbSend.mockResolvedValueOnce({
        Items: [{ PK: 'USER#+19998887777', GSI1PK: 'FLIGHT#UA123#2025-01-01' }],
      });

      mockDbSend.mockResolvedValueOnce({
        Items: [{ PK: 'USER#+19998887777', SK: 'SUB#2025-01-01#UA123' }],
      });

      mockDbSend.mockResolvedValueOnce({ Items: [] });

      const event = {
        detail: {
          flight_number: 'UA123',
          date: '2025-01-01',
          update_type: 'combined',
          milestone: '4h',
          changes: {
            gate_origin: { old: 'B10', new: 'B12' },
          },
          current_status: {
            status: 'On Time',
            scheduled_departure: '2025-01-01T14:00:00Z',
            gate_origin: 'B12',
          },
        },
      } as any;

      await handler(event);

      expect(mockCreate).toHaveBeenCalledWith({
        body: expect.stringContaining('4 Hours to Departure'),
        from: 'whatsapp:+12345',
        to: 'whatsapp:+19998887777',
      });
      expect(mockCreate).toHaveBeenCalledWith({
        body: expect.stringContaining('Gate: B10 → *B12*'),
        from: expect.any(String),
        to: expect.any(String),
      });
    });
  });

  describe('Connection Analysis', () => {
    test('Includes connection info when user has connecting flights', async () => {
      // Subscriber for UA123
      mockDbSend.mockResolvedValueOnce({
        Items: [{ PK: 'USER#+19998887777', GSI1PK: 'FLIGHT#UA123#2025-01-01' }],
      });

      // User has 2 flight subscriptions
      mockDbSend.mockResolvedValueOnce({
        Items: [
          { PK: 'USER#+19998887777', SK: 'SUB#2025-01-01#UA123' },
          { PK: 'USER#+19998887777', SK: 'SUB#2025-01-01#AA456' },
        ],
      });

      // Flight data for UA123 (arriving at LAX at 14:00)
      mockDbSend.mockResolvedValueOnce({
        Items: [{
          flight_number: 'UA123',
          departure_airport: 'SFO',
          arrival_airport: 'LAX',
          scheduled_departure: '2025-01-01T10:00:00Z',
          estimated_arrival: '2025-01-01T14:00:00Z',
        }],
      });

      // Flight data for AA456 (departing LAX at 15:30 - 90 min connection)
      mockDbSend.mockResolvedValueOnce({
        Items: [{
          flight_number: 'AA456',
          departure_airport: 'LAX',
          arrival_airport: 'JFK',
          scheduled_departure: '2025-01-01T15:30:00Z',
          estimated_departure: '2025-01-01T15:30:00Z',
        }],
      });

      const event = {
        detail: {
          flight_number: 'UA123',
          date: '2025-01-01',
          update_type: 'milestone',
          milestone: '24h',
          current_status: {
            flight_number: 'UA123',
            departure_airport: 'SFO',
            arrival_airport: 'LAX',
            scheduled_departure: '2025-01-01T10:00:00Z',
          },
        },
      } as any;

      await handler(event);

      // Should include connection info in the message
      expect(mockCreate).toHaveBeenCalledWith({
        body: expect.stringContaining('Connection to AA456'),
        from: 'whatsapp:+12345',
        to: 'whatsapp:+19998887777',
      });
    });

    test('Detects tight connection with terminal change', async () => {
      mockDbSend.mockResolvedValueOnce({
        Items: [{ PK: 'USER#+19998887777', GSI1PK: 'FLIGHT#UA123#2025-01-01' }],
      });

      mockDbSend.mockResolvedValueOnce({
        Items: [
          { PK: 'USER#+19998887777', SK: 'SUB#2025-01-01#UA123' },
          { PK: 'USER#+19998887777', SK: 'SUB#2025-01-01#AA456' },
        ],
      });

      // UA123 arrives at LAX at 14:00 at Terminal 1
      mockDbSend.mockResolvedValueOnce({
        Items: [{
          flight_number: 'UA123',
          departure_airport: 'SFO',
          arrival_airport: 'LAX',
          scheduled_departure: '2025-01-01T10:00:00Z',
          estimated_arrival: '2025-01-01T14:00:00Z',
          terminal_destination: 'Terminal 1',
        }],
      });

      // AA456 departs LAX at 14:45 from Terminal 3 (45 min connection with terminal change = tight)
      mockDbSend.mockResolvedValueOnce({
        Items: [{
          flight_number: 'AA456',
          departure_airport: 'LAX',
          arrival_airport: 'JFK',
          scheduled_departure: '2025-01-01T14:45:00Z',
          estimated_departure: '2025-01-01T14:45:00Z',
          terminal_origin: 'Terminal 3',
        }],
      });

      const event = {
        detail: {
          flight_number: 'UA123',
          date: '2025-01-01',
          update_type: 'change',
          changes: {
            estimated_arrival: { old: '2025-01-01T13:30:00Z', new: '2025-01-01T14:00:00Z' },
          },
          current_status: {
            flight_number: 'UA123',
            departure_airport: 'SFO',
            arrival_airport: 'LAX',
            estimated_arrival: '2025-01-01T14:00:00Z',
          },
        },
      } as any;

      await handler(event);

      expect(mockCreate).toHaveBeenCalledWith({
        body: expect.stringContaining('tight'),
        from: 'whatsapp:+12345',
        to: 'whatsapp:+19998887777',
      });
      expect(mockCreate).toHaveBeenCalledWith({
        body: expect.stringContaining('Terminal'),
        from: expect.any(String),
        to: expect.any(String),
      });
    });
  });

  describe('No Subscribers', () => {
    test('Does nothing when no subscribers exist', async () => {
      mockDbSend.mockResolvedValueOnce({ Items: [] });

      const event = {
        detail: {
          flight_number: 'UA123',
          date: '2025-01-01',
          update_type: 'milestone',
          milestone: '24h',
          current_status: {},
        },
      } as any;

      await handler(event);

      expect(mockDbSend).toHaveBeenCalledTimes(1);
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });
});

// --- Unit Tests for Message Formatting Functions ---

describe('formatTime', () => {
  test('formats time with timezone', () => {
    const result = formatTime('2025-01-15T14:30:00Z', 'America/New_York');
    expect(result).toMatch(/09:30\s*AM\s*EST/);
  });

  test('formats time without timezone defaults to UTC', () => {
    const result = formatTime('2025-01-15T14:30:00Z');
    expect(result).toMatch(/02:30\s*PM\s*UTC/);
  });

  test('returns TBD for undefined input', () => {
    expect(formatTime(undefined)).toBe('TBD');
  });

  test('returns TBD for empty string', () => {
    expect(formatTime('')).toBe('TBD');
  });

  test('formats time in Asia/Kolkata timezone', () => {
    const result = formatTime('2025-01-15T14:30:00Z', 'Asia/Kolkata');
    expect(result).toMatch(/08:00\s*PM\s*GMT\+5:30/);
  });

  test('formats time in Europe/Amsterdam timezone', () => {
    const result = formatTime('2025-07-15T14:30:00Z', 'Europe/Amsterdam');
    // Summer time (CEST = UTC+2)
    expect(result).toMatch(/04:30\s*PM\s*GMT\+2/);
  });
});

describe('formatDateTime', () => {
  test('includes weekday in formatted output', () => {
    const result = formatDateTime('2025-01-15T14:30:00Z', 'America/New_York');
    expect(result).toMatch(/Wed/);
    expect(result).toMatch(/09:30\s*AM/);
  });

  test('returns TBD for undefined input', () => {
    expect(formatDateTime(undefined)).toBe('TBD');
  });

  test('handles timezone correctly', () => {
    // Wednesday in UTC, but could be different day depending on timezone
    const result = formatDateTime('2025-01-15T02:30:00Z', 'Asia/Tokyo');
    expect(result).toMatch(/Wed/); // Still Wednesday in Tokyo (11:30 AM)
    expect(result).toMatch(/11:30\s*AM/);
  });
});

describe('formatTimeDiff', () => {
  test('formats positive delay in minutes', () => {
    const result = formatTimeDiff('2025-01-15T10:00:00Z', '2025-01-15T10:45:00Z');
    expect(result).toBe('+45m');
  });

  test('formats negative change (earlier) in minutes', () => {
    const result = formatTimeDiff('2025-01-15T10:45:00Z', '2025-01-15T10:00:00Z');
    expect(result).toBe('-45m');
  });

  test('formats delay with hours and minutes', () => {
    const result = formatTimeDiff('2025-01-15T10:00:00Z', '2025-01-15T11:30:00Z');
    expect(result).toBe('+1h 30m');
  });

  test('formats delay with hours only', () => {
    const result = formatTimeDiff('2025-01-15T10:00:00Z', '2025-01-15T12:00:00Z');
    expect(result).toBe('+2h');
  });

  test('returns no change for same time', () => {
    const result = formatTimeDiff('2025-01-15T10:00:00Z', '2025-01-15T10:00:00Z');
    expect(result).toBe('no change');
  });

  test('handles large delays', () => {
    const result = formatTimeDiff('2025-01-15T10:00:00Z', '2025-01-15T15:45:00Z');
    expect(result).toBe('+5h 45m');
  });
});

describe('getMilestoneHeader', () => {
  test('returns check-in header', () => {
    expect(getMilestoneHeader('KL879', 'checkin')).toBe('*Check-in Open: KL879*');
  });

  test('returns 24h header', () => {
    expect(getMilestoneHeader('KL879', '24h')).toBe('*KL879 - 24 Hours to Departure*');
  });

  test('returns 12h header', () => {
    expect(getMilestoneHeader('KL879', '12h')).toBe('*KL879 - 12 Hours to Go*');
  });

  test('returns 4h header', () => {
    expect(getMilestoneHeader('KL879', '4h')).toBe('*KL879 - 4 Hours to Departure*');
  });

  test('returns boarding header', () => {
    expect(getMilestoneHeader('KL879', 'boarding')).toBe('*KL879 - Boarding Soon*');
  });

  test('returns pre-landing header', () => {
    expect(getMilestoneHeader('KL879', 'pre-landing')).toBe('*KL879 - Landing Soon*');
  });
});

describe('generateMilestoneMessage', () => {
  const baseStatus = {
    flight_number: 'KL879',
    status: 'On Time',
    departure_airport: 'AMS',
    arrival_airport: 'BOM',
    departure_city: 'Amsterdam',
    arrival_city: 'Mumbai',
    departure_timezone: 'Europe/Amsterdam',
    arrival_timezone: 'Asia/Kolkata',
    scheduled_departure: '2025-01-15T10:00:00Z',
    estimated_departure: '2025-01-15T10:00:00Z',
    scheduled_arrival: '2025-01-15T22:00:00Z',
    estimated_arrival: '2025-01-15T22:00:00Z',
    gate_origin: 'D42',
    terminal_origin: 'Terminal 3',
    gate_destination: 'A12',
    terminal_destination: 'Terminal 2',
  };

  test('generates check-in message', () => {
    const message = generateMilestoneMessage('KL879', 'checkin', baseStatus);
    expect(message).toMatchSnapshot();
  });

  test('generates 24h reminder message', () => {
    const message = generateMilestoneMessage('KL879', '24h', baseStatus);
    expect(message).toMatchSnapshot();
  });

  test('generates 12h reminder message', () => {
    const message = generateMilestoneMessage('KL879', '12h', baseStatus);
    expect(message).toMatchSnapshot();
  });

  test('generates 4h reminder message', () => {
    const message = generateMilestoneMessage('KL879', '4h', baseStatus);
    expect(message).toMatchSnapshot();
  });

  test('generates boarding message', () => {
    const message = generateMilestoneMessage('KL879', 'boarding', baseStatus);
    expect(message).toMatchSnapshot();
  });

  test('generates pre-landing message', () => {
    const message = generateMilestoneMessage('KL879', 'pre-landing', baseStatus);
    expect(message).toMatchSnapshot();
  });

  test('generates pre-landing message with baggage claim', () => {
    const statusWithBaggage = { ...baseStatus, baggage_claim: 'Belt 5' };
    const message = generateMilestoneMessage('KL879', 'pre-landing', statusWithBaggage);
    expect(message).toMatchSnapshot();
    expect(message).toContain('Baggage claim: Belt 5');
  });

  test('generates message with connection info', () => {
    const connection = {
      fromFlight: 'KL879',
      toFlight: 'AI101',
      connectionMinutes: 90,
      layoverAirport: 'BOM',
      terminalChange: false,
      riskLevel: 'safe' as const,
      riskMessage: '90 min - comfortable',
    };
    const message = generateMilestoneMessage('KL879', 'pre-landing', baseStatus, connection);
    expect(message).toMatchSnapshot();
    expect(message).toContain('Connection to AI101');
  });
});

describe('generateChangeMessage', () => {
  const baseStatus = {
    flight_number: 'KL879',
    status: 'Delayed',
    departure_airport: 'AMS',
    arrival_airport: 'BOM',
    departure_city: 'Amsterdam',
    arrival_city: 'Mumbai',
    departure_timezone: 'Europe/Amsterdam',
    arrival_timezone: 'Asia/Kolkata',
    scheduled_departure: '2025-01-15T10:00:00Z',
    estimated_departure: '2025-01-15T10:45:00Z',
    scheduled_arrival: '2025-01-15T22:00:00Z',
    estimated_arrival: '2025-01-15T22:45:00Z',
    gate_origin: 'D42',
  };

  test('generates status change message', () => {
    const changes = {
      status: { old: 'On Time', new: 'Delayed' },
    };
    const message = generateChangeMessage('KL879', changes, baseStatus);
    expect(message).toMatchSnapshot();
  });

  test('generates departure time change message', () => {
    const changes = {
      estimated_departure: { old: '2025-01-15T10:00:00Z', new: '2025-01-15T10:45:00Z' },
    };
    const message = generateChangeMessage('KL879', changes, baseStatus);
    expect(message).toMatchSnapshot();
    expect(message).toContain('+45m');
  });

  test('generates arrival time change message', () => {
    const changes = {
      estimated_arrival: { old: '2025-01-15T22:00:00Z', new: '2025-01-15T22:45:00Z' },
    };
    const message = generateChangeMessage('KL879', changes, baseStatus);
    expect(message).toMatchSnapshot();
  });

  test('generates gate change message', () => {
    const changes = {
      gate_origin: { old: 'D40', new: 'D42' },
    };
    const message = generateChangeMessage('KL879', changes, baseStatus);
    expect(message).toMatchSnapshot();
    expect(message).toContain('Gate changed: D40 → *D42*');
  });

  test('generates gate change message from TBD', () => {
    const changes = {
      gate_origin: { old: null, new: 'D42' },
    };
    const message = generateChangeMessage('KL879', changes, baseStatus);
    expect(message).toContain('Gate changed: TBD → *D42*');
  });

  test('generates arrival gate assignment message', () => {
    const changes = {
      gate_destination: { old: null, new: 'A12' },
    };
    const message = generateChangeMessage('KL879', changes, baseStatus);
    expect(message).toMatchSnapshot();
    expect(message).toContain('Arrival gate: *A12*');
  });

  test('generates baggage claim assignment message', () => {
    const changes = {
      baggage_claim: { old: null, new: 'Belt 5' },
    };
    const statusWithTerminal = { ...baseStatus, terminal_destination: 'Terminal 2', gate_destination: 'A12' };
    const message = generateChangeMessage('KL879', changes, statusWithTerminal);
    expect(message).toMatchSnapshot();
    expect(message).toContain('Baggage claim: *Belt 5*');
    expect(message).toContain('Terminal: Terminal 2');
  });

  test('generates baggage claim change message', () => {
    const changes = {
      baggage_claim: { old: 'Belt 3', new: 'Belt 5' },
    };
    const message = generateChangeMessage('KL879', changes, baseStatus);
    expect(message).toMatchSnapshot();
    expect(message).toContain('Baggage claim changed: Belt 3 → *Belt 5*');
  });

  test('generates multiple changes message', () => {
    const changes = {
      status: { old: 'On Time', new: 'Delayed' },
      estimated_departure: { old: '2025-01-15T10:00:00Z', new: '2025-01-15T11:30:00Z' },
      gate_origin: { old: 'D40', new: 'D42' },
    };
    const message = generateChangeMessage('KL879', changes, baseStatus);
    expect(message).toMatchSnapshot();
  });

  test('generates fallback message when no specific changes', () => {
    const changes = {};
    const message = generateChangeMessage('KL879', changes, baseStatus);
    expect(message).toMatchSnapshot();
    expect(message).toContain('Your flight details:');
  });
});

describe('generateCombinedMessage', () => {
  const baseStatus = {
    flight_number: 'KL879',
    status: 'On Time',
    departure_timezone: 'Europe/Amsterdam',
    arrival_timezone: 'Asia/Kolkata',
    scheduled_departure: '2025-01-15T10:00:00Z',
    estimated_departure: '2025-01-15T10:00:00Z',
    gate_origin: 'D42',
  };

  test('generates 4h milestone with gate change', () => {
    const changes = {
      gate_origin: { old: 'D40', new: 'D42' },
    };
    const message = generateCombinedMessage('KL879', '4h', changes, baseStatus);
    expect(message).toMatchSnapshot();
  });

  test('generates 24h milestone with delay', () => {
    const changes = {
      estimated_departure: { old: '2025-01-15T10:00:00Z', new: '2025-01-15T11:00:00Z' },
    };
    const delayedStatus = { ...baseStatus, estimated_departure: '2025-01-15T11:00:00Z' };
    const message = generateCombinedMessage('KL879', '24h', changes, delayedStatus);
    expect(message).toMatchSnapshot();
  });

  test('generates boarding milestone with status change', () => {
    const changes = {
      status: { old: 'On Time', new: 'Boarding' },
    };
    const message = generateCombinedMessage('KL879', 'boarding', changes, baseStatus);
    expect(message).toMatchSnapshot();
  });
});

describe('generateInboundDelayMessage', () => {
  const baseStatus = {
    departure_airport: 'AMS',
    departure_timezone: 'Europe/Amsterdam',
    scheduled_departure: '2025-01-15T14:00:00Z',
    estimated_departure: '2025-01-15T14:00:00Z',
  };

  test('generates inbound delay message with minutes', () => {
    const inboundInfo = {
      flight_number: 'KL878',
      origin: 'BOM',
      origin_city: 'Mumbai',
      status: 'En Route - Delayed',
      scheduled_arrival: '2025-01-15T12:00:00Z',
      estimated_arrival: '2025-01-15T12:45:00Z',
      delay_minutes: 45,
    };
    const message = generateInboundDelayMessage('KL879', inboundInfo, baseStatus);
    expect(message).toMatchSnapshot();
    expect(message).toContain('45 minutes late');
  });

  test('generates inbound delay message with hours', () => {
    const inboundInfo = {
      flight_number: 'KL878',
      origin: 'BOM',
      origin_city: 'Mumbai',
      status: 'En Route - Delayed',
      scheduled_arrival: '2025-01-15T12:00:00Z',
      estimated_arrival: '2025-01-15T14:30:00Z',
      delay_minutes: 150,
    };
    const message = generateInboundDelayMessage('KL879', inboundInfo, baseStatus);
    expect(message).toMatchSnapshot();
    expect(message).toContain('2h 30m');
  });
});

describe('generateInboundLandedMessage', () => {
  const baseStatus = {
    departure_airport: 'AMS',
    departure_timezone: 'Europe/Amsterdam',
    scheduled_departure: '2025-01-15T14:00:00Z',
    estimated_departure: '2025-01-15T14:00:00Z',
  };

  test('generates inbound landed message', () => {
    const inboundInfo = {
      flight_number: 'KL878',
      origin: 'BOM',
      origin_city: 'Mumbai',
      status: 'Landed',
      actual_arrival: '2025-01-15T12:15:00Z',
      delay_minutes: 0,
    };
    const message = generateInboundLandedMessage('KL879', inboundInfo, baseStatus);
    expect(message).toMatchSnapshot();
    expect(message).toContain('Good news');
    expect(message).toContain('has landed');
  });
});

describe('calculateConnectionRisk', () => {
  test('returns critical for under 30 minutes', () => {
    const arriving = {
      flight_number: 'KL879',
      arrival_airport: 'BOM',
      estimated_arrival: '2025-01-15T14:00:00Z',
    };
    const departing = {
      flight_number: 'AI101',
      departure_airport: 'BOM',
      estimated_departure: '2025-01-15T14:25:00Z',
    };
    const result = calculateConnectionRisk(arriving, departing);
    expect(result.riskLevel).toBe('critical');
    expect(result.connectionMinutes).toBe(25);
    expect(result.riskMessage).toContain('extremely tight');
  });

  test('returns tight for 45 minutes with terminal change', () => {
    const arriving = {
      flight_number: 'KL879',
      arrival_airport: 'BOM',
      estimated_arrival: '2025-01-15T14:00:00Z',
      terminal_destination: 'Terminal 1',
    };
    const departing = {
      flight_number: 'AI101',
      departure_airport: 'BOM',
      estimated_departure: '2025-01-15T14:45:00Z',
      terminal_origin: 'Terminal 2',
    };
    const result = calculateConnectionRisk(arriving, departing);
    expect(result.riskLevel).toBe('tight');
    expect(result.terminalChange).toBe(true);
  });

  test('returns moderate for 45 minutes without terminal change', () => {
    const arriving = {
      flight_number: 'KL879',
      arrival_airport: 'BOM',
      estimated_arrival: '2025-01-15T14:00:00Z',
    };
    const departing = {
      flight_number: 'AI101',
      departure_airport: 'BOM',
      estimated_departure: '2025-01-15T14:45:00Z',
    };
    const result = calculateConnectionRisk(arriving, departing);
    expect(result.riskLevel).toBe('moderate');
    expect(result.connectionMinutes).toBe(45);
  });

  test('returns moderate for 75 minutes with terminal change', () => {
    const arriving = {
      flight_number: 'KL879',
      arrival_airport: 'BOM',
      estimated_arrival: '2025-01-15T14:00:00Z',
      terminal_destination: 'Terminal 1',
    };
    const departing = {
      flight_number: 'AI101',
      departure_airport: 'BOM',
      estimated_departure: '2025-01-15T15:15:00Z',
      terminal_origin: 'Terminal 2',
    };
    const result = calculateConnectionRisk(arriving, departing);
    expect(result.riskLevel).toBe('moderate');
    expect(result.riskMessage).toContain('allow extra time');
  });

  test('returns safe for 2 hours', () => {
    const arriving = {
      flight_number: 'KL879',
      arrival_airport: 'BOM',
      estimated_arrival: '2025-01-15T14:00:00Z',
    };
    const departing = {
      flight_number: 'AI101',
      departure_airport: 'BOM',
      estimated_departure: '2025-01-15T16:00:00Z',
    };
    const result = calculateConnectionRisk(arriving, departing);
    expect(result.riskLevel).toBe('safe');
    expect(result.connectionMinutes).toBe(120);
    expect(result.riskMessage).toContain('comfortable');
  });
});

describe('analyzeConnections', () => {
  test('returns empty array for single flight', () => {
    const flights = [{
      flight_number: 'KL879',
      departure_airport: 'AMS',
      arrival_airport: 'BOM',
      scheduled_departure: '2025-01-15T10:00:00Z',
    }];
    expect(analyzeConnections(flights)).toEqual([]);
  });

  test('returns empty array for no connections', () => {
    const flights = [
      {
        flight_number: 'KL879',
        departure_airport: 'AMS',
        arrival_airport: 'BOM',
        scheduled_departure: '2025-01-15T10:00:00Z',
        estimated_arrival: '2025-01-15T22:00:00Z',
      },
      {
        flight_number: 'UA123',
        departure_airport: 'SFO', // Different airport
        arrival_airport: 'LAX',
        scheduled_departure: '2025-01-15T23:00:00Z',
        estimated_departure: '2025-01-15T23:00:00Z',
      },
    ];
    expect(analyzeConnections(flights)).toEqual([]);
  });

  test('detects connecting flights', () => {
    const flights = [
      {
        flight_number: 'KL879',
        departure_airport: 'AMS',
        arrival_airport: 'BOM',
        scheduled_departure: '2025-01-15T10:00:00Z',
        estimated_departure: '2025-01-15T10:00:00Z',
        estimated_arrival: '2025-01-15T22:00:00Z',
      },
      {
        flight_number: 'AI101',
        departure_airport: 'BOM', // Same as arrival
        arrival_airport: 'DEL',
        scheduled_departure: '2025-01-16T00:00:00Z',
        estimated_departure: '2025-01-16T00:00:00Z',
      },
    ];
    const connections = analyzeConnections(flights);
    expect(connections).toHaveLength(1);
    expect(connections[0].fromFlight).toBe('KL879');
    expect(connections[0].toFlight).toBe('AI101');
    expect(connections[0].layoverAirport).toBe('BOM');
    expect(connections[0].connectionMinutes).toBe(120);
  });

  test('ignores connections over 24 hours apart', () => {
    const flights = [
      {
        flight_number: 'KL879',
        departure_airport: 'AMS',
        arrival_airport: 'BOM',
        scheduled_departure: '2025-01-15T10:00:00Z',
        estimated_departure: '2025-01-15T10:00:00Z',
        estimated_arrival: '2025-01-15T22:00:00Z',
      },
      {
        flight_number: 'AI101',
        departure_airport: 'BOM',
        arrival_airport: 'DEL',
        scheduled_departure: '2025-01-17T10:00:00Z', // 36 hours later
        estimated_departure: '2025-01-17T10:00:00Z',
      },
    ];
    expect(analyzeConnections(flights)).toEqual([]);
  });

  test('handles multiple connections in sequence', () => {
    const flights = [
      {
        flight_number: 'KL879',
        departure_airport: 'AMS',
        arrival_airport: 'BOM',
        scheduled_departure: '2025-01-15T10:00:00Z',
        estimated_departure: '2025-01-15T10:00:00Z',
        estimated_arrival: '2025-01-15T22:00:00Z',
      },
      {
        flight_number: 'AI101',
        departure_airport: 'BOM',
        arrival_airport: 'DEL',
        scheduled_departure: '2025-01-16T00:00:00Z',
        estimated_departure: '2025-01-16T00:00:00Z',
        estimated_arrival: '2025-01-16T02:00:00Z',
      },
      {
        flight_number: 'AI201',
        departure_airport: 'DEL',
        arrival_airport: 'CCU',
        scheduled_departure: '2025-01-16T04:00:00Z',
        estimated_departure: '2025-01-16T04:00:00Z',
      },
    ];
    const connections = analyzeConnections(flights);
    expect(connections).toHaveLength(2);
    expect(connections[0].fromFlight).toBe('KL879');
    expect(connections[0].toFlight).toBe('AI101');
    expect(connections[1].fromFlight).toBe('AI101');
    expect(connections[1].toFlight).toBe('AI201');
  });
});

describe('formatConnectionInfo', () => {
  test('formats safe connection', () => {
    const connection = {
      fromFlight: 'KL879',
      toFlight: 'AI101',
      connectionMinutes: 120,
      layoverAirport: 'BOM',
      terminalChange: false,
      riskLevel: 'safe' as const,
      riskMessage: '120 min - comfortable',
    };
    const result = formatConnectionInfo(connection);
    expect(result).toContain('Connection to AI101');
    expect(result).toContain('2h 0m');
    expect(result).toContain('comfortable');
  });

  test('formats connection with terminal change', () => {
    const connection = {
      fromFlight: 'KL879',
      toFlight: 'AI101',
      connectionMinutes: 75,
      layoverAirport: 'BOM',
      terminalChange: true,
      fromTerminal: 'T1',
      toTerminal: 'T2',
      riskLevel: 'moderate' as const,
      riskMessage: '75 min with terminal change',
    };
    const result = formatConnectionInfo(connection);
    expect(result).toContain('Terminal change: T1 ➔ T2');
  });

  test('includes next gate for pre-landing milestone', () => {
    const connection = {
      fromFlight: 'KL879',
      toFlight: 'AI101',
      connectionMinutes: 90,
      layoverAirport: 'BOM',
      terminalChange: false,
      toGate: 'A15',
      riskLevel: 'safe' as const,
      riskMessage: '90 min - comfortable',
    };
    const result = formatConnectionInfo(connection, 'pre-landing');
    expect(result).toContain('Next gate: A15');
  });

  test('formats short connection time in minutes only', () => {
    const connection = {
      fromFlight: 'KL879',
      toFlight: 'AI101',
      connectionMinutes: 45,
      layoverAirport: 'BOM',
      terminalChange: false,
      riskLevel: 'moderate' as const,
      riskMessage: '45 min - manageable',
    };
    const result = formatConnectionInfo(connection);
    expect(result).toContain('45m');
    expect(result).not.toContain('0h');
  });
});
