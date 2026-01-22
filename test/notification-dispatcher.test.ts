import { handler } from '../lambda/notification-dispatcher/index';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

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
