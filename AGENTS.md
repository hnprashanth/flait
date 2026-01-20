# AGENTS.md - AI Agent Guidelines for flait

## Project Overview

Flight tracking application built with AWS CDK v2 (TypeScript). Uses Lambda, DynamoDB (single-table design), EventBridge, and API Gateway.

## Build, Test, and Lint Commands

### Build
```bash
npm run build          # TypeScript compilation
npx cdk synth          # Synthesize CloudFormation template
npx cdk diff           # Preview infrastructure changes
```

### Test Commands
```bash
# Run all unit tests
npm test

# Run a single test file
npx jest test/user-service.test.ts

# Run tests matching a pattern
npx jest -t "subscribes to EXISTING flight"

# Run tests in watch mode
npx jest --watch

# Integration test (requires deployed stack)
npm run test:flight
bash scripts/test-flight.sh KL879 2025-12-18
```

### No Linter Configured
This project does not have ESLint or Prettier configured. Follow the code style guidelines below.

## Project Structure

```
flait/
├── bin/                    # CDK app entry point
├── lib/                    # CDK stack definitions (flait-stack.ts)
├── lambda/                 # Lambda handlers
│   ├── flight-tracker/
│   ├── schedule-flight-tracker/
│   ├── notification-dispatcher/
│   ├── user-service/
│   └── subscription-service/
├── test/                   # Jest test files (*.test.ts)
├── scripts/                # Utility bash scripts
└── docs/                   # Documentation
```

## Code Style Guidelines

### File Naming
- Use **kebab-case** for all files: `flight-tracker.ts`, `user-service.test.ts`
- Lambda handlers: `index.ts` within service directories
- Test files: `*.test.ts` suffix in `test/` directory

### Import Organization
Order imports in this sequence:
```typescript
// 1. AWS SDK clients
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

// 2. AWS Lambda types
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

// 3. External packages
import Twilio from 'twilio';

// 4. Node.js built-ins
import * as crypto from 'crypto';

// 5. Local modules
import { FlaitStack } from '../lib/flait-stack';
```

For CDK stacks, use namespace imports:
```typescript
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
```

### Naming Conventions
| Element | Convention | Example |
|---------|------------|---------|
| Functions | camelCase, verb prefix | `fetchFlightInfo`, `createUser` |
| Variables | camelCase | `flightData`, `oldRecord` |
| Interfaces/Types | PascalCase | `FlightRequest`, `UserProfile` |
| Env var constants | UPPER_SNAKE_CASE | `TABLE_NAME`, `API_KEY` |
| Files | kebab-case | `flight-tracker.ts` |

### Type Definitions
- Define interfaces at module level, before functions
- Use explicit return types on all functions
- Use non-null assertion (`!`) for required env vars: `process.env.TABLE_NAME!`
- Use `as` for type casting JSON responses
- Avoid `any` - use `Record<string, unknown>` for dynamic objects

```typescript
interface FlightRequest {
  flight_number: string;
  date: string; // Format: YYYY-MM-DD
}

async function fetchFlightInfo(flightNumber: string): Promise<FlightAwareResponse> {
  const data = await response.json() as FlightAwareResponse;
  return data;
}
```

### Error Handling
- Top-level try-catch in Lambda handlers
- Early validation returns with appropriate status codes
- Use `instanceof Error` for error narrowing
- Re-throw errors when Lambda retry/DLQ handling is needed

```typescript
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    if (!event.body) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing body' }) };
    }
    // ... main logic
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: error instanceof Error ? error.message : 'Internal Server Error' 
      }),
    };
  }
};
```

### Export Patterns
- Use **named exports only** - no default exports
- Lambda handlers: `export const handler = async (...) => { ... }`
- CDK stacks: `export class FlaitStack extends cdk.Stack { ... }`
- Helper functions: keep private (not exported)

### Lambda Handler Structure
Organize files in this order:
1. Imports
2. Client instantiation (singletons at module level)
3. Environment variable constants
4. Interface definitions
5. Helper functions
6. Exported handler (last)

### Comments
- JSDoc for exported functions with parameter descriptions
- Inline comments for non-obvious logic
- Section dividers in CDK stacks: `// --- Feature Name ---`

```typescript
/**
 * Fetches flight information from FlightAware AeroAPI v4
 * @param flightNumber - ICAO flight number (e.g., "KL879")
 * @param date - Flight date in YYYY-MM-DD format
 */
async function fetchFlightInfo(flightNumber: string, date: string): Promise<FlightAwareResponse>
```

## Definition of Done Checklist

Before completing any task, verify:
- [ ] `npm run build` - compiles without errors
- [ ] `npm test` - all unit tests pass
- [ ] `npx cdk synth` - infrastructure synthesizes correctly
- [ ] No hardcoded secrets - use environment variables
- [ ] JSDoc comments on new exported functions
- [ ] No `console.log` - use `console.error` for errors only
- [ ] IAM roles follow least-privilege principle

## DynamoDB Data Model

- **Table**: `flight-data`
- **PK**: `{flight_number}#{date}`
- **SK**: `created_at` (ISO timestamp)
- **GSI**: `flight-number-date-index` (PK: `flight_number`, SK: `date`)

## Security Guidelines

- Never hardcode secrets (`FLIGHTAWARE_API_KEY`, Twilio credentials, etc.)
- Validate all API inputs before processing
- Use least-privilege IAM policies
- Never execute destructive commands without confirmation:
  - `rm -rf`
  - `git push --force`
  - Destructive DB migrations

## Workflow Protocol

### For Complex Tasks (Multi-file or Infrastructure Changes)
1. **PLAN**: Search codebase for existing patterns, outline changes
2. **IMPLEMENT**: Make atomic, verifiable changes with tests
3. **REVIEW**: Run build, tests, and `cdk diff` to verify

### Creating a New Lambda Function
1. Create handler in `lambda/{service-name}/index.ts`
2. Add `NodejsFunction` definition in `lib/flait-stack.ts`
3. Grant required permissions (DynamoDB, EventBridge, etc.)
4. Add unit tests in `test/{service-name}.test.ts`
5. Run `npx cdk synth` to validate
