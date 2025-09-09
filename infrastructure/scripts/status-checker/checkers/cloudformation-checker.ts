import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { StatusResult } from '../types';

export class CloudFormationChecker {
    private cfClient: CloudFormationClient;
    private environment: string;

    constructor(region: string, environment: string) {
        this.cfClient = new CloudFormationClient({ region });
        this.environment = environment;
    }

    private createResult(
        service: string,
        category: StatusResult['category'],
        status: StatusResult['status'],
        message: string,
        details?: any,
    ): StatusResult {
        return {
            service,
            category,
            status,
            message,
            details,
            timestamp: new Date().toISOString(),
        };
    }

    async check(): Promise<StatusResult[]> {
        const results: StatusResult[] = [];
        try {
            const response = await this.cfClient.send(new DescribeStacksCommand({}));
            const stacks = (response.Stacks || []).filter(
                (stack) =>
                    stack.StackName?.includes(`-${this.environment}-`) ||
                    stack.StackName?.includes(`v3-backend-${this.environment}`),
            );

            for (const stack of stacks) {
                const stackName = stack.StackName || 'Unknown';
                const status = stack.StackStatus;
                let resultStatus: StatusResult['status'] = 'warning';
                let category: StatusResult['category'] = 'configuration';

                if (status?.includes('COMPLETE')) {
                    resultStatus = 'healthy';
                } else if (status?.includes('IN_PROGRESS')) {
                    resultStatus = 'warning';
                } else if (status?.includes('FAILED') || status?.includes('ROLLBACK')) {
                    resultStatus = 'error';
                    category = 'critical';
                }

                results.push(
                    this.createResult(
                        `CloudFormation-${stackName}`,
                        category,
                        resultStatus,
                        `Stack ${stackName}: ${status}`,
                        { status: stack.StackStatus },
                    ),
                );
            }
        } catch (error) {
            results.push(
                this.createResult(
                    'CloudFormation',
                    'critical',
                    'error',
                    `Failed to check CloudFormation: ${error instanceof Error ? error.message : 'Unknown error'}`,
                ),
            );
        }
        return results;
    }
}
