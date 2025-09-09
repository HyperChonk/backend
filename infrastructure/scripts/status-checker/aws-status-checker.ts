import { FullStatus } from './types';
import { EnvironmentUtils } from './utils/environment-utils';
import { CloudFormationChecker } from './checkers/cloudformation-checker';
import { ECSChecker } from './checkers/ecs-checker';
import { RDSChecker } from './checkers/rds-checker';
import {
    S3Checker,
    SQSChecker,
    LambdaChecker,
    SecretsManagerChecker,
    CloudWatchChecker,
    CertificateChecker,
} from './checkers/simple-checkers';
import { LoadBalancerChecker } from './checkers/loadbalancer-checker';
import { EndpointChecker } from './checkers/endpoint-checker';

export class AWSStatusChecker {
    private region: string;
    private environment: string;

    constructor(region: string = 'us-east-1', environment: string = 'development') {
        this.region = region;
        this.environment = environment;
    }

    async checkAll(): Promise<FullStatus> {
        console.log(`🔍 Checking AWS infrastructure status for ${this.environment} environment...\n`);

        // Create checker instances
        const cfChecker = new CloudFormationChecker(this.region, this.environment);
        const ecsChecker = new ECSChecker(this.region, this.environment);
        const rdsChecker = new RDSChecker(this.region, this.environment);
        const s3Checker = new S3Checker(this.region, this.environment);
        const sqsChecker = new SQSChecker(this.region, this.environment);
        const lambdaChecker = new LambdaChecker(this.region, this.environment);
        const secretsChecker = new SecretsManagerChecker(this.region, this.environment);
        const cloudwatchChecker = new CloudWatchChecker(this.region, this.environment);
        const certificateChecker = new CertificateChecker(this.region, this.environment);
        const lbChecker = new LoadBalancerChecker(this.region, this.environment);
        const endpointChecker = new EndpointChecker(this.region, this.environment);

        // Run all checks in parallel
        const [
            cfResults,
            ecsCheck,
            rdsResults,
            s3Results,
            sqsResults,
            lambdaResults,
            secretsResults,
            alarmsResults,
            certificateResults,
            lbCheck,
            endpointCheck,
        ] = await Promise.all([
            cfChecker.check(),
            ecsChecker.check(),
            rdsChecker.check(),
            s3Checker.check(),
            sqsChecker.check(),
            lambdaChecker.check(),
            secretsChecker.check(),
            cloudwatchChecker.check(),
            certificateChecker.check(),
            lbChecker.check(),
            endpointChecker.check(),
        ]);

        // Combine all results
        const allResults = [
            ...cfResults,
            ...ecsCheck.results,
            ...rdsResults,
            ...s3Results,
            ...sqsResults,
            ...lambdaResults,
            ...secretsResults,
            ...alarmsResults,
            ...certificateResults,
            ...lbCheck.results,
            ...endpointCheck.results,
        ];

        // Calculate summary
        const summary = {
            healthy: allResults.filter((r) => r.status === 'healthy').length,
            warning: allResults.filter((r) => r.status === 'warning').length,
            error: allResults.filter((r) => r.status === 'error').length,
            total: allResults.length,
        };

        // Assess overall health
        const overallHealth = EnvironmentUtils.assessOverallHealth(allResults, endpointCheck.health);

        return {
            environment: this.environment,
            region: this.region,
            timestamp: new Date().toISOString(),
            overallHealth,
            summary,
            services: allResults,
            endpointHealth: endpointCheck.health,
            deploymentIssues:
                ecsCheck.deploymentIssues && ecsCheck.deploymentIssues.length > 0
                    ? ecsCheck.deploymentIssues
                    : undefined,
            targetIssues: lbCheck.targetIssues && lbCheck.targetIssues.length > 0 ? lbCheck.targetIssues : undefined,
            domainIssues:
                endpointCheck.domainIssues && endpointCheck.domainIssues.length > 0
                    ? endpointCheck.domainIssues
                    : undefined,
        };
    }
}
