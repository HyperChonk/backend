import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

export class EnvironmentUtils {
    /**
     * Dynamically get domain configuration for the current environment
     */
    static getEnvironmentDomain(environment: string): string | null {
        try {
            const configPath = path.join(__dirname, '..', '..', '..', 'config', 'environments', `${environment}.ts`);

            if (!fs.existsSync(configPath)) {
                console.warn(`Environment configuration not found: ${configPath}`);
                return null;
            }

            // Read and parse the TypeScript configuration file
            const configContent = fs.readFileSync(configPath, 'utf8');

            // Extract domain name using regex (since we can't easily import TS in node script)
            const domainMatch = configContent.match(/domainName:\s*['"`]([^'"`]+)['"`]/);

            return domainMatch ? domainMatch[1] : null;
        } catch (error) {
            console.warn(`Error reading environment config for ${environment}:`, error);
            return null;
        }
    }

    /**
     * Check if a domain is relevant to this project based on dynamic configuration
     */
    static isDomainRelevant(domain: string, environment: string): boolean {
        const configuredDomain = this.getEnvironmentDomain(environment);

        if (configuredDomain) {
            // Check if it's exactly the configured domain
            return domain.toLowerCase() === configuredDomain.toLowerCase();
        }

        // Fallback: if no configured domain, don't check any certificates
        return false;
    }

    /**
     * Fetch with timeout for HTTP requests
     */
    static async fetchWithTimeout(url: string, timeout: number): Promise<any> {
        try {
            const response = await axios.get(url, {
                timeout,
                validateStatus: () => true,
            });

            return {
                ok: response.status >= 200 && response.status < 300,
                status: response.status,
                statusText: response.statusText,
            };
        } catch (error) {
            if (axios.isAxiosError(error) && error.response) {
                return {
                    ok: false,
                    status: error.response.status,
                    statusText: error.response.statusText,
                };
            }
            throw error;
        }
    }

    /**
     * Assess overall health based on results and endpoint health
     */
    static assessOverallHealth(results: any[], endpointHealth: any): any {
        const criticalIssues = results.filter((r) => r.category === 'critical' && r.status === 'error').length;
        const coreServiceFailures = results.filter(
            (r) =>
                ['ECS-Service', 'RDS-Instance', 'RDS-Cluster'].some((service) => r.service.includes(service)) &&
                r.status === 'error',
        ).length;

        let operational: 'healthy' | 'degraded' | 'critical' = 'healthy';
        let systemFunctional = true;

        // If endpoints aren't working, system is not functional
        if (!endpointHealth.allEndpointsWorking) {
            operational = 'critical';
            systemFunctional = false;
        } else if (coreServiceFailures > 0 || criticalIssues > 0) {
            operational = 'degraded';
        }

        return {
            operational,
            systemFunctional,
            criticalIssues,
        };
    }
}
