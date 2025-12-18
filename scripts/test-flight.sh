#!/bin/bash

# Test script for flight tracker Lambda
# Usage: ./scripts/test-flight.sh [flight_number] [date]
# Example: ./scripts/test-flight.sh KL879 2025-12-18

FLIGHT_NUMBER=${1:-KL879}
DATE=${2:-$(date +%Y-%m-%d)}

echo "Testing flight tracker for: $FLIGHT_NUMBER on $DATE"
echo ""

# Check if Lambda function exists
if ! aws lambda get-function --function-name flight-tracker &>/dev/null; then
    echo "❌ Lambda function 'flight-tracker' not found. Deploying stack first..."
    echo ""
    
    if [ -z "$FLIGHTAWARE_API_KEY" ]; then
        echo "ERROR: FLIGHTAWARE_API_KEY environment variable is not set!"
        echo "Please set it before deploying:"
        echo "  export FLIGHTAWARE_API_KEY=your_api_key"
        exit 1
    fi
    
    echo "Building and deploying stack..."
    npm run build
    npx cdk deploy --require-approval never
    
    echo ""
    echo "✅ Stack deployed. Waiting 10 seconds for Lambda to be ready..."
    sleep 10
fi

# Get API Gateway endpoint from stack outputs
API_URL=$(aws cloudformation describe-stacks \
    --stack-name FlaitStack \
    --query 'Stacks[0].Outputs[?OutputKey==`ApiEndpoint`].OutputValue' \
    --output text 2>/dev/null)

if [ -n "$API_URL" ]; then
    echo "Testing via API Gateway: $API_URL/flights"
    echo ""
    
    RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST "$API_URL/flights" \
        -H "Content-Type: application/json" \
        -d "{\"flight_number\":\"$FLIGHT_NUMBER\",\"date\":\"$DATE\"}")
    
    HTTP_CODE=$(echo "$RESPONSE" | grep "HTTP_CODE" | cut -d: -f2)
    BODY=$(echo "$RESPONSE" | sed '/HTTP_CODE/d')
    
    echo "Response (HTTP $HTTP_CODE):"
    echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
    echo ""
    
    if [ "$HTTP_CODE" = "200" ]; then
        echo "✅ Success! Flight data stored in DynamoDB."
        
        # Query DynamoDB to verify
        echo ""
        echo "Verifying data in DynamoDB..."
        TABLE_NAME=$(aws cloudformation describe-stacks \
            --stack-name FlaitStack \
            --query 'Stacks[0].Outputs[?OutputKey==`TableName`].OutputValue' \
            --output text 2>/dev/null)
        
        if [ -n "$TABLE_NAME" ]; then
            PK="$FLIGHT_NUMBER#$DATE"
            echo "Querying for PK: $PK"
            aws dynamodb query \
                --table-name "$TABLE_NAME" \
                --key-condition-expression "PK = :pk" \
                --expression-attribute-values "{\":pk\":{\"S\":\"$PK\"}}" \
                --limit 1 \
                --scan-index-forward false \
                --output json | jq '.Items[0]' 2>/dev/null || echo "No items found"
        fi
    else
        echo "❌ Error occurred. Check the response above."
        exit 1
    fi
else
    echo "API Gateway URL not found. Testing Lambda directly..."
    echo ""
    
    # Create test event
    EVENT=$(cat <<EOF
{
  "body": "{\"flight_number\":\"$FLIGHT_NUMBER\",\"date\":\"$DATE\"}",
  "httpMethod": "POST",
  "path": "/flights"
}
EOF
)
    
    echo "Invoking Lambda function..."
    aws lambda invoke \
        --function-name flight-tracker \
        --payload "$(echo "$EVENT" | jq -c .)" \
        --cli-binary-format raw-in-base64-out \
        /tmp/lambda-response.json
    
    echo ""
    echo "Response:"
    cat /tmp/lambda-response.json | jq '.' 2>/dev/null || cat /tmp/lambda-response.json
    echo ""
    
    if jq -e '.statusCode == 200' /tmp/lambda-response.json &>/dev/null; then
        echo "✅ Success! Flight data stored in DynamoDB."
    else
        echo "❌ Error occurred. Check the response above."
        exit 1
    fi
fi

