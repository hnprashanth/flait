import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, GetCommand, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GoogleGenerativeAI } from '@google/generative-ai';
import twilio from 'twilio';

// --- Clients ---
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const lambdaClient = new LambdaClient({});
let twilioClient: ReturnType<typeof twilio> | null = null;
let genAI: GoogleGenerativeAI | null = null;

// --- Environment Variables ---
const APP_TABLE_NAME = process.env.APP_TABLE_NAME!;
const FLIGHT_TABLE_NAME = process.env.FLIGHT_TABLE_NAME!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID!;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN!;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER!;
const FLIGHTAWARE_API_KEY = process.env.FLIGHTAWARE_API_KEY!;
const FLIGHT_TRACKER_FUNCTION_NAME = process.env.FLIGHT_TRACKER_FUNCTION_NAME;
const SCHEDULE_TRACKER_FUNCTION_NAME = process.env.SCHEDULE_TRACKER_FUNCTION_NAME;

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

/** Flight subscription request from Gemini */
interface SubscriptionRequest {
  flight_number: string;
  date_text: string;  // e.g., "tomorrow", "Jan 25", "next Monday"
}

/** Parsed Gemini response - either subscription intent or regular query */
interface ParsedGeminiResponse {
  intent: 'subscribe' | 'query';
  flights?: SubscriptionRequest[];
  text?: string;
}

/** Flight info from FlightAware for validation */
interface FlightValidationResult {
  valid: boolean;
  flight_number: string;
  date: string;  // Resolved YYYY-MM-DD
  fa_flight_id?: string;
  departure_airport?: string;
  departure_city?: string;
  arrival_airport?: string;
  arrival_city?: string;
  departure_time?: string;
  departure_timezone?: string;
  error?: string;
}

/** Subscription result */
interface SubscriptionResult {
  success: boolean;
  flight_number: string;
  date: string;
  message: string;
  flight_info?: FlightValidationResult;
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

// --- Subscription Functions ---

/**
 * Parses Gemini response to detect subscription intent or regular query
 */
function parseGeminiResponse(response: string): ParsedGeminiResponse {
  const trimmed = response.trim();
  
  // Check if response is JSON (subscription intent)
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.intent === 'subscribe' && Array.isArray(parsed.flights)) {
        return {
          intent: 'subscribe',
          flights: parsed.flights as SubscriptionRequest[],
        };
      }
    } catch {
      // Not valid JSON, treat as regular text
    }
  }
  
  // Regular text response
  return {
    intent: 'query',
    text: response,
  };
}

/**
 * Resolves a relative date text to an actual date in a given timezone.
 * @param dateText - e.g., "tomorrow", "next Monday", "Jan 25", "in 3 days"
 * @param timezone - IANA timezone string (e.g., "Europe/Amsterdam")
 * @returns Date string in YYYY-MM-DD format
 */
function resolveDateInTimezone(dateText: string, timezone: string): string {
  // Get current date in the target timezone
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', { 
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const todayStr = formatter.format(now);
  const todayParts = todayStr.split('-');
  const todayInTz = new Date(parseInt(todayParts[0]), parseInt(todayParts[1]) - 1, parseInt(todayParts[2]));
  
  const lowerText = dateText.toLowerCase().trim();
  
  // Handle relative dates
  if (lowerText === 'today') {
    return todayStr;
  }
  
  if (lowerText === 'tomorrow') {
    const tomorrow = new Date(todayInTz);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.toISOString().split('T')[0];
  }
  
  if (lowerText === 'day after tomorrow' || lowerText === 'day after') {
    const dayAfter = new Date(todayInTz);
    dayAfter.setDate(dayAfter.getDate() + 2);
    return dayAfter.toISOString().split('T')[0];
  }
  
  // Handle "in X days"
  const inDaysMatch = lowerText.match(/^in (\d+) days?$/);
  if (inDaysMatch) {
    const days = parseInt(inDaysMatch[1]);
    const futureDate = new Date(todayInTz);
    futureDate.setDate(futureDate.getDate() + days);
    return futureDate.toISOString().split('T')[0];
  }
  
  // Handle "next Monday", "next Tuesday", etc.
  const nextDayMatch = lowerText.match(/^next (monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/);
  if (nextDayMatch) {
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const targetDay = dayNames.indexOf(nextDayMatch[1]);
    const currentDay = todayInTz.getDay();
    let daysToAdd = targetDay - currentDay;
    if (daysToAdd <= 0) daysToAdd += 7; // Next week
    const nextDay = new Date(todayInTz);
    nextDay.setDate(nextDay.getDate() + daysToAdd);
    return nextDay.toISOString().split('T')[0];
  }
  
  // Handle absolute dates like "Jan 25", "January 25", "25 Jan", "25th January"
  const currentYear = todayInTz.getFullYear();
  const nextYear = currentYear + 1;
  
  // Month names for parsing
  const monthNames: Record<string, number> = {
    'jan': 0, 'january': 0,
    'feb': 1, 'february': 1,
    'mar': 2, 'march': 2,
    'apr': 3, 'april': 3,
    'may': 4,
    'jun': 5, 'june': 5,
    'jul': 6, 'july': 6,
    'aug': 7, 'august': 7,
    'sep': 8, 'september': 8,
    'oct': 9, 'october': 9,
    'nov': 10, 'november': 10,
    'dec': 11, 'december': 11,
  };
  
  // Try various date formats
  // "Jan 25" or "January 25"
  let match = lowerText.match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?$/);
  if (match) {
    const month = monthNames[match[1]];
    const day = parseInt(match[2]);
    if (month !== undefined && day >= 1 && day <= 31) {
      let date = new Date(currentYear, month, day);
      // If date is in the past, assume next year
      if (date < todayInTz) {
        date = new Date(nextYear, month, day);
      }
      return date.toISOString().split('T')[0];
    }
  }
  
  // "25 Jan" or "25th January"
  match = lowerText.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)$/);
  if (match) {
    const day = parseInt(match[1]);
    const month = monthNames[match[2]];
    if (month !== undefined && day >= 1 && day <= 31) {
      let date = new Date(currentYear, month, day);
      if (date < todayInTz) {
        date = new Date(nextYear, month, day);
      }
      return date.toISOString().split('T')[0];
    }
  }
  
  // "2026-01-25" (already in correct format)
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateText)) {
    return dateText;
  }
  
  // If we can't parse it, return empty string
  console.error(`Could not parse date: ${dateText}`);
  return '';
}

/**
 * Fetches upcoming flights for a flight number from FlightAware
 */
async function fetchUpcomingFlights(flightNumber: string): Promise<any[]> {
  try {
    // Fetch flights for the next 7 days
    const url = `https://aeroapi.flightaware.com/aeroapi/flights/${encodeURIComponent(flightNumber)}`;
    console.log(`Fetching upcoming flights for ${flightNumber}`);
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-apikey': FLIGHTAWARE_API_KEY,
        'Content-Type': 'application/json',
      },
    });
    
    if (!response.ok) {
      console.error(`FlightAware API error: ${response.status} ${response.statusText}`);
      return [];
    }
    
    const data = await response.json() as { flights?: unknown[] };
    return data.flights || [];
  } catch (error) {
    console.error('Error fetching flights from FlightAware:', error);
    return [];
  }
}

/**
 * Validates a flight subscription request and returns flight details
 */
async function validateFlightSubscription(
  request: SubscriptionRequest
): Promise<FlightValidationResult> {
  try {
    // Fetch upcoming flights
    const flights = await fetchUpcomingFlights(request.flight_number);
    
    if (!flights || flights.length === 0) {
      return {
        valid: false,
        flight_number: request.flight_number,
        date: '',
        error: `Couldn't find any upcoming flights for ${request.flight_number}`,
      };
    }
    
    // Get departure timezone from first flight to resolve the date
    const firstFlight = flights[0];
    const departureTimezone = firstFlight.origin?.timezone || 'UTC';
    
    // Resolve the date text to an actual date
    const resolvedDate = resolveDateInTimezone(request.date_text, departureTimezone);
    
    if (!resolvedDate) {
      return {
        valid: false,
        flight_number: request.flight_number,
        date: '',
        error: `Couldn't understand the date "${request.date_text}"`,
      };
    }
    
    // Find the flight on the resolved date
    const matchingFlight = flights.find((f: any) => {
      const scheduledDeparture = f.scheduled_out || f.scheduled_off;
      if (!scheduledDeparture) return false;
      
      // Format the departure date in the departure timezone
      const depDate = new Date(scheduledDeparture);
      const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: departureTimezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
      const flightDate = formatter.format(depDate);
      return flightDate === resolvedDate;
    });
    
    if (!matchingFlight) {
      return {
        valid: false,
        flight_number: request.flight_number,
        date: resolvedDate,
        error: `${request.flight_number} doesn't appear to operate on ${resolvedDate}. Please check the date.`,
      };
    }
    
    // Extract flight info
    const depTime = matchingFlight.scheduled_out || matchingFlight.scheduled_off;
    
    return {
      valid: true,
      flight_number: request.flight_number,
      date: resolvedDate,
      fa_flight_id: matchingFlight.fa_flight_id,
      departure_airport: matchingFlight.origin?.code_iata || matchingFlight.origin?.code,
      departure_city: matchingFlight.origin?.city,
      arrival_airport: matchingFlight.destination?.code_iata || matchingFlight.destination?.code,
      arrival_city: matchingFlight.destination?.city,
      departure_time: depTime,
      departure_timezone: departureTimezone,
    };
  } catch (error) {
    console.error('Error validating flight:', error);
    return {
      valid: false,
      flight_number: request.flight_number,
      date: '',
      error: 'Error validating flight. Please try again.',
    };
  }
}

/**
 * Checks if user already has a subscription for a flight
 */
async function checkExistingSubscription(
  phone: string,
  flightNumber: string,
  date: string
): Promise<boolean> {
  try {
    const result = await docClient.send(new GetCommand({
      TableName: APP_TABLE_NAME,
      Key: {
        PK: `USER#${phone}`,
        SK: `SUB#${date}#${flightNumber}`,
      },
    }));
    
    if (result.Item) {
      const status = (result.Item.status as string || '').toUpperCase();
      return status === 'ACTIVE';
    }
    
    return false;
  } catch (error) {
    console.error('Error checking existing subscription:', error);
    return false;
  }
}

/**
 * Invokes a Lambda function asynchronously (fire-and-forget for provisioning)
 */
async function invokeLambdaAsync(functionName: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'Event', // Async invocation
      Payload: Buffer.from(JSON.stringify(payload)),
    }));
    console.log(`Invoked ${functionName} with payload:`, JSON.stringify(payload));
  } catch (error) {
    console.error(`Error invoking ${functionName}:`, error);
    throw error;
  }
}

/**
 * Creates a flight subscription for a user and provisions tracking
 */
async function createSubscription(
  phone: string,
  flightInfo: FlightValidationResult
): Promise<boolean> {
  try {
    const now = new Date().toISOString();
    
    // 1. Save the subscription
    await docClient.send(new PutCommand({
      TableName: APP_TABLE_NAME,
      Item: {
        PK: `USER#${phone}`,
        SK: `SUB#${flightInfo.date}#${flightInfo.flight_number}`,
        GSI1PK: `FLIGHT#${flightInfo.flight_number}#${flightInfo.date}`,
        GSI1SK: `USER#${phone}`,
        flight_number: flightInfo.flight_number,
        date: flightInfo.date,
        fa_flight_id: flightInfo.fa_flight_id,
        status: 'ACTIVE',
        created_at: now,
        updated_at: now,
      },
    }));
    
    console.log(`Created subscription for ${phone}: ${flightInfo.flight_number} on ${flightInfo.date}`);
    
    // 2. Provision flight tracking (async - don't block the response)
    // Flight data was already fetched during validation, but we need to ensure
    // it's stored and schedules are created
    const trackingPayload = {
      flight_number: flightInfo.flight_number,
      date: flightInfo.date,
    };
    
    // Invoke flight-tracker to ensure data is stored (may already exist from validation)
    if (FLIGHT_TRACKER_FUNCTION_NAME) {
      try {
        await invokeLambdaAsync(FLIGHT_TRACKER_FUNCTION_NAME, trackingPayload);
      } catch (error) {
        console.error('Failed to invoke flight-tracker (non-fatal):', error);
      }
    }
    
    // Invoke schedule-tracker to create polling schedules
    if (SCHEDULE_TRACKER_FUNCTION_NAME) {
      try {
        await invokeLambdaAsync(SCHEDULE_TRACKER_FUNCTION_NAME, trackingPayload);
      } catch (error) {
        console.error('Failed to invoke schedule-tracker (non-fatal):', error);
      }
    }
    
    return true;
  } catch (error) {
    console.error('Error creating subscription:', error);
    return false;
  }
}

/**
 * Handles a subscription request from WhatsApp
 */
async function handleSubscriptionRequest(
  phone: string,
  flights: SubscriptionRequest[]
): Promise<string> {
  const results: SubscriptionResult[] = [];
  
  for (const request of flights) {
    // Validate the flight
    const validation = await validateFlightSubscription(request);
    
    if (!validation.valid) {
      results.push({
        success: false,
        flight_number: request.flight_number,
        date: validation.date || request.date_text,
        message: validation.error || 'Flight not found',
      });
      continue;
    }
    
    // Check for existing subscription
    const exists = await checkExistingSubscription(phone, validation.flight_number, validation.date);
    if (exists) {
      results.push({
        success: false,
        flight_number: validation.flight_number,
        date: validation.date,
        message: `You're already tracking ${validation.flight_number} on ${formatDateForDisplay(validation.date)}!`,
      });
      continue;
    }
    
    // Create the subscription
    const created = await createSubscription(phone, validation);
    if (created) {
      results.push({
        success: true,
        flight_number: validation.flight_number,
        date: validation.date,
        message: 'Success',
        flight_info: validation,
      });
    } else {
      results.push({
        success: false,
        flight_number: validation.flight_number,
        date: validation.date,
        message: 'Error creating subscription. Please try again.',
      });
    }
  }
  
  // Format the response message
  return formatSubscriptionResponse(results);
}

/**
 * Formats a date for user-friendly display (e.g., "Jan 25, 2026")
 */
function formatDateForDisplay(dateStr: string): string {
  try {
    const date = new Date(dateStr + 'T00:00:00');
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

/**
 * Formats departure time for display (e.g., "9:50 PM CET")
 */
function formatDepartureTimeForDisplay(isoTime: string, timezone: string): string {
  try {
    const date = new Date(isoTime);
    const timeStr = date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: timezone,
    });
    
    // Get timezone abbreviation
    const tzFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'short',
    });
    const parts = tzFormatter.formatToParts(date);
    const tzAbbr = parts.find(p => p.type === 'timeZoneName')?.value || '';
    
    return `${timeStr} ${tzAbbr}`;
  } catch {
    return isoTime;
  }
}

/**
 * Formats the subscription response message
 */
function formatSubscriptionResponse(results: SubscriptionResult[]): string {
  const successes = results.filter(r => r.success);
  const failures = results.filter(r => !r.success);
  
  const lines: string[] = [];
  
  if (successes.length > 0) {
    if (successes.length === 1) {
      const s = successes[0];
      const info = s.flight_info!;
      lines.push(`✅ Now tracking ${s.flight_number}`);
      lines.push('');
      lines.push(`${info.departure_city || info.departure_airport} → ${info.arrival_city || info.arrival_airport}`);
      lines.push(`${formatDateForDisplay(s.date)} • Departs ${formatDepartureTimeForDisplay(info.departure_time!, info.departure_timezone!)}`);
    } else {
      lines.push(`✅ Now tracking ${successes.length} flights!`);
      lines.push('');
      successes.forEach((s, i) => {
        const info = s.flight_info!;
        lines.push(`${i + 1}. ${s.flight_number} ${info.departure_airport} → ${info.arrival_airport}`);
        lines.push(`   ${formatDateForDisplay(s.date)} • Departs ${formatDepartureTimeForDisplay(info.departure_time!, info.departure_timezone!)}`);
      });
    }
    lines.push('');
    lines.push("I'll send you updates about delays, gate changes, and more.");
  }
  
  if (failures.length > 0) {
    if (successes.length > 0) {
      lines.push('');
      lines.push('---');
      lines.push('');
    }
    
    for (const f of failures) {
      lines.push(`❌ ${f.flight_number}: ${f.message}`);
    }
  }
  
  return lines.join('\n');
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

SUBSCRIPTION INTENT DETECTION (CRITICAL):
If the user wants to TRACK, ADD, SUBSCRIBE to, or FOLLOW a flight, you MUST respond with ONLY this JSON format and nothing else:
{"intent":"subscribe","flights":[{"flight_number":"XX123","date_text":"tomorrow"}]}

Examples of subscription requests:
- "Track KL880 tomorrow" → {"intent":"subscribe","flights":[{"flight_number":"KL880","date_text":"tomorrow"}]}
- "Add flight UA123 on Jan 25" → {"intent":"subscribe","flights":[{"flight_number":"UA123","date_text":"Jan 25"}]}
- "Follow BA456 next Monday" → {"intent":"subscribe","flights":[{"flight_number":"BA456","date_text":"next Monday"}]}
- "Track KL880 tomorrow and KL881 on Jan 26" → {"intent":"subscribe","flights":[{"flight_number":"KL880","date_text":"tomorrow"},{"flight_number":"KL881","date_text":"Jan 26"}]}

IMPORTANT for subscriptions:
- Extract the EXACT flight number (letters + numbers, e.g., KL880, UA123, BA456)
- Extract the date_text EXACTLY as the user said it (e.g., "tomorrow", "Jan 25", "next Monday", "in 3 days")
- If multiple flights, include all of them in the flights array
- ONLY output the JSON, no other text, no markdown formatting

For ALL OTHER messages (questions, greetings, etc.), respond normally with text.

IMPORTANT - PRE-COMPUTED VALUES:
- All times are ALREADY converted to local timezone - use them exactly as shown
- "Time Until Departure" is already calculated - use this value directly
- "Phase" tells you what the user should be doing (Boarding, Go to Gate, Check-in Open, etc.)
- Connection analysis (if present) already has risk assessment and recommendations - use these directly
- DO NOT recalculate any times or durations - they are pre-computed and accurate

FLIGHT QUESTIONS:
- For flight questions, ALWAYS use the provided flight data - don't make up information
- If you don't have flight data for what they're asking, say so politely
- If the user has no flights tracked, let them know they can say "Track [flight] [date]" to add one
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
    const geminiResponse = await askGemini(question, flightContexts, conversationHistory);
    console.log(`Gemini response length: ${geminiResponse.length} chars`);

    // Parse the response to check for subscription intent
    const parsed = parseGeminiResponse(geminiResponse);
    
    let finalResponse: string;
    
    if (parsed.intent === 'subscribe' && parsed.flights && parsed.flights.length > 0) {
      // Handle subscription request
      console.log(`Detected subscription intent for ${parsed.flights.length} flight(s)`);
      finalResponse = await handleSubscriptionRequest(phone, parsed.flights);
    } else {
      // Regular query response
      finalResponse = parsed.text || geminiResponse;
    }

    // Save assistant's response to conversation history
    await saveConversationMessage(phone, 'assistant', finalResponse);

    // Send response
    await sendWhatsAppMessage(phone, finalResponse);

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
