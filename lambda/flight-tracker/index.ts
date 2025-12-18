import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const TABLE_NAME = process.env.TABLE_NAME!;
const FLIGHTAWARE_API_KEY = process.env.FLIGHTAWARE_API_KEY!;

interface FlightRequest {
  flight_number: string;
  date: string; // Format: YYYY-MM-DD
}

interface FlightAwareResponse {
  // FlightAware API response structure
  // This will vary based on the actual API endpoint used
  [key: string]: any;
}

/**
 * Fetches flight information from FlightAware AeroAPI v4
 * Documentation: https://flightaware.com/aeroapi/
 * AeroAPI v4 only requires an API key (no username needed)
 */
async function fetchFlightInfo(flightNumber: string, date: string): Promise<FlightAwareResponse> {
  if (!FLIGHTAWARE_API_KEY) {
    throw new Error('FlightAware API key not configured');
  }

  // FlightAware AeroAPI v4 endpoint
  // Documentation: https://flightaware.com/aeroapi/documentation
  // Endpoint: /flights/{ident} - returns current status of a flight
  const url = `https://aeroapi.flightaware.com/aeroapi/flights/${encodeURIComponent(flightNumber)}`;
  
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
 * Stores flight data in DynamoDB
 */
async function storeFlightData(
  flightNumber: string,
  date: string,
  flightData: FlightAwareResponse
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
 * Extracts common flight fields from FlightAware AeroAPI v4 response for easier querying
 * Adjust this based on the actual AeroAPI v4 response structure
 * Documentation: https://flightaware.com/aeroapi/documentation
 */
function extractFlightFields(flightData: FlightAwareResponse): Record<string, any> {
  const result: Record<string, any> = {};
  
  // AeroAPI v4 response structure - adjust based on actual endpoint response
  // The /flights/{ident} endpoint returns flight information
  if (flightData && typeof flightData === 'object') {
    // Extract common fields (adjust field names based on actual API response)
    // AeroAPI v4 typically returns fields like:
    // - ident (flight number)
    // - origin, destination
    // - scheduled_out, scheduled_in
    // - actual_out, actual_in
    // - status
    // etc.
    
    if ('ident' in flightData) result.flight_ident = (flightData as any).ident;
    if ('origin' in flightData) result.departure_airport = (flightData as any).origin;
    if ('destination' in flightData) result.arrival_airport = (flightData as any).destination;
    if ('scheduled_out' in flightData) result.scheduled_departure = (flightData as any).scheduled_out;
    if ('scheduled_in' in flightData) result.scheduled_arrival = (flightData as any).scheduled_in;
    if ('actual_out' in flightData) result.actual_departure = (flightData as any).actual_out;
    if ('actual_in' in flightData) result.actual_arrival = (flightData as any).actual_in;
    if ('status' in flightData) result.status = (flightData as any).status;
    
    // Add any other relevant fields from the API response
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
      };
    }
    return null;
  }
  
  // Direct Lambda invocation (from EventBridge Scheduler)
  if (event.flight_number && event.date) {
    return {
      flight_number: event.flight_number,
      date: event.date,
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

    // Fetch flight information from FlightAware
    console.log(`Fetching flight info for ${body.flight_number} on ${body.date}`);
    const flightData = await fetchFlightInfo(body.flight_number, body.date);

    // Store in DynamoDB
    await storeFlightData(body.flight_number, body.date, flightData);
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

