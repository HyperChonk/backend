import { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import { ACMClient, ListCertificatesCommand } from '@aws-sdk/client-acm';
import { StatusResult, EndpointCheckResult } from '../types';
import { EnvironmentUtils } from '../utils/environment-utils';

export class EndpointChecker {
    private elbClient: ElasticLoadBalancingV2Client;
    private acmClient: ACMClient;
    private environment: string;

    constructor(region: string, environment: string) {
        this.elbClient = new ElasticLoadBalancingV2Client({ region });
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

    async check(): Promise<EndpointCheckResult> {
        const results: StatusResult[] = [];
        const domainIssues: any[] = [];
        let httpWorking = false;
        let httpsWorking = false;

        // Get domain from load balancer and certificates
        let testDomain: string | undefined;
        let loadBalancerDns: string | undefined;
        let certificateDomains: string[] = [];

        try {
            const lbResponse = await this.elbClient.send(new DescribeLoadBalancersCommand({}));
            const envLB = (lbResponse.LoadBalancers || []).find(
                (lb) =>
                    lb.LoadBalancerName?.includes(`-${this.environment}-`) ||
                    lb.LoadBalancerName?.includes(`v3-backend-${this.environment}`),
            );
            loadBalancerDns = envLB?.DNSName;

            // Get certificate domains (filtered to this project using dynamic configuration)
            const certResponse = await this.acmClient.send(new ListCertificatesCommand({}));
            const envCerts = (certResponse.CertificateSummaryList || []).filter((cert) => {
                if (!cert.DomainName) return false;
                return EnvironmentUtils.isDomainRelevant(cert.DomainName, this.environment);
            });

            for (const cert of envCerts) {
                if (cert.DomainName) {
                    certificateDomains.push(cert.DomainName);
                }
            }

            // Try to use the configured domain first, then fallback to discovered certificates or load balancer DNS
            const configuredDomain = EnvironmentUtils.getEnvironmentDomain(this.environment);
            testDomain = configuredDomain || undefined;

            // Check for domain/certificate mismatch - This check is only relevant if not using a custom domain
            if (!configuredDomain && loadBalancerDns && certificateDomains.length > 0) {
                const matchingCert = certificateDomains.some(
                    (domain) =>
                        domain.includes(loadBalancerDns!.split('.')[0]) ||
                        loadBalancerDns!.includes(domain.split('.')[0]),
                );

                if (!matchingCert) {
                    domainIssues.push({
                        issue: 'Domain/Certificate Mismatch',
                        loadBalancerDns,
                        certificateDomains,
                        recommendation: `Use custom domain (${certificateDomains[0]}) instead of load balancer DNS, or update certificate to include load balancer domain`,
                    });
                }
            }
        } catch (error) {
            console.warn('Could not determine test domain:', error);
        }

        if (!testDomain) {
            results.push(
                this.createResult('Endpoints', 'critical', 'error', 'No domain available for endpoint testing', {
                    loadBalancerDns,
                    certificateDomains,
                }),
            );
            return {
                results,
                health: { allEndpointsWorking: false, httpWorking: false, httpsWorking: false },
                domainIssues,
            };
        }

        // Test HTTP
        try {
            const httpResponse = await EnvironmentUtils.fetchWithTimeout(`http://${testDomain}/health`, 10000);
            httpWorking = httpResponse.ok;
            const status = httpResponse.ok ? 'healthy' : 'error';
            results.push(
                this.createResult(
                    'HTTP-Endpoint',
                    httpResponse.ok ? 'configuration' : 'critical',
                    status,
                    `HTTP endpoint: ${httpResponse.status} ${httpResponse.statusText}`,
                    { url: `http://${testDomain}/health`, statusCode: httpResponse.status },
                ),
            );
        } catch (error) {
            results.push(
                this.createResult(
                    'HTTP-Endpoint',
                    'critical',
                    'error',
                    `HTTP endpoint failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
                    { url: `http://${testDomain}/health` },
                ),
            );
        }

        // Test HTTPS
        try {
            const httpsResponse = await EnvironmentUtils.fetchWithTimeout(`https://${testDomain}/health`, 10000);
            httpsWorking = httpsResponse.ok;
            const status = httpsResponse.ok ? 'healthy' : 'error';
            results.push(
                this.createResult(
                    'HTTPS-Endpoint',
                    httpsResponse.ok ? 'configuration' : 'critical',
                    status,
                    `HTTPS endpoint: ${httpsResponse.status} ${httpsResponse.statusText}`,
                    { url: `https://${testDomain}/health`, statusCode: httpsResponse.status },
                ),
            );
        } catch (error) {
            // Check if it's a certificate mismatch error
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            if (errorMessage.includes('certificate') || errorMessage.includes('altnames')) {
                domainIssues.push({
                    issue: 'Certificate Hostname Mismatch',
                    testedDomain: testDomain,
                    error: errorMessage,
                    recommendation:
                        'Use the correct custom domain that matches the certificate, or update load balancer to use custom domain',
                });
            }

            results.push(
                this.createResult('HTTPS-Endpoint', 'critical', 'error', `HTTPS endpoint failed: ${errorMessage}`, {
                    url: `https://${testDomain}/health`,
                }),
            );
        }

        const allEndpointsWorking = httpWorking && httpsWorking;

        // Add compliance result based on endpoint health
        const complianceStatus = allEndpointsWorking ? 'healthy' : 'error';
        const complianceCategory = allEndpointsWorking ? 'configuration' : 'critical';
        const complianceMessage = allEndpointsWorking
            ? `${this.environment} environment is compliant - endpoints working`
            : `${this.environment} environment NOT COMPLIANT - endpoints not working`;

        results.push(
            this.createResult('Environment-Compliance', complianceCategory, complianceStatus, complianceMessage, {
                httpWorking,
                httpsWorking,
                allEndpointsWorking,
            }),
        );

        return {
            results,
            health: { allEndpointsWorking, httpWorking, httpsWorking },
            domainIssues,
        };
    }
}
