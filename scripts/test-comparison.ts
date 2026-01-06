import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const TABLE_NAME = 'flight-data'; // Hardcoded for this script

async function getAllFlightData() {
  console.log('Scanning flight-data table...');
  const response = await docClient.send(new ScanCommand({
    TableName: TABLE_NAME,
  }));
  return response.Items || [];
}

/**
 * Extracts common flight fields - copied from lambda/flight-tracker/index.ts
 * to ensure consistency in comparison logic.
 */
function extractFlightFields(flightData: any): Record<string, any> {
  const result: Record<string, any> = {};
  
  if (flightData && typeof flightData === 'object') {
    if ('ident' in flightData) result.flight_ident = flightData.ident;
    if ('origin' in flightData) result.departure_airport = flightData.origin;
    if ('destination' in flightData) result.arrival_airport = flightData.destination;
    if ('scheduled_out' in flightData) result.scheduled_departure = flightData.scheduled_out;
    if ('scheduled_in' in flightData) result.scheduled_arrival = flightData.scheduled_in;
    if ('estimated_out' in flightData) result.estimated_departure = flightData.estimated_out;
    if ('estimated_in' in flightData) result.estimated_arrival = flightData.estimated_in;
    if ('actual_out' in flightData) result.actual_departure = flightData.actual_out;
    if ('actual_in' in flightData) result.actual_arrival = flightData.actual_in;
    if ('status' in flightData) result.status = flightData.status;
    if ('gate_origin' in flightData) result.gate_origin = flightData.gate_origin;
    if ('gate_destination' in flightData) result.gate_destination = flightData.gate_destination;
  }
  
  return result;
}

/**
 * Compares old and new flight data - copied from lambda/flight-tracker/index.ts
 */
function compareFlightData(oldData: Record<string, any>, newRawData: any): Record<string, any> {
  const changes: Record<string, any> = {};
  const newFields = extractFlightFields(newRawData);
  
  const fieldsToMonitor = [
    'status',
    'scheduled_departure',
    'estimated_departure',
    'actual_departure',
    'scheduled_arrival',
    'estimated_arrival',
    'actual_arrival',
    'departure_airport',
    'arrival_airport',
    'gate_origin',
    'gate_destination'
  ];

  for (const field of fieldsToMonitor) {
    const oldValue = oldData[field];
    const newValue = newFields[field];
    
    // We need to handle nested objects (like airports) for comparison
    // Ideally we should compare primitive values or specific props of objects
    // But for this quick test, simple equality or JSON stringify equality works
    
    let isDifferent = false;
    if (typeof oldValue === 'object' && oldValue !== null && typeof newValue === 'object' && newValue !== null) {
       isDifferent = JSON.stringify(oldValue) !== JSON.stringify(newValue);
    } else {
       isDifferent = oldValue !== newValue;
    }

    if (isDifferent) {
      if (!oldValue && !newValue) continue;
      
      changes[field] = {
        old: oldValue,
        new: newValue
      };
    }
  }
  
  return changes;
}

async function main() {
  try {
    const items = await getAllFlightData();
    console.log(`Found ${items.length} items.`);

    // Group by flight and date (PK)
    const groups: Record<string, any[]> = {};
    for (const item of items) {
      const pk = item.PK as unknown as string;
      if (!groups[pk]) groups[pk] = [];
      groups[pk].push(item);
    }

    // Process each group
    for (const pk in groups) {
      const groupItems = groups[pk];
      
      // We need at least 2 items to compare
      if (groupItems.length < 2) continue;

      // Sort by SK (timestamp)
      groupItems.sort((a, b) => (a.SK as unknown as string).localeCompare(b.SK as unknown as string));

      console.log(`
Analyzing history for ${pk} (${groupItems.length} records):`);

      for (let i = 1; i < groupItems.length; i++) {
        const oldRecord = groupItems[i-1];
        const newRecord = groupItems[i];
        
        // The 'flight_data' attribute contains the raw API response in the DynamoDB item
        // But wait, looking at the scan output from earlier:
        // "flight_data": { "M": { "flights": { "L": [...] } } }
        // It seems the stored data structure might be slightly different than what I expected 
        // or what the extraction logic expects if it wasn't flattened.
        
        // Let's inspect the structure from the scan output provided by the user earlier:
        // It had "flight_data": { "M": ... } which is DynamoDB JSON format.
        // The AWS SDK unmarshalls this for us.
        // However, the structure inside 'flight_data' seems to be the raw response.
        // In the scan output: "flight_data": { "flights": [ ... ] }
        // So the raw response is an object with a 'flights' array.
        
        // The extractFlightFields function in lambda/flight-tracker/index.ts:
        // if ('ident' in flightData) ...
        // It seems to expect the flight object directly, NOT { flights: [...] }
        
        // Let's look at the Lambda code again.
        // async function fetchFlightInfo... returns FlightAwareResponse
        // const flightData = await fetchFlightInfo(...)
        // ... extractFlightFields(flightData) ...
        
        // If AeroAPI v4 returns { flights: [...] }, then `extractFlightFields` logic in the Lambda
        // might be slightly off if it expects 'ident' at the top level, OR 
        // `fetchFlightInfo` returns the inner flight object?
        
        // Let's check `lambda/flight-tracker/index.ts` again.
        // It calls `fetch(url)`. AeroAPI /flights/{ident} returns { flights: [ ... ] }.
        // The lambda returns `data` which is that whole object.
        // Then `storeFlightData` puts it into `flight_data` attribute.
        // AND `storeFlightData` calls `extractFlightFields(flightData)`.
        
        // WAIT. In the Lambda `extractFlightFields`:
        // if ('ident' in flightData) ...
        
        // If `flightData` is { flights: [...] }, then 'ident' is NOT in `flightData`.
        // It is in `flightData.flights[0]`.
        
        // So `extractFlightFields` in the Lambda might be BUGGY if it expects top-level fields
        // but receives the wrapper.
        // OR, the scan output I saw earlier was just one example and maybe sometimes it returns differently?
        // AeroAPI v4 /flights/:ident usually returns { flights: [...] }.
        
        // Let's try to handle both cases in this script to be safe, 
        // and identifying this potential bug is also a "result" of this test.
        
        let rawDataOld = oldRecord.flight_data;
        let rawDataNew = newRecord.flight_data;
        
        // Unmarshall check: if we run this locally with ts-node, the SDK might return unmarshalled JS objects.
        // If rawDataNew has 'flights' array, we should probably pick the first one to compare?
        // Or if we stored flattened fields in the item itself (which the Lambda does: ...extractFlightFields(flightData)),
        // we can compare those directly from the Item!
        
        // The Lambda does:
        // const item = {
        //   ...
        //   flight_data: flightData,
        //   ...extractFlightFields(flightData),
        // };
        
        // So the Item itself SHOULD have `status`, `estimated_departure` etc. at the top level 
        // IF `extractFlightFields` worked correctly.
        
        // Let's try to compare the Item's top-level fields against the next Item's top-level fields.
        // That's the most accurate simulation of "did the stored state change?".
        
        // BUT, the goal is to trigger on changes.
        // If the Lambda logic was buggy, those fields might be missing.
        // Let's check the scan output again.
        // "flight_data": { "M": { "flights": { "L": [...] } } }
        // "status": { "S": "Scheduled" }  <-- Wait, checking the scan output again...
        // ...
        // "flight_data": { ... },
        // "created_at": { "S": "..." },
        // "flight_number": { "S": "..." },
        // "PK": { ... }
        
        // I DO NOT see "status", "estimated_departure" etc. at the top level in the previous `aws dynamodb scan` output!
        // This implies `extractFlightFields` failed to find 'ident', 'status' etc. in the raw response
        // because they were nested inside `flights: []`.
        
        // SO, THE LAMBDA BUG IS REAL. `extractFlightFields` is looking for 'ident' in `{ flights: [...] }`.
        
        // For this test script, I need to look inside `flight_data.flights[0]` to actually find the data to compare.
        // And I should probably fix the Lambda later.
        
        let actualFlightDataOld = rawDataOld;
        if (rawDataOld && rawDataOld.flights && Array.isArray(rawDataOld.flights) && rawDataOld.flights.length > 0) {
            actualFlightDataOld = rawDataOld.flights[0];
        }
        
        let actualFlightDataNew = rawDataNew;
        if (rawDataNew && rawDataNew.flights && Array.isArray(rawDataNew.flights) && rawDataNew.flights.length > 0) {
            actualFlightDataNew = rawDataNew.flights[0];
        }
        
        // Now compare
        // We simulate "Old Data" as the fields we extracted from the previous record
        // "New Data" as the raw response of the new record
        
        const oldFields = extractFlightFields(actualFlightDataOld);
        const changes = compareFlightData(oldFields, actualFlightDataNew); // Note: we pass the object that HAS the fields
        
        if (Object.keys(changes).length > 0) {
          console.log(`
  Change detected between ${oldRecord.SK} and ${newRecord.SK}:`);
          for (const [key, val] of Object.entries(changes)) {
             // @ts-ignore
             console.log(`    - ${key}: ${val.old} -> ${val.new}`);
          }
        } else {
           // console.log(`  No changes between ${oldRecord.SK} and ${newRecord.SK}`);
        }
      }
    }

  } catch (error) {
    console.error('Error:', error);
  }
}

main();
