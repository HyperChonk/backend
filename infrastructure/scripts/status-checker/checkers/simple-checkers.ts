import { S3Client, ListBucketsCommand, GetBucketLocationCommand } from '@aws-sdk/client-s3';
import { SQSClient, ListQueuesCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { LambdaClient, ListFunctionsCommand } from '@aws-sdk/client-lambda';
import { SecretsManagerClient, ListSecretsCommand } from '@aws-sdk/client-secrets-manager';
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { ACMClient, ListCertificatesCommand, DescribeCertificateCommand } from '@aws-sdk/client-acm';
import { StatusResult } from '../types';
import { EnvironmentUtils } from '../utils/environment-utils';

export class S3Checker {
    private s3Client: S3Client;
    private environment: string;

    constructor(region: string, environment: string) {
        this.s3Client = new S3Client({ region });
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
            const response = await this.s3Client.send(new ListBucketsCommand({}));
            const envBuckets = (response.Buckets || []).filter(
                (bucket) =>
                    bucket.Name?.includes(`-${this.environment}-`) ||
                    bucket.Name?.includes(`v3-backend-${this.environment}`) ||
                    bucket.Name?.includes(`balancer-v3-${this.environment}`),
            );

            for (const bucket of envBuckets) {
                const bucketName = bucket.Name || 'Unknown';
                try {
                    await this.s3Client.send(new GetBucketLocationCommand({ Bucket: bucketName }));
                    results.push(
                        this.createResult(
                            `S3-${bucketName}`,
                            'configuration',
                            'healthy',
                            `Bucket ${bucketName}: Accessible`,
                        ),
                    );
                } catch {
                    results.push(
                        this.createResult(
                            `S3-${bucketName}`,
                            'configuration',
                            'error',
                            `Bucket ${bucketName}: Access error`,
                        ),
                    );
                }
            }
        } catch (error) {
            results.push(
                this.createResult(
                    'S3',
                    'critical',
                    'error',
                    `Failed to check S3: ${error instanceof Error ? error.message : 'Unknown error'}`,
                ),
            );
        }
        return results;
    }
}

export class SQSChecker {
    private sqsClient: SQSClient;
    private environment: string;

    constructor(region: string, environment: string) {
        this.sqsClient = new SQSClient({ region });
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
            const response = await this.sqsClient.send(new ListQueuesCommand({}));
            const envQueues = (response.QueueUrls || []).filter(
                (url) => url.includes(`-${this.environment}-`) || url.includes(`v3-backend-${this.environment}`),
            );

            for (const queueUrl of envQueues) {
                const queueName = queueUrl.split('/').pop() || 'Unknown';
                try {
                    const attributes = await this.sqsClient.send(
                        new GetQueueAttributesCommand({
                            QueueUrl: queueUrl,
                            AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
                        }),
                    );

                    const visible = parseInt(attributes.Attributes?.ApproximateNumberOfMessages || '0');
                    const inFlight = parseInt(attributes.Attributes?.ApproximateNumberOfMessagesNotVisible || '0');

                    let status: StatusResult['status'] = 'healthy';
                    if (queueName.includes('dlq') && visible > 0) {
                        // Background job DLQ is warning, other DLQs are errors
                        status = queueName.includes('background-job-dlq') ? 'warning' : 'error';
                    } else if (visible > 50) {
                        status = 'warning';
                    }

                    results.push(
                        this.createResult(
                            `SQS-${queueName}`,
                            'configuration',
                            status,
                            `Queue ${queueName}: ${visible} visible, ${inFlight} in-flight`,
                            { visible, inFlight },
                        ),
                    );
                } catch {
                    results.push(
                        this.createResult(
                            `SQS-${queueName}`,
                            'configuration',
                            'error',
                            `Queue ${queueName}: Access error`,
                        ),
                    );
                }
            }
        } catch (error) {
            results.push(
                this.createResult(
                    'SQS',
                    'critical',
                    'error',
                    `Failed to check SQS: ${error instanceof Error ? error.message : 'Unknown error'}`,
                ),
            );
        }
        return results;
    }
}

export class LambdaChecker {
    private lambdaClient: LambdaClient;
    private environment: string;

    constructor(region: string, environment: string) {
        this.lambdaClient = new LambdaClient({ region });
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
            const response = await this.lambdaClient.send(new ListFunctionsCommand({}));
            const envFunctions = (response.Functions || []).filter(
                (func: any) =>
                    func.FunctionName?.includes(`-${this.environment}-`) ||
                    func.FunctionName?.includes(`v3-backend-${this.environment}`),
            );

            for (const func of envFunctions) {
                const functionName = func.FunctionName || 'Unknown';
                const state = func.State;
                const status = state === 'Active' ? 'healthy' : 'warning';
                results.push(
                    this.createResult(
                        `Lambda-${functionName}`,
                        'configuration',
                        status,
                        `Function ${functionName}: ${state}`,
                        { state },
                    ),
                );
            }
        } catch (error) {
            results.push(
                this.createResult(
                    'Lambda',
                    'critical',
                    'error',
                    `Failed to check Lambda: ${error instanceof Error ? error.message : 'Unknown error'}`,
                ),
            );
        }
        return results;
    }
}

export class SecretsManagerChecker {
    private secretsClient: SecretsManagerClient;
    private environment: string;

    constructor(region: string, environment: string) {
        this.secretsClient = new SecretsManagerClient({ region });
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
            const response = await this.secretsClient.send(new ListSecretsCommand({}));
            const envSecrets = (response.SecretList || []).filter(
                (secret) =>
                    secret.Name?.includes(`v3-backend/${this.environment}/`) ||
                    secret.Name?.includes(`-${this.environment}-`),
            );

            for (const secret of envSecrets) {
                const secretName = secret.Name || 'Unknown';
                results.push(
                    this.createResult(
                        `SecretsManager-${secretName}`,
                        'configuration',
                        'healthy',
                        `Secret ${secretName}: Available`,
                    ),
                );
            }
        } catch (error) {
            results.push(
                this.createResult(
                    'SecretsManager',
                    'critical',
                    'error',
                    `Failed to check Secrets Manager: ${error instanceof Error ? error.message : 'Unknown error'}`,
                ),
            );
        }
        return results;
    }
}

export class CloudWatchChecker {
    private cloudwatchClient: CloudWatchClient;
    private environment: string;

    constructor(region: string, environment: string) {
        this.cloudwatchClient = new CloudWatchClient({ region });
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
            const response = await this.cloudwatchClient.send(new DescribeAlarmsCommand({}));
            const envAlarms = (response.MetricAlarms || []).filter(
                (alarm) =>
                    alarm.AlarmName?.includes(`-${this.environment}-`) ||
                    alarm.AlarmName?.includes(`v3-backend-${this.environment}`),
            );

            let alarmCount = 0;
            let okCount = 0;

            for (const alarm of envAlarms) {
                const alarmName = alarm.AlarmName || 'Unknown';
                const state = alarm.StateValue;

                if (state === 'ALARM') {
                    alarmCount++;
                    // Only treat certain alarms as critical
                    // DLQ alarms for background jobs are warnings unless they're API-critical
                    const isCritical = 
                        (alarmName.includes('5xx') || alarmName.includes('error')) ||
                        (alarmName.includes('dlq') && !alarmName.includes('background-job'));
                    const category = isCritical ? 'critical' : 'efficiency';
                    const status = isCritical ? 'error' : 'warning';

                    results.push(
                        this.createResult(`Alarm-${alarmName}`, category, status, `${alarmName}: ${state}`, {
                            state,
                            reason: alarm.StateReason,
                        }),
                    );
                } else if (state === 'OK') {
                    okCount++;
                }
            }

            // Add summary
            results.unshift(
                this.createResult(
                    'CloudWatch-Alarms',
                    'configuration',
                    alarmCount > 0 ? 'warning' : 'healthy',
                    `Alarms: ${okCount} OK, ${alarmCount} triggered`,
                    { total: envAlarms.length, ok: okCount, alarm: alarmCount },
                ),
            );
        } catch (error) {
            results.push(
                this.createResult(
                    'CloudWatch-Alarms',
                    'critical',
                    'error',
                    `Failed to check alarms: ${error instanceof Error ? error.message : 'Unknown error'}`,
                ),
            );
        }
        return results;
    }
}

export class CertificateChecker {
    private acmClient: ACMClient;
    private environment: string;

    constructor(region: string, environment: string) {
        this.acmClient = new ACMClient({ region });
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
            const response = await this.acmClient.send(new ListCertificatesCommand({}));

            // Filter certificates to only those relevant to this project (dynamically determined)
            const relevantCerts = (response.CertificateSummaryList || []).filter((cert) => {
                if (!cert.DomainName) return false;
                return EnvironmentUtils.isDomainRelevant(cert.DomainName, this.environment);
            });

            for (const cert of relevantCerts) {
                if (!cert.CertificateArn) continue;

                const details = await this.acmClient.send(
                    new DescribeCertificateCommand({ CertificateArn: cert.CertificateArn }),
                );

                const certificate = details.Certificate;
                if (!certificate) continue;

                const domainName = certificate.DomainName;
                const status = certificate.Status;
                let resultStatus: StatusResult['status'] = 'healthy';

                if (status === 'ISSUED') {
                    if (certificate.NotAfter) {
                        const daysUntilExpiry = Math.floor(
                            (certificate.NotAfter.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
                        );
                        if (daysUntilExpiry < 30) resultStatus = 'warning';
                    }
                } else {
                    resultStatus = 'error';
                }

                results.push(
                    this.createResult(
                        `SSL-Certificate-${domainName}`,
                        'configuration',
                        resultStatus,
                        `Certificate ${domainName}: ${status}`,
                        { status, domainName },
                    ),
                );
            }
        } catch (error) {
            results.push(
                this.createResult(
                    'SSL-Certificates',
                    'configuration',
                    'error',
                    `Failed to check certificates: ${error instanceof Error ? error.message : 'Unknown error'}`,
                ),
            );
        }
        return results;
    }
}
