#!/usr/bin/env ts-node

import {
    CloudWatchLogsClient,
    FilterLogEventsCommand,
    OutputLogEvent,
    FilterLogEventsCommandOutput,
} from '@aws-sdk/client-cloudwatch-logs';
import { normalizeEnvironmentName } from '../config/environments/shared';

// Helper to parse command line arguments
function getArg(argName: string, defaultValue?: string): string | undefined {
    const argIndex = process.argv.indexOf(argName);
    if (argIndex > -1 && process.argv.length > argIndex + 1) {
        return process.argv[argIndex + 1];
    }
    return defaultValue;
}

const client = new CloudWatchLogsClient({ region: process.env.AWS_REGION || 'us-east-1' });

async function getLogs(environment: string, minutesAgo: number, filterPattern?: string, watch: boolean = false) {
    const logGroupNames = [
        `/v3-backend/${environment}/api`,
        `/v3-backend/${environment}/worker`,
        `/v3-backend/${environment}/scheduler`,
        `/v3-backend/${environment}/migration`,
    ];

    console.log(`🔍 Fetching logs for environment: ${environment}`);
    console.log(`📋 Log Groups: ${logGroupNames.join(', ')}`);
    console.log(`⏰ Time window: Last ${minutesAgo} minutes`);
    if (filterPattern) {
        console.log(`🔎 Filter pattern: "${filterPattern}"`);
    }
    if (watch) {
        console.log('👀 Watching for new logs (Ctrl+C to stop)...');
    }
    console.log('---');

    let startTime = Date.now() - minutesAgo * 60 * 1000;

    const fetchAndPrint = async () => {
        let nextToken: string | undefined;
        const allEvents: (OutputLogEvent & { logGroupName?: string; logStreamName?: string })[] = [];

        try {
            // FilterLogEvents can't query multiple log groups at once. We must iterate.
            for (const logGroupName of logGroupNames) {
                nextToken = undefined;
                do {
                    const command = new FilterLogEventsCommand({
                        logGroupName,
                        startTime,
                        filterPattern,
                        interleaved: true,
                        nextToken,
                    });

                    const response: FilterLogEventsCommandOutput = await client.send(command);
                    if (response.events) {
                        // Manually add logGroupName to each event for context
                        for (const event of response.events) {
                            allEvents.push({ ...event, logGroupName });
                        }
                    }
                    nextToken = response.nextToken;
                } while (nextToken);
            }

            // Sort all collected events by timestamp
            allEvents.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

            for (const event of allEvents) {
                const logStream = event.logStreamName || 'unknown-stream';
                const logGroup = event.logGroupName || 'unknown-group';
                const timestamp = event.timestamp ? new Date(event.timestamp).toLocaleString() : 'no-timestamp';
                console.log(`[${timestamp}] [${logGroup}] [${logStream}] ${event.message}`);
            }

            // For watching, update the start time to the last event's timestamp to avoid re-fetching old logs
            if (watch && allEvents.length > 0) {
                startTime = (allEvents[allEvents.length - 1].timestamp || startTime) + 1;
            }
        } catch (error) {
            console.error(`❌ Error fetching logs:`, error);
        }
    };

    await fetchAndPrint();

    if (watch) {
        setInterval(fetchAndPrint, 10000); // Poll every 10 seconds
    }
}

async function main() {
    const rawEnvironment = getArg('--env');
    if (!rawEnvironment) {
        console.error('❌ Missing required argument: --env <environment>');
        console.error('   Example: bun scripts/get-logs.ts --env development');
        process.exit(1);
    }
    const environment = normalizeEnvironmentName(rawEnvironment);

    const minutesAgo = parseInt(getArg('--minutes-ago', '30')!, 10);
    const filterPattern = getArg('--filter');
    const watch = process.argv.includes('--watch');

    if (isNaN(minutesAgo)) {
        console.error('❌ Invalid value for --minutes-ago. Must be a number.');
        process.exit(1);
    }

    await getLogs(environment, minutesAgo, filterPattern, watch);
}

main().catch((error) => {
    console.error('💥 An unexpected error occurred:', error);
    process.exit(1);
});
