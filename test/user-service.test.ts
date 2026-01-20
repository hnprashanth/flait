import { handler } from '../lambda/user-service/index';
import { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

// If aws-sdk-client-mock were available, we'd use it. Since it's not in package.json,
// we will mock the prototype of DynamoDBDocumentClient.send.
// However, adding the library is safer for the future. 
// For now, I will use a manual Jest mock pattern common in this environment.

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

describe('User Service', () => {
  const mockSend = DynamoDBDocumentClient.from({} as any).send as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.APP_TABLE_NAME = 'TestTable';
  });

  test('POST /users creates a user', async () => {
    mockSend.mockResolvedValue({});

    const event = {
      httpMethod: 'POST',
      body: JSON.stringify({ name: 'John Doe', phone: '1234567890' }),
    } as any;

    const result = await handler(event);
    
    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.name).toBe('John Doe');
    expect(body.id).toBeDefined();
    
    // Verify DynamoDB call
    expect(mockSend).toHaveBeenCalledWith(expect.any(PutCommand));
    const putCall = mockSend.mock.calls[0][0];
    expect(putCall.input.Item.PK).toBe('USER#1234567890');
  });

  test('POST /users returns 409 if user already exists', async () => {
    mockSend.mockRejectedValueOnce({ name: 'ConditionalCheckFailedException' });

    const event = {
      httpMethod: 'POST',
      body: JSON.stringify({ name: 'John Doe', phone: '1234567890' }),
    } as any;

    const result = await handler(event);
    
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body).error).toContain('already exists');
  });

  test('GET /users returns a user', async () => {
    mockSend.mockResolvedValue({
      Item: {
        PK: 'USER#1234567890',
        SK: 'PROFILE',
        name: 'John Doe',
        phone: '1234567890'
      }
    });

    const event = {
      httpMethod: 'GET',
      queryStringParameters: { phone: '1234567890' },
    } as any;

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.name).toBe('John Doe');
  });

  test('GET /users returns 404 if not found', async () => {
    mockSend.mockResolvedValue({}); // No Item

    const event = {
      httpMethod: 'GET',
      queryStringParameters: { phone: '999' },
    } as any;

    const result = await handler(event);
    expect(result.statusCode).toBe(404);
  });
});
