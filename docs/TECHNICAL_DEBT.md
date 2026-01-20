# Technical Debt & Future Improvements

This document tracks known architectural gaps, security recommendations, and reliability improvements for the Flait project.

## 🔴 High Priority: Security & Data Integrity

### 1. Secrets Management
*   **Issue**: `TWILIO_AUTH_TOKEN` and `FLIGHTAWARE_API_KEY` are currently stored in Lambda environment variables.
*   **Risk**: Plain-text visibility in the AWS Console.
*   **Task**: Migrate all sensitive keys to **AWS Secrets Manager**. Update Lambdas to fetch secrets at runtime or via the AWS Parameters and Secrets Lambda Extension.

### 2. Production Removal Policies
*   **Issue**: DynamoDB tables are currently set to `cdk.RemovalPolicy.DESTROY`.
*   **Risk**: Accidental `cdk destroy` or stack deletion will result in permanent data loss.
*   **Task**: Change to `cdk.RemovalPolicy.RETAIN` before deploying to a production AWS account.

---

## 🟡 Medium Priority: Reliability & Orchestration

### 1. Subscription Orchestration (Step Functions)
*   **Issue**: `subscription-service` performs a synchronous "chain" of Lambda invocations (Tracker -> Scheduler -> DB Write).
*   **Risk**: Partial failure (e.g., Tracker succeeds, but Scheduler fails) leaves the system in an inconsistent state.
*   **Task**: Replace the internal Lambda orchestration with an **AWS Step Functions (Express Workflow)** to provide built-in retries, error handling, and visual debugging.

### 2. Twilio Webhook Handling
*   **Issue**: We are sending messages but not handling status callbacks or user replies.
*   **Task**: Create an API Gateway endpoint to receive Twilio Webhooks. This allows us to track message delivery status (Delivered, Read) and handle "STOP" or "HELP" commands from users.

### 3. Flight Data Cleanup
*   **Issue**: `flight-data` (the log table) grows indefinitely.
*   **Task**: Enable **DynamoDB TTL** (Time to Live) on the `flight-data` table to automatically expire logs after 30-90 days to keep storage costs low and performance high.

---

## 🟢 Low Priority: Developer Experience & DX

### 1. Enhanced Type Definitions
*   **Task**: Create a shared `types/` or `layers/` directory to share common interfaces (User, Subscription, FlightEvent) between all Lambda functions.

### 2. Integration Test Suite
*   **Task**: Create a `scripts/e2e-test.ts` that performs a full flow: Create User -> Subscribe to New Flight -> Mock EventBridge Event -> Verify Mock Twilio Call.

---

## 📋 Definition of Done for Future Tasks
- [ ] Code follows Single Table Design principles.
- [ ] Logic is verified with a corresponding `*.test.ts`.
- [ ] Security review: No secrets exposed in logs or env vars.
- [ ] Infrastructure: `npx cdk synth` passes.
