import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeEvent } from 'aws-lambda';
import twilio from 'twilio';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const APP_TABLE_NAME = process.env.APP_TABLE_NAME!;

// Initialize Twilio client lazily
let twilioClient: ReturnType<typeof twilio> | null = null;

interface FlightStatusEvent {
  flight_number: string;
  date: string;
  changes: Record<string, { old: any; new: any }>;
  current_status: any;
}

interface Subscription {
  PK: string; // USER#phone
  SK: string; // SUB#date#flight
  GSI1PK: string; // FLIGHT#flight#date
  GSI1SK: string; // USER#phone
}

/**
 * Lambda handler for processing flight status changes and dispatching notifications.
 */
export const handler = async (
  event: EventBridgeEvent<'FlightStatusChanged', FlightStatusEvent>
): Promise<void> => {
  console.log('Received Flight Status Update:', JSON.stringify(event.detail));
  
  const { flight_number, date } = event.detail;
  const flightId = `FLIGHT#${flight_number}#${date}`;

  // 1. Find all subscribers for this flight
  const subscribers = await getSubscribersForFlight(flightId);
  console.log(`Found ${subscribers.length} subscribers for ${flight_number}`);

  if (subscribers.length === 0) return;

  // 2. Process each subscriber
  for (const sub of subscribers) {
    const userId = sub.PK; // USER#phone
    
    // 3. Build Trip Context
    const tripContext = await getUserTripContext(userId);
    
    // 4. Analyze Impact and generate message
    const message = analyzeImpact(event.detail, tripContext);
    
    if (message) {
      // 5. Send real WhatsApp notification via Twilio
      await sendWhatsAppNotification(userId, message);
    }
  }
};

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
 * Fetches all flight subscriptions for a specific user to understand trip context.
 */
async function getUserTripContext(userId: string): Promise<Subscription[]> {
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
 * Analyzes flight changes to determine if a notification is necessary and formats the message.
 */
function analyzeImpact(
  update: FlightStatusEvent, 
  userSubscriptions: Subscription[]
): string | null {
  const { flight_number, changes } = update;
  
  const lines: string[] = [`*Flight Update: ${flight_number}*`];
  let significantChange = false;

  if (changes.status) {
    lines.push(`📌 Status: ${changes.status.old} ➔ *${changes.status.new}*`);
    significantChange = true;
  }
  
  if (changes.estimated_departure) {
    lines.push(`🕒 New Est. Departure: *${changes.estimated_departure.new}*`);
    significantChange = true;
  }

  if (changes.gate_origin) {
    lines.push(`🚪 Gate: *${changes.gate_origin.new}*`);
    significantChange = true;
  }

  // Simple Trip Context Logic
  if (userSubscriptions.length > 1) {
    lines.push('');
    lines.push(`⚠️ _You have ${userSubscriptions.length - 1} other flight(s) in your trip. Please check your connection times._`);
  }

  return significantChange ? lines.join('\n') : null;
}

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
    return;
  }

  if (!twilioClient) {
    twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  }

  try {
    const result = await twilioClient.messages.create({
      body: message,
      from: TWILIO_FROM_NUMBER, // Should be 'whatsapp:+...'
      to: to,
    });
    console.log(`Successfully sent WhatsApp message to ${to}. SID: ${result.sid}`);
  } catch (error) {
    console.error(`Failed to send WhatsApp message to ${to}:`, error);
    throw error; // Rethrow to trigger Lambda retry/DLQ
  }
}