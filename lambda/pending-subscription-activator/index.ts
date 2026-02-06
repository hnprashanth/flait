import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const lambdaClient = new LambdaClient({});

const APP_TABLE_NAME = process.env.APP_TABLE_NAME!;
const FLIGHTAWARE_API_KEY = process.env.FLIGHTAWARE_API_KEY!;
const FLIGHT_TRACKER_FUNCTION_NAME = process.env.FLIGHT_TRACKER_FUNCTION_NAME!;
const SCHEDULE_TRACKER_FUNCTION_NAME = process.env.SCHEDULE_TRACKER_FUNCTION_NAME!;

/**
 * Mapping of 2-letter IATA airline codes to 3-letter ICAO codes
 */
const IATA_TO_ICAO: Record<string, string> = {
  'AA': 'AAL', 'UA': 'UAL', 'DL': 'DAL', 'WN': 'SWA', 'BA': 'BAW',
  'AF': 'AFR', 'KL': 'KLM', 'LH': 'DLH', 'JL': 'JAL', 'NH': 'ANA',
  'QF': 'QFA', 'SQ': 'SIA', 'CX': 'CPA', 'EK': 'UAE', 'EY': 'ETD',
  'QR': 'QTR', 'TK': 'THY', 'SK': 'SAS', 'TP': 'TAP', 'IB': 'IBE',
  'AC': 'ACA', 'NZ': 'ANZ', 'VS': 'VIR', 'U2': 'EZY', 'FR': 'RYR',
  'AI': 'AIC', 'CI': 'CAL', 'BR': 'EVA', 'OZ': 'AAR', 'KE': 'KAL',
  'MH': 'MAS', 'GA': 'GIA', 'TG': 'THA', 'VN': 'HVN', 'PR': 'PAL',
  '6E': 'IGO', 'UK': 'VTI', 'SG': 'SEJ', 'IX': 'AXB', 'QP': 'AKJ',
  'I5': 'IAD', 'WY': 'OMA', 'GF': 'GFA', 'SV': 'SVA', 'AZ': 'ITY',
  'OS': 'AUA', 'LX': 'SWR', 'SN': 'BEL',
};

interface PendingSubscription {
  PK: string;
  SK: string;
  flight_number: string;
  date: string;
  departure_airport?: string;
  arrival_airport?: string;
}

interface ActivationResult {
  flight_number: string;
  date: string;
  phone: string;
  activated: boolean;
  fa_flight_id?: string;
  reason?: string;
}

/**
 * Extracts the airline code prefix from a flight number
 */
function extractAirlineCode(flightNumber: string): { airlineCode: string; flightNum: string } {
  const upper = flightNumber.toUpperCase().trim();

  // Try 3-letter ICAO code first
  const icaoMatch = upper.match(/^([A-Z]{3})[- ]?(\d+)$/);
  if (icaoMatch) {
    return { airlineCode: icaoMatch[1], flightNum: icaoMatch[2] };
  }

  // Try 2-letter IATA code
  const iataMatch = upper.match(/^([A-Z0-9]{2})[- ]?(\d+)$/);
  if (iataMatch) {
    return { airlineCode: iataMatch[1], flightNum: iataMatch[2] };
  }

  return { airlineCode: '', flightNum: '' };
}

/**
 * Converts IATA airline code to ICAO if mapping exists
 */
function convertToIcaoFlightNumber(flightNumber: string): string | null {
  const { airlineCode, flightNum } = extractAirlineCode(flightNumber);
  if (!airlineCode || !flightNum) return null;

  if (airlineCode.length === 2) {
    const icaoCode = IATA_TO_ICAO[airlineCode];
    if (icaoCode) {
      return `${icaoCode}${flightNum}`;
    }
  }
  return null;
}

/**
 * Fetches upcoming flights from FlightAware API
 * Returns flights array if found, null otherwise
 */
async function fetchUpcomingFlights(flightNumber: string): Promise<any[] | null> {
  const url = `https://aeroapi.flightaware.com/aeroapi/flights/${encodeURIComponent(flightNumber)}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-apikey': FLIGHTAWARE_API_KEY,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      // Try ICAO conversion
      const icaoFlightNumber = convertToIcaoFlightNumber(flightNumber);
      if (icaoFlightNumber) {
        const icaoUrl = `https://aeroapi.flightaware.com/aeroapi/flights/${encodeURIComponent(icaoFlightNumber)}`;
        const icaoResponse = await fetch(icaoUrl, {
          method: 'GET',
          headers: {
            'x-apikey': FLIGHTAWARE_API_KEY,
            'Content-Type': 'application/json',
          },
        });
        if (icaoResponse.ok) {
          const data = await icaoResponse.json() as { flights?: any[] };
          return data.flights || null;
        }
      }
      return null;
    }

    const data = await response.json() as { flights?: any[] };
    return data.flights || null;
  } catch (error) {
    console.error(`Error fetching flights for ${flightNumber}:`, error);
    return null;
  }
}

/**
 * Finds a flight matching the target date from a list of flights
 */
function findFlightForDate(flights: any[], targetDate: string): any | null {
  for (const flight of flights) {
    const scheduledOut = flight.scheduled_out || flight.scheduled_off;
    if (!scheduledOut) continue;

    const departureTimezone = flight.origin?.timezone || 'UTC';
    const depDate = new Date(scheduledOut);
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: departureTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const flightDate = formatter.format(depDate);

    if (flightDate === targetDate) {
      return flight;
    }
  }
  return null;
}

/**
 * Invokes a Lambda function asynchronously
 */
async function invokeLambdaAsync(functionName: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify(payload)),
    }));
    console.log(`Invoked ${functionName} with payload:`, JSON.stringify(payload));
  } catch (error) {
    console.error(`Error invoking ${functionName}:`, error);
    throw error;
  }
}

/**
 * Activates a pending subscription
 */
async function activateSubscription(
  subscription: PendingSubscription,
  faFlightId: string,
  departureTime: string
): Promise<void> {
  const now = new Date().toISOString();

  // Update subscription status to ACTIVE
  await docClient.send(new UpdateCommand({
    TableName: APP_TABLE_NAME,
    Key: {
      PK: subscription.PK,
      SK: subscription.SK,
    },
    UpdateExpression: 'SET #status = :active, fa_flight_id = :faId, departure_time = :depTime, updated_at = :now',
    ExpressionAttributeNames: {
      '#status': 'status',
    },
    ExpressionAttributeValues: {
      ':active': 'ACTIVE',
      ':faId': faFlightId,
      ':depTime': departureTime,
      ':now': now,
    },
  }));

  console.log(`Activated subscription: ${subscription.flight_number} on ${subscription.date}`);

  // Provision flight tracking
  const trackingPayload = {
    flight_number: subscription.flight_number,
    date: subscription.date,
  };

  // Invoke flight-tracker
  if (FLIGHT_TRACKER_FUNCTION_NAME) {
    try {
      await invokeLambdaAsync(FLIGHT_TRACKER_FUNCTION_NAME, trackingPayload);
    } catch (error) {
      console.error('Failed to invoke flight-tracker:', error);
    }
  }

  // Invoke schedule-tracker
  if (SCHEDULE_TRACKER_FUNCTION_NAME) {
    try {
      await invokeLambdaAsync(SCHEDULE_TRACKER_FUNCTION_NAME, trackingPayload);
    } catch (error) {
      console.error('Failed to invoke schedule-tracker:', error);
    }
  }
}

/**
 * Lambda handler - runs daily to activate pending subscriptions
 */
export const handler = async (): Promise<{
  statusCode: number;
  body: string;
}> => {
  console.log('Starting pending subscription activation check');

  const results: ActivationResult[] = [];

  try {
    // Scan for all PENDING_ACTIVATION subscriptions
    // Note: In production with many users, use a GSI on status instead of scan
    let lastEvaluatedKey: Record<string, any> | undefined;
    const pendingSubscriptions: PendingSubscription[] = [];

    do {
      const scanResult = await docClient.send(new ScanCommand({
        TableName: APP_TABLE_NAME,
        FilterExpression: '#status = :pending AND begins_with(SK, :sub)',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':pending': 'PENDING_ACTIVATION',
          ':sub': 'SUB#',
        },
        ExclusiveStartKey: lastEvaluatedKey,
      }));

      if (scanResult.Items) {
        pendingSubscriptions.push(...scanResult.Items as PendingSubscription[]);
      }
      lastEvaluatedKey = scanResult.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    console.log(`Found ${pendingSubscriptions.length} pending subscriptions`);

    // Process each pending subscription
    for (const subscription of pendingSubscriptions) {
      const phone = subscription.PK.replace('USER#', '');
      const result: ActivationResult = {
        flight_number: subscription.flight_number,
        date: subscription.date,
        phone,
        activated: false,
      };

      try {
        // Check if flight is now available in the flights API
        const flights = await fetchUpcomingFlights(subscription.flight_number);

        if (!flights || flights.length === 0) {
          result.reason = 'Flight not yet available in real-time API';
          results.push(result);
          continue;
        }

        // Find flight for the target date
        const matchingFlight = findFlightForDate(flights, subscription.date);

        if (!matchingFlight) {
          result.reason = 'Flight not found for specified date';
          results.push(result);
          continue;
        }

        const faFlightId = matchingFlight.fa_flight_id;
        const departureTime = matchingFlight.scheduled_out || matchingFlight.scheduled_off;

        if (!faFlightId) {
          result.reason = 'No fa_flight_id available';
          results.push(result);
          continue;
        }

        // Activate the subscription
        await activateSubscription(subscription, faFlightId, departureTime);

        result.activated = true;
        result.fa_flight_id = faFlightId;
        results.push(result);

      } catch (error) {
        console.error(`Error processing subscription ${subscription.flight_number}:`, error);
        result.reason = `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
        results.push(result);
      }
    }

    const activated = results.filter(r => r.activated).length;
    const notActivated = results.filter(r => !r.activated).length;

    console.log(`Activation complete: ${activated} activated, ${notActivated} still pending`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Pending subscription check complete',
        total: pendingSubscriptions.length,
        activated,
        still_pending: notActivated,
        results,
      }),
    };

  } catch (error) {
    console.error('Error in pending subscription activator:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
