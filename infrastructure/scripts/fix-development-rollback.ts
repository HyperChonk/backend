#!/usr/bin/env ts-node

import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DescribeServicesCommand, ECSClient, UpdateServiceCommand } from '@aws-sdk/client-ecs';
import chalk from 'chalk';

class DevelopmentRecovery {
    private ecsClient: ECSClient;
    private cfClient: CloudFormationClient;
    private environment = 'development';
    private region = 'us-east-1';

    constructor() {
        this.ecsClient = new ECSClient({ region: this.region });
        this.cfClient = new CloudFormationClient({ region: this.region });
    }

    async recover(): Promise<void> {
        console.log(chalk.blue('🚑 Starting Development Environment Recovery'));
        console.log(chalk.blue('='.repeat(50)));

        try {
            // Step 1: Check CloudFormation stack status
            await this.checkStackStatus();

            // Step 2: Scale up services that are at 0/0
            await this.scaleUpServices();

            // Step 3: Verify recovery
            await this.verifyRecovery();

            console.log(chalk.green('\n🎉 Recovery completed successfully!'));
            console.log(chalk.blue('\n📋 Next steps:'));
            console.log('1. Monitor services: npm run check-status:dev');
            console.log('2. Check logs: npm run logs:dev');
            console.log('3. Test GraphQL endpoint: curl https://dev-api.hyperchonk.com/graphql');
        } catch (error) {
            console.error(chalk.red('\n❌ Recovery failed:'), error);
            console.log(chalk.yellow('\n🔧 Manual steps required:'));
            console.log('1. Run: npm run fix-stuck-stack:dev');
            console.log('2. Then rerun this script');
            process.exit(1);
        }
    }

    private async checkStackStatus(): Promise<void> {
        console.log(chalk.blue('\n🔍 Checking CloudFormation stack status...'));

        const stackName = `v3-backend-${this.environment}-compute`;

        try {
            const response = await this.cfClient.send(
                new DescribeStacksCommand({
                    StackName: stackName,
                }),
            );

            const stack = response.Stacks?.[0];
            if (!stack) {
                throw new Error(`Stack ${stackName} not found`);
            }

            console.log(`Stack Status: ${stack.StackStatus}`);

            if (stack.StackStatus?.includes('ROLLBACK_FAILED')) {
                console.log(chalk.yellow('⚠️  Stack is in failed rollback state'));
                console.log(chalk.yellow('   This is why services are scaled down to 0'));
                console.log(chalk.blue("   We'll scale them back up manually"));
            }
        } catch (error) {
            console.error(chalk.red(`Failed to check stack status: ${error}`));
            throw error;
        }
    }

    private async scaleUpServices(): Promise<void> {
        console.log(chalk.blue('\n🔄 Scaling up services...'));

        const clusterName = `v3-backend-${this.environment}-cluster`;
        const services = [
            { name: `v3-backend-${this.environment}-api-service`, desiredCount: 1 },
            { name: `v3-backend-${this.environment}-scheduler-service`, desiredCount: 1 },
            // Worker service is already at 2/2, so we'll leave it
        ];

        for (const service of services) {
            try {
                console.log(`Scaling ${service.name} to ${service.desiredCount} tasks...`);

                await this.ecsClient.send(
                    new UpdateServiceCommand({
                        cluster: clusterName,
                        service: service.name,
                        desiredCount: service.desiredCount,
                    }),
                );

                console.log(chalk.green(`✅ ${service.name} scaled successfully`));
            } catch (error) {
                console.error(chalk.red(`❌ Failed to scale ${service.name}:`), error);
            }
        }
    }

    private async verifyRecovery(): Promise<void> {
        console.log(chalk.blue('\n🔍 Verifying recovery...'));

        const clusterName = `v3-backend-${this.environment}-cluster`;
        const serviceNames = [
            `v3-backend-${this.environment}-api-service`,
            `v3-backend-${this.environment}-worker-service`,
            `v3-backend-${this.environment}-scheduler-service`,
        ];

        try {
            const response = await this.ecsClient.send(
                new DescribeServicesCommand({
                    cluster: clusterName,
                    services: serviceNames,
                }),
            );

            console.log(chalk.green('\n📊 Service Status:'));
            for (const service of response.services || []) {
                const name = service.serviceName!;
                const running = service.runningCount || 0;
                const desired = service.desiredCount || 0;
                const status = running === desired ? '✅' : '⚠️';

                console.log(`${status} ${name}: ${running}/${desired} tasks`);
            }
        } catch (error) {
            console.error(chalk.red('Failed to verify recovery:'), error);
        }
    }
}

async function main() {
    const recovery = new DevelopmentRecovery();
    await recovery.recover();
}

if (require.main === module) {
    main();
}
