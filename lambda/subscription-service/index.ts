import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const lambdaClient = new LambdaClient({});

const APP_TABLE_NAME = process.env.APP_TABLE_NAME!;
const FLIGHT_TABLE_NAME = process.env.FLIGHT_TABLE_NAME!;
const FLIGHT_TRACKER_FUNCTION_NAME = process.env.FLIGHT_TRACKER_FUNCTION_NAME!;
const SCHEDULE_TRACKER_FUNCTION_NAME = process.env.SCHEDULE_TRACKER_FUNCTION_NAME!;

interface SubscribeRequest {
  phone: string;
  flight_number: string;
  date: string; // YYYY-MM-DD
}

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    const method = event.httpMethod;

    if (method === 'POST') {
      return await subscribe(event);
    } else if (method === 'GET') {
      return await getSubscriptions(event);
    } else {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: 'Method Not Allowed' }),
      };
    }
  } catch (error) {
    console.error('Error in subscription-service:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal Server Error' }),
    };
  }
};

async function subscribe(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  if (!event.body) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing body' }) };
  }

  let body: SubscribeRequest;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { phone, flight_number, date } = body;

  if (!phone || !flight_number || !date) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing phone, flight_number, or date' }) };
  }

  // 1. Verify User Exists (Optional, but good practice. skipping for speed to focus on orchestration)
  // Ideally, we check if PK=USER#{phone} exists.

  // 2. Check if Flight is being tracked
  const existingFlight = await getExistingFlightData(flight_number, date);
  let faFlightId: string | undefined;

  if (!existingFlight) {
    console.log(`Flight ${flight_number} on ${date} not found. Attempting to provision...`);
    
    // 2a. Provision: Invoke Flight Tracker (Verify & Fetch Initial Data)
    try {
      await invokeLambda(FLIGHT_TRACKER_FUNCTION_NAME, { flight_number, date });
    } catch (err) {
      console.error('Failed to invoke Flight Tracker:', err);
      // If flight tracker fails (e.g., invalid flight), we reject the subscription
      return { 
        statusCode: 404, 
        body: JSON.stringify({ error: 'Flight not found or could not be tracked.' }) 
      };
    }

    // 2b. Provision: Invoke Schedule Tracker (Start Background Polling)
    // This will return fa_flight_id in the response
    try {
      const scheduleResult = await invokeLambdaWithResponse(SCHEDULE_TRACKER_FUNCTION_NAME, { flight_number, date });
      faFlightId = scheduleResult?.fa_flight_id;
      console.log(`Schedule created with fa_flight_id: ${faFlightId}`);
    } catch (err) {
      console.error('Failed to invoke Schedule Tracker:', err);
      return { 
        statusCode: 500, 
        body: JSON.stringify({ error: 'Failed to schedule flight tracking.' }) 
      };
    }

    // If we still don't have fa_flight_id, try to get it from the newly created flight data
    if (!faFlightId) {
      const newFlightData = await getExistingFlightData(flight_number, date);
      faFlightId = newFlightData?.fa_flight_id;
    }
  } else {
    // Flight already exists, get fa_flight_id from existing data
    faFlightId = existingFlight.fa_flight_id;
    console.log(`Using existing fa_flight_id: ${faFlightId}`);
  }

  // 3. Save Subscription with fa_flight_id
  const subscriptionItem: Record<string, unknown> = {
    PK: `USER#${phone}`,
    SK: `SUB#${date}#${flight_number}`,
    GSI1PK: `FLIGHT#${flight_number}#${date}`,
    GSI1SK: `USER#${phone}`,
    createdAt: new Date().toISOString(),
    status: 'ACTIVE',
  };

  // Add fa_flight_id if available
  if (faFlightId) {
    subscriptionItem.fa_flight_id = faFlightId;
  }

  await docClient.send(new PutCommand({
    TableName: APP_TABLE_NAME,
    Item: subscriptionItem,
  }));

  return {
    statusCode: 201,
    body: JSON.stringify({ message: 'Subscribed successfully', subscription: subscriptionItem }),
  };
}

async function getSubscriptions(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const phone = event.queryStringParameters?.phone;

  if (!phone) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing phone query parameter' }) };
  }

  // Query all subscriptions for user
  const response = await docClient.send(new QueryCommand({
    TableName: APP_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
    ExpressionAttributeValues: {
      ':pk': `USER#${phone}`,
      ':skPrefix': 'SUB#',
    },
  }));

  return {
    statusCode: 200,
    body: JSON.stringify(response.Items || []),
  };
}

/**
 * Gets the latest flight data record if it exists, including fa_flight_id
 */
async function getExistingFlightData(flightNumber: string, date: string): Promise<Record<string, any> | null> {
  const response = await docClient.send(new QueryCommand({
    TableName: FLIGHT_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: {
      ':pk': `${flightNumber}#${date}`,
    },
    ScanIndexForward: false, // Get latest first
    Limit: 1,
  }));

  if (response.Items && response.Items.length > 0) {
    return response.Items[0];
  }
  return null;
}

async function invokeLambda(functionName: string, payload: any): Promise<void> {
  const command = new InvokeCommand({
    FunctionName: functionName,
    InvocationType: 'RequestResponse', // Wait for result to ensure it worked
    Payload: JSON.stringify(payload),
  });

  const response = await lambdaClient.send(command);

  if (response.FunctionError) {
    throw new Error(`Lambda ${functionName} failed: ${response.FunctionError}`);
  }
  
  // Also check if the payload itself contains an error message (common in Lambda)
  if (response.Payload) {
      const resultStr = new TextDecoder().decode(response.Payload);
      try {
          const result = JSON.parse(resultStr);
          // If the lambda returns an error object structure (like { errorMessage: ... })
          if (result.errorMessage) {
              throw new Error(`Lambda ${functionName} returned error: ${result.errorMessage}`);
          }
      } catch (e) {
          // Ignore parsing error if it's not JSON
      }
  }
}

/**
 * Invokes a Lambda function and returns the parsed response body
 * @param functionName - Name of the Lambda function to invoke
 * @param payload - Payload to send to the Lambda
 * @returns Parsed response body or null
 */
async function invokeLambdaWithResponse(functionName: string, payload: any): Promise<any> {
  const command = new InvokeCommand({
    FunctionName: functionName,
    InvocationType: 'RequestResponse',
    Payload: JSON.stringify(payload),
  });

  const response = await lambdaClient.send(command);

  if (response.FunctionError) {
    throw new Error(`Lambda ${functionName} failed: ${response.FunctionError}`);
  }
  
  if (response.Payload) {
    const resultStr = new TextDecoder().decode(response.Payload);
    try {
      const result = JSON.parse(resultStr);
      if (result.errorMessage) {
        throw new Error(`Lambda ${functionName} returned error: ${result.errorMessage}`);
      }
      // Parse the body if it's an API Gateway response format
      if (result.body && typeof result.body === 'string') {
        return JSON.parse(result.body);
      }
      return result;
    } catch (e) {
      // If parsing fails, return null
      if (e instanceof Error && e.message.includes('returned error')) {
        throw e;
      }
    }
  }
  return null;
}
