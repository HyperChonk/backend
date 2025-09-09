import { RDSClient, DescribeDBInstancesCommand, DescribeDBClustersCommand } from '@aws-sdk/client-rds';
import { StatusResult } from '../types';

export class RDSChecker {
    private rdsClient: RDSClient;
    private environment: string;

    constructor(region: string, environment: string) {
        this.rdsClient = new RDSClient({ region });
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
            const [instancesResponse, clustersResponse] = await Promise.all([
                this.rdsClient.send(new DescribeDBInstancesCommand({})),
                this.rdsClient.send(new DescribeDBClustersCommand({})),
            ]);

            const envInstances = (instancesResponse.DBInstances || []).filter(
                (instance) =>
                    instance.DBInstanceIdentifier?.includes(`-${this.environment}-`) ||
                    instance.DBInstanceIdentifier?.includes(`v3-backend-${this.environment}`),
            );

            const envClusters = (clustersResponse.DBClusters || []).filter(
                (cluster) =>
                    cluster.DBClusterIdentifier?.includes(`-${this.environment}-`) ||
                    cluster.DBClusterIdentifier?.includes(`v3-backend-${this.environment}`),
            );

            for (const instance of envInstances) {
                const instanceId = instance.DBInstanceIdentifier || 'Unknown';
                const status = instance.DBInstanceStatus === 'available' ? 'healthy' : 'warning';
                results.push(
                    this.createResult(
                        `RDS-Instance-${instanceId}`,
                        'configuration',
                        status,
                        `Instance ${instanceId}: ${instance.DBInstanceStatus}`,
                        { status: instance.DBInstanceStatus, engine: instance.Engine },
                    ),
                );
            }

            for (const cluster of envClusters) {
                const clusterId = cluster.DBClusterIdentifier || 'Unknown';
                const status = cluster.Status === 'available' ? 'healthy' : 'warning';
                results.push(
                    this.createResult(
                        `RDS-Cluster-${clusterId}`,
                        'configuration',
                        status,
                        `Cluster ${clusterId}: ${cluster.Status}`,
                        { status: cluster.Status, engine: cluster.Engine },
                    ),
                );
            }
        } catch (error) {
            results.push(
                this.createResult(
                    'RDS',
                    'critical',
                    'error',
                    `Failed to check RDS: ${error instanceof Error ? error.message : 'Unknown error'}`,
                ),
            );
        }
        return results;
    }
}
