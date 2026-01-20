import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import * as crypto from 'crypto';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const TABLE_NAME = process.env.APP_TABLE_NAME!;

interface CreateUserRequest {
  name: string;
  phone: string;
}

interface UserProfile {
  id: string;
  name: string;
  phone: string;
  createdAt: string;
}

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    const method = event.httpMethod;

    if (method === 'POST') {
      return await createUser(event);
    } else if (method === 'GET') {
      return await getUser(event);
    } else {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: 'Method Not Allowed' }),
      };
    }
  } catch (error) {
    console.error('Error in user-service:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal Server Error' }),
    };
  }
};

async function createUser(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  if (!event.body) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing body' }) };
  }

  let body: CreateUserRequest;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (!body.name || !body.phone) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing name or phone' }) };
  }

  const userId = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  const userProfile: UserProfile = {
    id: userId,
    name: body.name,
    phone: body.phone,
    createdAt: timestamp,
  };

  const params = {
    TableName: TABLE_NAME,
    Item: {
      PK: `USER#${body.phone}`,
      SK: 'PROFILE',
      ...userProfile,
    },
    ConditionExpression: 'attribute_not_exists(PK)',
  };

  try {
    await docClient.send(new PutCommand(params));
  } catch (err: any) {
    if (err.name === 'ConditionalCheckFailedException') {
      return {
        statusCode: 409,
        body: JSON.stringify({ error: 'User already exists with this phone number' }),
      };
    }
    throw err;
  }

  return {
    statusCode: 201,
    body: JSON.stringify(userProfile),
  };
}

async function getUser(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const phone = event.queryStringParameters?.phone;

  if (!phone) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing phone query parameter' }) };
  }

  const params = {
    TableName: TABLE_NAME,
    Key: {
      PK: `USER#${phone}`,
      SK: 'PROFILE',
    },
  };

  const response = await docClient.send(new GetCommand(params));

  if (!response.Item) {
    return { statusCode: 404, body: JSON.stringify({ error: 'User not found' }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify(response.Item),
  };
}
