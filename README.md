# Flait - Flight Tracker

AWS CDK project for tracking flight information using FlightAware API and storing data in DynamoDB.

## Architecture

- **Lambda Function**: Fetches flight data from FlightAware API and stores it in DynamoDB
- **DynamoDB Table**: Stores flight data with composite key (PK: flight_number#date, SK: created_at)
- **API Gateway**: REST API endpoint to trigger flight tracking

## Setup

### Prerequisites

1. AWS CLI configured with appropriate credentials
2. Node.js 20.x installed
3. FlightAware API credentials (username and API key)

### Installation

```bash
npm install
```

### Configuration

Before deploying, set the following environment variable:

```bash
export FLIGHTAWARE_API_KEY=your_api_key
```

Or set it in your shell profile for persistence.

**Note**: This project uses FlightAware's AeroAPI v4, which only requires an API key (no username needed).

### Deployment

```bash
# Build the project
npm run build

# Deploy the stack
npx cdk deploy
```

After deployment, you'll receive:
- API Gateway endpoint URL
- DynamoDB table name

## Usage

### API Endpoints

**POST /flights**
```json
{
  "flight_number": "AA123",
  "date": "2025-01-15"
}
```

**GET /flights?flight_number=AA123&date=2025-01-15**

### DynamoDB Schema

- **Partition Key (PK)**: `{flight_number}#{date}` (e.g., `AA123#2025-01-15`)
- **Sort Key (SK)**: ISO timestamp of when the data was fetched (e.g., `2025-01-15T10:30:00.000Z`)
- **Additional Fields**:
  - `flight_number`: Flight number
  - `date`: Date in YYYY-MM-DD format
  - `created_at`: Timestamp
  - `flight_data`: Full FlightAware API response
  - Extracted fields: status, departure_airport, arrival_airport, etc.

### Querying Data

To query all records for a specific flight on a date:

```javascript
// Using AWS SDK
const params = {
  TableName: 'flight-data',
  KeyConditionExpression: 'PK = :pk',
  ExpressionAttributeValues: {
    ':pk': 'AA123#2025-01-15'
  },
  ScanIndexForward: false // Get most recent first
};
```

## Useful Commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template

## FlightAware API

This project uses FlightAware's AeroAPI v4. You'll need:
- A FlightAware account
- API access (may require a subscription)
- API key (no username required)

For API documentation, visit: https://flightaware.com/aeroapi/documentation

## Notes

- The Lambda function uses Node.js 20.x runtime
- DynamoDB table uses on-demand billing (pay-per-request)
- The table is set to DESTROY on stack deletion (change to RETAIN for production)
- CORS is enabled for all origins (restrict in production)
