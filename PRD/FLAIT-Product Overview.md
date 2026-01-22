# FLAIT - Product Overview

We will check flight status at different intervals and the intervals increase as we get closer to the departure or landing. Here is how we are going to do it:

- Check every 12 hours until 24 hours to departure

- Check every 2 hours until 12 hours to departure

- Check every hour until 4 hours to departure

- Check every 15 mins 4 hours to departure

~~Scheduling is unnecessary if FA has web-hooks.~~ *Webhook only comes in standard+ accounts which costs 100 USD a month! so we cant use this approach*

Save data from each checkpoint into the database to do further analysis and decide if user needs to be notified. If there is change in departure, example delay, we need to update all the upcoming checking schedules.

1. Take flight number and date and fetch initial data from FA

2. Based on departure time create schedules for different times as mentioned above

3. We will need to do time conversion if necessary, depends on what FA gives us

4. Store the data into DDB

## DDB Schema:

We have combination of flight_number and date as a unique property that we track, so we could use concat of this as PK. Since we do multiple checks as mentioned in above schedule, our sort key can be created_at, this way we can maintain PK+SK uniqueness. It will also support querying for a particular flight if we just pass flight_number and date


