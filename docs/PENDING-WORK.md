# Pending Work - FLAIT

Last updated: 2026-01-22

## Overview

This document tracks pending features and improvements for the FLAIT flight tracking application, based on the PRD documents and current implementation status.

---

## High Priority

### ~~1. Schedule Recalculation on Delay~~ ✅ COMPLETED
**Status:** Implemented  
**Completed:** 2026-01-21

When departure time changes by >30 minutes, flight-tracker automatically triggers schedule recalculation. The schedule-tracker deletes old schedules and creates new ones based on the updated departure time.

---

### ~~2. WhatsApp On-Demand Query Interface + LLM Integration~~ ✅ COMPLETED
**Status:** Implemented  
**Completed:** 2026-01-21

Users can now send WhatsApp messages to the Flait number and receive intelligent responses powered by Gemini 3 Flash Preview. The assistant (named "Flait") answers questions about tracked flights and general travel queries.

**Features:**
- Natural language understanding via Gemini 3 Flash Preview (4096 token output)
- Flight context awareness (pulls user's subscriptions and current flight data)
- Pre-computed local times, flight phases, and connection analysis for accurate responses
- Travel assistant personality for general questions
- Rate limiting (20 queries/hour per user)
- Graceful error handling

**Webhook URL:** `https://3x1f2jf6p4.execute-api.ap-south-1.amazonaws.com/prod/whatsapp`

---

### 3. Inbound Aircraft Tracking
**Status:** Not Implemented  
**Effort:** High  
**Description:** Track the aircraft that will operate your flight. If the inbound flight is delayed, predict delay for your flight before it's officially announced.

**Implementation Notes:**
- FlightAware API provides `inbound_fa_flight_id` field
- Need to track the inbound flight and correlate delays
- Proactively warn users: "Your aircraft is running 30 min late on its previous leg"

**PRD Reference:** FLAIT-Assistant-in-the-Air.md → Before Checkin

---

## Medium Priority

### 4. Leave-for-Airport Notifications
**Status:** Not Implemented  
**Effort:** Medium  
**Description:** Calculate when user should leave for airport based on departure time, and send a reminder.

**Implementation Notes:**
- Need user's location or default lead time preference
- Consider traffic conditions (optional - requires external API)
- Simple version: "Leave now to arrive 2 hours before departure"

---

### 5. Boarding Zone Timing Estimates
**Status:** Not Implemented  
**Effort:** Low  
**Description:** Estimate when user's boarding zone will be called based on departure time and typical boarding patterns.

**Implementation Notes:**
- Boarding typically starts 30-40 min before departure
- Zone timing varies by airline
- Simple heuristic: "Zone 3 typically boards 15-20 min before departure"

---

### 6. Baggage Belt Information
**Status:** Not Implemented  
**Effort:** Medium  
**Description:** Notify users which baggage carousel to go to upon arrival.

**Implementation Notes:**
- FlightAware may not provide this
- May need airport-specific APIs or manual data
- Could be added to pre-landing summary

---

### 7. User Preferences & Settings
**Status:** Not Implemented  
**Effort:** Medium  
**Description:** Allow users to configure notification preferences.

**Preferences to support:**
- Notification frequency (all milestones vs. important only)
- Lead time for airport departure reminder
- Quiet hours (no notifications between X and Y)
- Timezone preference override

---

## Low Priority

### 8. Express Security/TSA Pre Suggestions
**Status:** Not Implemented  
**Effort:** Low  
**Description:** Remind users about expedited security options if available.

---

### 9. Seat Intelligence
**Status:** Not Implemented  
**Effort:** High  
**Description:** Track seat assignments and notify about upgrades or changes.

**Notes:** Requires airline-specific integrations, not available via FlightAware.

---

### 10. Airport Navigation Instructions
**Status:** Not Implemented  
**Effort:** High  
**Description:** Provide walking directions within airports for connections.

**Notes:** Requires airport map data and indoor navigation capabilities.

---

### 11. Layover Suggestions
**Status:** Not Implemented  
**Effort:** Medium  
**Description:** For long layovers, suggest lounges, restaurants, or activities.

**Notes:** Requires curated airport data or third-party API.

---

### 12. Weather & Local Time Info
**Status:** Not Implemented  
**Effort:** Low  
**Description:** Include destination weather and local time in pre-landing summary.

**Notes:** Requires weather API integration.

---

### 13. Immigration Prep
**Status:** Not Implemented  
**Effort:** Low  
**Description:** Remind international travelers about immigration requirements.

**Notes:** Static content based on destination country.

---

### 14. Ground Transport Instructions
**Status:** Not Implemented  
**Effort:** Medium  
**Description:** Provide info about getting from airport to final destination.

**Notes:** Requires user's final destination and transport APIs.

---

## Technical Debt

### 1. Improve Error Handling in Notification Dispatcher
**Description:** Add retry logic and better error messages when Twilio fails.

### 2. Add Integration Tests
**Description:** Create end-to-end tests that verify the full flow from subscription to notification.

### 3. CloudWatch Alarms
**Description:** Set up alarms for Lambda errors, DLQ messages, and API latency.

### 4. Cost Optimization
**Description:** Review Lambda memory settings and DynamoDB capacity for cost efficiency.

### 5. WhatsApp Template Messages
**Description:** Register pre-approved WhatsApp templates for proactive notifications outside the 24-hour window.

### 6. Conversation Memory for WhatsApp Queries
**Description:** Add conversation history to enable follow-up questions in WhatsApp.

**Current Issue:** Each WhatsApp message is stateless - Flait has no memory of previous messages in the conversation.

**Implementation Plan:**
- Store last 5-10 messages per user in DynamoDB with 1-hour TTL
- Schema: `PK: CONV#{phone}`, `SK: {timestamp}`, `role: user|assistant`
- Pass conversation history to Gemini for context-aware responses
- Example: "What's my flight status?" → "What about the gate?" (second message needs context)

---

## Completed Features ✓

- [x] Flight data fetching from FlightAware API
- [x] Intelligent schedule creation (4-phase polling)
- [x] Flight data storage in DynamoDB
- [x] Change detection and event publishing
- [x] User registration system
- [x] Flight subscription system with auto-provisioning
- [x] WhatsApp notifications via Twilio
- [x] Dead letter queue for failed notifications
- [x] Proactive milestone notifications (24h, 12h, 4h, boarding, pre-landing)
- [x] Smart connection analysis with risk assessment
- [x] Local timezone display in notifications
- [x] City names in route display
- [x] Precise flight tracking with `fa_flight_id` (prevents wrong flight data as time passes)
- [x] Schedule recalculation on delay (>30 min departure change triggers schedule rebuild)
- [x] WhatsApp on-demand query interface with Gemini 3 Flash Preview LLM
- [x] Rate limiting for WhatsApp queries (20/hour)
- [x] Pre-computed local times, flight phases, and connection analysis for LLM context
- [x] Time change notifications with old→new format and difference (e.g., "07:45 → 08:27 (+42m)")

---

## How to Contribute

1. Pick an item from this list
2. Create a feature branch: `git checkout -b feature/item-name`
3. Implement the feature with tests
4. Run `npm run build && npm test && npx cdk synth`
5. Create a PR with description referencing this document
