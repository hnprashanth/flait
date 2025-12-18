import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as path from 'path';

export class FlaitStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create DynamoDB table for flight data
    const flightTable = new dynamodb.Table(this, 'FlightDataTable', {
      tableName: 'flight-data',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Change to RETAIN for production
    });

    // Add Global Secondary Index for querying by flight_number and date
    flightTable.addGlobalSecondaryIndex({
      indexName: 'flight-number-date-index',
      partitionKey: { name: 'flight_number', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'date', type: dynamodb.AttributeType.STRING },
    });

    // Create Lambda function
    const flightTrackerFunction = new NodejsFunction(this, 'FlightTrackerFunction', {
      functionName: 'flight-tracker',
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/flight-tracker/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      environment: {
        TABLE_NAME: flightTable.tableName,
        FLIGHTAWARE_API_KEY: process.env.FLIGHTAWARE_API_KEY || '',
      },
      bundling: {
        externalModules: ['@aws-sdk'],
        minify: true,
      },
    });

    // Grant Lambda permissions to write to DynamoDB
    flightTable.grantWriteData(flightTrackerFunction);

    // Create API Gateway REST API
    const api = new apigateway.RestApi(this, 'FlightTrackerApi', {
      restApiName: 'Flight Tracker API',
      description: 'API for tracking flight information',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'X-Amz-Date', 'Authorization', 'X-Api-Key'],
      },
    });

    // Create Lambda integration
    const flightTrackerIntegration = new apigateway.LambdaIntegration(flightTrackerFunction, {
      requestTemplates: { 'application/json': '{ "statusCode": "200" }' },
    });

    // Add POST endpoint
    const flightsResource = api.root.addResource('flights');
    flightsResource.addMethod('POST', flightTrackerIntegration);

    // Add GET endpoint (for query parameters)
    flightsResource.addMethod('GET', flightTrackerIntegration);

    // Output the API endpoint
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: api.url,
      description: 'API Gateway endpoint URL',
    });

    // Output the table name
    new cdk.CfnOutput(this, 'TableName', {
      value: flightTable.tableName,
      description: 'DynamoDB table name',
    });
  }
}
