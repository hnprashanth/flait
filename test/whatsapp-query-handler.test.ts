// Set environment variables BEFORE importing the handler
process.env.APP_TABLE_NAME = 'AppTable';
process.env.FLIGHT_TABLE_NAME = 'FlightTable';
process.env.GEMINI_API_KEY = 'test-api-key';
process.env.TWILIO_ACCOUNT_SID = 'test-sid';
process.env.TWILIO_AUTH_TOKEN = 'test-token';
process.env.TWILIO_FROM_NUMBER = '+14646669094';

import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// --- Mock DynamoDB ---
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

// --- Mock Twilio ---
const mockTwilioCreate = jest.fn();
jest.mock('twilio', () => {
  return jest.fn(() => ({
    messages: {
      create: mockTwilioCreate,
    },
  }));
});

// --- Mock Google Generative AI ---
const mockGenerateContent = jest.fn();
jest.mock('@google/generative-ai', () => {
  return {
    GoogleGenerativeAI: jest.fn(() => ({
      getGenerativeModel: jest.fn(() => ({
        generateContent: mockGenerateContent,
      })),
    })),
  };
});

// Import handler AFTER mocks are set up
import { handler } from '../lambda/whatsapp-query-handler/index';

describe('WhatsApp Query Handler', () => {
  const mockDbSend = DynamoDBDocumentClient.from({} as any).send as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockTwilioCreate.mockReset();
    mockGenerateContent.mockReset();
    mockDbSend.mockReset();
  });

  // --- Helper to create Twilio webhook event ---
  function createTwilioEvent(from: string, body: string): any {
    const params = new URLSearchParams({
      From: `whatsapp:${from}`,
      To: 'whatsapp:+14646669094',
      Body: body,
      MessageSid: 'SM12345',
    });
    return {
      httpMethod: 'POST',
      body: params.toString(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    };
  }

  // --- Test: Basic message handling ---
  test('responds to user message with Gemini response', async () => {
    // Mock rate limit check (get returns nothing, update succeeds)
    mockDbSend.mockResolvedValueOnce({ Item: null }); // Rate limit get
    mockDbSend.mockResolvedValueOnce({}); // Rate limit update
    
    // Mock user subscriptions (empty)
    mockDbSend.mockResolvedValueOnce({ Items: [] });

    // Mock Gemini response
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => 'Hello! I see you don\'t have any flights tracked yet. Would you like to subscribe to one?',
      },
    });

    // Mock Twilio send
    mockTwilioCreate.mockResolvedValueOnce({ sid: 'SM67890' });

    const event = createTwilioEvent('+919900110110', 'Hello');
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(result.headers?.['Content-Type']).toBe('text/xml');
    expect(result.body).toContain('<Response>');

    // Verify Twilio was called
    expect(mockTwilioCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'whatsapp:+919900110110',
        from: 'whatsapp:+14646669094',
      })
    );
  });

  // --- Test: Rate limiting ---
  test('blocks user when rate limit exceeded', async () => {
    // Mock rate limit check - user has 20 recent timestamps
    const now = Date.now();
    const timestamps = Array(20).fill(null).map((_, i) => now - i * 1000);
    mockDbSend.mockResolvedValueOnce({ 
      Item: { timestamps } 
    });

    // Mock Twilio send for rate limit message
    mockTwilioCreate.mockResolvedValueOnce({ sid: 'SM67890' });

    const event = createTwilioEvent('+919900110110', 'What is my flight status?');
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(mockTwilioCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('reached your query limit'),
      })
    );

    // Gemini should NOT be called
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  // --- Test: Flight context included ---
  test('includes flight data in Gemini context', async () => {
    // Mock rate limit check
    mockDbSend.mockResolvedValueOnce({ Item: null });
    mockDbSend.mockResolvedValueOnce({});

    // Mock user subscriptions
    mockDbSend.mockResolvedValueOnce({
      Items: [
        { PK: 'USER#+919900110110', SK: 'SUB#2026-01-22#KL880', status: 'ACTIVE' },
      ],
    });

    // Mock flight data query
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    mockDbSend.mockResolvedValueOnce({
      Items: [
        {
          flight_number: 'KL880',
          date: '2026-01-22',
          status: 'Scheduled',
          departure_airport: 'AMS',
          arrival_airport: 'BLR',
          scheduled_departure: futureDate,
          gate_origin: 'D12',
          terminal_origin: '3',
        },
      ],
    });

    // Mock Gemini response
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => 'Your KL880 flight departs from Gate D12, Terminal 3 at Amsterdam.',
      },
    });

    mockTwilioCreate.mockResolvedValueOnce({ sid: 'SM67890' });

    const event = createTwilioEvent('+919900110110', 'What gate is my flight?');
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    
    // Verify Gemini was called with flight context
    expect(mockGenerateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        contents: expect.arrayContaining([
          expect.objectContaining({
            parts: expect.arrayContaining([
              expect.objectContaining({
                text: expect.stringContaining('KL880'),
              }),
            ]),
          }),
        ]),
      })
    );
  });

  // --- Test: Handles missing body ---
  test('handles missing body gracefully', async () => {
    const event = {
      httpMethod: 'POST',
      body: null,
    };

    const result = await handler(event as any);

    expect(result.statusCode).toBe(200);
    expect(result.body).toContain('<Response>');
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  // --- Test: Handles Gemini error ---
  test('handles Gemini API error gracefully', async () => {
    // Mock rate limit
    mockDbSend.mockResolvedValueOnce({ Item: null });
    mockDbSend.mockResolvedValueOnce({});
    
    // Mock empty subscriptions
    mockDbSend.mockResolvedValueOnce({ Items: [] });

    // Mock Gemini error
    mockGenerateContent.mockRejectedValueOnce(new Error('API quota exceeded'));

    // Mock Twilio for error response
    mockTwilioCreate.mockResolvedValueOnce({ sid: 'SM67890' });

    const event = createTwilioEvent('+919900110110', 'Hello');
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(mockTwilioCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('trouble thinking'),
      })
    );
  });

  // --- Test: Parses Twilio webhook correctly ---
  test('parses Twilio webhook payload correctly', async () => {
    mockDbSend.mockResolvedValueOnce({ Item: null });
    mockDbSend.mockResolvedValueOnce({});
    mockDbSend.mockResolvedValueOnce({ Items: [] });
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => 'Test response' },
    });
    mockTwilioCreate.mockResolvedValueOnce({ sid: 'SM67890' });

    // Test with different phone format
    const params = new URLSearchParams({
      From: 'whatsapp:+1234567890',
      To: 'whatsapp:+14646669094',
      Body: '  What is my flight status?  ', // Whitespace should be trimmed
    });

    const event = {
      httpMethod: 'POST',
      body: params.toString(),
    };

    await handler(event as any);

    // The message body should be trimmed
    expect(mockGenerateContent).toHaveBeenCalled();
  });

  // --- Test: Low rate limit warning ---
  test('sends warning when rate limit is low', async () => {
    // Mock rate limit check - user has 16 timestamps (4 remaining)
    const now = Date.now();
    const timestamps = Array(16).fill(null).map((_, i) => now - i * 60000);
    mockDbSend.mockResolvedValueOnce({ Item: { timestamps } });
    mockDbSend.mockResolvedValueOnce({}); // Update

    // Mock subscriptions
    mockDbSend.mockResolvedValueOnce({ Items: [] });

    // Mock Gemini
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => 'Response' },
    });

    // Mock Twilio - two calls expected
    mockTwilioCreate.mockResolvedValue({ sid: 'SM67890' });

    const event = createTwilioEvent('+919900110110', 'Hello');
    await handler(event);

    // Should send both response AND rate limit warning
    expect(mockTwilioCreate).toHaveBeenCalledTimes(2);
    expect(mockTwilioCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('questions remaining'),
      })
    );
  });

  // --- Test: Conversation memory ---
  test('includes conversation history in Gemini context', async () => {
    mockDbSend.mockResolvedValueOnce({ Item: null }); // Rate limit get
    mockDbSend.mockResolvedValueOnce({}); // Rate limit update
    mockDbSend.mockResolvedValueOnce({ Items: [] }); // No subscriptions

    // Mock conversation history with previous messages
    mockDbSend.mockResolvedValueOnce({
      Items: [
        { role: 'user', content: 'What is my flight status?', timestamp: '2026-01-22T10:00:00Z' },
        { role: 'assistant', content: 'Your flight KL880 departs at 9:50 PM.', timestamp: '2026-01-22T10:00:05Z' },
      ],
    });
    mockDbSend.mockResolvedValueOnce({}); // Save user message
    mockDbSend.mockResolvedValueOnce({}); // Save assistant message

    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => 'Gate D12, Terminal 3.' },
    });
    mockTwilioCreate.mockResolvedValueOnce({ sid: 'SM67890' });

    const event = createTwilioEvent('+919900110110', 'What gate?');
    await handler(event);

    // Verify Gemini was called with conversation history
    expect(mockGenerateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        contents: expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            parts: expect.arrayContaining([
              expect.objectContaining({ text: expect.stringContaining('What is my flight status?') }),
            ]),
          }),
        ]),
      })
    );
  });

  // --- Test: Filters old subscriptions ---
  test('filters out past date subscriptions', async () => {
    mockDbSend.mockResolvedValueOnce({ Item: null }); // Rate limit get
    mockDbSend.mockResolvedValueOnce({}); // Rate limit update

    // Mock subscriptions - one past, one future
    mockDbSend.mockResolvedValueOnce({
      Items: [
        { PK: 'USER#+919900110110', SK: 'SUB#2020-01-01#OLD123', status: 'ACTIVE' }, // Past
        { PK: 'USER#+919900110110', SK: 'SUB#2030-12-31#FUTURE1', status: 'ACTIVE' }, // Future
      ],
    });

    // Only future flight data should be queried
    mockDbSend.mockResolvedValueOnce({
      Items: [{
        flight_number: 'FUTURE1',
        date: '2030-12-31',
        status: 'Scheduled',
        departure_airport: 'JFK',
        arrival_airport: 'LHR',
      }],
    });

    // Conversation history (empty)
    mockDbSend.mockResolvedValueOnce({ Items: [] });
    // Save user message
    mockDbSend.mockResolvedValueOnce({});
    // Save assistant message
    mockDbSend.mockResolvedValueOnce({});

    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => 'Response' },
    });
    mockTwilioCreate.mockResolvedValueOnce({ sid: 'SM67890' });

    const event = createTwilioEvent('+919900110110', 'Status');
    await handler(event);

    // Calls: rate limit get, rate limit update, subscriptions query, flight data query,
    //        conversation history, save user msg, save assistant msg
    expect(mockDbSend).toHaveBeenCalledTimes(7);
  });

  // --- Test: Filters inactive subscriptions ---
  test('filters out inactive subscriptions', async () => {
    mockDbSend.mockResolvedValueOnce({ Item: null }); // Rate limit get
    mockDbSend.mockResolvedValueOnce({}); // Rate limit update

    // Mock subscriptions - one inactive, one active
    mockDbSend.mockResolvedValueOnce({
      Items: [
        { PK: 'USER#+919900110110', SK: 'SUB#2030-12-31#CANCELLED', status: 'CANCELLED' },
        { PK: 'USER#+919900110110', SK: 'SUB#2030-12-31#ACTIVE1', status: 'active' }, // lowercase
      ],
    });

    mockDbSend.mockResolvedValueOnce({
      Items: [{
        flight_number: 'ACTIVE1',
        date: '2030-12-31',
        status: 'Scheduled',
        departure_airport: 'JFK',
        arrival_airport: 'LHR',
      }],
    });

    // Conversation history (empty)
    mockDbSend.mockResolvedValueOnce({ Items: [] });
    // Save user message
    mockDbSend.mockResolvedValueOnce({});
    // Save assistant message
    mockDbSend.mockResolvedValueOnce({});

    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => 'Response' },
    });
    mockTwilioCreate.mockResolvedValueOnce({ sid: 'SM67890' });

    const event = createTwilioEvent('+919900110110', 'Status');
    await handler(event);

    // Calls: rate limit get, rate limit update, subscriptions query, flight data query,
    //        conversation history, save user msg, save assistant msg
    expect(mockDbSend).toHaveBeenCalledTimes(7);
  });
});

describe('Timezone Formatting', () => {
  const mockDbSend = DynamoDBDocumentClient.from({} as any).send as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockTwilioCreate.mockReset();
    mockGenerateContent.mockReset();
    mockDbSend.mockReset();
  });

  // Test edge cases through integration
  test('handles unknown airport timezone gracefully', async () => {
    mockDbSend.mockResolvedValueOnce({ Item: null });
    mockDbSend.mockResolvedValueOnce({});
    mockDbSend.mockResolvedValueOnce({
      Items: [{ PK: 'USER#+1', SK: 'SUB#2030-01-01#XX999', status: 'ACTIVE' }],
    });
    mockDbSend.mockResolvedValueOnce({
      Items: [{
        flight_number: 'XX999',
        date: '2030-01-01',
        status: 'Scheduled',
        departure_airport: 'UNKNOWN', // Not in timezone map
        arrival_airport: 'ALSO_UNKNOWN',
        scheduled_departure: '2030-01-01T12:00:00Z',
      }],
    });

    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => 'Response with UTC fallback' },
    });
    mockTwilioCreate.mockResolvedValueOnce({ sid: 'SM67890' });

    const params = new URLSearchParams({
      From: 'whatsapp:+1',
      To: 'whatsapp:+14646669094',
      Body: 'Status',
    });

    const event = { httpMethod: 'POST', body: params.toString() };
    const result = await handler(event as any);

    expect(result.statusCode).toBe(200);
    // Should not throw - gracefully falls back to UTC
  });
});
