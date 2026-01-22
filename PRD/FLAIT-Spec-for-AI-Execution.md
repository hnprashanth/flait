# FLAIT Spec for AI Execution

We need to create user table which will consist of user phone number, uuid and name.

We need to create a subscription table so that we can know which user has subscribed to which flight. A single flight have multiple users subscribing to it. So this table can have user_id, phone number and combo of flight number and date of flight.

Whenever we need to trigger a notification for a flight, we can check the subscribers of that flight and send the notification.

We will be using Twilio to send these messages to users over WhatsApp, since whatsapp works with in-flight wifi as well.There is a possibility user is in transit before the next flight.

If a user is subscribed to multiple flights, we need to have a way to determine if they are connecting, if they are then we will new set of notifications to trigger with current and next flight in context, change in timing in either flight impacts overall trip. SO we cant see a flight in isolation, but have the view of whole trip.


