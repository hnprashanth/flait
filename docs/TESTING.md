# Flait Testing Guide

## 1. Unit Testing (Local)
Run the test suite to verify business logic and error handling.
```bash
npm test
```

## 2. Integration Testing (Deployed)

### Prerequisites
1.  **Deploy**: Ensure your stack is deployed.
    ```bash
    npx cdk deploy
    ```
2.  **Configure**: Copy the `ApiEndpoint` URL from the deployment output and add it to your `.env` file:
    ```env
    API_URL=https://xxxxxx.execute-api.us-east-1.amazonaws.com/prod/
    TEST_PHONE=15551234567  # Your WhatsApp number
    ```

### Running the Full Flow
We have a script that:
1.  Creates a User.
2.  Subscribes them to a dummy flight (`UA999`).
3.  Injects a fake "Flight Delay" event into EventBridge.

Run it:
```bash
npx ts-node scripts/test-integration.ts
```

**Expected Result:**
1.  Console shows successful User Creation and Subscription.
2.  Console confirms Event sent.
3.  **You receive a WhatsApp message** stating `Flight Update: UA999 ... Status: Scheduled ➔ Delayed`.

## 3. Manual Testing

### API
You can manually interact with the API:
```bash
# Create User
curl -X POST $API_URL/users \
  -H "Content-Type: application/json" \
  -d '{"name": "Me", "phone": "15550001234"}'

# Subscribe
curl -X POST $API_URL/subscriptions \
  -H "Content-Type: application/json" \
  -d '{"phone": "15550001234", "flight_number": "UA123", "date": "2025-12-25"}'
```

### Event Simulation
To manually trigger a notification for ANY flight:
```bash
aws events put-events --entries '[{
  "Source": "com.flait.flight-tracker",
  "DetailType": "FlightStatusChanged",
  "Detail": "{\"flight_number\": \"UA123\", \"date\": \"2025-12-25\", \"changes\": {\"status\": {\"old\": \"OK\", \"new\": \"DELAYED\"}}, \"current_status\": {}}",
  "EventBusName": "flight-tracker-bus"
}]'
```
