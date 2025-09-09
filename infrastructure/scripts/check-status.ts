#!/usr/bin/env ts-node

import { Command } from 'commander';
import { AWSStatusChecker } from './status-checker/aws-status-checker';
import { StatusFormatters } from './status-checker/utils/formatters';

// CLI setup
const program = new Command();

program
    .name('check-status')
    .description('Check AWS infrastructure status')
    .option('-e, --env <environment>', 'Environment to check', 'development')
    .option('-r, --region <region>', 'AWS region', 'us-east-1')
    .option('-j, --json', 'Output JSON format')
    .option('-y, --yaml', 'Output YAML format')
    .option('-s, --summary', 'Output summary format')
    .option('-q, --quiet', 'Suppress progress messages');

program.parse();

const options = program.opts();

async function main() {
    try {
        const checker = new AWSStatusChecker(options.region, options.env);
        const status = await checker.checkAll();

        if (options.json) {
            console.log(JSON.stringify(status, null, 2));
        } else if (options.yaml) {
            console.log(StatusFormatters.formatYAML(status));
        } else if (options.summary) {
            console.log(StatusFormatters.formatSummary(status));
        } else {
            if (!options.quiet) {
                console.log('📊 Status Report:');
                console.log(StatusFormatters.formatYAML(status));
                console.log(StatusFormatters.formatSummary(status));
            } else {
                console.log(StatusFormatters.formatYAML(status));
            }
        }

        // Exit with error code if system not functional or endpoints not working
        const exitCode =
            !status.overallHealth.systemFunctional || !status.endpointHealth.allEndpointsWorking
                ? 1
                : status.summary.error > 0
                ? 2
                : 0; // Don't fail on warnings if system is functional and endpoints work
        process.exit(exitCode);
    } catch (error) {
        console.error(
            '❌ Failed to check infrastructure status:',
            error instanceof Error ? error.message : 'Unknown error',
        );
        process.exit(4);
    }
}

if (require.main === module) {
    main();
}

export { AWSStatusChecker } from './status-checker/aws-status-checker';
export * from './status-checker/types';
export { StatusFormatters } from './status-checker/utils/formatters';
