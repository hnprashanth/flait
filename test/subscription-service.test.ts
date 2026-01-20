import { handler } from '../lambda/subscription-service/index';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

// 1. Mock LambdaClient completely inside the factory
jest.mock('@aws-sdk/client-lambda', () => {
  const sendMock = jest.fn();
  return {
    LambdaClient: jest.fn(() => ({
      send: sendMock,
    })),
    InvokeCommand: jest.fn(),
    // Helper to access the mock from tests
    __mockSend: sendMock, 
  };
});

// 2. Mock DynamoDB
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

describe('Subscription Service', () => {
  const mockDbSend = DynamoDBDocumentClient.from({} as any).send as jest.Mock;
  
  // Retrieve the mocked send function
  // We cast to any because __mockSend is our custom property
  const mockLambdaSend = require('@aws-sdk/client-lambda').__mockSend as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLambdaSend.mockReset(); 
    
    process.env.APP_TABLE_NAME = 'AppTable';
    process.env.FLIGHT_TABLE_NAME = 'FlightTable';
    process.env.FLIGHT_TRACKER_FUNCTION_NAME = 'FlightTracker';
    process.env.SCHEDULE_TRACKER_FUNCTION_NAME = 'ScheduleTracker';
  });

  test('POST /subscriptions subscribes to EXISTING flight', async () => {
    // Mock Flight Exists (Query returns items)
    mockDbSend.mockResolvedValueOnce({ Items: [{ PK: 'FLIGHT#123' }] }); 
    // Mock Put Subscription
    mockDbSend.mockResolvedValueOnce({}); 

    const event = {
      httpMethod: 'POST',
      body: JSON.stringify({ phone: '123', flight_number: 'UA123', date: '2025-01-01' }),
    } as any;

    const result = await handler(event);

    expect(result.statusCode).toBe(201);
    expect(mockLambdaSend).not.toHaveBeenCalled(); // Should NOT invoke provisioning
    expect(mockDbSend).toHaveBeenCalledTimes(2); // 1 Query (Check), 1 Put (Sub)
  });

  test('POST /subscriptions provisions NEW flight', async () => {
    // Mock Flight Missing (Query returns empty)
    mockDbSend.mockResolvedValueOnce({ Items: [] }); 
    
    // Mock Lambda Success
    mockLambdaSend.mockResolvedValue({ 
      StatusCode: 200, 
      Payload: new TextEncoder().encode(JSON.stringify({ message: 'Success' })) 
    });

    // Mock Put Subscription
    mockDbSend.mockResolvedValueOnce({}); 

    const event = {
      httpMethod: 'POST',
      body: JSON.stringify({ phone: '123', flight_number: 'UA123', date: '2025-01-01' }),
    } as any;

    const result = await handler(event);

    expect(result.statusCode).toBe(201);
    expect(mockLambdaSend).toHaveBeenCalledTimes(2); // 1 Tracker, 1 Scheduler
  });

  test('POST /subscriptions FAILS if Flight Tracker fails', async () => {
    // Mock Flight Missing
    mockDbSend.mockResolvedValueOnce({ Items: [] });
    
    // Mock Lambda Failure
    mockLambdaSend.mockRejectedValueOnce(new Error('Flight not found'));

    const event = {
      httpMethod: 'POST',
      body: JSON.stringify({ phone: '123', flight_number: 'INVALID', date: '2025-01-01' }),
    } as any;

    const result = await handler(event);

    expect(result.statusCode).toBe(404); // Caught and mapped to 404
    expect(mockDbSend).toHaveBeenCalledTimes(1); // Only check, NO Put
  });
});
