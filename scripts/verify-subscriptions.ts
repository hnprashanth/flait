import * as dotenv from 'dotenv';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

dotenv.config();

const TABLE_NAME = 'flait-app-data';
const TEST_PHONE = process.env.TEST_PHONE;

if (!TEST_PHONE) {
  console.error('❌ Error: TEST_PHONE is missing in .env');
  process.exit(1);
}

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

async function verifySubscriptions() {
  console.log(`🔍 Fetching active subscriptions for ${TEST_PHONE}...\n`);

  try {
    const response = await docClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': `USER${TEST_PHONE}`,
        ':skPrefix': 'SUB#',
      },
    }));

    const subs = response.Items || [];
    
    if (subs.length === 0) {
      console.log('📭 No active subscriptions found.');
      return;
    }

    console.log(`✅ Found ${subs.length} Active Subscriptions:`);
    console.log('-------------------------------------------');
    subs.forEach((sub, index) => {
      // SK format: SUB#YYYY-MM-DD#FLIGHT
      const parts = sub.SK.split('#');
      const date = parts[1];
      const flight = parts[2];
      console.log(`${index + 1}. Flight: ${flight.padEnd(8)} | Date: ${date} | Status: ${sub.status}`);
    });
    console.log('-------------------------------------------');
  } catch (error) {
    console.error('❌ Failed to fetch subscriptions:', error);
  }
}

verifySubscriptions();
