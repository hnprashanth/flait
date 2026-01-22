import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
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

    // Create Event Bus for flight events
    const flightBus = new events.EventBus(this, 'FlightTrackerBus', {
      eventBusName: 'flight-tracker-bus',
    });

    // Create Lambda function for flight tracking
    // Uses a fixed function name for schedule-tracker to avoid circular dependency
    const flightTrackerFunction = new NodejsFunction(this, 'FlightTrackerFunction', {
      functionName: 'flight-tracker',
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/flight-tracker/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      environment: {
        TABLE_NAME: flightTable.tableName,
        FLIGHTAWARE_API_KEY: process.env.FLIGHTAWARE_API_KEY || '',
        EVENT_BUS_NAME: flightBus.eventBusName,
        SCHEDULE_TRACKER_FUNCTION_NAME: 'schedule-flight-tracker', // Fixed name to avoid circular dep
      },
      bundling: {
        externalModules: ['@aws-sdk'],
        minify: true,
      },
    });

    // Grant Lambda permissions to read and write to DynamoDB
    flightTable.grantReadWriteData(flightTrackerFunction);

    // Grant Lambda permissions to put events to EventBridge
    flightBus.grantPutEventsTo(flightTrackerFunction);

    // Create IAM role for EventBridge Scheduler to invoke flight-tracker Lambda
    const schedulerRole = new iam.Role(this, 'SchedulerInvokeRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Role for EventBridge Scheduler to invoke flight-tracker Lambda',
    });
    flightTrackerFunction.grantInvoke(schedulerRole);

    // Create Lambda function for scheduling flight tracking
    const scheduleFlightTrackerFunction = new NodejsFunction(this, 'ScheduleFlightTrackerFunction', {
      functionName: 'schedule-flight-tracker',
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/schedule-flight-tracker/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(60),
      environment: {
        FLIGHTAWARE_API_KEY: process.env.FLIGHTAWARE_API_KEY || '',
        FLIGHT_TRACKER_FUNCTION_ARN: flightTrackerFunction.functionArn,
        SCHEDULER_ROLE_ARN: schedulerRole.roleArn,
      },
      bundling: {
        externalModules: ['@aws-sdk'],
        minify: true,
      },
    });

    // Grant schedule-flight-tracker Lambda permissions to manage EventBridge schedules
    scheduleFlightTrackerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'scheduler:CreateSchedule',
          'scheduler:DeleteSchedule',
          'scheduler:GetSchedule',
          'scheduler:UpdateSchedule',
          'scheduler:ListSchedules',
        ],
        resources: ['*'], // EventBridge Scheduler doesn't support resource-level permissions yet
      })
    );

    // Grant flight-tracker permission to invoke schedule-tracker for recalculation
    // Using direct policy to avoid circular dependency
    flightTrackerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['lambda:InvokeFunction'],
        resources: [`arn:aws:lambda:${this.region}:${this.account}:function:schedule-flight-tracker`],
      })
    );

    // Grant permission to pass the scheduler role to EventBridge Scheduler
    scheduleFlightTrackerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [schedulerRole.roleArn],
      })
    );

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

    // Create Lambda integration for schedule-flight-tracker
    const scheduleFlightTrackerIntegration = new apigateway.LambdaIntegration(scheduleFlightTrackerFunction, {
      requestTemplates: { 'application/json': '{ "statusCode": "200" }' },
    });

    // Add POST endpoint for scheduling flight tracking
    const scheduleResource = api.root.addResource('schedule');
    scheduleResource.addMethod('POST', scheduleFlightTrackerIntegration);
    scheduleResource.addMethod('GET', scheduleFlightTrackerIntegration);

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

    // --- User & Subscription Features ---

    // 1. Create App Data Table (Users & Subscriptions)
    const appTable = new dynamodb.Table(this, 'AppDataTable', {
      tableName: 'flait-app-data',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Change to RETAIN for production
    });

    // GSI for finding subscribers by flight
    appTable.addGlobalSecondaryIndex({
      indexName: 'flight-subscribers-index',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
    });

    // 2. User Service Lambda
    const userService = new NodejsFunction(this, 'UserService', {
      functionName: 'user-service',
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/user-service/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(10),
      environment: {
        APP_TABLE_NAME: appTable.tableName,
      },
      bundling: {
        minify: true,
      },
    });

    appTable.grantReadWriteData(userService);

    // 3. Subscription Service Lambda
    const subscriptionService = new NodejsFunction(this, 'SubscriptionService', {
      functionName: 'subscription-service',
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/subscription-service/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(29),
      environment: {
        APP_TABLE_NAME: appTable.tableName,
        FLIGHT_TABLE_NAME: flightTable.tableName,
        FLIGHT_TRACKER_FUNCTION_NAME: flightTrackerFunction.functionName,
        SCHEDULE_TRACKER_FUNCTION_NAME: scheduleFlightTrackerFunction.functionName,
      },
      bundling: {
        minify: true,
      },
    });

    // Permissions for Subscription Service
    appTable.grantReadWriteData(subscriptionService);
    flightTable.grantReadData(subscriptionService);
    flightTrackerFunction.grantInvoke(subscriptionService);
    scheduleFlightTrackerFunction.grantInvoke(subscriptionService);

    // 4. API Gateway Routes for Users
    const usersResource = api.root.addResource('users');
    const userIntegration = new apigateway.LambdaIntegration(userService);
    usersResource.addMethod('POST', userIntegration);
    usersResource.addMethod('GET', userIntegration);

    // 5. API Gateway Routes for Subscriptions
    const subscriptionsResource = api.root.addResource('subscriptions');
    const subscriptionIntegration = new apigateway.LambdaIntegration(subscriptionService);
    subscriptionsResource.addMethod('POST', subscriptionIntegration);
    subscriptionsResource.addMethod('GET', subscriptionIntegration);

    // --- Notification System ---

    // 1. Dead Letter Queue for failed notifications
    const dlq = new sqs.Queue(this, 'NotificationDLQ', {
      queueName: 'notification-dlq',
      retentionPeriod: cdk.Duration.days(14),
    });

    // 2. Notification Dispatcher Lambda
    const notificationDispatcher = new NodejsFunction(this, 'NotificationDispatcher', {
      functionName: 'notification-dispatcher',
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/notification-dispatcher/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(60),
      deadLetterQueue: dlq,
      environment: {
        APP_TABLE_NAME: appTable.tableName,
        FLIGHT_TABLE_NAME: flightTable.tableName,
        TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || '',
        TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || '',
        TWILIO_FROM_NUMBER: process.env.TWILIO_FROM_NUMBER || '',
      },
      bundling: {
        minify: true,
      },
    });

    // Grant permissions - read from both tables for connection analysis
    appTable.grantReadData(notificationDispatcher);
    flightTable.grantReadData(notificationDispatcher);

    // 3. EventBridge Rule - handles all flight update events (milestones, changes, combined)
    new events.Rule(this, 'FlightUpdateRule', {
      eventBus: flightBus,
      eventPattern: {
        source: ['com.flait.flight-tracker'],
        detailType: ['FlightUpdate'],
      },
      targets: [new targets.LambdaFunction(notificationDispatcher)],
    });

    // --- WhatsApp Query Handler (Gemini-powered assistant) ---

    const whatsappQueryHandler = new NodejsFunction(this, 'WhatsAppQueryHandler', {
      functionName: 'whatsapp-query-handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/whatsapp-query-handler/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30), // Gemini calls may take time
      environment: {
        APP_TABLE_NAME: appTable.tableName,
        FLIGHT_TABLE_NAME: flightTable.tableName,
        GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
        TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || '',
        TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || '',
        TWILIO_FROM_NUMBER: process.env.TWILIO_FROM_NUMBER || '',
        FLIGHTAWARE_API_KEY: process.env.FLIGHTAWARE_API_KEY || '',
        FLIGHT_TRACKER_FUNCTION_NAME: 'flight-tracker',
        SCHEDULE_TRACKER_FUNCTION_NAME: 'schedule-flight-tracker',
      },
      bundling: {
        minify: true,
      },
    });

    // Grant permissions - read from both tables, write to app table for rate limiting
    appTable.grantReadWriteData(whatsappQueryHandler);
    flightTable.grantReadData(whatsappQueryHandler);

    // Grant permission to invoke flight-tracker and schedule-tracker for provisioning subscriptions
    whatsappQueryHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['lambda:InvokeFunction'],
        resources: [
          `arn:aws:lambda:${this.region}:${this.account}:function:flight-tracker`,
          `arn:aws:lambda:${this.region}:${this.account}:function:schedule-flight-tracker`,
        ],
      })
    );

    // API Gateway route for Twilio webhook
    const whatsappResource = api.root.addResource('whatsapp');
    const whatsappIntegration = new apigateway.LambdaIntegration(whatsappQueryHandler);
    whatsappResource.addMethod('POST', whatsappIntegration);

    // Output the WhatsApp webhook URL
    new cdk.CfnOutput(this, 'WhatsAppWebhookUrl', {
      value: `${api.url}whatsapp`,
      description: 'WhatsApp webhook URL for Twilio',
    });
  }
}
