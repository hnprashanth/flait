import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GoogleGenerativeAI } from '@google/generative-ai';
import twilio from 'twilio';

// --- Clients ---
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
let twilioClient: ReturnType<typeof twilio> | null = null;
let genAI: GoogleGenerativeAI | null = null;

// --- Environment Variables ---
const APP_TABLE_NAME = process.env.APP_TABLE_NAME!;
const FLIGHT_TABLE_NAME = process.env.FLIGHT_TABLE_NAME!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID!;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN!;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER!;

// --- Constants ---
const RATE_LIMIT_MAX_QUERIES = 20;
const RATE_LIMIT_WINDOW_HOURS = 1;
const GEMINI_MODEL = 'gemini-2.0-flash';

// --- Interfaces ---
interface TwilioWebhookPayload {
  From: string;
  To: string;
  Body: string;
  MessageSid?: string;
}

interface FlightContext {
  flight_number: string;
  date: string;
  status: string;
  departure_airport: string;
  arrival_airport: string;
  scheduled_departure?: string;
  estimated_departure?: string;
  actual_departure?: string;
  scheduled_arrival?: string;
  estimated_arrival?: string;
  actual_arrival?: string;
  gate_origin?: string;
  gate_destination?: string;
  terminal_origin?: string;
  terminal_destination?: string;
  baggage_claim?: string;
  aircraft_type?: string;
}

interface Subscription {
  flight_number: string;
  date: string;
  fa_flight_id?: string;
}

// --- System Prompt ---
const SYSTEM_PROMPT = `You are Flait, a friendly and helpful flight assistant on WhatsApp. You help travelers with their flights and travel questions.

CURRENT USER'S FLIGHTS:
{flight_context}

GUIDELINES:
- Be concise but friendly - this is WhatsApp, keep messages short (under 300 words)
- Use emojis sparingly but appropriately (e.g. for flights, for time, for warnings)
- For flight questions, ALWAYS use the provided flight data above - don't make up information
- For general travel questions (weather, visa, transport, airport tips), provide helpful general info
- If you don't have specific flight data for what they're asking, say so politely
- Format times clearly with timezone when available
- If asked about connections, assess if they'll make it based on layover time:
  - < 1 hour: Tight, may miss it
  - 1-2 hours: Should be okay but hurry
  - > 2 hours: Comfortable layover
- If the user has no flights tracked, encourage them to subscribe to a flight first
- Be proactive - if you notice something concerning (tight connection, delay), mention it
- Keep responses conversational, not robotic

RESPONSE FORMAT:
- Use line breaks for readability
- Don't use markdown headers or bullet points extensively
- Keep it chat-friendly`;

/**
 * Parses Twilio webhook payload from x-www-form-urlencoded body
 */
function parseTwilioWebhook(body: string): TwilioWebhookPayload {
  const params = new URLSearchParams(body);
  return {
    From: params.get('From') || '',
    To: params.get('To') || '',
    Body: params.get('Body') || '',
    MessageSid: params.get('MessageSid') || undefined,
  };
}

/**
 * Extracts phone number from Twilio format (whatsapp:+1234567890 -> +1234567890)
 */
function extractPhoneNumber(twilioNumber: string): string {
  return twilioNumber.replace('whatsapp:', '');
}

/**
 * Checks and updates rate limit for a user
 * Returns true if within limit, false if exceeded
 */
async function checkRateLimit(phone: string): Promise<{ allowed: boolean; remaining: number }> {
  const now = Date.now();
  const windowStart = now - (RATE_LIMIT_WINDOW_HOURS * 60 * 60 * 1000);
  const rateLimitKey = `RATELIMIT#${phone}`;

  try {
    // Get current rate limit record
    const result = await docClient.send(new GetCommand({
      TableName: APP_TABLE_NAME,
      Key: { PK: rateLimitKey, SK: 'QUERIES' },
    }));

    let queryCount = 0;
    let timestamps: number[] = [];

    if (result.Item) {
      // Filter out timestamps outside the window
      timestamps = (result.Item.timestamps || []).filter((ts: number) => ts > windowStart);
      queryCount = timestamps.length;
    }

    if (queryCount >= RATE_LIMIT_MAX_QUERIES) {
      return { allowed: false, remaining: 0 };
    }

    // Add current timestamp and update
    timestamps.push(now);
    await docClient.send(new UpdateCommand({
      TableName: APP_TABLE_NAME,
      Key: { PK: rateLimitKey, SK: 'QUERIES' },
      UpdateExpression: 'SET timestamps = :timestamps, updatedAt = :now, #ttl = :ttl',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':timestamps': timestamps,
        ':now': new Date().toISOString(),
        ':ttl': Math.floor((now + 2 * 60 * 60 * 1000) / 1000), // TTL: 2 hours from now
      },
    }));

    return { allowed: true, remaining: RATE_LIMIT_MAX_QUERIES - timestamps.length };
  } catch (error) {
    console.error('Rate limit check error:', error);
    // On error, allow the request but log it
    return { allowed: true, remaining: RATE_LIMIT_MAX_QUERIES };
  }
}

/**
 * Gets user's active subscriptions
 */
async function getUserSubscriptions(phone: string): Promise<Subscription[]> {
  const userPK = `USER#${phone}`;

  try {
    const result = await docClient.send(new QueryCommand({
      TableName: APP_TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': userPK,
        ':sk': 'SUB#',
      },
    }));

    if (!result.Items || result.Items.length === 0) {
      return [];
    }

    // Filter to only active subscriptions (future flights or today)
    const today = new Date().toISOString().split('T')[0];
    return result.Items
      .filter(item => item.date >= today && item.status === 'active')
      .map(item => ({
        flight_number: item.flight_number,
        date: item.date,
        fa_flight_id: item.fa_flight_id,
      }));
  } catch (error) {
    console.error('Error fetching subscriptions:', error);
    return [];
  }
}

/**
 * Gets latest flight data for a subscription
 */
async function getFlightData(flightNumber: string, date: string): Promise<FlightContext | null> {
  const pk = `${flightNumber}#${date}`;

  try {
    const result = await docClient.send(new QueryCommand({
      TableName: FLIGHT_TABLE_NAME,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': pk },
      ScanIndexForward: false, // Latest first
      Limit: 1,
    }));

    if (!result.Items || result.Items.length === 0) {
      return null;
    }

    const item = result.Items[0];
    return {
      flight_number: item.flight_number || flightNumber,
      date: item.date || date,
      status: item.status || 'Unknown',
      departure_airport: item.departure_airport || 'Unknown',
      arrival_airport: item.arrival_airport || 'Unknown',
      scheduled_departure: item.scheduled_departure,
      estimated_departure: item.estimated_departure,
      actual_departure: item.actual_departure,
      scheduled_arrival: item.scheduled_arrival,
      estimated_arrival: item.estimated_arrival,
      actual_arrival: item.actual_arrival,
      gate_origin: item.gate_origin,
      gate_destination: item.gate_destination,
      terminal_origin: item.terminal_origin,
      terminal_destination: item.terminal_destination,
      baggage_claim: item.baggage_claim,
      aircraft_type: item.aircraft_type,
    };
  } catch (error) {
    console.error(`Error fetching flight data for ${flightNumber} on ${date}:`, error);
    return null;
  }
}

/**
 * Formats flight context for the system prompt
 */
function formatFlightContext(flights: FlightContext[]): string {
  if (flights.length === 0) {
    return 'No flights currently being tracked. The user needs to subscribe to a flight first.';
  }

  return flights.map((f, index) => {
    const lines = [
      `Flight ${index + 1}: ${f.flight_number} on ${f.date}`,
      `  Route: ${f.departure_airport} -> ${f.arrival_airport}`,
      `  Status: ${f.status}`,
    ];

    if (f.scheduled_departure) {
      lines.push(`  Scheduled Departure: ${f.scheduled_departure}`);
    }
    if (f.estimated_departure && f.estimated_departure !== f.scheduled_departure) {
      lines.push(`  Estimated Departure: ${f.estimated_departure}`);
    }
    if (f.actual_departure) {
      lines.push(`  Actual Departure: ${f.actual_departure}`);
    }
    if (f.scheduled_arrival) {
      lines.push(`  Scheduled Arrival: ${f.scheduled_arrival}`);
    }
    if (f.estimated_arrival && f.estimated_arrival !== f.scheduled_arrival) {
      lines.push(`  Estimated Arrival: ${f.estimated_arrival}`);
    }
    if (f.actual_arrival) {
      lines.push(`  Actual Arrival: ${f.actual_arrival}`);
    }
    if (f.gate_origin) {
      lines.push(`  Departure Gate: ${f.gate_origin}${f.terminal_origin ? ` (Terminal ${f.terminal_origin})` : ''}`);
    }
    if (f.gate_destination) {
      lines.push(`  Arrival Gate: ${f.gate_destination}${f.terminal_destination ? ` (Terminal ${f.terminal_destination})` : ''}`);
    }
    if (f.baggage_claim) {
      lines.push(`  Baggage Claim: ${f.baggage_claim}`);
    }
    if (f.aircraft_type) {
      lines.push(`  Aircraft: ${f.aircraft_type}`);
    }

    return lines.join('\n');
  }).join('\n\n');
}

/**
 * Calls Gemini API with the user's question and flight context
 */
async function askGemini(question: string, flightContext: FlightContext[]): Promise<string> {
  if (!genAI) {
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  }

  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

  const systemPrompt = SYSTEM_PROMPT.replace('{flight_context}', formatFlightContext(flightContext));

  try {
    const result = await model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [
            { text: systemPrompt + '\n\nUser question: ' + question },
          ],
        },
      ],
      generationConfig: {
        maxOutputTokens: 500,
        temperature: 0.7,
      },
    });

    const response = result.response;
    const text = response.text();

    if (!text) {
      return "I'm sorry, I couldn't generate a response. Please try again!";
    }

    return text;
  } catch (error) {
    console.error('Gemini API error:', error);
    return "Oops! I'm having trouble thinking right now. Please try again in a moment.";
  }
}

/**
 * Sends a WhatsApp message via Twilio
 */
async function sendWhatsAppMessage(to: string, message: string): Promise<void> {
  if (!twilioClient) {
    twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  }

  let fromNumber = TWILIO_FROM_NUMBER;
  if (!fromNumber.startsWith('whatsapp:')) {
    fromNumber = `whatsapp:${fromNumber}`;
  }

  // Ensure 'to' is in WhatsApp format
  let toNumber = to;
  if (!toNumber.startsWith('whatsapp:')) {
    toNumber = `whatsapp:${toNumber}`;
  }

  try {
    const result = await twilioClient.messages.create({
      body: message,
      from: fromNumber,
      to: toNumber,
    });
    console.log(`Sent WhatsApp message to ${toNumber}. SID: ${result.sid}`);
  } catch (error) {
    console.error(`Failed to send WhatsApp message to ${toNumber}:`, error);
    throw error;
  }
}

/**
 * Returns TwiML response (empty - we send async via API)
 */
function twimlResponse(): APIGatewayProxyResult {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/xml',
    },
    body: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
  };
}

/**
 * Lambda handler for WhatsApp webhook
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Received WhatsApp webhook event');

  try {
    // Parse Twilio webhook payload
    if (!event.body) {
      console.error('No body in request');
      return twimlResponse();
    }

    const payload = parseTwilioWebhook(event.body);
    console.log(`Message from ${payload.From}: ${payload.Body}`);

    if (!payload.From || !payload.Body) {
      console.error('Missing From or Body in payload');
      return twimlResponse();
    }

    const phone = extractPhoneNumber(payload.From);
    const question = payload.Body.trim();

    // Check rate limit
    const rateLimit = await checkRateLimit(phone);
    if (!rateLimit.allowed) {
      await sendWhatsAppMessage(phone, 
        "Hey! You've reached your query limit (20 per hour). Take a breather and try again soon!"
      );
      return twimlResponse();
    }

    // Get user's subscriptions
    const subscriptions = await getUserSubscriptions(phone);
    console.log(`Found ${subscriptions.length} active subscriptions for ${phone}`);

    // Get flight data for each subscription
    const flightContexts: FlightContext[] = [];
    for (const sub of subscriptions) {
      const flightData = await getFlightData(sub.flight_number, sub.date);
      if (flightData) {
        flightContexts.push(flightData);
      }
    }
    console.log(`Retrieved flight data for ${flightContexts.length} flights`);

    // Ask Gemini
    const response = await askGemini(question, flightContexts);
    console.log(`Gemini response length: ${response.length} chars`);

    // Send response
    await sendWhatsAppMessage(phone, response);

    // Add remaining queries info if low
    if (rateLimit.remaining <= 5 && rateLimit.remaining > 0) {
      await sendWhatsAppMessage(phone, 
        `(${rateLimit.remaining} questions remaining this hour)`
      );
    }

    return twimlResponse();
  } catch (error) {
    console.error('Error processing WhatsApp message:', error);
    
    // Try to send error message to user
    try {
      if (event.body) {
        const payload = parseTwilioWebhook(event.body);
        const phone = extractPhoneNumber(payload.From);
        if (phone) {
          await sendWhatsAppMessage(phone, 
            "Sorry, something went wrong on my end. Please try again!"
          );
        }
      }
    } catch (sendError) {
      console.error('Failed to send error message:', sendError);
    }

    return twimlResponse();
  }
};
