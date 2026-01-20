# DynamoDB Flight Data Analysis

## Data Structure Overview

The flight data is stored in DynamoDB with the following structure:

### Primary Keys
- **PK (Partition Key)**: `{flight_number}#{date}` (e.g., `KL879#2025-12-18`)
- **SK (Sort Key)**: ISO timestamp when data was fetched (e.g., `2025-12-18T07:17:59.297Z`)

### Stored Fields
- `flight_number`: The flight number (e.g., "KL879")
- `date`: The date in YYYY-MM-DD format
- `created_at`: Timestamp when the record was created
- `flight_data`: Complete FlightAware API response containing multiple flight records

## Understanding the Flight Data Response

The FlightAware API returns an array of flight records for the given flight number. Each record represents a different occurrence of that flight (past, present, or future).

### Key Fields in Each Flight Record

#### 1. **Flight Identification** (Essential)
- `ident`: Full flight identifier (e.g., "KLM879")
- `ident_iata`: IATA code (e.g., "KL879")
- `ident_icao`: ICAO code (e.g., "KLM879")
- `flight_number`: Numeric flight number (e.g., "879")
- `operator`: Airline name (e.g., "KLM")
- `operator_iata`: Airline IATA code (e.g., "KL")
- `operator_icao`: Airline ICAO code (e.g., "KLM")

#### 2. **Status Information** (Critical)
- `status`: Current flight status
  - "Scheduled" - Flight is scheduled but hasn't departed
  - "In Flight" - Flight is currently in the air
  - "Arrived / Gate Arrival" - Flight has landed and arrived at gate
  - "Landed" - Flight has landed
  - "Cancelled" - Flight was cancelled
  - "Diverted" - Flight was diverted
- `cancelled`: Boolean indicating if flight is cancelled
- `diverted`: Boolean indicating if flight was diverted
- `blocked`: Boolean indicating if flight is blocked
- `progress_percent`: Flight progress (0-100)

#### 3. **Origin & Destination** (Essential)
- `origin`: Object containing:
  - `code`: ICAO code (e.g., "EHAM")
  - `code_iata`: IATA code (e.g., "AMS")
  - `code_icao`: ICAO code
  - `name`: Airport name (e.g., "Amsterdam Schiphol")
  - `city`: City name (e.g., "Amsterdam")
  - `timezone`: Timezone (e.g., "Europe/Amsterdam")
- `destination`: Same structure as origin

#### 4. **Timing Information** (Critical for Tracking)

**Scheduled Times:**
- `scheduled_out`: Scheduled gate departure (UTC)
- `scheduled_off`: Scheduled runway departure (UTC)
- `scheduled_on`: Scheduled runway arrival (UTC)
- `scheduled_in`: Scheduled gate arrival (UTC)

**Estimated Times:**
- `estimated_out`: Estimated gate departure (UTC)
- `estimated_off`: Estimated runway departure (UTC)
- `estimated_on`: Estimated runway arrival (UTC)
- `estimated_in`: Estimated gate arrival (UTC)

**Actual Times:**
- `actual_out`: Actual gate departure (UTC) - null if not yet departed
- `actual_off`: Actual runway departure (UTC) - null if not yet taken off
- `actual_on`: Actual runway arrival (UTC) - null if not yet landed
- `actual_in`: Actual gate arrival (UTC) - null if not yet arrived

**Delays:**
- `departure_delay`: Departure delay in seconds (negative = early)
- `arrival_delay`: Arrival delay in seconds (negative = early)

#### 5. **Gate & Terminal Information** (Useful for Passengers)
- `gate_origin`: Departure gate (e.g., "E17")
- `gate_destination`: Arrival gate (e.g., "C1")
- `terminal_origin`: Departure terminal
- `terminal_destination`: Arrival terminal (e.g., "2")
- `baggage_claim`: Baggage claim area (e.g., "3A")

#### 6. **Aircraft Information** (Useful)
- `aircraft_type`: Aircraft model (e.g., "B78X", "B77W")
- `registration`: Aircraft registration (e.g., "PH-BKP")
- `route_distance`: Route distance in nautical miles (e.g., 4785)

#### 7. **Flight Details** (Additional Context)
- `route`: Flight route (often null)
- `filed_airspeed`: Filed airspeed in knots
- `filed_altitude`: Filed altitude
- `filed_ete`: Filed estimated time enroute in seconds
- `actual_runway_off`: Runway used for takeoff (e.g., "18L")
- `actual_runway_on`: Runway used for landing (e.g., "09L")

#### 8. **Codeshares** (Reference)
- `codeshares`: Array of codeshare flight identifiers
- `codeshares_iata`: Array of IATA codeshare identifiers

#### 9. **Metadata**
- `fa_flight_id`: FlightAware unique flight ID
- `inbound_fa_flight_id`: Related inbound flight ID
- `foresight_predictions_available`: Boolean for prediction availability
- `type`: Flight type (e.g., "Airline")
- `position_only`: Boolean indicating if only position data available

## Most Useful Fields for Flight Tracking

### For Real-time Tracking:
1. **`status`** - Current flight status
2. **`progress_percent`** - How far along the flight is
3. **`estimated_out`**, **`estimated_off`**, **`estimated_on`**, **`estimated_in`** - Best estimates
4. **`actual_out`**, **`actual_off`**, **`actual_on`**, **`actual_in`** - Actual times when available

### For Passenger Information:
1. **`gate_origin`**, **`gate_destination`** - Gate numbers
2. **`terminal_origin`**, **`terminal_destination`** - Terminal information
3. **`baggage_claim`** - Where to collect baggage
4. **`departure_delay`**, **`arrival_delay`** - Delay information

### For Historical Analysis:
1. **`scheduled_*`** vs **`actual_*`** - Compare planned vs actual
2. **`departure_delay`**, **`arrival_delay`** - Track punctuality
3. **`aircraft_type`** - Track aircraft usage
4. **`route_distance`** - Track route consistency

### For Flight Identification:
1. **`ident_iata`** - Most commonly used identifier
2. **`flight_number`** - Numeric flight number
3. **`operator`** - Airline name

## How to Query and Use the Data

### Finding the Most Recent Check for a Flight:
```javascript
// Query by PK, sort by SK descending, limit 1
{
  KeyConditionExpression: "PK = :pk",
  ExpressionAttributeValues: {
    ":pk": "KL879#2025-12-18"
  },
  ScanIndexForward: false,  // Descending order
  Limit: 1
}
```

### Finding the Current/Latest Flight Status:
The API returns multiple flights. To find the one for your specific date:
1. Filter by `scheduled_out` date matching your query date
2. Or use the first flight in the array (usually the most relevant)
3. Check `status` field to determine if it's past, current, or future

### Understanding Multiple Flight Records:
- The API returns historical and future flights for the same flight number
- Each record has a different `scheduled_out` date
- Use the record where `scheduled_out` matches your query date
- If multiple records exist for the same date, they might be different legs or rebookings

## Recommendations for Data Extraction

Consider extracting these fields to top-level for easier querying:
- `status`
- `origin.code_iata` → `departure_airport`
- `destination.code_iata` → `arrival_airport`
- `scheduled_out` → `scheduled_departure`
- `scheduled_in` → `scheduled_arrival`
- `estimated_out` → `estimated_departure`
- `estimated_in` → `estimated_arrival`
- `actual_out` → `actual_departure`
- `actual_in` → `actual_arrival`
- `departure_delay`
- `arrival_delay`
- `gate_origin`
- `gate_destination`
- `aircraft_type`

This would make querying and filtering much easier without having to parse the nested `flight_data` structure.






