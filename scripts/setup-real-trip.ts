import * as dotenv from 'dotenv';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

dotenv.config();

const API_URL = process.env.API_URL;
const TEST_PHONE = process.env.TEST_PHONE; 
const EVENT_BUS_NAME = 'flight-tracker-bus';

// Flights for the "Real World" test (Hyderabad -> Amsterdam -> SFO)
const FLIGHT_1 = 'KL880';
const FLIGHT_2 = 'KL605';

if (!API_URL || !TEST_PHONE) {
  console.error('❌ Error: API_URL or TEST_PHONE is missing in .env');
  process.exit(1);
}

const ebClient = new EventBridgeClient({});

async function setupRealTrip() {
  // 1. Calculate Tomorrow's Date (YYYY-MM-DD)
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dateStr = tomorrow.toISOString().split('T')[0];

  console.log(`🚀 Setting up Real Trip for ${dateStr} (User: ${TEST_PHONE})...
`);

  // 2. Subscribe to Flight 1 (KL880)
  console.log(`1️⃣  Subscribing to ${FLIGHT_1} (Leg 1)...`);
  await subscribe(FLIGHT_1, dateStr);

  // 3. Subscribe to Flight 2 (KL605)
  console.log(`2️⃣  Subscribing to ${FLIGHT_2} (Leg 2)...`);
  await subscribe(FLIGHT_2, dateStr);

  console.log('\n✅ Trip Subscribed! You are now tracking both flights.');
  console.log('   (Real tracking is active in the background via FlightAware)');

  // 4. Simulate an Event to prove Connection Logic works
  console.log(`\n3️⃣  Simulating "Gate Change" for ${FLIGHT_1} to test Trip Context...`);
  
  const eventDetail = {
    flight_number: FLIGHT_1,
    date: dateStr,
    changes: {
      gate_origin: { old: 'TBD', new: 'D45' }, // Gate assigned!
      estimated_departure: { old: '02:00', new: '02:00' }
    },
    current_status: { status: 'Scheduled' }
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
    console.log('   ✅ Event sent.');
    console.log('   📲 CHECK WHATSAPP: You should see the update + a warning about your connecting flight.');
  } catch (error) {
    console.error('   ❌ Failed to simulate event:', error);
  }
}

async function subscribe(flight: string, date: string) {
  try {
    const res = await fetch(`${API_URL}subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: TEST_PHONE, 
        flight_number: flight, 
        date: date 
      }),
    });
    
    if (res.status === 201) {
      console.log(`   ✅ Subscribed to ${flight}.`);
    } else {
      console.warn(`   ⚠️ Status ${res.status}:`, await res.text());
    }
  } catch (err) {
    console.error(`   ❌ Network error subscribing to ${flight}:`, err);
  }
}

setupRealTrip();
