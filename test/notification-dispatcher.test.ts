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
    process.env.TWILIO_ACCOUNT_SID = 'ACxxx';
    process.env.TWILIO_AUTH_TOKEN = 'token';
    process.env.TWILIO_FROM_NUMBER = 'whatsapp:+12345';
  });

  test('Processes FlightStatusChanged and sends WhatsApp message', async () => {
    // 1. Mock GSI Query (Subscribers)
    mockDbSend.mockResolvedValueOnce({ 
      Items: [{ PK: 'USER#+19998887777', GSI1PK: 'FLIGHT#UA123#2025-01-01' }] 
    });

    // 2. Mock User Context
    mockDbSend.mockResolvedValueOnce({ 
      Items: [{ PK: 'USER#+19998887777', SK: 'SUB#2025-01-01#UA123' }] 
    });

    const event = {
      detail: {
        flight_number: 'UA123',
        date: '2025-01-01',
        changes: {
          status: { old: 'Scheduled', new: 'Delayed' }
        },
        current_status: {}
      }
    } as any;

    await handler(event);

    expect(mockDbSend).toHaveBeenCalledTimes(2);
    expect(mockCreate).toHaveBeenCalledWith({
      body: expect.stringContaining('*Flight Update: UA123*'),
      from: 'whatsapp:+12345',
      to: 'whatsapp:+19998887777',
    });
  });
});