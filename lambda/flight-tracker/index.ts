import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const eventBridgeClient = new EventBridgeClient({});
const lambdaClient = new LambdaClient({});

const TABLE_NAME = process.env.TABLE_NAME!;
const FLIGHTAWARE_API_KEY = process.env.FLIGHTAWARE_API_KEY!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;
const SCHEDULE_TRACKER_FUNCTION_NAME = process.env.SCHEDULE_TRACKER_FUNCTION_NAME;

/**
 * Returns the next day in YYYY-MM-DD format
 */
function getNextDay(dateStr: string): string {
  const date = new Date(dateStr);
  date.setDate(date.getDate() + 1);
  return date.toISOString().split('T')[0];
}

interface FlightRequest {
  flight_number: string;
  date: string; // Format: YYYY-MM-DD
  fa_flight_id?: string; // FlightAware unique flight ID for precise tracking
}

interface FlightAwareResponse {
  // FlightAware API response structure
  // This will vary based on the actual API endpoint used
  [key: string]: any;
}

/** Milestone types for proactive notifications */
type MilestoneType = 'checkin' | '24h' | '12h' | '4h' | 'boarding' | 'pre-landing';

interface MilestoneResult {
  milestone: MilestoneType;
  hoursRemaining: number;
}

interface FlightChange {
  old: unknown;
  new: unknown;
}

interface FlightUpdateEvent {
  flight_number: string;
  date: string;
  update_type: 'milestone' | 'change' | 'combined';
  milestone?: MilestoneType;
  changes?: Record<string, FlightChange>;
  current_status: Record<string, unknown>;
}

/**
 * Fetches flight information from FlightAware AeroAPI v4
 * Documentation: https://flightaware.com/aeroapi/
 * 
 * @param flightNumber - Flight ident (e.g., "KL880")
 * @param date - Flight date in YYYY-MM-DD format
 * @param faFlightId - Optional FlightAware unique flight ID for precise tracking
 */
async function fetchFlightInfo(flightNumber: string, date: string, faFlightId?: string): Promise<FlightAwareResponse> {
  if (!FLIGHTAWARE_API_KEY) {
    throw new Error('FlightAware API key not configured');
  }

  let url: string;

  if (faFlightId) {
    // Use precise fa_flight_id query for exact flight tracking
    // This ensures we always get the same flight instance
    url = `https://aeroapi.flightaware.com/aeroapi/flights/${encodeURIComponent(faFlightId)}`;
    console.log(`Fetching flight by fa_flight_id: ${faFlightId}`);
  } else {
    // Fall back to date-filtered ident query
    // Add date range to filter for the specific flight date
    const startDate = date; // e.g., "2026-01-21"
    const endDate = getNextDay(date); // e.g., "2026-01-22"
    url = `https://aeroapi.flightaware.com/aeroapi/flights/${encodeURIComponent(flightNumber)}?start=${startDate}&end=${endDate}`;
    console.log(`Fetching flight by ident with date filter: ${flightNumber} from ${startDate} to ${endDate}`);
  }
  
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'x-apikey': FLIGHTAWARE_API_KEY,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`FlightAware API error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const data = await response.json() as FlightAwareResponse;
  
  // AeroAPI v4 returns data in a specific format
  // Adjust this based on actual API response structure
  // The response structure will vary based on the endpoint used
  return data;
}

/**
 * Fetches the latest flight data from DynamoDB for a given flight number and date
 */
async function getLatestFlightData(flightNumber: string, date: string): Promise<Record<string, any> | null> {
  const partitionKey = `${flightNumber}#${date}`;
  
  const response = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': partitionKey,
      },
      ScanIndexForward: false, // Descending order (latest first)
      Limit: 1,
    })
  );

  if (response.Items && response.Items.length > 0) {
    return response.Items[0];
  }
  
  return null;
}

/**
 * Detects milestones based on time to departure/arrival.
 * Returns milestones that should be triggered (not previously sent).
 * @param departureTime - Scheduled or estimated departure time
 * @param arrivalTime - Scheduled or estimated arrival time (optional)
 * @param previousMilestones - Array of milestones already sent for this flight
 * @param now - Current time (defaults to now, injectable for testing)
 */
function detectMilestones(
  departureTime: Date,
  arrivalTime: Date | null,
  previousMilestones: MilestoneType[],
  now: Date = new Date()
): MilestoneResult[] {
  const milestones: MilestoneResult[] = [];
  const hoursToDeparture = (departureTime.getTime() - now.getTime()) / (1000 * 60 * 60);

  // Check-in reminder: at 24h mark (±30 min window to catch it during polling)
  if (hoursToDeparture <= 24.5 && hoursToDeparture >= 23.5 && !previousMilestones.includes('checkin')) {
    milestones.push({ milestone: 'checkin', hoursRemaining: hoursToDeparture });
  }

  // 24h milestone: when we cross into 24h window (but not at exact checkin time)
  if (hoursToDeparture <= 24 && hoursToDeparture > 12 && !previousMilestones.includes('24h')) {
    milestones.push({ milestone: '24h', hoursRemaining: hoursToDeparture });
  }

  // 12h milestone
  if (hoursToDeparture <= 12 && hoursToDeparture > 4 && !previousMilestones.includes('12h')) {
    milestones.push({ milestone: '12h', hoursRemaining: hoursToDeparture });
  }

  // 4h milestone
  if (hoursToDeparture <= 4 && hoursToDeparture > 0.6 && !previousMilestones.includes('4h')) {
    milestones.push({ milestone: '4h', hoursRemaining: hoursToDeparture });
  }

  // Boarding soon: ~30-35 min before departure
  if (hoursToDeparture <= 0.6 && hoursToDeparture > 0 && !previousMilestones.includes('boarding')) {
    milestones.push({ milestone: 'boarding', hoursRemaining: hoursToDeparture });
  }

  // Pre-landing: 1h before arrival (flight must be in the air)
  if (arrivalTime && hoursToDeparture < 0) {
    const hoursToArrival = (arrivalTime.getTime() - now.getTime()) / (1000 * 60 * 60);
    if (hoursToArrival <= 1.1 && hoursToArrival > 0 && !previousMilestones.includes('pre-landing')) {
      milestones.push({ milestone: 'pre-landing', hoursRemaining: hoursToArrival });
    }
  }

  return milestones;
}

/**
 * Extracts departure and arrival times from flight data
 */
function extractFlightTimes(flightData: Record<string, unknown>): { departure: Date | null; arrival: Date | null } {
  // Try estimated first, then scheduled
  const departureStr = (flightData.estimated_departure || flightData.scheduled_departure) as string | undefined;
  const arrivalStr = (flightData.estimated_arrival || flightData.scheduled_arrival) as string | undefined;

  return {
    departure: departureStr ? new Date(departureStr) : null,
    arrival: arrivalStr ? new Date(arrivalStr) : null,
  };
}

/**
 * Compares old and new flight data to detect meaningful changes
 */
function compareFlightData(oldData: Record<string, any>, newData: FlightAwareResponse): Record<string, FlightChange> {
  const changes: Record<string, FlightChange> = {};
  
  // Extract fields from new data using the same logic as storage
  const newFields = extractFlightFields(newData);
  
  // Fields to monitor for changes
  const fieldsToMonitor = [
    'status',
    'scheduled_departure',
    'estimated_departure',
    'actual_departure',
    'scheduled_arrival',
    'estimated_arrival',
    'actual_arrival',
    'departure_airport',
    'arrival_airport',
    'gate_origin',
    'gate_destination'
  ];

  // If we don't have old data, everything is new, but we might not want to alert on initial creation
  // or maybe we do. For now, let's assume we only alert on changes if old record exists.
  
  for (const field of fieldsToMonitor) {
    const oldValue = oldData[field];
    const newValue = newFields[field];
    
    // Simple equality check (works for strings and numbers)
    // For dates, we might want to allow some tolerance, but exact string match is a safe start
    if (oldValue !== newValue) {
      // If both are null/undefined, no change
      if (!oldValue && !newValue) continue;
      
      changes[field] = {
        old: oldValue,
        new: newValue
      };
    }
  }
  
  return changes;
}

/** Minimum time change (in minutes) to trigger schedule recalculation */
const SCHEDULE_RECALC_THRESHOLD_MINUTES = 30;

/**
 * Checks if departure time has changed significantly and triggers schedule recalculation
 * @param changes - Detected flight changes
 * @param flightNumber - Flight identifier
 * @param date - Flight date
 * @param faFlightId - FlightAware unique flight ID
 * @returns true if recalculation was triggered
 */
async function checkAndRecalculateSchedules(
  changes: Record<string, FlightChange>,
  flightNumber: string,
  date: string,
  faFlightId: string | undefined
): Promise<boolean> {
  if (!SCHEDULE_TRACKER_FUNCTION_NAME) {
    console.log('SCHEDULE_TRACKER_FUNCTION_NAME not configured, skipping schedule recalculation');
    return false;
  }

  // Check for significant departure time changes
  const departureFields = ['estimated_departure', 'scheduled_departure'];
  
  for (const field of departureFields) {
    if (changes[field]) {
      const oldTime = changes[field].old as string | undefined;
      const newTime = changes[field].new as string | undefined;
      
      if (oldTime && newTime) {
        const oldDate = new Date(oldTime);
        const newDate = new Date(newTime);
        const diffMinutes = Math.abs(newDate.getTime() - oldDate.getTime()) / (1000 * 60);
        
        if (diffMinutes >= SCHEDULE_RECALC_THRESHOLD_MINUTES) {
          console.log(`Significant departure time change detected: ${diffMinutes.toFixed(0)} minutes`);
          console.log(`Old: ${oldTime}, New: ${newTime}`);
          
          // Trigger schedule recalculation
          try {
            const payload = {
              flight_number: flightNumber,
              date: date,
              recalculate: true,
              new_departure_time: newTime,
              fa_flight_id: faFlightId,
            };
            
            console.log(`Invoking schedule recalculation with payload:`, payload);
            
            await lambdaClient.send(new InvokeCommand({
              FunctionName: SCHEDULE_TRACKER_FUNCTION_NAME,
              InvocationType: 'Event', // Async invocation
              Payload: JSON.stringify(payload),
            }));
            
            console.log('Schedule recalculation triggered successfully');
            return true;
          } catch (err) {
            console.error('Failed to trigger schedule recalculation:', err);
          }
        }
      }
    }
  }
  
  return false;
}

/**
 * Publishes flight update event to EventBridge.
 * Handles milestone-only, change-only, or combined (milestone + change) events.
 */
async function publishFlightUpdate(
  flightNumber: string,
  date: string,
  changes: Record<string, FlightChange>,
  milestones: MilestoneResult[],
  flightData: Record<string, unknown>
): Promise<void> {
  const hasChanges = Object.keys(changes).length > 0;
  const hasMilestones = milestones.length > 0;

  if (!hasChanges && !hasMilestones) return;

  // Determine update type
  let updateType: 'milestone' | 'change' | 'combined';
  if (hasChanges && hasMilestones) {
    updateType = 'combined';
  } else if (hasMilestones) {
    updateType = 'milestone';
  } else {
    updateType = 'change';
  }

  // Use the most important milestone (priority: boarding > pre-landing > 4h > 12h > 24h > checkin)
  const milestonePriority: MilestoneType[] = ['boarding', 'pre-landing', '4h', '12h', '24h', 'checkin'];
  const primaryMilestone = milestones.length > 0
    ? milestones.sort((a, b) => milestonePriority.indexOf(a.milestone) - milestonePriority.indexOf(b.milestone))[0]
    : undefined;

  const eventDetail: FlightUpdateEvent = {
    flight_number: flightNumber,
    date: date,
    update_type: updateType,
    current_status: flightData,
  };

  if (primaryMilestone) {
    eventDetail.milestone = primaryMilestone.milestone;
  }

  if (hasChanges) {
    eventDetail.changes = changes;
  }

  console.log(`Publishing ${updateType} event for ${flightNumber} on ${date}:`, {
    milestone: primaryMilestone?.milestone,
    changes: hasChanges ? Object.keys(changes) : [],
  });

  const entry = {
    Source: 'com.flait.flight-tracker',
    DetailType: 'FlightUpdate',
    Detail: JSON.stringify(eventDetail),
    EventBusName: EVENT_BUS_NAME,
  };

  await eventBridgeClient.send(new PutEventsCommand({
    Entries: [entry],
  }));

  console.log('Published flight update event to EventBridge');
}

/**
 * Stores flight data in DynamoDB with milestone tracking
 * @param flightNumber - Flight identifier
 * @param date - Flight date
 * @param flightData - Raw API response
 * @param milestonesSent - Array of milestones that have been sent for this flight
 */
async function storeFlightData(
  flightNumber: string,
  date: string,
  flightData: FlightAwareResponse,
  milestonesSent: MilestoneType[] = []
): Promise<void> {
  const partitionKey = `${flightNumber}#${date}`;
  const sortKey = new Date().toISOString(); // created_at timestamp

  const item = {
    PK: partitionKey,
    SK: sortKey,
    flight_number: flightNumber,
    date: date,
    created_at: sortKey,
    flight_data: flightData,
    milestones_sent: milestonesSent,
    // Store individual fields for easier querying if needed
    ...extractFlightFields(flightData),
  };

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: item,
    })
  );
}

/**
 * Extracts a simple string value from an airport object or returns the value if already a string.
 * FlightAware returns airport as objects like { code: "VOBL", code_iata: "BLR", name: "Bengaluru Int'l", ... }
 */
function extractAirportCode(airport: unknown): string | null {
  if (!airport) return null;
  if (typeof airport === 'string') return airport;
  if (typeof airport === 'object' && airport !== null) {
    const airportObj = airport as Record<string, unknown>;
    // Prefer IATA code, then ICAO code, then generic code
    return (airportObj.code_iata || airportObj.code_icao || airportObj.code || null) as string | null;
  }
  return null;
}

/**
 * Extracts timezone from an airport object.
 */
function extractAirportTimezone(airport: unknown): string | null {
  if (!airport) return null;
  if (typeof airport === 'object' && airport !== null) {
    const airportObj = airport as Record<string, unknown>;
    return (airportObj.timezone || null) as string | null;
  }
  return null;
}

/**
 * Extracts city name from an airport object.
 */
function extractAirportCity(airport: unknown): string | null {
  if (!airport) return null;
  if (typeof airport === 'object' && airport !== null) {
    const airportObj = airport as Record<string, unknown>;
    return (airportObj.city || null) as string | null;
  }
  return null;
}

/**
 * Extracts common flight fields from FlightAware AeroAPI v4 response for easier querying.
 * Normalizes complex objects (like airports) to simple string values for reliable comparison.
 * Documentation: https://flightaware.com/aeroapi/documentation
 */
function extractFlightFields(flightData: FlightAwareResponse): Record<string, any> {
  const result: Record<string, any> = {};
  
  // AeroAPI v4 response structure - adjust based on actual endpoint response
  // The /flights/{ident} endpoint returns flight information in a 'flights' array
  let actualData = flightData;
  
  if (flightData && typeof flightData === 'object' && 'flights' in flightData && Array.isArray((flightData as any).flights) && (flightData as any).flights.length > 0) {
    actualData = (flightData as any).flights[0];
  }

  if (actualData && typeof actualData === 'object') {
    const data = actualData as Record<string, unknown>;
    
    // Flight identifier
    if ('ident' in data) result.flight_ident = data.ident;
    
    // Airports - extract as simple IATA/ICAO codes for reliable comparison
    if ('origin' in data) {
      result.departure_airport = extractAirportCode(data.origin);
      result.departure_timezone = extractAirportTimezone(data.origin);
      result.departure_city = extractAirportCity(data.origin);
    }
    if ('destination' in data) {
      result.arrival_airport = extractAirportCode(data.destination);
      result.arrival_timezone = extractAirportTimezone(data.destination);
      result.arrival_city = extractAirportCity(data.destination);
    }
    
    // Times - these are already strings
    if ('scheduled_out' in data) result.scheduled_departure = data.scheduled_out;
    if ('scheduled_in' in data) result.scheduled_arrival = data.scheduled_in;
    if ('estimated_out' in data) result.estimated_departure = data.estimated_out;
    if ('estimated_in' in data) result.estimated_arrival = data.estimated_in;
    if ('actual_out' in data) result.actual_departure = data.actual_out;
    if ('actual_in' in data) result.actual_arrival = data.actual_in;
    
    // Status
    if ('status' in data) result.status = data.status;
    if ('cancelled' in data) result.cancelled = data.cancelled;
    
    // Gates
    if ('gate_origin' in data) result.gate_origin = data.gate_origin;
    if ('gate_destination' in data) result.gate_destination = data.gate_destination;
    
    // Terminals
    if ('terminal_origin' in data) result.terminal_origin = data.terminal_origin;
    if ('terminal_destination' in data) result.terminal_destination = data.terminal_destination;

    // FlightAware unique flight ID - critical for precise tracking
    if ('fa_flight_id' in data) result.fa_flight_id = data.fa_flight_id;
  }
  
  return result;
}

/**
 * Extracts flight request from either API Gateway event or direct Lambda invocation
 */
function extractFlightRequest(event: any): FlightRequest | null {
  // Check if this is an API Gateway event
  if (event.httpMethod || event.requestContext) {
    const apiEvent = event as APIGatewayProxyEvent;
    if (apiEvent.body) {
      try {
        return JSON.parse(apiEvent.body);
      } catch (e) {
        return null;
      }
    } else if (apiEvent.queryStringParameters) {
      return {
        flight_number: apiEvent.queryStringParameters.flight_number || '',
        date: apiEvent.queryStringParameters.date || '',
        fa_flight_id: apiEvent.queryStringParameters.fa_flight_id,
      };
    }
    return null;
  }
  
  // Direct Lambda invocation (from EventBridge Scheduler)
  if (event.flight_number && event.date) {
    return {
      flight_number: event.flight_number,
      date: event.date,
      fa_flight_id: event.fa_flight_id, // May be undefined for legacy invocations
    };
  }
  
  return null;
}

/**
 * Lambda handler - supports both API Gateway and direct invocations
 */
export const handler = async (
  event: any
): Promise<APIGatewayProxyResult | void> => {
  const isApiGatewayEvent = !!(event.httpMethod || event.requestContext);
  
  try {
    // Extract flight request from event
    const body = extractFlightRequest(event);
    
    if (!body) {
      if (isApiGatewayEvent) {
        return {
          statusCode: 400,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
          body: JSON.stringify({
            error: 'Missing required parameters: flight_number and date are required',
          }),
        };
      } else {
        console.error('Missing required parameters: flight_number and date are required');
        return;
      }
    }

    // Validate input
    if (!body.flight_number || !body.date) {
      if (isApiGatewayEvent) {
        return {
          statusCode: 400,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
          body: JSON.stringify({
            error: 'Missing required parameters: flight_number and date are required',
          }),
        };
      } else {
        console.error('Missing required parameters: flight_number and date are required');
        return;
      }
    }

    // Validate date format (YYYY-MM-DD)
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(body.date)) {
      if (isApiGatewayEvent) {
        return {
          statusCode: 400,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
          body: JSON.stringify({
            error: 'Invalid date format. Expected YYYY-MM-DD',
          }),
        };
      } else {
        console.error('Invalid date format. Expected YYYY-MM-DD');
        return;
      }
    }

    // Get the previous latest record from DynamoDB
    const oldRecord = await getLatestFlightData(body.flight_number, body.date);

    // Determine fa_flight_id to use: from request, from previous record, or none
    const faFlightId = body.fa_flight_id || oldRecord?.fa_flight_id as string | undefined;

    // Fetch flight information from FlightAware
    console.log(`Fetching flight info for ${body.flight_number} on ${body.date}${faFlightId ? ` (fa_flight_id: ${faFlightId})` : ''}`);
    const flightData = await fetchFlightInfo(body.flight_number, body.date, faFlightId);
    const extractedFields = extractFlightFields(flightData);

    // Validate we got the right flight - check if fa_flight_id matches
    if (faFlightId && extractedFields.fa_flight_id && extractedFields.fa_flight_id !== faFlightId) {
      console.warn(`fa_flight_id mismatch! Expected: ${faFlightId}, Got: ${extractedFields.fa_flight_id}`);
      // This could indicate the flight was cancelled and replaced - continue but log warning
    }

    // Detect changes
    let changes: Record<string, FlightChange> = {};
    if (oldRecord) {
      changes = compareFlightData(oldRecord, flightData);
      
      // Check if departure time changed significantly and recalculate schedules
      if (Object.keys(changes).length > 0) {
        await checkAndRecalculateSchedules(
          changes,
          body.flight_number,
          body.date,
          extractedFields.fa_flight_id || faFlightId
        );
      }
    } else {
      console.log(`No previous record found for ${body.flight_number} on ${body.date}. This is the first entry.`);
    }

    // Detect milestones
    const previousMilestones: MilestoneType[] = (oldRecord?.milestones_sent as MilestoneType[]) || [];
    const { departure, arrival } = extractFlightTimes(extractedFields);
    let newMilestones: MilestoneResult[] = [];

    if (departure) {
      newMilestones = detectMilestones(departure, arrival, previousMilestones, new Date());
      if (newMilestones.length > 0) {
        console.log(`Detected milestones for ${body.flight_number}:`, newMilestones.map(m => m.milestone));
      }
    }

    // Publish combined event if there are changes OR milestones
    if (Object.keys(changes).length > 0 || newMilestones.length > 0) {
      await publishFlightUpdate(
        body.flight_number,
        body.date,
        changes,
        newMilestones,
        extractedFields
      );
    }

    // Store in DynamoDB with updated milestones
    const allMilestones = [...previousMilestones, ...newMilestones.map(m => m.milestone)];
    await storeFlightData(body.flight_number, body.date, flightData, allMilestones);
    console.log(`Successfully stored flight data for ${body.flight_number} on ${body.date}`);

    // Return response based on invocation type
    if (isApiGatewayEvent) {
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({
          message: 'Flight data stored successfully',
          flight_number: body.flight_number,
          date: body.date,
          data: flightData,
        }),
      };
    } else {
      // Direct invocation - no response needed, just log success
      console.log('Flight tracking completed successfully');
    }
  } catch (error) {
    console.error('Error processing flight data:', error);
    
    if (isApiGatewayEvent) {
      return {
        statusCode: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({
          error: 'Internal server error',
          message: error instanceof Error ? error.message : 'Unknown error',
        }),
      };
    } else {
      // Direct invocation - log error and rethrow for EventBridge to handle
      throw error;
    }
  }
};

