import { SchedulerClient, CreateScheduleCommand, FlexibleTimeWindowMode } from '@aws-sdk/client-scheduler';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const schedulerClient = new SchedulerClient({});
const FLIGHTAWARE_API_KEY = process.env.FLIGHTAWARE_API_KEY!;
const FLIGHT_TRACKER_FUNCTION_ARN = process.env.FLIGHT_TRACKER_FUNCTION_ARN!;
const SCHEDULER_ROLE_ARN = process.env.SCHEDULER_ROLE_ARN!;

interface FlightRequest {
  flight_number: string;
  date: string; // Format: YYYY-MM-DD
}

interface FlightAwareResponse {
  [key: string]: any;
}


/**
 * Fetches flight information from FlightAware AeroAPI v4 to get actual departure time
 */
async function fetchFlightInfo(flightNumber: string, date: string): Promise<FlightAwareResponse> {
  if (!FLIGHTAWARE_API_KEY) {
    throw new Error('FlightAware API key not configured');
  }

  const url = `https://aeroapi.flightaware.com/aeroapi/flights/${encodeURIComponent(flightNumber)}`;
  
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
 * Extracts departure time from FlightAware response
 * Tries actual_out first, then scheduled_out, then estimated_out
 */
function extractDepartureTime(flightData: FlightAwareResponse): Date | null {
  // Try to get actual departure time first
  if (flightData.actual_out) {
    return new Date(flightData.actual_out);
  }
  
  // Fall back to scheduled departure
  if (flightData.scheduled_out) {
    return new Date(flightData.scheduled_out);
  }
  
  // Try estimated departure
  if (flightData.estimated_out) {
    return new Date(flightData.estimated_out);
  }
  
  // If no departure time found, try looking in flights array (AeroAPI v4 may return array)
  if (Array.isArray(flightData.flights) && flightData.flights.length > 0) {
    const firstFlight = flightData.flights[0];
    if (firstFlight.actual_out) return new Date(firstFlight.actual_out);
    if (firstFlight.scheduled_out) return new Date(firstFlight.scheduled_out);
    if (firstFlight.estimated_out) return new Date(firstFlight.estimated_out);
  }
  
  return null;
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
 * Creates a recurring EventBridge schedule with start and end times
 */
async function createRecurringSchedule(
  scheduleName: string,
  startTime: Date,
  endTime: Date,
  interval: string,
  flightNumber: string,
  date: string
): Promise<void> {
  const scheduleExpression = intervalToRateExpression(interval);
  
  // Create the schedule
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
            date: (event as any).date
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

    // Fetch initial flight information to get departure time
    console.log(`Fetching flight info for ${body.flight_number} on ${body.date}`);
    const flightData = await fetchFlightInfo(body.flight_number, body.date);
    
    // Extract departure time
    const departureTime = extractDepartureTime(flightData);
    if (!departureTime) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({
          error: 'Could not determine departure time from flight data',
          flight_data: flightData,
        }),
      };
    }

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
          body.date
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
        message: 'Schedules created successfully',
        flight_number: body.flight_number,
        date: body.date,
        departure_time: departureTime.toISOString(),
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
