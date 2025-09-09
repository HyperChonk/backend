#!/usr/bin/env ts-node

import { Command } from 'commander';
import {
    CloudWatchLogsClient,
    DescribeLogGroupsCommand,
    DescribeLogStreamsCommand,
    FilterLogEventsCommand,
    OutputLogEvent,
} from '@aws-sdk/client-cloudwatch-logs';
import { normalizeEnvironmentName } from '../config/environments/shared';
import chalk from 'chalk';

interface LogTailerOptions {
    environment: string;
    region: string;
    services: string[];
    follow: boolean;
    lines: number;
    filter?: string;
    startTime?: Date;
    logGroupPattern?: string;
    quiet: boolean;
    json: boolean;
    colors: boolean;
}

interface LogGroup {
    name: string;
    service: string;
    displayName: string;
    colorFunc: (text: string) => string;
}

class CloudWatchLogTailer {
    private client: CloudWatchLogsClient;
    private options: LogTailerOptions;
    private isRunning = false;
    private colors = [
        chalk.blue,
        chalk.green,
        chalk.yellow,
        chalk.magenta,
        chalk.cyan,
        chalk.red,
        chalk.gray,
        chalk.blueBright,
        chalk.greenBright,
        chalk.yellowBright,
    ];

    constructor(options: LogTailerOptions) {
        this.options = options;
        this.client = new CloudWatchLogsClient({ region: options.region });
    }

    /**
     * Discover all relevant log groups for the environment
     */
    async discoverLogGroups(): Promise<LogGroup[]> {
        const normalizedEnv = normalizeEnvironmentName(this.options.environment);
        const logGroups: LogGroup[] = [];

        if (!this.options.quiet) {
            console.log(chalk.blue(`🔍 Discovering log groups for environment: ${normalizedEnv}`));
        }

        try {
            // Define the log groups we expect for this environment
            const expectedLogGroups = [
                { pattern: `/v3-backend/${normalizedEnv}/api`, service: 'api', displayName: 'API Service' },
                { pattern: `/v3-backend/${normalizedEnv}/worker`, service: 'worker', displayName: 'Worker Service' },
                {
                    pattern: `/v3-backend/${normalizedEnv}/scheduler`,
                    service: 'scheduler',
                    displayName: 'Scheduler Service',
                },
                {
                    pattern: `/v3-backend/${normalizedEnv}/migration`,
                    service: 'migration',
                    displayName: 'Migration Service',
                },
                {
                    pattern: `/v3-backend/${normalizedEnv}/background-processor`,
                    service: 'background',
                    displayName: 'Background Processor',
                },
                { pattern: `/v3-backend/${normalizedEnv}/waf`, service: 'waf', displayName: 'WAF Logs' },
                { pattern: `/aws/vpc/flowlogs/${normalizedEnv}`, service: 'vpc', displayName: 'VPC Flow Logs' },
                {
                    pattern: `/aws/lambda/v3-backend-${normalizedEnv}-*`,
                    service: 'lambda',
                    displayName: 'Lambda Functions',
                },
                {
                    pattern: `/aws/apigateway/v3-backend-${normalizedEnv}*`,
                    service: 'apigateway',
                    displayName: 'API Gateway',
                },
                { pattern: `/v3-backend/${normalizedEnv}/*`, service: 'other', displayName: 'Other Services' },
            ];

            // Use custom pattern if provided
            if (this.options.logGroupPattern) {
                expectedLogGroups.push({
                    pattern: this.options.logGroupPattern,
                    service: 'custom',
                    displayName: 'Custom Pattern',
                });
            }

            let nextToken: string | undefined;
            const allLogGroups: string[] = [];

            do {
                const response = await this.client.send(
                    new DescribeLogGroupsCommand({
                        nextToken,
                        limit: 50,
                    }),
                );

                if (response.logGroups) {
                    allLogGroups.push(...response.logGroups.map((lg) => lg.logGroupName!).filter(Boolean));
                }

                nextToken = response.nextToken;
            } while (nextToken);

            const matchedGroups = new Set<string>();

            // Match discovered log groups with our expected patterns
            let colorIndex = 0;
            for (const expected of expectedLogGroups) {
                const matchingGroups = allLogGroups.filter((name) => {
                    if (matchedGroups.has(name)) {
                        return false;
                    }

                    if (expected.pattern.includes('*')) {
                        const regex = new RegExp('^' + expected.pattern.replace(/\*/g, '.*') + '$');
                        return regex.test(name);
                    }
                    return name === expected.pattern || name.startsWith(expected.pattern);
                });

                for (const groupName of matchingGroups) {
                    // Filter by service if specified
                    if (this.options.services.length > 0 && !this.options.services.includes(expected.service)) {
                        continue;
                    }

                    matchedGroups.add(groupName);

                    logGroups.push({
                        name: groupName,
                        service: expected.service,
                        displayName: expected.displayName,
                        colorFunc: this.options.colors ? this.colors[colorIndex % this.colors.length] : chalk.white,
                    });
                    colorIndex++;
                }
            }

            if (!this.options.quiet) {
                console.log(chalk.green(`📋 Found ${logGroups.length} log groups:`));
                logGroups.forEach((lg) => {
                    console.log(`  ${lg.colorFunc('●')} ${lg.displayName} (${lg.name})`);
                });
                console.log('');
            }

            return logGroups;
        } catch (error) {
            console.error(chalk.red('❌ Failed to discover log groups:'), error);
            throw error;
        }
    }

    /**
     * Get recent log events from a log group
     */
    async getRecentLogs(logGroup: LogGroup, startTime?: number): Promise<OutputLogEvent[]> {
        try {
            const response = await this.client.send(
                new FilterLogEventsCommand({
                    logGroupName: logGroup.name,
                    startTime: startTime || Date.now() - this.options.lines * 60 * 1000, // Default to last N minutes
                    limit: this.options.lines,
                    filterPattern: this.options.filter,
                }),
            );

            return response.events || [];
        } catch (error) {
            if (!this.options.quiet) {
                console.error(chalk.red(`❌ Failed to get logs from ${logGroup.name}:`), error);
            }
            return [];
        }
    }

    /**
     * Format and display a log event
     */
    formatLogEvent(event: OutputLogEvent, logGroup: LogGroup): void {
        if (!event.timestamp || !event.message) return;

        const timestamp = new Date(event.timestamp).toLocaleString();
        const service = logGroup.service.padEnd(10);

        if (this.options.json) {
            console.log(
                JSON.stringify({
                    timestamp,
                    service: logGroup.service,
                    logGroup: logGroup.name,
                    message: event.message.trim(),
                }),
            );
        } else {
            const timeStr = this.options.colors ? chalk.gray(timestamp) : timestamp;
            const serviceStr = this.options.colors ? logGroup.colorFunc(`[${service}]`) : `[${service}]`;
            const message = event.message.trim();

            console.log(`${timeStr} ${serviceStr} ${message}`);
        }
    }

    /**
     * Start tailing logs from all discovered log groups
     */
    async startTailing(): Promise<void> {
        const logGroups = await this.discoverLogGroups();

        if (logGroups.length === 0) {
            console.log(chalk.yellow('⚠️ No log groups found for this environment'));
            return;
        }

        this.isRunning = true;
        let lastEventTime = this.options.startTime?.getTime() || Date.now() - this.options.lines * 60 * 1000;

        if (!this.options.quiet) {
            console.log(chalk.blue('🚀 Starting log tail...'));
            console.log(chalk.gray('Press Ctrl+C to stop\n'));
        }

        // Get initial logs if not following
        if (!this.options.follow) {
            const allEvents: Array<{ event: OutputLogEvent; logGroup: LogGroup }> = [];

            for (const logGroup of logGroups) {
                const events = await this.getRecentLogs(logGroup, lastEventTime);
                events.forEach((event) => allEvents.push({ event, logGroup }));
            }

            // Sort by timestamp
            allEvents.sort((a, b) => (a.event.timestamp || 0) - (b.event.timestamp || 0));

            // Display events
            allEvents.forEach(({ event, logGroup }) => {
                this.formatLogEvent(event, logGroup);
            });

            return;
        }

        // Follow mode - continuous polling
        while (this.isRunning) {
            try {
                const allEvents: Array<{ event: OutputLogEvent; logGroup: LogGroup }> = [];
                const newLastEventTime = Date.now();

                // Get new events from all log groups
                for (const logGroup of logGroups) {
                    const response = await this.client.send(
                        new FilterLogEventsCommand({
                            logGroupName: logGroup.name,
                            startTime: lastEventTime + 1, // Start after last event
                            endTime: newLastEventTime,
                            filterPattern: this.options.filter,
                        }),
                    );

                    if (response.events) {
                        response.events.forEach((event) => allEvents.push({ event, logGroup }));
                    }
                }

                // Sort by timestamp and display
                allEvents.sort((a, b) => (a.event.timestamp || 0) - (b.event.timestamp || 0));
                allEvents.forEach(({ event, logGroup }) => {
                    this.formatLogEvent(event, logGroup);
                });

                lastEventTime = newLastEventTime;

                // Wait before next poll
                await new Promise((resolve) => setTimeout(resolve, 2000));
            } catch (error) {
                if (!this.options.quiet) {
                    console.error(chalk.red('❌ Error while tailing logs:'), error);
                }
                await new Promise((resolve) => setTimeout(resolve, 5000));
            }
        }
    }

    /**
     * Stop the log tailer
     */
    stop(): void {
        this.isRunning = false;
    }
}

// CLI setup
const program = new Command();

program
    .name('live-tail-logs')
    .description('Live tail AWS CloudWatch logs for all services in an environment')
    .option('-e, --env <environment>', 'Environment to tail logs for', 'development')
    .option('-r, --region <region>', 'AWS region', 'us-east-1')
    .option(
        '-s, --services <services>',
        'Comma-separated list of services to include (api,background,waf,vpc,lambda)',
        '',
    )
    .option('-f, --follow', 'Follow log output (live tail)', false)
    .option('-n, --lines <number>', 'Number of lines/minutes of history to show initially', '10')
    .option('--filter <pattern>', 'CloudWatch Logs filter pattern')
    .option('--start-time <time>', 'Start time (ISO string or relative like "2h ago")')
    .option('--log-group-pattern <pattern>', 'Custom log group pattern to include')
    .option('-q, --quiet', 'Suppress discovery and status messages')
    .option('--json', 'Output logs in JSON format')
    .option('--no-colors', 'Disable colored output');

program.parse();

const options = program.opts();

// Parse services
const services = options.services ? options.services.split(',').map((s: string) => s.trim()) : [];

// Parse start time
let startTime: Date | undefined;
if (options.startTime) {
    if (options.startTime.includes('ago')) {
        const match = options.startTime.match(/(\d+)([smhd])\s*ago/);
        if (match) {
            const value = parseInt(match[1]);
            const unit = match[2];
            const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
            startTime = new Date(Date.now() - value * multipliers[unit as keyof typeof multipliers]);
        }
    } else {
        startTime = new Date(options.startTime);
    }
}

const tailerOptions: LogTailerOptions = {
    environment: options.env,
    region: options.region,
    services,
    follow: options.follow,
    lines: parseInt(options.lines),
    filter: options.filter,
    startTime,
    logGroupPattern: options.logGroupPattern,
    quiet: options.quiet,
    json: options.json,
    colors: options.colors !== false,
};

async function main() {
    const tailer = new CloudWatchLogTailer(tailerOptions);

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        if (!tailerOptions.quiet) {
            console.log(chalk.yellow('\n👋 Stopping log tailer...'));
        }
        tailer.stop();
        process.exit(0);
    });

    try {
        await tailer.startTailing();
    } catch (error) {
        console.error(chalk.red('❌ Failed to start log tailer:'), error);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

export { CloudWatchLogTailer };
