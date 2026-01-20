import * as dotenv from 'dotenv';
import twilio from 'twilio';

dotenv.config();

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
let from = process.env.TWILIO_FROM_NUMBER;
const to = 'whatsapp:+919900110110';

if (!accountSid || !authToken || !from) {
  console.error('Error: Missing Twilio credentials in .env file');
  process.exit(1);
}

// Ensure from number is prefixed with whatsapp:
if (!from.startsWith('whatsapp:')) {
  from = `whatsapp:${from}`;
}

const client = twilio(accountSid, authToken);

async function sendTest() {
  try {
    console.log(`Attempting to send test WhatsApp message from ${from} to ${to}...`);
    const message = await client.messages.create({
      body: '🚀 *Flait Test Notification*\n\nYour WhatsApp integration is working perfectly! This message confirms that Flait can send you real-time flight updates.',
      from: from,
      to: to
    });
    console.log(`✅ Success! Message SID: ${message.sid}`);
  } catch (error) {
    console.error('❌ Failed to send message:', error);
  }
}

sendTest();
