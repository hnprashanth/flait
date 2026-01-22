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

### ~~3. Inbound Aircraft Tracking~~ ✅ COMPLETED
**Status:** Implemented  
**Completed:** 2026-01-22

Track the aircraft's previous flight leg to proactively warn users about potential delays.

**Features:**
- Extracts `inbound_fa_flight_id` from FlightAware API
- Checks inbound flight status within 5 hours of departure
- Sends delay alerts when inbound delay > 30 min (re-alerts on +15 min increases)
- Sends "inbound landed" alert when aircraft arrives
- Inbound info included in WhatsApp query context

**Notifications:**
- "⚠️ Your aircraft is running 45 min late on its previous flight from JFK"
- "✅ Good news! Your aircraft has landed at AMS"

---

### ~~4. WhatsApp Flight Subscription~~ ✅ COMPLETED
**Status:** Implemented  
**Completed:** 2026-01-22

Users can subscribe to flights via natural language in WhatsApp.

**Supported formats:**
- "Track KL880 tomorrow"
- "Add flight UA123 on Jan 25"
- "Track KL880 tomorrow and KL881 on Jan 26"

**Features:**
- Natural language parsing via Gemini
- Relative dates: "tomorrow", "next Monday", "in 3 days"
- Absolute dates: "Jan 25", "25th January"
- Dates resolved using departure city timezone
- Multiple flights in single message
- Duplicate detection
- Flight validation before subscribing

---

## Medium Priority

### 5. Leave-for-Airport Notifications
**Status:** Not Implemented  
**Effort:** Medium  
**Description:** Calculate when user should leave for airport based on departure time, and send a reminder.

**Implementation Notes:**
- Need user's location or default lead time preference
- Consider traffic conditions (optional - requires external API)
- Simple version: "Leave now to arrive 2 hours before departure"

---

### 6. Boarding Zone Timing Estimates
**Status:** Not Implemented  
**Effort:** Low  
**Description:** Estimate when user's boarding zone will be called based on departure time and typical boarding patterns.

**Implementation Notes:**
- Boarding typically starts 30-40 min before departure
- Zone timing varies by airline
- Simple heuristic: "Zone 3 typically boards 15-20 min before departure"

---

### 7. Baggage Belt Information
**Status:** Not Implemented  
**Effort:** Medium  
**Description:** Notify users which baggage carousel to go to upon arrival.

**Implementation Notes:**
- FlightAware may not provide this
- May need airport-specific APIs or manual data
- Could be added to pre-landing summary

---

### 8. User Preferences & Settings
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

### 9. Express Security/TSA Pre Suggestions
**Status:** Not Implemented  
**Effort:** Low  
**Description:** Remind users about expedited security options if available.

---

### 10. Seat Intelligence
**Status:** Not Implemented  
**Effort:** High  
**Description:** Track seat assignments and notify about upgrades or changes.

**Notes:** Requires airline-specific integrations, not available via FlightAware.

---

### 11. Airport Navigation Instructions
**Status:** Not Implemented  
**Effort:** High  
**Description:** Provide walking directions within airports for connections.

**Notes:** Requires airport map data and indoor navigation capabilities.

---

### 12. Layover Suggestions
**Status:** Not Implemented  
**Effort:** Medium  
**Description:** For long layovers, suggest lounges, restaurants, or activities.

**Notes:** Requires curated airport data or third-party API.

---

### 13. Weather & Local Time Info
**Status:** Not Implemented  
**Effort:** Low  
**Description:** Include destination weather and local time in pre-landing summary.

**Notes:** Requires weather API integration.

---

### 14. Immigration Prep
**Status:** Not Implemented  
**Effort:** Low  
**Description:** Remind international travelers about immigration requirements.

**Notes:** Static content based on destination country.

---

### 15. Ground Transport Instructions
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

### ~~6. Conversation Memory for WhatsApp Queries~~ ✅ COMPLETED
**Description:** Conversation history now enables follow-up questions in WhatsApp.

**Implementation:**
- Stores last 10 messages per user in DynamoDB with 1-hour TTL
- Schema: `PK: CONV#{phone}`, `SK: {timestamp}#{role}`
- Passes conversation history to Gemini for context-aware responses
- Completed: 2026-01-22

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
- [x] Conversation memory for WhatsApp follow-up questions (10 messages, 1-hour TTL)
- [x] Inbound aircraft tracking with delay and landed alerts
- [x] WhatsApp flight subscription via natural language ("Track KL880 tomorrow")

---

## How to Contribute

1. Pick an item from this list
2. Create a feature branch: `git checkout -b feature/item-name`
3. Implement the feature with tests
4. Run `npm run build && npm test && npx cdk synth`
5. Create a PR with description referencing this document
