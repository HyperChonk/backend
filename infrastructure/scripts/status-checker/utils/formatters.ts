import { FullStatus } from '../types';

export class StatusFormatters {
    private static getServiceEmoji(serviceName: string): string {
        if (serviceName.startsWith('CloudFormation')) return '🏗️';
        if (serviceName.startsWith('ECS-Cluster')) return '🏢';
        if (serviceName.startsWith('ECS-Service')) return '⚙️';
        if (serviceName.startsWith('RDS')) return '🗄️';
        if (serviceName.startsWith('S3')) return '📦';
        if (serviceName.startsWith('SQS')) return '📨';
        if (serviceName.startsWith('Lambda')) return '⚡';
        if (serviceName.startsWith('SecretsManager')) return '🔒';
        if (serviceName.startsWith('CloudWatch')) return '📊';
        if (serviceName.startsWith('Alarm')) return '🚨';
        if (serviceName.startsWith('SSL-Certificate')) return '📜';
        if (serviceName.startsWith('LoadBalancer')) return '🚦';
        if (serviceName.startsWith('HTTP-Endpoint')) return '🌐';
        if (serviceName.startsWith('HTTPS-Endpoint')) return '🔐';
        if (serviceName.startsWith('Environment-Compliance')) return '🛡️';
        if (serviceName.startsWith('Domain')) return '🌐';
        if (serviceName.includes('-tg')) return '🎯';
        return '🔹'; // Default
    }

    private static getStatusEmoji(status: 'healthy' | 'warning' | 'error'): string {
        switch (status) {
            case 'healthy':
                return '✅';
            case 'warning':
                return '⚠️';
            case 'error':
                return '❌';
        }
    }

    static formatSummary(status: FullStatus): string {
        const health = status.overallHealth;
        const statusEmoji = health.operational === 'critical' ? '🚨' : health.operational === 'degraded' ? '⚠️' : '✅';
        const functionalEmoji = health.systemFunctional ? '🟢' : '🔴';
        const endpointEmoji = status.endpointHealth.allEndpointsWorking ? '🟢' : '🔴';

        let output = `\n${statusEmoji} System Status: ${health.operational.toUpperCase()}\n`;
        output += `${functionalEmoji} System Functional: ${health.systemFunctional ? 'YES' : 'NO'}\n`;
        output += `${endpointEmoji} Endpoints Working: ${status.endpointHealth.allEndpointsWorking ? 'YES' : 'NO'}\n`;
        output += `Environment: ${status.environment} | Region: ${status.region}\n`;
        output += `Services: ${status.summary.healthy}✅ ${status.summary.warning}⚠️ ${status.summary.error}❌\n`;

        // Critical issues first
        const criticalIssues = status.services.filter((s) => s.category === 'critical' && s.status === 'error');
        if (criticalIssues.length > 0) {
            output += `\n🚨 CRITICAL ISSUES:\n`;
            for (const service of criticalIssues) {
                output += `  ❌ ${this.getServiceEmoji(service.service)} ${service.service}: ${service.message}\n`;
            }
        }

        // Show deployment issues with debugging info
        if (status.deploymentIssues && status.deploymentIssues.length > 0) {
            output += `\n🔄 DEPLOYMENT ISSUES:\n`;
            for (const issue of status.deploymentIssues) {
                output += `  🔴 ${this.getServiceEmoji(issue.service)} ${issue.service}: ${issue.issue}\n`;

                if (issue.details.taskFailures?.summary) {
                    output += `    💡 ${issue.details.taskFailures.summary}\n`;
                }

                if (issue.details.rolloutStateReason) {
                    output += `    📋 Rollout: ${issue.details.rolloutStateReason}\n`;
                }

                // Show log analysis results
                if (issue.details.logAnalysis?.length) {
                    output += `    📋 Log Analysis:\n`;
                    for (const logResult of issue.details.logAnalysis.slice(0, 2)) {
                        // Show first 2 log results
                        output += `      • ${logResult.source}: ${logResult.summary}\n`;
                        if (logResult.errorPatterns?.length) {
                            output += `        🔍 Issues: ${logResult.errorPatterns.join(', ')}\n`;
                        }
                        if (logResult.recentLogs?.length) {
                            output += `        📜 Recent logs:\n`;
                            for (const logEvent of logResult.recentLogs.slice(-3)) {
                                // Last 3 log entries
                                const timestamp = new Date(logEvent.timestamp || 0).toISOString().substring(11, 19);
                                const message = logEvent.message?.substring(0, 80) || '';
                                output += `          ${timestamp}: ${message}${message.length >= 80 ? '...' : ''}\n`;
                            }
                        }
                    }
                }

                if (issue.recommendations.length > 0) {
                    output += `    🔧 Next steps:\n`;
                    for (const rec of issue.recommendations.slice(0, 2)) {
                        // Show top 2 recommendations
                        output += `      • ${rec}\n`;
                    }
                }

                if (issue.details.taskFailures?.failures?.length > 0) {
                    output += `    📜 Recent failures:\n`;
                    for (const failure of issue.details.taskFailures.failures) {
                        const reason = failure.stoppedReason || failure.containerReason || 'Unknown';
                        output += `      • Task ${failure.taskArn}: ${reason}\n`;
                    }
                }
            }
        }

        // Show load balancer target issues
        if (status.targetIssues && status.targetIssues.length > 0) {
            output += `\n🎯 LOAD BALANCER TARGET ISSUES:\n`;
            for (const issue of status.targetIssues) {
                output += `  🔴 ${this.getServiceEmoji(issue.targetGroup)} ${issue.targetGroup}: ${
                    issue.healthyTargets
                }/${issue.totalTargets} targets healthy\n`;

                if (issue.unhealthyTargets?.length > 0) {
                    output += `    📜 Unhealthy targets:\n`;
                    for (const target of issue.unhealthyTargets.slice(0, 3)) {
                        // Show first 3
                        output += `      • ${target.id}:${target.port} - ${target.state} (${target.reason})\n`;
                    }
                }

                if (issue.recommendations?.length > 0) {
                    output += `    🔧 Recommendations:\n`;
                    for (const rec of issue.recommendations.slice(0, 2)) {
                        output += `      • ${rec}\n`;
                    }
                }
            }
        }

        // Show domain/certificate issues
        if (status.domainIssues && status.domainIssues.length > 0) {
            output += `\n🌐 DOMAIN/CERTIFICATE ISSUES:\n`;
            for (const issue of status.domainIssues) {
                output += `  🔴 ${this.getServiceEmoji(issue.issue)} ${issue.issue}\n`;

                if (issue.loadBalancerDns && issue.certificateDomains) {
                    output += `    📋 Load Balancer: ${issue.loadBalancerDns}\n`;
                    output += `    📋 Certificate domains: ${issue.certificateDomains.join(', ')}\n`;
                }

                if (issue.testedDomain) {
                    output += `    📋 Tested domain: ${issue.testedDomain}\n`;
                }

                if (issue.recommendation) {
                    output += `    🔧 Recommendation: ${issue.recommendation}\n`;
                }
            }
        }

        // Endpoint status with URLs
        output += `\n🌍 Endpoints:\n`;

        // Extract URLs from endpoint test results
        const httpEndpoint = status.services.find((s) => s.service === 'HTTP-Endpoint');
        const httpsEndpoint = status.services.find((s) => s.service === 'HTTPS-Endpoint');

        const httpUrl = httpEndpoint?.details?.url || 'Unknown URL';
        const httpsUrl = httpsEndpoint?.details?.url || 'Unknown URL';

        output += `  HTTP: ${status.endpointHealth.httpWorking ? '✅' : '❌'} ${httpUrl}\n`;
        output += `  HTTPS: ${status.endpointHealth.httpsWorking ? '✅' : '❌'} ${httpsUrl}\n`;

        // Environment compliance
        const compliance = status.services.find((s) => s.service === 'Environment-Compliance');
        if (compliance) {
            const emoji = compliance.status === 'healthy' ? '✅' : '❌';
            output += `\n⚙️ Environment: ${emoji} ${compliance.message}\n`;
        }

        return output;
    }

    static formatYAML(status: FullStatus): string {
        const yamlData = {
            infrastructure_status: {
                environment: status.environment,
                region: status.region,
                timestamp: status.timestamp,
                system_functional: status.overallHealth.systemFunctional,
                endpoints_working: status.endpointHealth.allEndpointsWorking,
                summary: {
                    healthy: status.summary.healthy,
                    warning: status.summary.warning,
                    error: status.summary.error,
                    total: status.summary.total,
                    overall_status:
                        status.summary.error > 0 ? 'ERROR' : status.summary.warning > 0 ? 'WARNING' : 'HEALTHY',
                },
                critical_issues: status.services
                    .filter((s) => s.category === 'critical' && s.status === 'error')
                    .map((s) => ({
                        service: `${this.getServiceEmoji(s.service)} ${s.service}`,
                        message: s.message,
                    })),
                deployment_issues: status.deploymentIssues?.map((issue) => ({
                    service: `${this.getServiceEmoji(issue.service)} ${issue.service}`,
                    issue: issue.issue,
                    recommendations: issue.recommendations,
                    details: {
                        rollout_state: issue.details.rolloutState,
                        rollout_reason: issue.details.rolloutStateReason,
                        task_failures: issue.details.taskFailures?.summary,
                        recent_failures: issue.details.taskFailures?.failures?.map((f: any) => ({
                            task: f.taskArn,
                            reason: f.stoppedReason || f.containerReason,
                            exit_code: f.exitCode,
                        })),
                    },
                })),
                target_issues: status.targetIssues?.map((issue) => ({
                    target_group: `${this.getServiceEmoji(issue.targetGroup)} ${issue.targetGroup}`,
                    healthy_targets: issue.healthyTargets,
                    total_targets: issue.totalTargets,
                    unhealthy_targets: issue.unhealthyTargets?.map((target: any) => ({
                        id: target.id,
                        port: target.port,
                        state: target.state,
                        reason: target.reason,
                    })),
                    recommendations: issue.recommendations,
                })),
                domain_issues: status.domainIssues?.map((issue) => ({
                    issue: `${this.getServiceEmoji(issue.issue)} ${issue.issue}`,
                    load_balancer_dns: issue.loadBalancerDns,
                    certificate_domains: issue.certificateDomains,
                    tested_domain: issue.testedDomain,
                    recommendation: issue.recommendation,
                })),
                services: status.services.map((s) => ({
                    name: `${this.getStatusEmoji(s.status)} ${this.getServiceEmoji(s.service)} ${s.service}`,
                    status: s.status,
                    message: s.message,
                })),
            },
        };

        return this.objectToYAML(yamlData);
    }

    private static objectToYAML(obj: any, indent: number = 0): string {
        const spaces = '  '.repeat(indent);
        let yaml = '';

        for (const [key, value] of Object.entries(obj)) {
            if (value === null || value === undefined) continue;

            if (Array.isArray(value)) {
                if (value.length === 0) continue;
                yaml += `${spaces}${key}:\n`;
                for (const item of value) {
                    if (typeof item === 'object' && item !== null) {
                        yaml += `${spaces}- \n${this.objectToYAML(item, indent + 1).replace(/^/gm, '  ')}`;
                    } else {
                        yaml += `${spaces}- ${item}\n`;
                    }
                }
            } else if (typeof value === 'object' && value !== null) {
                yaml += `${spaces}${key}:\n`;
                yaml += this.objectToYAML(value, indent + 1);
            } else {
                yaml += `${spaces}${key}: ${value}\n`;
            }
        }

        return yaml;
    }
}
