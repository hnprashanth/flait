import { SchedulerClient, CreateScheduleCommand, DeleteScheduleCommand, ListSchedulesCommand, FlexibleTimeWindowMode } from '@aws-sdk/client-scheduler';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const schedulerClient = new SchedulerClient({});
const FLIGHTAWARE_API_KEY = process.env.FLIGHTAWARE_API_KEY!;
const FLIGHT_TRACKER_FUNCTION_ARN = process.env.FLIGHT_TRACKER_FUNCTION_ARN!;
const SCHEDULER_ROLE_ARN = process.env.SCHEDULER_ROLE_ARN!;

interface FlightRequest {
  flight_number: string;
  date: string; // Format: YYYY-MM-DD
  recalculate?: boolean; // If true, delete existing schedules and recreate
  new_departure_time?: string; // ISO string of new departure time (used with recalculate)
  fa_flight_id?: string; // FlightAware unique flight ID (used with recalculate)
}

interface FlightAwareResponse {
  [key: string]: any;
}

interface FlightInfo {
  departureTime: Date;
  faFlightId: string;
}

/**
 * Returns the next day in YYYY-MM-DD format
 */
function getNextDay(dateStr: string): string {
  const date = new Date(dateStr);
  date.setDate(date.getDate() + 1);
  return date.toISOString().split('T')[0];
}

/**
 * Fetches flight information from FlightAware AeroAPI v4 with date filtering
 * to get the correct flight for the specified date
 */
async function fetchFlightInfo(flightNumber: string, date: string): Promise<FlightAwareResponse> {
  if (!FLIGHTAWARE_API_KEY) {
    throw new Error('FlightAware API key not configured');
  }

  // Use date filtering to get the correct flight for the specified date
  const startDate = date;
  const endDate = getNextDay(date);
  const url = `https://aeroapi.flightaware.com/aeroapi/flights/${encodeURIComponent(flightNumber)}?start=${startDate}&end=${endDate}`;
  
  console.log(`Fetching from FlightAware: ${url}`);
  
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'x-apikey': FLIGHTAWARE_API_KEY,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`FlightAware API error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const data = await response.json() as FlightAwareResponse;
  return data;
}

/**
 * Extracts departure time and fa_flight_id from FlightAware response
 * @param flightData - FlightAware API response
 * @param targetDate - The date we're looking for (YYYY-MM-DD)
 * @returns FlightInfo with departure time and fa_flight_id, or null if not found
 */
function extractFlightInfo(flightData: FlightAwareResponse, targetDate: string): FlightInfo | null {
  // AeroAPI v4 returns flights in an array
  if (!Array.isArray(flightData.flights) || flightData.flights.length === 0) {
    console.warn('No flights found in response');
    return null;
  }

  // Find the flight matching the target date
  // scheduled_out format: "2026-01-21T21:00:00Z"
  for (const flight of flightData.flights) {
    const scheduledOut = flight.scheduled_out || flight.estimated_out || flight.actual_out;
    if (!scheduledOut) continue;

    const flightDate = scheduledOut.split('T')[0]; // Extract YYYY-MM-DD
    
    if (flightDate === targetDate) {
      const departureTime = new Date(flight.actual_out || flight.estimated_out || flight.scheduled_out);
      const faFlightId = flight.fa_flight_id;

      if (!faFlightId) {
        console.warn('Flight found but missing fa_flight_id');
        return null;
      }

      console.log(`Found flight for ${targetDate}: fa_flight_id=${faFlightId}, departure=${departureTime.toISOString()}`);
      return { departureTime, faFlightId };
    }
  }

  // If no exact date match, use the first flight (fallback for edge cases)
  console.warn(`No exact date match for ${targetDate}, using first flight from response`);
  const firstFlight = flightData.flights[0];
  const scheduledOut = firstFlight.actual_out || firstFlight.estimated_out || firstFlight.scheduled_out;
  
  if (!scheduledOut || !firstFlight.fa_flight_id) {
    return null;
  }

  return {
    departureTime: new Date(scheduledOut),
    faFlightId: firstFlight.fa_flight_id,
  };
}

/**
 * Calculates schedule phases based on departure time and interval rules
 * Returns an array of schedule phases with start/end times and intervals
 */
interface SchedulePhase {
  startTime: Date;
  endTime: Date;
  interval: string;
  window: string;
}

function calculateSchedulePhases(departureTime: Date, now: Date = new Date()): SchedulePhase[] {
  const phases: SchedulePhase[] = [];
  const timeToDeparture = departureTime.getTime() - now.getTime();
  
  // If flight has already departed or is very close (< 1 minute), return empty
  if (timeToDeparture < 60000) {
    return phases;
  }
  
  const hoursToDeparture = timeToDeparture / (1000 * 60 * 60);
  
  // Phase 1: > 24 hours - Check every 12 hours
  if (hoursToDeparture > 24) {
    const phase1End = new Date(departureTime.getTime() - 24 * 60 * 60 * 1000);
    if (now < phase1End) {
      phases.push({
        startTime: new Date(now),
        endTime: phase1End,
        interval: '12h',
        window: '>24h to departure',
      });
    }
  }
  
  // Phase 2: 12-24 hours - Check every 2 hours
  if (hoursToDeparture > 12) {
    const phase2Start = new Date(departureTime.getTime() - 24 * 60 * 60 * 1000);
    const phase2End = new Date(departureTime.getTime() - 12 * 60 * 60 * 1000);
    const actualStart = phase2Start > now ? phase2Start : now;
    
    if (actualStart < phase2End) {
      phases.push({
        startTime: actualStart,
        endTime: phase2End,
        interval: '2h',
        window: '12-24h to departure',
      });
    }
  }
  
  // Phase 3: 4-12 hours - Check every 1 hour
  if (hoursToDeparture > 4) {
    const phase3Start = new Date(departureTime.getTime() - 12 * 60 * 60 * 1000);
    const phase3End = new Date(departureTime.getTime() - 4 * 60 * 60 * 1000);
    const actualStart = phase3Start > now ? phase3Start : now;
    
    if (actualStart < phase3End) {
      phases.push({
        startTime: actualStart,
        endTime: phase3End,
        interval: '1h',
        window: '4-12h to departure',
      });
    }
  }
  
  // Phase 4: 0-4 hours - Check every 15 minutes
  if (hoursToDeparture > 0) {
    const phase4Start = new Date(departureTime.getTime() - 4 * 60 * 60 * 1000);
    const actualStart = phase4Start > now ? phase4Start : now;
    
    if (actualStart < departureTime) {
      phases.push({
        startTime: actualStart,
        endTime: new Date(departureTime),
        interval: '15m',
        window: '0-4h to departure',
      });
    }
  }
  
  return phases;
}

/**
 * Converts interval string to rate expression
 */
function intervalToRateExpression(interval: string): string {
  switch (interval) {
    case '12h':
      return 'rate(12 hours)';
    case '2h':
      return 'rate(2 hours)';
    case '1h':
      return 'rate(1 hour)';
    case '15m':
      return 'rate(15 minutes)';
    default:
      throw new Error(`Unknown interval: ${interval}`);
  }
}

/**
 * Creates a unique schedule name for recurring schedules
 * EventBridge Scheduler names must be <= 64 characters
 */
function generateScheduleName(flightNumber: string, date: string, interval: string, phase: string): string {
  const cleanFlightNumber = flightNumber.replace(/[^a-zA-Z0-9]/g, '');
  const cleanPhase = phase.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '');
  let name = `ft-${cleanFlightNumber}-${date}-${interval}-${cleanPhase}`.toLowerCase();
  
  // Truncate if too long (EventBridge limit is 64 chars)
  if (name.length > 64) {
    const hash = Buffer.from(`${flightNumber}-${date}-${interval}-${phase}`).toString('base64').slice(0, 8);
    name = `ft-${cleanFlightNumber}-${date}-${interval}-${hash}`.toLowerCase();
  }
  
  return name;
}

/**
 * Deletes all existing schedules for a flight
 * Schedule names follow pattern: ft-{flight}-{date}-{interval}-{phase}
 */
async function deleteExistingSchedules(flightNumber: string, date: string): Promise<number> {
  const cleanFlightNumber = flightNumber.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  const prefix = `ft-${cleanFlightNumber}-${date}`;
  
  console.log(`Looking for schedules with prefix: ${prefix}`);
  
  let deletedCount = 0;
  let nextToken: string | undefined;
  
  do {
    // List schedules (no prefix filter in API, so we filter manually)
    const listCommand = new ListSchedulesCommand({
      MaxResults: 100,
      NextToken: nextToken,
    });
    
    const response = await schedulerClient.send(listCommand);
    nextToken = response.NextToken;
    
    if (!response.Schedules) continue;
    
    // Filter and delete schedules matching our flight
    for (const schedule of response.Schedules) {
      if (schedule.Name && schedule.Name.startsWith(prefix)) {
        try {
          await schedulerClient.send(new DeleteScheduleCommand({
            Name: schedule.Name,
          }));
          console.log(`Deleted schedule: ${schedule.Name}`);
          deletedCount++;
        } catch (err) {
          console.error(`Failed to delete schedule ${schedule.Name}:`, err);
        }
      }
    }
  } while (nextToken);
  
  return deletedCount;
}

/**
 * Creates a recurring EventBridge schedule with start and end times
 * Now includes fa_flight_id for precise flight tracking
 */
async function createRecurringSchedule(
  scheduleName: string,
  startTime: Date,
  endTime: Date,
  interval: string,
  flightNumber: string,
  date: string,
  faFlightId: string
): Promise<void> {
  const scheduleExpression = intervalToRateExpression(interval);
  
  // Create the schedule with fa_flight_id in the payload
  const command = new CreateScheduleCommand({
    Name: scheduleName,
    Description: `Flight tracker schedule for ${flightNumber} on ${date} - ${interval} interval`,
    ScheduleExpression: scheduleExpression,
    ScheduleExpressionTimezone: 'UTC',
    StartDate: startTime,
    EndDate: endTime,
    FlexibleTimeWindow: {
      Mode: FlexibleTimeWindowMode.OFF,
    },
    Target: {
      Arn: FLIGHT_TRACKER_FUNCTION_ARN,
      RoleArn: SCHEDULER_ROLE_ARN,
      Input: JSON.stringify({
        flight_number: flightNumber,
        date: date,
        fa_flight_id: faFlightId, // Include for precise flight tracking
      }),
    },
    State: 'ENABLED',
  });
  
  await schedulerClient.send(command);
}

/**
 * Lambda handler
 */
export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    // Parse request body
    let body: FlightRequest;
    
    // Check if this is a direct invocation (event has flight_number directly)
    if ((event as any).flight_number) {
        body = {
            flight_number: (event as any).flight_number,
            date: (event as any).date,
            recalculate: (event as any).recalculate,
            new_departure_time: (event as any).new_departure_time,
            fa_flight_id: (event as any).fa_flight_id,
        };
    } else if (event.body) {
      // API Gateway invocation with body
      body = JSON.parse(event.body);
    } else {
      // API Gateway invocation with query params
      body = {
        flight_number: event.queryStringParameters?.flight_number || '',
        date: event.queryStringParameters?.date || '',
      };
    }

    // Validate input
    if (!body.flight_number || !body.date) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({
          error: 'Missing required parameters: flight_number and date are required',
        }),
      };
    }

    // Validate date format (YYYY-MM-DD)
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(body.date)) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({
          error: 'Invalid date format. Expected YYYY-MM-DD',
        }),
      };
    }

    // If recalculating, delete existing schedules first
    let deletedCount = 0;
    if (body.recalculate) {
      console.log(`Recalculating schedules for ${body.flight_number} on ${body.date}`);
      deletedCount = await deleteExistingSchedules(body.flight_number, body.date);
      console.log(`Deleted ${deletedCount} existing schedules`);
    }

    let departureTime: Date;
    let faFlightId: string;

    // If recalculating with provided departure time and fa_flight_id, use those
    if (body.recalculate && body.new_departure_time && body.fa_flight_id) {
      departureTime = new Date(body.new_departure_time);
      faFlightId = body.fa_flight_id;
      console.log(`Using provided departure time: ${departureTime.toISOString()}, fa_flight_id: ${faFlightId}`);
    } else {
      // Fetch flight information to get departure time and fa_flight_id
      console.log(`Fetching flight info for ${body.flight_number} on ${body.date}`);
      const flightData = await fetchFlightInfo(body.flight_number, body.date);
      
      // Extract departure time and fa_flight_id
      const flightInfo = extractFlightInfo(flightData, body.date);
      if (!flightInfo) {
        return {
          statusCode: 400,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
          body: JSON.stringify({
            error: 'Could not find flight for the specified date',
            flight_data: flightData,
          }),
        };
      }

      departureTime = flightInfo.departureTime;
      faFlightId = flightInfo.faFlightId;
    }

    console.log(`Flight: fa_flight_id=${faFlightId}, departure=${departureTime.toISOString()}`);

    const now = new Date();
    const timeToDeparture = departureTime.getTime() - now.getTime();
    
    // Check if flight has already departed
    if (timeToDeparture < 0) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({
          error: 'Flight has already departed',
          departure_time: departureTime.toISOString(),
        }),
      };
    }

    // Calculate schedule phases
    const schedulePhases = calculateSchedulePhases(departureTime, now);
    
    if (schedulePhases.length === 0) {
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({
          message: 'No schedules to create (flight too close to departure)',
          departure_time: departureTime.toISOString(),
          schedules_created: 0,
        }),
      };
    }

    // Create recurring schedules for each phase
    const createdSchedules: string[] = [];
    const errors: string[] = [];
    
    for (const phase of schedulePhases) {
      try {
        const scheduleName = generateScheduleName(
          body.flight_number,
          body.date,
          phase.interval,
          phase.window
        );
        
        await createRecurringSchedule(
          scheduleName,
          phase.startTime,
          phase.endTime,
          phase.interval,
          body.flight_number,
          body.date,
          faFlightId
        );
        
        createdSchedules.push(scheduleName);
        console.log(`Created schedule: ${scheduleName} - ${phase.interval} from ${phase.startTime.toISOString()} to ${phase.endTime.toISOString()}`);
      } catch (error) {
        const errorMsg = `Failed to create schedule for ${phase.window}: ${error instanceof Error ? error.message : 'Unknown error'}`;
        console.error(errorMsg, error);
        errors.push(errorMsg);
      }
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        message: body.recalculate ? 'Schedules recalculated successfully' : 'Schedules created successfully',
        flight_number: body.flight_number,
        date: body.date,
        fa_flight_id: faFlightId,
        departure_time: departureTime.toISOString(),
        schedules_deleted: deletedCount > 0 ? deletedCount : undefined,
        schedules_created: createdSchedules.length,
        schedules: createdSchedules,
        errors: errors.length > 0 ? errors : undefined,
      }),
    };
  } catch (error) {
    console.error('Error creating flight tracking schedules:', error);
    
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};

// Export internal functions for testing
export const _testExports = {
  calculateSchedulePhases,
  extractFlightInfo,
  generateScheduleName,
  intervalToRateExpression,
  getNextDay,
};
