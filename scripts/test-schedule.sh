#!/bin/bash

# Test script for schedule-flight-tracker Lambda
# Usage: ./scripts/test-schedule.sh [flight_number] [date]
# Example: ./scripts/test-schedule.sh KL879 2025-12-21

FLIGHT_NUMBER=${1:-KL879}
DATE=${2:-2025-12-21}

echo "Testing schedule creation for: $FLIGHT_NUMBER on $DATE"
echo ""

# Get API Gateway endpoint from stack outputs
API_URL=$(aws cloudformation describe-stacks \
    --stack-name FlaitStack \
    --query 'Stacks[0].Outputs[?OutputKey==`ApiEndpoint`].OutputValue' \
    --output text 2>/dev/null)

if [ -z "$API_URL" ]; then
    echo "❌ API Gateway URL not found. Is the stack deployed?"
    exit 1
fi

# Remove trailing slash if present
API_URL="${API_URL%/}"

echo "Testing via API Gateway: $API_URL/schedule"
echo ""

RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST "$API_URL/schedule" \
    -H "Content-Type: application/json" \
    -d "{\"flight_number\":\"$FLIGHT_NUMBER\",\"date\":\"$DATE\"}")

HTTP_CODE=$(echo "$RESPONSE" | grep "HTTP_CODE" | cut -d: -f2)
BODY=$(echo "$RESPONSE" | sed '/HTTP_CODE/d')

echo "Response (HTTP $HTTP_CODE):"
echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
echo ""

if [ "$HTTP_CODE" = "200" ]; then
    echo "✅ Success! Schedules created."
    
    # Extract schedule names from response
    SCHEDULE_COUNT=$(echo "$BODY" | jq -r '.schedules_created // 0' 2>/dev/null)
    if [ "$SCHEDULE_COUNT" -gt 0 ]; then
        echo ""
        echo "Created $SCHEDULE_COUNT schedule(s). Listing schedules..."
        echo ""
        
        # List all schedules for this flight
        SCHEDULE_NAMES=$(echo "$BODY" | jq -r '.schedules[]?' 2>/dev/null)
        if [ -n "$SCHEDULE_NAMES" ]; then
            echo "$SCHEDULE_NAMES" | while read -r schedule_name; do
                if [ -n "$schedule_name" ]; then
                    echo "Schedule: $schedule_name"
                    aws scheduler get-schedule --name "$schedule_name" \
                        --query '{Name:Name,State:State,StartDate:StartDate,EndDate:EndDate,ScheduleExpression:ScheduleExpression}' \
                        --output json 2>/dev/null | jq '.' || echo "  (Could not retrieve schedule details)"
                    echo ""
                fi
            done
        fi
    fi
else
    echo "❌ Error occurred. Check the response above."
    if echo "$BODY" | grep -q "FlightAware API key not configured"; then
        echo ""
        echo "⚠️  FLIGHTAWARE_API_KEY is not configured!"
        echo "Set it and redeploy:"
        echo "  export FLIGHTAWARE_API_KEY=your_api_key"
        echo "  npx cdk deploy"
        echo ""
        echo "Or update Lambda directly:"
        echo "  aws lambda update-function-configuration \\"
        echo "    --function-name schedule-flight-tracker \\"
        echo "    --environment \"Variables={FLIGHTAWARE_API_KEY=your_api_key}\""
        echo ""
        echo "  aws lambda update-function-configuration \\"
        echo "    --function-name flight-tracker \\"
        echo "    --environment \"Variables={FLIGHTAWARE_API_KEY=your_api_key}\""
    fi
    exit 1
fi
