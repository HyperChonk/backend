export interface StatusResult {
    service: string;
    category: 'critical' | 'configuration' | 'efficiency' | 'healthy';
    status: 'healthy' | 'warning' | 'error';
    message: string;
    details?: any;
    timestamp: string;
}

export interface DeploymentIssue {
    service: string;
    issue: string;
    details: any;
    recommendations: string[];
}

export interface FullStatus {
    environment: string;
    region: string;
    timestamp: string;
    overallHealth: {
        operational: 'healthy' | 'degraded' | 'critical';
        systemFunctional: boolean;
        criticalIssues: number;
    };
    summary: {
        healthy: number;
        warning: number;
        error: number;
        total: number;
    };
    services: StatusResult[];
    endpointHealth: {
        allEndpointsWorking: boolean;
        httpWorking: boolean;
        httpsWorking: boolean;
    };
    deploymentIssues?: DeploymentIssue[];
    targetIssues?: any[];
    domainIssues?: any[];
}

export interface CheckResult {
    results: StatusResult[];
    deploymentIssues?: DeploymentIssue[];
    targetIssues?: any[];
    domainIssues?: any[];
    diagnostics?: any;
}

export interface EndpointCheckResult {
    results: StatusResult[];
    health: {
        allEndpointsWorking: boolean;
        httpWorking: boolean;
        httpsWorking: boolean;
    };
    domainIssues?: any[];
}

export interface LoadBalancerCheckResult {
    results: StatusResult[];
    targetIssues: any[];
}
