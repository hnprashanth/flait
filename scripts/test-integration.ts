import * as dotenv from 'dotenv';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

dotenv.config();

// CONFIGURATION
const API_URL = process.env.API_URL; // e.g., https://xxx.execute-api.us-east-1.amazonaws.com/prod/
const EVENT_BUS_NAME = 'flight-tracker-bus';
const TEST_PHONE = process.env.TEST_PHONE || '15550001234'; // Override in .env
const TEST_FLIGHT = 'UA999';
const TEST_DATE = '2025-05-20';

if (!API_URL) {
  console.error('❌ Error: API_URL is missing in .env');
  console.log('Run "npx cdk deploy" and copy the "ApiEndpoint" output to your .env file.');
  process.exit(1);
}

const ebClient = new EventBridgeClient({});

async function runIntegrationTest() {
  console.log('🚀 Starting Integration Test Flow...\n');

  // 1. Create User
  console.log(`1️⃣  Creating User (Phone: ${TEST_PHONE})...`);
  const userRes = await fetch(`${API_URL}users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Integration Tester', phone: TEST_PHONE }),
  });
  
  if (userRes.status === 201 || userRes.status === 409) {
    console.log('   ✅ User verified (Created or Already Exists).');
  } else {
    console.error('   ❌ Failed to create user:', await userRes.text());
    return;
  }

  // 2. Subscribe to Flight
  console.log(`\n2️⃣  Subscribing to ${TEST_FLIGHT} on ${TEST_DATE}...`);
  // Note: This might trigger provisioning (Tracker/Scheduler). 
  // For this test, we assume the mock flight data or real API key allows it, 
  // or we accept the subscription even if provisioning warns (depending on implementation).
  const subRes = await fetch(`${API_URL}subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      phone: TEST_PHONE, 
      flight_number: TEST_FLIGHT, 
      date: TEST_DATE 
    }),
  });

  if (subRes.status === 201) {
    console.log('   ✅ Subscription confirmed.');
  } else {
    // It might fail if the flight doesn't exist in FlightAware. 
    // For a pure test, we might need a "real" future flight number.
    console.warn('   ⚠️ Subscription response:', await subRes.status, await subRes.text());
    console.log('   (Proceeding to simulation regardless...)');
  }

  // 3. Simulate EventBridge Event
  console.log(`\n3️⃣  Simulating "Flight Delayed" Event...`);
  const eventDetail = {
    flight_number: TEST_FLIGHT,
    date: TEST_DATE,
    changes: {
      status: { old: 'Scheduled', new: 'Delayed' },
      estimated_departure: { old: '10:00', new: '10:45' }
    },
    current_status: { status: 'Delayed' }
  };

  try {
    await ebClient.send(new PutEventsCommand({
      Entries: [{
        Source: 'com.flait.flight-tracker',
        DetailType: 'FlightStatusChanged',
        Detail: JSON.stringify(eventDetail),
        EventBusName: EVENT_BUS_NAME,
      }]
    }));
    console.log('   ✅ Event sent to EventBridge.');
    console.log('   📲 CHECK YOUR WHATSAPP NOW!');
  } catch (error) {
    console.error('   ❌ Failed to put event:', error);
  }
}

runIntegrationTest();
