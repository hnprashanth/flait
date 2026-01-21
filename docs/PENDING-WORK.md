# Pending Work - FLAIT

Last updated: 2026-01-21 (evening)

## Overview

This document tracks pending features and improvements for the FLAIT flight tracking application, based on the PRD documents and current implementation status.

---

## High Priority

### ~~1. Schedule Recalculation on Delay~~ ✅ COMPLETED
**Status:** Implemented  
**Completed:** 2026-01-21

When departure time changes by >30 minutes, flight-tracker automatically triggers schedule recalculation. The schedule-tracker deletes old schedules and creates new ones based on the updated departure time.

---

### 2. WhatsApp On-Demand Query Interface + LLM Integration
**Status:** Not Implemented  
**Effort:** High  
**Description:** Allow users to send messages to the WhatsApp number and get intelligent responses about their flights using an LLM (Gemini or OpenAI).

**User Queries to Support:**
- "What's my gate?"
- "Is my flight on time?"
- "When should I leave for the airport?"
- "Will I make my connection?"
- "What's the weather in Amsterdam?"
- General travel questions

**Implementation Notes:**
- Create Twilio webhook endpoint (new Lambda: `whatsapp-handler`)
- Integrate with Gemini API (preferred) or OpenAI for natural language understanding
- Build context from user's flight subscriptions and current flight data
- Use function calling / tool use for structured data retrieval
- Implement conversation memory for follow-up questions
- Fallback to simple keyword matching if LLM is unavailable

**Architecture:**
```
User WhatsApp Message
        ↓
   Twilio Webhook
        ↓
  whatsapp-handler Lambda
        ↓
   ┌────────────────┐
   │  LLM (Gemini)  │ ← Context: user's flights, current status
   └────────────────┘
        ↓
   Response Generation
        ↓
   Twilio → User
```

**LLM Provider Options:**
| Provider | Pros | Cons |
|----------|------|------|
| Gemini | Free tier, good function calling, fast | Newer, less ecosystem |
| OpenAI | Mature, excellent function calling | Cost, rate limits |
| Claude | Great reasoning | Cost, no direct API in India |

**Recommended:** Start with Gemini (google-generativelanguage API) for cost efficiency.

**PRD Reference:** FLAIT-Assistant-in-the-Air.md → On-Demand Features

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

---

## How to Contribute

1. Pick an item from this list
2. Create a feature branch: `git checkout -b feature/item-name`
3. Implement the feature with tests
4. Run `npm run build && npm test && npx cdk synth`
5. Create a PR with description referencing this document
