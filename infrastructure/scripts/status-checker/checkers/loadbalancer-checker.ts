import {
    ElasticLoadBalancingV2Client,
    DescribeLoadBalancersCommand,
    DescribeTargetGroupsCommand,
    DescribeTargetHealthCommand,
    DescribeListenersCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { StatusResult, LoadBalancerCheckResult } from '../types';

export class LoadBalancerChecker {
    private elbClient: ElasticLoadBalancingV2Client;
    private environment: string;

    constructor(region: string, environment: string) {
        this.elbClient = new ElasticLoadBalancingV2Client({ region });
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

    /**
     * Analyze health check failures by examining ALB target health
     */
    async analyzeHealthCheckFailures(targetGroupArn: string): Promise<any> {
        try {
            const healthResponse = await this.elbClient.send(
                new DescribeTargetHealthCommand({
                    TargetGroupArn: targetGroupArn,
                }),
            );

            const targets = healthResponse.TargetHealthDescriptions || [];
            const unhealthyTargets = targets.filter((t) => t.TargetHealth?.State !== 'healthy');

            if (unhealthyTargets.length === 0) {
                return { hasHealthCheckIssues: false, details: 'All targets are healthy' };
            }

            // Categorize health check failure types
            const failureAnalysis = {
                failedHealthChecks: unhealthyTargets.filter(
                    (t) => t.TargetHealth?.Reason === 'Target.FailedHealthChecks',
                ).length,
                timeouts: unhealthyTargets.filter((t) => t.TargetHealth?.Reason === 'Target.Timeout').length,
                responseCodeMismatch: unhealthyTargets.filter(
                    (t) => t.TargetHealth?.Reason === 'Target.ResponseCodeMismatch',
                ).length,
                connectionFailures: unhealthyTargets.filter(
                    (t) =>
                        t.TargetHealth?.Reason?.includes('Connection') ||
                        t.TargetHealth?.Reason?.includes('connection'),
                ).length,
                deregistrationInProgress: unhealthyTargets.filter(
                    (t) => t.TargetHealth?.Reason === 'Target.DeregistrationInProgress',
                ).length,
            };

            // Generate specific recommendations based on failure types
            const recommendations = [];

            if (failureAnalysis.failedHealthChecks > 0) {
                recommendations.push('Application /health endpoint may not be responding with 200 status');
                recommendations.push('Check if application fully started and database is connected');
                recommendations.push('Verify all required environment variables and secrets are accessible');
            }

            if (failureAnalysis.timeouts > 0) {
                recommendations.push('Application is slow to start or respond - check for performance issues');
                recommendations.push('Consider increasing ALB health check timeout or initial delay');
                recommendations.push('Check for database connection delays or migration issues');
            }

            if (failureAnalysis.responseCodeMismatch > 0) {
                recommendations.push('Health endpoint returning wrong HTTP status code');
                recommendations.push('Check application logs for startup errors or exceptions');
            }

            if (failureAnalysis.connectionFailures > 0) {
                recommendations.push('Network connectivity issues - check security groups');
                recommendations.push('Verify ECS tasks are running and listening on correct port');
            }

            if (failureAnalysis.deregistrationInProgress > 0) {
                recommendations.push('Targets are being replaced - this may be normal during deployment');
                recommendations.push('Wait for deployment to complete or check for rolling failures');
            }

            return {
                hasHealthCheckIssues: true,
                details: {
                    totalUnhealthy: unhealthyTargets.length,
                    totalTargets: targets.length,
                    failureAnalysis,
                    unhealthyTargets: unhealthyTargets.slice(0, 3).map((target) => ({
                        id: target.Target?.Id,
                        port: target.Target?.Port,
                        state: target.TargetHealth?.State,
                        reason: target.TargetHealth?.Reason,
                        description: target.TargetHealth?.Description,
                    })),
                    recommendations,
                },
            };
        } catch (error) {
            return {
                hasHealthCheckIssues: false,
                error: error instanceof Error ? error.message : 'Unknown error analyzing health checks',
            };
        }
    }

    private getTargetHealthRecommendations(unhealthyTargets: any[]): string[] {
        const recommendations = [];

        const failingHealthChecks = unhealthyTargets.filter(
            (t) => t.TargetHealth?.Reason === 'Target.FailedHealthChecks',
        );

        const timeouts = unhealthyTargets.filter((t) => t.TargetHealth?.Reason === 'Target.Timeout');

        const connectionFailures = unhealthyTargets.filter(
            (t) => t.TargetHealth?.Reason === 'Target.ResponseCodeMismatch',
        );

        if (failingHealthChecks.length > 0) {
            recommendations.push('Check if application /health endpoint is responding');
            recommendations.push('Verify application is fully started and database is accessible');
        }

        if (timeouts.length > 0) {
            recommendations.push('Application may be slow to respond - check for performance issues');
            recommendations.push('Consider increasing health check timeout or start period');
        }

        if (connectionFailures.length > 0) {
            recommendations.push('Application returning wrong status code on health endpoint');
            recommendations.push('Check application logs for startup errors');
        }

        if (recommendations.length === 0) {
            recommendations.push('Check ECS task logs for application startup issues');
            recommendations.push('Verify security groups allow health check traffic');
        }

        return recommendations;
    }

    async check(): Promise<LoadBalancerCheckResult> {
        const results: StatusResult[] = [];
        const targetIssues: any[] = [];

        try {
            const lbResponse = await this.elbClient.send(new DescribeLoadBalancersCommand({}));
            const envLBs = (lbResponse.LoadBalancers || []).filter(
                (lb) =>
                    lb.LoadBalancerName?.includes(`-${this.environment}-`) ||
                    lb.LoadBalancerName?.includes(`v3-backend-${this.environment}`),
            );

            for (const lb of envLBs) {
                const lbName = lb.LoadBalancerName || 'Unknown';

                // Get target groups
                const tgResponse = await this.elbClient.send(
                    new DescribeTargetGroupsCommand({
                        LoadBalancerArn: lb.LoadBalancerArn,
                    }),
                );

                let allTargetsHealthy = true;
                let totalTargets = 0;
                let healthyTargets = 0;

                for (const tg of tgResponse.TargetGroups || []) {
                    try {
                        const healthResponse = await this.elbClient.send(
                            new DescribeTargetHealthCommand({
                                TargetGroupArn: tg.TargetGroupArn,
                            }),
                        );

                        const targets = healthResponse.TargetHealthDescriptions || [];
                        totalTargets += targets.length;

                        const healthy = targets.filter((t) => t.TargetHealth?.State === 'healthy');
                        const unhealthy = targets.filter((t) => t.TargetHealth?.State !== 'healthy');

                        healthyTargets += healthy.length;

                        if (unhealthy.length > 0) {
                            allTargetsHealthy = false;

                            targetIssues.push({
                                loadBalancer: lbName,
                                targetGroup: tg.TargetGroupName,
                                totalTargets: targets.length,
                                healthyTargets: healthy.length,
                                unhealthyTargets: unhealthy.map((target) => ({
                                    id: target.Target?.Id,
                                    port: target.Target?.Port,
                                    state: target.TargetHealth?.State,
                                    reason: target.TargetHealth?.Reason,
                                    description: target.TargetHealth?.Description,
                                })),
                                recommendations: this.getTargetHealthRecommendations(unhealthy),
                            });
                        }
                    } catch (error) {
                        allTargetsHealthy = false;
                    }
                }

                const lbStatus = allTargetsHealthy ? 'healthy' : 'error';
                const lbMessage = `Load balancer ${lbName}: ${healthyTargets}/${totalTargets} targets healthy`;

                results.push(
                    this.createResult(`LoadBalancer-${lbName}`, 'configuration', lbStatus, lbMessage, {
                        dnsName: lb.DNSName,
                        state: lb.State?.Code,
                        totalTargets,
                        healthyTargets,
                    }),
                );
            }
        } catch (error) {
            results.push(
                this.createResult(
                    'LoadBalancer',
                    'critical',
                    'error',
                    `Failed to check load balancers: ${error instanceof Error ? error.message : 'Unknown error'}`,
                ),
            );
        }

        return { results, targetIssues };
    }
}
