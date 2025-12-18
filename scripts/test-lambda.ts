#!/usr/bin/env ts-node
import { handler } from '../lambda/flight-tracker/index';
import { APIGatewayProxyEvent } from 'aws-lambda';

// Get today's date in YYYY-MM-DD format
const today = new Date().toISOString().split('T')[0];

// Create a mock API Gateway event
const event: APIGatewayProxyEvent = {
  body: JSON.stringify({
    flight_number: 'KL879',
    date: today,
  }),
  headers: {},
  multiValueHeaders: {},
  httpMethod: 'POST',
  isBase64Encoded: false,
  path: '/flights',
  pathParameters: null,
  queryStringParameters: null,
  multiValueQueryStringParameters: null,
  stageVariables: null,
  requestContext: {
    accountId: 'test',
    apiId: 'test',
    protocol: 'HTTP/1.1',
    httpMethod: 'POST',
    path: '/flights',
    stage: 'test',
    requestId: 'test-request-id',
    requestTime: new Date().toISOString(),
    requestTimeEpoch: Date.now(),
    resourceId: 'test',
    resourcePath: '/flights',
    authorizer: {},
    identity: {
      accessKey: null,
      accountId: null,
      apiKey: null,
      apiKeyId: null,
      caller: null,
      clientCert: null,
      cognitoAuthenticationProvider: null,
      cognitoAuthenticationType: null,
      cognitoIdentityId: null,
      cognitoIdentityPoolId: null,
      principalOrgId: null,
      sourceIp: '127.0.0.1',
      user: null,
      userAgent: 'test',
      userArn: null,
    },
  },
  resource: '/flights',
};

async function testLambda() {
  console.log(`Testing Lambda function with flight KL879 and date ${today}...\n`);
  
  // Set required environment variables
  process.env.TABLE_NAME = process.env.TABLE_NAME || 'flight-data';
  process.env.FLIGHTAWARE_API_KEY = process.env.FLIGHTAWARE_API_KEY || '';
  
  if (!process.env.FLIGHTAWARE_API_KEY) {
    console.error('ERROR: FLIGHTAWARE_API_KEY environment variable is not set!');
    console.error('Please set it before running the test:');
    console.error('  export FLIGHTAWARE_API_KEY=your_api_key');
    process.exit(1);
  }
  
  try {
    const result = await handler(event);
    
    console.log('Response Status:', result.statusCode);
    console.log('Response Body:', result.body);
    
    if (result.statusCode === 200) {
      console.log('\n✅ Success! Flight data has been stored in DynamoDB.');
    } else {
      console.log('\n❌ Error occurred. Check the response above.');
    }
  } catch (error) {
    console.error('❌ Error invoking Lambda:', error);
    process.exit(1);
  }
}

testLambda();

