import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, GetCommand, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
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
const GEMINI_MODEL = 'gemini-3-flash-preview';
const CONVERSATION_HISTORY_LIMIT = 10; // Keep last N messages
const CONVERSATION_TTL_HOURS = 1; // Expire conversations after 1 hour

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
  // Pre-formatted local times (added by formatFlightContext)
  departure_local?: string;
  arrival_local?: string;
  departure_timezone?: string;
  arrival_timezone?: string;
  // Inbound aircraft tracking
  inbound_flight_number?: string;
  inbound_origin?: string;
  inbound_origin_city?: string;
  inbound_status?: string;
  inbound_estimated_arrival?: string;
  inbound_actual_arrival?: string;
  inbound_delay_minutes?: number;
}

// --- Airport Timezone Map (common airports) ---
const AIRPORT_TIMEZONES: Record<string, { tz: string; label: string }> = {
  // India
  'BLR': { tz: 'Asia/Kolkata', label: 'IST' },
  'DEL': { tz: 'Asia/Kolkata', label: 'IST' },
  'BOM': { tz: 'Asia/Kolkata', label: 'IST' },
  'MAA': { tz: 'Asia/Kolkata', label: 'IST' },
  'HYD': { tz: 'Asia/Kolkata', label: 'IST' },
  'CCU': { tz: 'Asia/Kolkata', label: 'IST' },
  // Europe
  'AMS': { tz: 'Europe/Amsterdam', label: 'CET' },
  'LHR': { tz: 'Europe/London', label: 'GMT' },
  'CDG': { tz: 'Europe/Paris', label: 'CET' },
  'FRA': { tz: 'Europe/Berlin', label: 'CET' },
  'FCO': { tz: 'Europe/Rome', label: 'CET' },
  'MAD': { tz: 'Europe/Madrid', label: 'CET' },
  'MUC': { tz: 'Europe/Berlin', label: 'CET' },
  'ZRH': { tz: 'Europe/Zurich', label: 'CET' },
  // Middle East
  'DXB': { tz: 'Asia/Dubai', label: 'GST' },
  'DOH': { tz: 'Asia/Qatar', label: 'AST' },
  'AUH': { tz: 'Asia/Dubai', label: 'GST' },
  // Asia
  'SIN': { tz: 'Asia/Singapore', label: 'SGT' },
  'HKG': { tz: 'Asia/Hong_Kong', label: 'HKT' },
  'BKK': { tz: 'Asia/Bangkok', label: 'ICT' },
  'NRT': { tz: 'Asia/Tokyo', label: 'JST' },
  'ICN': { tz: 'Asia/Seoul', label: 'KST' },
  'PEK': { tz: 'Asia/Shanghai', label: 'CST' },
  'KUL': { tz: 'Asia/Kuala_Lumpur', label: 'MYT' },
  // USA
  'JFK': { tz: 'America/New_York', label: 'EST' },
  'LAX': { tz: 'America/Los_Angeles', label: 'PST' },
  'ORD': { tz: 'America/Chicago', label: 'CST' },
  'SFO': { tz: 'America/Los_Angeles', label: 'PST' },
  'MIA': { tz: 'America/New_York', label: 'EST' },
  'DFW': { tz: 'America/Chicago', label: 'CST' },
  'ATL': { tz: 'America/New_York', label: 'EST' },
  'SEA': { tz: 'America/Los_Angeles', label: 'PST' },
  'BOS': { tz: 'America/New_York', label: 'EST' },
  // Australia
  'SYD': { tz: 'Australia/Sydney', label: 'AEDT' },
  'MEL': { tz: 'Australia/Melbourne', label: 'AEDT' },
};

interface Subscription {
  flight_number: string;
  date: string;
  fa_flight_id?: string;
}

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

/**
 * Saves a message to the conversation history
 */
async function saveConversationMessage(phone: string, role: 'user' | 'assistant', content: string): Promise<void> {
  const now = Date.now();
  const ttl = Math.floor((now + CONVERSATION_TTL_HOURS * 60 * 60 * 1000) / 1000);
  
  try {
    await docClient.send(new PutCommand({
      TableName: APP_TABLE_NAME,
      Item: {
        PK: `CONV#${phone}`,
        SK: `${now}#${role}`,
        role,
        content,
        timestamp: new Date(now).toISOString(),
        ttl,
      },
    }));
  } catch (error) {
    console.error('Error saving conversation message:', error);
    // Don't throw - conversation memory is not critical
  }
}

/**
 * Retrieves recent conversation history for a user
 */
async function getConversationHistory(phone: string): Promise<ConversationMessage[]> {
  try {
    const result = await docClient.send(new QueryCommand({
      TableName: APP_TABLE_NAME,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `CONV#${phone}`,
      },
      ScanIndexForward: false, // Most recent first
      Limit: CONVERSATION_HISTORY_LIMIT,
    }));

    if (!result.Items || result.Items.length === 0) {
      return [];
    }

    // Reverse to get chronological order (oldest first)
    return result.Items.reverse().map(item => ({
      role: item.role as 'user' | 'assistant',
      content: item.content as string,
      timestamp: item.timestamp as string,
    }));
  } catch (error) {
    console.error('Error fetching conversation history:', error);
    return [];
  }
}

/**
 * Converts UTC time to local time for a given airport
 * Returns formatted string like "2:30 AM IST on Jan 22"
 */
function formatLocalTime(utcTimeStr: string | undefined, airportCode: string): string | undefined {
  if (!utcTimeStr) return undefined;

  try {
    const utcDate = new Date(utcTimeStr);
    if (isNaN(utcDate.getTime())) return undefined;

    const tzInfo = AIRPORT_TIMEZONES[airportCode];
    if (!tzInfo) {
      // Fallback: just format UTC
      return utcDate.toLocaleString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      }) + ' UTC';
    }

    const localStr = utcDate.toLocaleString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      month: 'short',
      day: 'numeric',
      timeZone: tzInfo.tz,
    });

    return `${localStr} ${tzInfo.label}`;
  } catch (e) {
    console.error('Error formatting local time:', e);
    return undefined;
  }
}

/**
 * Gets the best departure time (actual > estimated > scheduled)
 */
function getBestDepartureTime(flight: FlightContext): string | undefined {
  return flight.actual_departure || flight.estimated_departure || flight.scheduled_departure;
}

/**
 * Gets the best arrival time (actual > estimated > scheduled)
 */
function getBestArrivalTime(flight: FlightContext): string | undefined {
  return flight.actual_arrival || flight.estimated_arrival || flight.scheduled_arrival;
}

/**
 * Calculates time until departure or since departure
 * Returns human-readable string like "2h 45m" or "Departed 1h 30m ago"
 */
function calculateTimeUntil(utcTimeStr: string | undefined): string | undefined {
  if (!utcTimeStr) return undefined;

  try {
    const targetTime = new Date(utcTimeStr).getTime();
    const now = Date.now();
    const diffMs = targetTime - now;
    const absDiffMs = Math.abs(diffMs);

    const hours = Math.floor(absDiffMs / (1000 * 60 * 60));
    const minutes = Math.floor((absDiffMs % (1000 * 60 * 60)) / (1000 * 60));

    let timeStr = '';
    if (hours > 0) {
      timeStr += `${hours}h `;
    }
    timeStr += `${minutes}m`;

    if (diffMs < 0) {
      // Already departed/arrived
      if (hours === 0 && minutes < 5) {
        return 'Just now';
      }
      return `${timeStr.trim()} ago`;
    } else {
      // In the future
      if (hours === 0 && minutes < 5) {
        return 'In a few minutes';
      }
      return `In ${timeStr.trim()}`;
    }
  } catch (e) {
    console.error('Error calculating time until:', e);
    return undefined;
  }
}

/**
 * Determines flight phase based on times
 */
function getFlightPhase(flight: FlightContext): string {
  const now = Date.now();
  
  const departure = getBestDepartureTime(flight);
  const arrival = getBestArrivalTime(flight);
  
  if (flight.actual_arrival) {
    return 'Arrived';
  }
  
  if (flight.actual_departure) {
    return 'In Flight';
  }
  
  if (departure) {
    const depTime = new Date(departure).getTime();
    const hoursUntil = (depTime - now) / (1000 * 60 * 60);
    
    if (hoursUntil < 0) {
      return 'Departed';
    } else if (hoursUntil <= 0.5) {
      return 'Boarding';
    } else if (hoursUntil <= 2) {
      return 'Go to Gate';
    } else if (hoursUntil <= 4) {
      return 'Check-in Open';
    } else if (hoursUntil <= 24) {
      return 'Within 24 Hours';
    } else {
      return 'Upcoming';
    }
  }
  
  return 'Unknown';
}

/**
 * Analyzes connection between two flights
 * Returns assessment with risk level and recommendations
 */
interface ConnectionAnalysis {
  layover_duration: string;
  risk_level: 'comfortable' | 'ok' | 'tight' | 'risky' | 'missed';
  recommendation: string;
  same_terminal: boolean | null;
}

function analyzeConnection(arriving: FlightContext, departing: FlightContext): ConnectionAnalysis | null {
  const arrivalTime = getBestArrivalTime(arriving);
  const departureTime = getBestDepartureTime(departing);
  
  if (!arrivalTime || !departureTime) {
    return null;
  }
  
  const arrivalMs = new Date(arrivalTime).getTime();
  const departureMs = new Date(departureTime).getTime();
  const layoverMs = departureMs - arrivalMs;
  const layoverMinutes = layoverMs / (1000 * 60);
  
  // Format layover duration
  const hours = Math.floor(layoverMinutes / 60);
  const mins = Math.round(layoverMinutes % 60);
  let layoverDuration = '';
  if (hours > 0) layoverDuration += `${hours}h `;
  layoverDuration += `${mins}m`;
  
  // Check if same terminal
  const sameTerminal = arriving.terminal_destination && departing.terminal_origin
    ? arriving.terminal_destination === departing.terminal_origin
    : null;
  
  // Assess risk
  let riskLevel: ConnectionAnalysis['risk_level'];
  let recommendation: string;
  
  if (layoverMinutes < 0) {
    riskLevel = 'missed';
    recommendation = 'Connection not possible - departing flight leaves before arriving flight lands.';
  } else if (layoverMinutes < 45) {
    riskLevel = 'risky';
    recommendation = 'Very tight! You may miss this connection. Run and hope for the best.';
  } else if (layoverMinutes < 75) {
    riskLevel = 'tight';
    recommendation = 'Tight connection. Head straight to your gate after landing. No time for delays.';
  } else if (layoverMinutes < 120) {
    riskLevel = 'ok';
    recommendation = 'Should be fine, but don\'t dawdle. Go to your gate first, then grab food if needed.';
  } else {
    riskLevel = 'comfortable';
    recommendation = 'Comfortable layover. You have time to relax, grab food, or visit a lounge.';
  }
  
  // Adjust for terminal change
  if (sameTerminal === false && layoverMinutes < 90) {
    if (riskLevel === 'ok') riskLevel = 'tight';
    if (riskLevel === 'tight') riskLevel = 'risky';
    recommendation += ' Note: Terminal change required!';
  }
  
  return {
    layover_duration: layoverDuration.trim(),
    risk_level: riskLevel,
    recommendation,
    same_terminal: sameTerminal,
  };
}

// --- System Prompt ---
const SYSTEM_PROMPT = `You are Flait, a friendly and helpful flight assistant on WhatsApp. You help travelers with their flights and travel questions.

CURRENT USER'S FLIGHTS:
{flight_context}

IMPORTANT - PRE-COMPUTED VALUES:
- All times are ALREADY converted to local timezone - use them exactly as shown
- "Time Until Departure" is already calculated - use this value directly
- "Phase" tells you what the user should be doing (Boarding, Go to Gate, Check-in Open, etc.)
- Connection analysis (if present) already has risk assessment and recommendations - use these directly
- DO NOT recalculate any times or durations - they are pre-computed and accurate

FLIGHT QUESTIONS:
- For flight questions, ALWAYS use the provided flight data - don't make up information
- If you don't have flight data for what they're asking, say so politely
- If the user has no flights tracked, encourage them to subscribe to a flight first
- Be proactive - if Phase is "Boarding" or "Go to Gate", emphasize urgency

TRAVEL KNOWLEDGE:
- You have extensive knowledge about airports, terminals, gates, and navigation
- For airport questions, provide SPECIFIC details: estimated walking times, landmarks, step-by-step directions
- Mention relevant nearby facilities (lounges, restaurants, shops) when helpful
- For major airports (AMS, LHR, JFK, DXB, SIN, etc.), share your detailed knowledge
- Include practical tips like whether passport control is needed, which zones/piers to use

GENERAL GUIDELINES:
- Be concise but friendly - this is WhatsApp, keep messages short (under 300 words)
- Use emojis sparingly but appropriately
- Use line breaks for readability
- Keep it conversational, not robotic`;

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
 * Parses subscription SK to extract date and flight number
 * SK format: SUB#YYYY-MM-DD#FLIGHTNUMBER
 */
function parseSubscriptionSK(sk: string): { date: string; flight_number: string } | null {
  const parts = sk.split('#');
  if (parts.length !== 3 || parts[0] !== 'SUB') {
    return null;
  }
  return {
    date: parts[1],
    flight_number: parts[2],
  };
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
    const subscriptions: Subscription[] = [];

    for (const item of result.Items) {
      // Parse date and flight_number from SK
      const parsed = parseSubscriptionSK(item.SK as string);
      if (!parsed) continue;

      // Check if active (case-insensitive) and not in the past
      const status = (item.status as string || '').toUpperCase();
      if (status !== 'ACTIVE') continue;
      if (parsed.date < today) continue;

      subscriptions.push({
        flight_number: parsed.flight_number,
        date: parsed.date,
        fa_flight_id: item.fa_flight_id as string | undefined,
      });
    }

    return subscriptions;
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
      // Inbound aircraft tracking
      inbound_flight_number: item.inbound_flight_number,
      inbound_origin: item.inbound_origin,
      inbound_origin_city: item.inbound_origin_city,
      inbound_status: item.inbound_status,
      inbound_estimated_arrival: item.inbound_estimated_arrival,
      inbound_actual_arrival: item.inbound_actual_arrival,
      inbound_delay_minutes: item.inbound_delay_minutes,
    };
  } catch (error) {
    console.error(`Error fetching flight data for ${flightNumber} on ${date}:`, error);
    return null;
  }
}

/**
 * Formats flight context for the system prompt with pre-computed values
 * Includes: local times, time until departure, flight phase, and connection analysis
 */
function formatFlightContext(flights: FlightContext[]): string {
  if (flights.length === 0) {
    return 'No flights currently being tracked. The user needs to subscribe to a flight first.';
  }

  const flightSections = flights.map((f, index) => {
    const lines = [
      `Flight ${index + 1}: ${f.flight_number} on ${f.date}`,
      `  Route: ${f.departure_airport} -> ${f.arrival_airport}`,
      `  Status: ${f.status}`,
    ];

    // Flight phase (what user should be doing now)
    const phase = getFlightPhase(f);
    lines.push(`  Phase: ${phase}`);

    // Pre-formatted local departure time
    const bestDeparture = getBestDepartureTime(f);
    const departureLocal = formatLocalTime(bestDeparture, f.departure_airport);
    if (departureLocal) {
      lines.push(`  Departure Time (Local): ${departureLocal}`);
    }

    // Time until departure (pre-calculated!)
    const timeUntilDeparture = calculateTimeUntil(bestDeparture);
    if (timeUntilDeparture) {
      lines.push(`  Time Until Departure: ${timeUntilDeparture}`);
    }

    // Pre-formatted local arrival time
    const bestArrival = getBestArrivalTime(f);
    const arrivalLocal = formatLocalTime(bestArrival, f.arrival_airport);
    if (arrivalLocal) {
      lines.push(`  Arrival Time (Local): ${arrivalLocal}`);
    }

    // Time until arrival (for in-flight)
    if (f.actual_departure && !f.actual_arrival) {
      const timeUntilArrival = calculateTimeUntil(bestArrival);
      if (timeUntilArrival) {
        lines.push(`  Time Until Arrival: ${timeUntilArrival}`);
      }
    }

    // Gate and terminal info
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
    
    // Inbound aircraft info (if available)
    if (f.inbound_flight_number) {
      lines.push('');
      lines.push('  INBOUND AIRCRAFT:');
      lines.push(`    Flight: ${f.inbound_flight_number} from ${f.inbound_origin_city || f.inbound_origin}`);
      lines.push(`    Status: ${f.inbound_status}`);
      if (f.inbound_delay_minutes && f.inbound_delay_minutes > 0) {
        const delayHours = Math.floor(f.inbound_delay_minutes / 60);
        const delayMins = f.inbound_delay_minutes % 60;
        const delayStr = delayHours > 0 ? `${delayHours}h ${delayMins}m` : `${delayMins}m`;
        lines.push(`    Delay: ${delayStr} late`);
      }
      if (f.inbound_actual_arrival) {
        const arrivalLocal = formatLocalTime(f.inbound_actual_arrival, f.departure_airport);
        lines.push(`    Arrived: ${arrivalLocal || f.inbound_actual_arrival}`);
      } else if (f.inbound_estimated_arrival) {
        const arrivalLocal = formatLocalTime(f.inbound_estimated_arrival, f.departure_airport);
        lines.push(`    Expected: ${arrivalLocal || f.inbound_estimated_arrival}`);
      }
    }

    return lines.join('\n');
  });

  // Add connection analysis if user has multiple flights
  let connectionSection = '';
  if (flights.length >= 2) {
    // Sort flights by departure time to find connections
    const sortedFlights = [...flights].sort((a, b) => {
      const aTime = getBestDepartureTime(a) || '';
      const bTime = getBestDepartureTime(b) || '';
      return aTime.localeCompare(bTime);
    });

    // Analyze each consecutive pair
    const connectionAnalyses: string[] = [];
    for (let i = 0; i < sortedFlights.length - 1; i++) {
      const arriving = sortedFlights[i];
      const departing = sortedFlights[i + 1];
      
      // Check if this is a valid connection (arriving flight's destination = departing flight's origin)
      if (arriving.arrival_airport === departing.departure_airport) {
        const analysis = analyzeConnection(arriving, departing);
        if (analysis) {
          connectionAnalyses.push(
            `Connection: ${arriving.flight_number} -> ${departing.flight_number} at ${arriving.arrival_airport}\n` +
            `  Layover: ${analysis.layover_duration}\n` +
            `  Risk Level: ${analysis.risk_level.toUpperCase()}\n` +
            `  ${analysis.recommendation}` +
            (analysis.same_terminal !== null ? `\n  Same Terminal: ${analysis.same_terminal ? 'Yes' : 'No'}` : '')
          );
        }
      }
    }

    if (connectionAnalyses.length > 0) {
      connectionSection = '\n\nCONNECTION ANALYSIS:\n' + connectionAnalyses.join('\n\n');
    }
  }

  return flightSections.join('\n\n') + connectionSection;
}

/**
 * Calls Gemini API with the user's question, flight context, and conversation history
 * @param question - User's question
 * @param flightContext - Array of user's flight data
 * @param conversationHistory - Previous messages in the conversation
 */
async function askGemini(
  question: string, 
  flightContext: FlightContext[], 
  conversationHistory: ConversationMessage[]
): Promise<string> {
  if (!genAI) {
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  }

  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

  const systemPrompt = SYSTEM_PROMPT.replace('{flight_context}', formatFlightContext(flightContext));

  // Build conversation contents for Gemini
  // Start with system prompt as the first user message
  const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];
  
  // Add system prompt with first user message or standalone
  if (conversationHistory.length > 0) {
    // Add system context as initial user message
    contents.push({
      role: 'user',
      parts: [{ text: systemPrompt + '\n\n[Conversation starts]' }],
    });
    contents.push({
      role: 'model',
      parts: [{ text: 'I understand. I\'m Flait, your flight assistant. How can I help you?' }],
    });
    
    // Add conversation history
    for (const msg of conversationHistory) {
      contents.push({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.content }],
      });
    }
    
    // Add current question
    contents.push({
      role: 'user',
      parts: [{ text: question }],
    });
  } else {
    // No history - single message with system prompt
    contents.push({
      role: 'user',
      parts: [{ text: systemPrompt + '\n\nUser question: ' + question }],
    });
  }

  try {
    const result = await model.generateContent({
      contents,
      generationConfig: {
        maxOutputTokens: 4096,
        temperature: 0.7,
      },
    });

    const response = result.response;
    const text = response.text();
    
    console.log('Gemini response length:', text?.length || 0);

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

    // Get conversation history for context
    const conversationHistory = await getConversationHistory(phone);
    console.log(`Retrieved ${conversationHistory.length} messages from conversation history`);

    // Save user's question to conversation history
    await saveConversationMessage(phone, 'user', question);

    // Ask Gemini with conversation history
    const response = await askGemini(question, flightContexts, conversationHistory);
    console.log(`Gemini response length: ${response.length} chars`);

    // Save assistant's response to conversation history
    await saveConversationMessage(phone, 'assistant', response);

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
