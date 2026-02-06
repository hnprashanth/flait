import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeEvent } from 'aws-lambda';
import twilio from 'twilio';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const APP_TABLE_NAME = process.env.APP_TABLE_NAME!;
const FLIGHT_TABLE_NAME = process.env.FLIGHT_TABLE_NAME!;

// Initialize Twilio client lazily
let twilioClient: ReturnType<typeof twilio> | null = null;

// --- Type Definitions ---

type MilestoneType = 'checkin' | '24h' | '12h' | '4h' | 'boarding' | 'pre-landing';
type UpdateType = 'milestone' | 'change' | 'combined' | 'inbound-delay' | 'inbound-landed';
type RiskLevel = 'safe' | 'moderate' | 'tight' | 'critical';

interface FlightChange {
  old: unknown;
  new: unknown;
}

interface InboundFlightInfo {
  flight_number: string;
  origin: string;
  origin_city?: string;
  status: string;
  scheduled_arrival?: string;
  estimated_arrival?: string;
  actual_arrival?: string;
  delay_minutes: number;
}

interface FlightUpdateEvent {
  flight_number: string;
  date: string;
  update_type: UpdateType;
  milestone?: MilestoneType;
  changes?: Record<string, FlightChange>;
  current_status: FlightStatus;
  inbound_info?: InboundFlightInfo;
}

interface FlightStatus {
  flight_number?: string;
  date?: string;
  status?: string;
  departure_airport?: string;
  arrival_airport?: string;
  departure_timezone?: string;
  arrival_timezone?: string;
  departure_city?: string;
  arrival_city?: string;
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
}

interface Subscription {
  PK: string; // USER#phone
  SK: string; // SUB#date#flight
  GSI1PK: string; // FLIGHT#flight#date
  GSI1SK: string; // USER#phone
}

interface ConnectionAnalysis {
  fromFlight: string;
  toFlight: string;
  connectionMinutes: number;
  layoverAirport: string;
  terminalChange: boolean;
  fromTerminal?: string;
  toTerminal?: string;
  fromGate?: string;
  toGate?: string;
  riskLevel: RiskLevel;
  riskMessage: string;
}

interface TripContext {
  subscriptions: Subscription[];
  flightData: Map<string, FlightStatus>;
  connections: ConnectionAnalysis[];
}

// --- Main Handler ---

/**
 * Lambda handler for processing flight updates and dispatching notifications.
 * Handles milestone events, change events, and combined events.
 */
export const handler = async (
  event: EventBridgeEvent<'FlightUpdate', FlightUpdateEvent>
): Promise<void> => {
  console.log('Received Flight Update:', JSON.stringify(event.detail));

  const { flight_number, date } = event.detail;
  const flightId = `FLIGHT#${flight_number}#${date}`;

  // 1. Find all subscribers for this flight
  const subscribers = await getSubscribersForFlight(flightId);
  console.log(`Found ${subscribers.length} subscribers for ${flight_number}`);

  if (subscribers.length === 0) return;

  // 2. Process each subscriber
  for (const sub of subscribers) {
    const userId = sub.PK; // USER#phone

    // 3. Build full trip context with flight data
    const tripContext = await buildTripContext(userId);

    // 4. Generate message based on event type and trip context
    const message = generateNotificationMessage(event.detail, tripContext);

    if (message) {
      // 5. Send WhatsApp notification via Twilio
      await sendWhatsAppNotification(userId, message);
    }
  }
};

// --- Data Fetching Functions ---

/**
 * Fetches all subscribers for a specific flight from the GSI.
 */
async function getSubscribersForFlight(flightId: string): Promise<Subscription[]> {
  const response = await docClient.send(new QueryCommand({
    TableName: APP_TABLE_NAME,
    IndexName: 'flight-subscribers-index',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: {
      ':pk': flightId,
    },
  }));

  return (response.Items as Subscription[]) || [];
}

/**
 * Fetches all flight subscriptions for a user.
 */
async function getUserSubscriptions(userId: string): Promise<Subscription[]> {
  const response = await docClient.send(new QueryCommand({
    TableName: APP_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
    ExpressionAttributeValues: {
      ':pk': userId,
      ':skPrefix': 'SUB#',
    },
  }));

  return (response.Items as Subscription[]) || [];
}

/**
 * Fetches the latest flight data from the flight-data table.
 */
async function getLatestFlightData(flightNumber: string, date: string): Promise<FlightStatus | null> {
  const partitionKey = `${flightNumber}#${date}`;

  const response = await docClient.send(new QueryCommand({
    TableName: FLIGHT_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: {
      ':pk': partitionKey,
    },
    ScanIndexForward: false, // Descending order (latest first)
    Limit: 1,
  }));

  if (response.Items && response.Items.length > 0) {
    return response.Items[0] as FlightStatus;
  }

  return null;
}

/**
 * Builds complete trip context including flight data and connection analysis.
 */
async function buildTripContext(userId: string): Promise<TripContext> {
  const subscriptions = await getUserSubscriptions(userId);
  const flightData = new Map<string, FlightStatus>();

  // Fetch flight data for all subscriptions
  for (const sub of subscriptions) {
    // Parse flight info from SK: SUB#date#flight
    const skParts = sub.SK.split('#');
    if (skParts.length >= 3) {
      const date = skParts[1];
      const flightNumber = skParts.slice(2).join('#'); // Handle flight numbers with #

      // Skip stale subscriptions - only include flights from yesterday onwards
      const flightDate = new Date(date);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 1);
      cutoff.setHours(0, 0, 0, 0);
      if (flightDate < cutoff) continue;

      const key = `${flightNumber}#${date}`;

      const data = await getLatestFlightData(flightNumber, date);
      if (data) {
        flightData.set(key, data);
      }
    }
  }

  // Analyze connections between flights
  const connections = analyzeConnections(Array.from(flightData.values()));

  return { subscriptions, flightData, connections };
}

// --- Connection Analysis ---

/**
 * Analyzes connections between flights in a trip.
 * Detects connecting flights (arrival airport = departure airport, within 24h).
 */
function analyzeConnections(flights: FlightStatus[]): ConnectionAnalysis[] {
  if (flights.length < 2) return [];

  // Sort by departure time
  const sorted = [...flights]
    .filter(f => f.scheduled_departure || f.estimated_departure)
    .sort((a, b) => {
      const timeA = new Date(a.estimated_departure || a.scheduled_departure || '').getTime();
      const timeB = new Date(b.estimated_departure || b.scheduled_departure || '').getTime();
      return timeA - timeB;
    });

  const connections: ConnectionAnalysis[] = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    const arriving = sorted[i];
    const departing = sorted[i + 1];

    // Check if arrival airport matches departure airport of next flight
    if (arriving.arrival_airport && departing.departure_airport &&
        arriving.arrival_airport === departing.departure_airport) {
      
      const arrivalTime = arriving.estimated_arrival || arriving.scheduled_arrival;
      const departureTime = departing.estimated_departure || departing.scheduled_departure;

      if (arrivalTime && departureTime) {
        const arrivalDate = new Date(arrivalTime);
        const departureDate = new Date(departureTime);
        const hoursBetween = (departureDate.getTime() - arrivalDate.getTime()) / (1000 * 60 * 60);

        // Connection if within 24 hours and arrival is before departure
        if (hoursBetween > 0 && hoursBetween <= 24) {
          connections.push(calculateConnectionRisk(arriving, departing));
        }
      }
    }
  }

  return connections;
}

/**
 * Calculates connection risk based on time and terminal change.
 */
function calculateConnectionRisk(arriving: FlightStatus, departing: FlightStatus): ConnectionAnalysis {
  const arrivalTime = new Date(arriving.estimated_arrival || arriving.scheduled_arrival || '');
  const departureTime = new Date(departing.estimated_departure || departing.scheduled_departure || '');
  const connectionMinutes = Math.round((departureTime.getTime() - arrivalTime.getTime()) / (1000 * 60));

  const terminalChange = !!(
    arriving.terminal_destination &&
    departing.terminal_origin &&
    arriving.terminal_destination !== departing.terminal_origin
  );

  let riskLevel: RiskLevel;
  let riskMessage: string;

  if (connectionMinutes < 30) {
    riskLevel = 'critical';
    riskMessage = `Only ${connectionMinutes} min - extremely tight!`;
  } else if (connectionMinutes < 60 && terminalChange) {
    riskLevel = 'tight';
    riskMessage = `${connectionMinutes} min with terminal change - tight`;
  } else if (connectionMinutes < 60) {
    riskLevel = 'moderate';
    riskMessage = `${connectionMinutes} min - manageable`;
  } else if (connectionMinutes < 90 && terminalChange) {
    riskLevel = 'moderate';
    riskMessage = `${connectionMinutes} min with terminal change - allow extra time`;
  } else {
    riskLevel = 'safe';
    riskMessage = `${connectionMinutes} min - comfortable`;
  }

  return {
    fromFlight: arriving.flight_number || 'Unknown',
    toFlight: departing.flight_number || 'Unknown',
    connectionMinutes,
    layoverAirport: arriving.arrival_airport || 'Unknown',
    terminalChange,
    fromTerminal: arriving.terminal_destination,
    toTerminal: departing.terminal_origin,
    fromGate: arriving.gate_destination,
    toGate: departing.gate_origin,
    riskLevel,
    riskMessage,
  };
}

// --- Message Generation ---

/**
 * Generates notification message based on event type and trip context.
 */
function generateNotificationMessage(
  update: FlightUpdateEvent,
  tripContext: TripContext
): string | null {
  const { flight_number, update_type, milestone, changes, current_status, inbound_info } = update;

  // Find relevant connection for this flight
  const relevantConnection = tripContext.connections.find(
    c => c.fromFlight === flight_number || c.toFlight === flight_number
  );

  let message: string;

  switch (update_type) {
    case 'milestone':
      message = generateMilestoneMessage(flight_number, milestone!, current_status, relevantConnection);
      break;
    case 'change':
      message = generateChangeMessage(flight_number, changes!, current_status, relevantConnection);
      break;
    case 'combined':
      message = generateCombinedMessage(flight_number, milestone!, changes!, current_status, relevantConnection);
      break;
    case 'inbound-delay':
      message = generateInboundDelayMessage(flight_number, inbound_info!, current_status);
      break;
    case 'inbound-landed':
      message = generateInboundLandedMessage(flight_number, inbound_info!, current_status);
      break;
    default:
      return null;
  }

  return message;
}

/**
 * Generates message for milestone-only events.
 */
function generateMilestoneMessage(
  flightNumber: string,
  milestone: MilestoneType,
  status: FlightStatus,
  connection?: ConnectionAnalysis
): string {
  const lines: string[] = [];
  const departureTime = formatTime(status.estimated_departure || status.scheduled_departure, status.departure_timezone);
  const arrivalTime = formatTime(status.estimated_arrival || status.scheduled_arrival, status.arrival_timezone);
  const departureLocation = status.departure_city || status.departure_airport || '';
  const arrivalLocation = status.arrival_city || status.arrival_airport || '';

  switch (milestone) {
    case 'checkin':
      lines.push(`*Check-in Open: ${flightNumber}*`);
      lines.push('');
      lines.push('Online check-in is now available!');
      lines.push('');
      lines.push(`Departure: ${departureTime}`);
      if (departureLocation) lines.push(`From: ${departureLocation}`);
      if (status.gate_origin) lines.push(`Gate: ${status.gate_origin}`);
      if (status.terminal_origin) lines.push(`Terminal: ${status.terminal_origin}`);
      break;

    case '24h':
      lines.push(`*${flightNumber} - 24 Hours to Departure*`);
      lines.push('');
      lines.push(`Status: ${status.status || 'On Time'}`);
      lines.push(`Departure: ${departureTime}`);
      if (departureLocation) lines.push(`From: ${departureLocation}`);
      if (status.gate_origin) lines.push(`Gate: ${status.gate_origin}`);
      break;

    case '12h':
      lines.push(`*${flightNumber} - 12 Hours to Go*`);
      lines.push('');
      lines.push(`Status: ${status.status || 'On Time'}`);
      lines.push(`Departure: ${departureTime}`);
      if (status.gate_origin) lines.push(`Gate: ${status.gate_origin}`);
      break;

    case '4h':
      lines.push(`*${flightNumber} - 4 Hours to Departure*`);
      lines.push('');
      lines.push('Time to head to the airport!');
      lines.push('');
      lines.push(`Status: ${status.status || 'On Time'}`);
      lines.push(`Departure: ${departureTime}`);
      if (status.gate_origin) lines.push(`Gate: ${status.gate_origin}`);
      if (status.terminal_origin) lines.push(`Terminal: ${status.terminal_origin}`);
      break;

    case 'boarding':
      lines.push(`*${flightNumber} - Boarding Soon*`);
      lines.push('');
      lines.push('Boarding begins in approximately 30 minutes.');
      lines.push('');
      if (status.gate_origin) lines.push(`Gate: ${status.gate_origin}`);
      if (status.terminal_origin) lines.push(`Terminal: ${status.terminal_origin}`);
      break;

    case 'pre-landing':
      lines.push(`*Landing in ~1 Hour*`);
      lines.push('');
      lines.push(`Your flight ${flightNumber} is approaching ${arrivalLocation || 'destination'}.`);
      lines.push(`Expected arrival: ${arrivalTime}`);
      if (status.gate_destination) lines.push(`Arrival gate: ${status.gate_destination}`);
      if (status.baggage_claim) lines.push(`Baggage claim: ${status.baggage_claim}`);
      break;
  }

  // Add connection info if available
  if (connection) {
    lines.push('');
    lines.push(formatConnectionInfo(connection, flightNumber, milestone));
  }

  return lines.join('\n');
}

/**
 * Generates message for change-only events.
 */
function generateChangeMessage(
  flightNumber: string,
  changes: Record<string, FlightChange>,
  status: FlightStatus,
  connection?: ConnectionAnalysis
): string {
  const lines: string[] = [`*Flight Update: ${flightNumber}*`];
  lines.push('');

  let hasSpecificChanges = false;
  const departureLocation = status.departure_city || status.departure_airport || '';
  const arrivalLocation = status.arrival_city || status.arrival_airport || '';

  if (changes.status) {
    lines.push(`Status: ${changes.status.old || 'Unknown'} → *${changes.status.new}*`);
    hasSpecificChanges = true;
  }

  if (changes.estimated_departure) {
    const oldTime = formatTime(changes.estimated_departure.old as string, status.departure_timezone);
    const newTime = formatTime(changes.estimated_departure.new as string, status.departure_timezone);
    const diff = formatTimeDiff(changes.estimated_departure.old as string, changes.estimated_departure.new as string);
    lines.push(`Departure: ${oldTime} → *${newTime}* (${diff})`);
    hasSpecificChanges = true;
  }

  if (changes.estimated_arrival) {
    const oldTime = formatTime(changes.estimated_arrival.old as string, status.arrival_timezone);
    const newTime = formatTime(changes.estimated_arrival.new as string, status.arrival_timezone);
    const diff = formatTimeDiff(changes.estimated_arrival.old as string, changes.estimated_arrival.new as string);
    lines.push(`Arrival: ${oldTime} → *${newTime}* (${diff})`);
    hasSpecificChanges = true;
  }

  if (changes.gate_origin) {
    lines.push(`Gate changed: ${changes.gate_origin.old || 'TBD'} → *${changes.gate_origin.new}*`);
    hasSpecificChanges = true;
  }

  if (changes.gate_destination) {
    lines.push(`Arrival gate: *${changes.gate_destination.new}*`);
    hasSpecificChanges = true;
  }

  if (changes.baggage_claim) {
    if (changes.baggage_claim.old) {
      lines.push(`Baggage claim changed: ${changes.baggage_claim.old} → *${changes.baggage_claim.new}*`);
    } else {
      lines.push(`Baggage claim: *${changes.baggage_claim.new}*`);
      if (status.terminal_destination) lines.push(`Terminal: ${status.terminal_destination}`);
      if (status.gate_destination) lines.push(`Arrival gate: ${status.gate_destination}`);
    }
    hasSpecificChanges = true;
  }

  // If no specific user-facing changes, add current flight info
  if (!hasSpecificChanges) {
    lines.push('Your flight details:');
    lines.push('');
    if (status.status) lines.push(`Status: *${status.status}*`);
    if (departureLocation && arrivalLocation) {
      lines.push(`Route: ${departureLocation} → ${arrivalLocation}`);
    }
    lines.push(`Departure: *${formatTime(status.estimated_departure || status.scheduled_departure, status.departure_timezone)}*`);
    lines.push(`Arrival: *${formatDateTime(status.estimated_arrival || status.scheduled_arrival, status.arrival_timezone)}*`);
    if (status.gate_origin) lines.push(`Gate: ${status.gate_origin}`);
  }

  // Add connection impact if relevant
  if (connection) {
    lines.push('');
    lines.push(formatConnectionInfo(connection, flightNumber));
  }

  return lines.join('\n');
}

/**
 * Generates message for combined milestone + change events.
 */
function generateCombinedMessage(
  flightNumber: string,
  milestone: MilestoneType,
  changes: Record<string, FlightChange>,
  status: FlightStatus,
  connection?: ConnectionAnalysis
): string {
  const lines: string[] = [];

  // Start with milestone header
  const milestoneHeader = getMilestoneHeader(flightNumber, milestone);
  lines.push(milestoneHeader);
  lines.push('');

  // Add changes
  if (Object.keys(changes).length > 0) {
    lines.push('*Updates:*');
    if (changes.status) {
      lines.push(`Status: ${changes.status.old} → *${changes.status.new}*`);
    }
    if (changes.estimated_departure) {
      const oldTime = formatTime(changes.estimated_departure.old as string, status.departure_timezone);
      const newTime = formatTime(changes.estimated_departure.new as string, status.departure_timezone);
      const diff = formatTimeDiff(changes.estimated_departure.old as string, changes.estimated_departure.new as string);
      lines.push(`Departure: ${oldTime} → *${newTime}* (${diff})`);
    }
    if (changes.estimated_arrival) {
      const oldTime = formatTime(changes.estimated_arrival.old as string, status.arrival_timezone);
      const newTime = formatTime(changes.estimated_arrival.new as string, status.arrival_timezone);
      const diff = formatTimeDiff(changes.estimated_arrival.old as string, changes.estimated_arrival.new as string);
      lines.push(`Arrival: ${oldTime} → *${newTime}* (${diff})`);
    }
    if (changes.gate_origin) {
      lines.push(`Gate: ${changes.gate_origin.old || 'TBD'} → *${changes.gate_origin.new}*`);
    }
    lines.push('');
  }

  // Add current status summary
  lines.push('*Current Status:*');
  lines.push(`Departure: ${formatTime(status.estimated_departure || status.scheduled_departure, status.departure_timezone)}`);
  if (status.gate_origin) lines.push(`Gate: ${status.gate_origin}`);
  if (status.status) lines.push(`Status: ${status.status}`);

  // Add connection info
  if (connection) {
    lines.push('');
    lines.push(formatConnectionInfo(connection, flightNumber, milestone));
  }

  return lines.join('\n');
}

/**
 * Returns appropriate header for milestone type.
 */
function getMilestoneHeader(flightNumber: string, milestone: MilestoneType): string {
  switch (milestone) {
    case 'checkin': return `*Check-in Open: ${flightNumber}*`;
    case '24h': return `*${flightNumber} - 24 Hours to Departure*`;
    case '12h': return `*${flightNumber} - 12 Hours to Go*`;
    case '4h': return `*${flightNumber} - 4 Hours to Departure*`;
    case 'boarding': return `*${flightNumber} - Boarding Soon*`;
    case 'pre-landing': return `*${flightNumber} - Landing Soon*`;
    default: return `*${flightNumber} Update*`;
  }
}

/**
 * Formats connection information for notification.
 * @param connection - The connection analysis
 * @param currentFlight - The flight this notification is about (to determine direction)
 * @param milestone - Optional milestone type
 */
function formatConnectionInfo(
  connection: ConnectionAnalysis, 
  currentFlight: string,
  milestone?: MilestoneType
): string {
  const lines: string[] = [];
  const hours = Math.floor(connection.connectionMinutes / 60);
  const mins = connection.connectionMinutes % 60;
  const timeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

  // Risk emoji based on level
  const riskEmoji = {
    safe: '',
    moderate: '',
    tight: '',
    critical: '',
  }[connection.riskLevel];

  // Determine if this notification is about the arriving or departing flight
  const isArrivingFlight = connection.fromFlight === currentFlight;
  
  if (isArrivingFlight) {
    // Notification is about the first leg - show connection TO the next flight
    lines.push(`${riskEmoji} *Connection to ${connection.toFlight}*`);
  } else {
    // Notification is about the second leg - show connection FROM the previous flight
    lines.push(`${riskEmoji} *Connection from ${connection.fromFlight}*`);
  }
  
  lines.push(`Time: ${timeStr} (${connection.riskMessage})`);

  if (connection.terminalChange) {
    lines.push(`Terminal change: ${connection.fromTerminal || '?'} ➔ ${connection.toTerminal || '?'}`);
  }

  if (milestone === 'pre-landing' && connection.toGate && isArrivingFlight) {
    lines.push(`Next gate: ${connection.toGate}`);
  }

  return lines.join('\n');
}

/**
 * Generates message for inbound aircraft delay.
 */
function generateInboundDelayMessage(
  flightNumber: string,
  inboundInfo: InboundFlightInfo,
  status: FlightStatus
): string {
  const lines: string[] = [];
  
  lines.push(`⚠️ *Inbound Aircraft Update: ${flightNumber}*`);
  lines.push('');
  lines.push(`Your aircraft is on its way from ${inboundInfo.origin_city || inboundInfo.origin} as flight ${inboundInfo.flight_number}.`);
  lines.push('');
  
  lines.push(`Status: *${inboundInfo.status}*`);
  
  const arrivalTime = inboundInfo.estimated_arrival || inboundInfo.scheduled_arrival;
  if (arrivalTime) {
    lines.push(`Expected at ${status.departure_airport || 'airport'}: *${formatTime(arrivalTime, status.departure_timezone)}*`);
  }
  
  // Format delay nicely
  const delayHours = Math.floor(inboundInfo.delay_minutes / 60);
  const delayMins = inboundInfo.delay_minutes % 60;
  let delayStr = '';
  if (delayHours > 0) {
    delayStr = `${delayHours}h ${delayMins}m`;
  } else {
    delayStr = `${delayMins} minutes`;
  }
  lines.push(`Current delay: *${delayStr} late*`);
  
  lines.push('');
  lines.push('This may affect your departure. We\'ll keep you updated.');
  
  return lines.join('\n');
}

/**
 * Generates message for inbound aircraft landed.
 */
function generateInboundLandedMessage(
  flightNumber: string,
  inboundInfo: InboundFlightInfo,
  status: FlightStatus
): string {
  const lines: string[] = [];
  
  lines.push(`✅ *Good news for ${flightNumber}!*`);
  lines.push('');
  lines.push(`Your aircraft has landed at ${status.departure_airport || 'the airport'} from ${inboundInfo.origin_city || inboundInfo.origin} (flight ${inboundInfo.flight_number}).`);
  lines.push('');
  
  if (inboundInfo.actual_arrival) {
    lines.push(`Arrived: ${formatTime(inboundInfo.actual_arrival, status.departure_timezone)}`);
  }
  
  lines.push('');
  lines.push('The crew will now prepare for your flight.');
  
  // Add scheduled departure reminder
  const departureTime = status.estimated_departure || status.scheduled_departure;
  if (departureTime) {
    lines.push(`Your scheduled departure: ${formatTime(departureTime, status.departure_timezone)}`);
  }
  
  return lines.join('\n');
}

/**
 * Calculates the time difference between two ISO timestamps.
 * Returns human-readable string like "+45m" or "-1h 30m"
 */
function formatTimeDiff(oldTime: string, newTime: string): string {
  try {
    const oldDate = new Date(oldTime).getTime();
    const newDate = new Date(newTime).getTime();
    const diffMs = newDate - oldDate;
    const absDiffMs = Math.abs(diffMs);
    
    const hours = Math.floor(absDiffMs / (1000 * 60 * 60));
    const minutes = Math.floor((absDiffMs % (1000 * 60 * 60)) / (1000 * 60));
    
    const sign = diffMs >= 0 ? '+' : '-';
    
    if (hours === 0 && minutes === 0) {
      return 'no change';
    } else if (hours === 0) {
      return `${sign}${minutes}m`;
    } else if (minutes === 0) {
      return `${sign}${hours}h`;
    } else {
      return `${sign}${hours}h ${minutes}m`;
    }
  } catch {
    return '';
  }
}

/**
 * Formats ISO timestamp to readable local time.
 * @param isoString - ISO timestamp string
 * @param timezone - IANA timezone (e.g., 'Asia/Kolkata', 'Europe/Amsterdam')
 */
function formatTime(isoString?: string, timezone?: string): string {
  if (!isoString) return 'TBD';
  
  try {
    const date = new Date(isoString);
    
    // Use provided timezone, or fall back to UTC
    const options: Intl.DateTimeFormatOptions = {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZone: timezone || 'UTC',
    };
    
    const timeStr = date.toLocaleTimeString('en-US', options);
    
    // Add timezone abbreviation or city name for clarity
    if (timezone) {
      // Get short timezone name
      const tzOptions: Intl.DateTimeFormatOptions = {
        timeZone: timezone,
        timeZoneName: 'short',
      };
      const tzParts = date.toLocaleTimeString('en-US', tzOptions).split(' ');
      const tzAbbr = tzParts[tzParts.length - 1]; // Last part is timezone
      return `${timeStr} ${tzAbbr}`;
    }
    
    return `${timeStr} UTC`;
  } catch {
    return isoString;
  }
}

/**
 * Formats a date with day info for arrivals that may be next day.
 */
function formatDateTime(isoString?: string, timezone?: string): string {
  if (!isoString) return 'TBD';
  
  try {
    const date = new Date(isoString);
    
    const options: Intl.DateTimeFormatOptions = {
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZone: timezone || 'UTC',
    };
    
    const timeStr = date.toLocaleString('en-US', options);
    
    if (timezone) {
      const tzOptions: Intl.DateTimeFormatOptions = {
        timeZone: timezone,
        timeZoneName: 'short',
      };
      const tzParts = date.toLocaleTimeString('en-US', tzOptions).split(' ');
      const tzAbbr = tzParts[tzParts.length - 1];
      return `${timeStr} ${tzAbbr}`;
    }
    
    return `${timeStr} UTC`;
  } catch {
    return isoString;
  }
}

// --- WhatsApp Notification ---

/**
 * Sends a WhatsApp message using the Twilio API.
 */
async function sendWhatsAppNotification(userId: string, message: string): Promise<void> {
  const phone = userId.replace('USER#', '');

  const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
  const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
  let TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;

  if (TWILIO_FROM_NUMBER && !TWILIO_FROM_NUMBER.startsWith('whatsapp:')) {
    TWILIO_FROM_NUMBER = `whatsapp:${TWILIO_FROM_NUMBER}`;
  }

  // Ensure phone number starts with + for Twilio
  const formattedPhone = phone.startsWith('+') ? phone : `+${phone}`;
  const to = `whatsapp:${formattedPhone}`;

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
    console.error('Twilio credentials missing. Skipping notification.');
    console.log('Would have sent message:', message);
    return;
  }

  if (!twilioClient) {
    twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  }

  try {
    const TWILIO_CONTENT_SID = process.env.TWILIO_CONTENT_SID;

    let result;
    if (TWILIO_CONTENT_SID) {
      try {
        // Use pre-approved template — works outside the 24h session window
        // Sanitize: collapse 3+ consecutive newlines to 2 (WhatsApp limit)
        const sanitized = message.replace(/\n{3,}/g, '\n\n');
        result = await twilioClient.messages.create({
          contentSid: TWILIO_CONTENT_SID,
          contentVariables: JSON.stringify({ '1': sanitized }),
          from: TWILIO_FROM_NUMBER,
          to: to,
        });
      } catch (templateError) {
        // Template send failed — fall back to free-form body
        console.warn(`Template send failed, falling back to body message:`, templateError);
        result = await twilioClient.messages.create({
          body: message,
          from: TWILIO_FROM_NUMBER,
          to: to,
        });
      }
    } else {
      result = await twilioClient.messages.create({
        body: message,
        from: TWILIO_FROM_NUMBER,
        to: to,
      });
    }
    console.log(`Successfully sent WhatsApp message to ${to}. SID: ${result.sid}`);
  } catch (error) {
    console.error(`Failed to send WhatsApp message to ${to}:`, error);
    throw error; // Rethrow to trigger Lambda retry/DLQ
  }
}

// --- Test Exports ---
// Export internal functions for unit testing
export const _testExports = {
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
};
