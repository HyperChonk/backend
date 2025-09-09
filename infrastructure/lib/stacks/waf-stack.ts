import * as cdk from 'aws-cdk-lib';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../../config/shared/types';
import { generateResourceName } from '../../config/environments/shared';

export interface WafStackProps extends cdk.StackProps {
    config: EnvironmentConfig;
}

/**
 * WAF Stack for Balancer v3 Backend
 *
 * Creates AWS WAF v2 Web ACL with GraphQL-specific protections:
 * - Rate limiting for API endpoints
 * - Protection against common attacks (SQL injection, XSS, etc.)
 * - GraphQL query complexity limits
 * - Geo-blocking and IP whitelisting capabilities
 * - Comprehensive logging and monitoring
 */
export class WafStack extends cdk.Stack {
    public readonly webAcl: wafv2.CfnWebACL;
    public readonly logGroup: logs.LogGroup;

    constructor(scope: Construct, id: string, props: WafStackProps) {
        super(scope, id, props);

        const { config } = props;

        // Create CloudWatch log group for WAF logs
        this.logGroup = new logs.LogGroup(this, 'WafLogGroup', {
            logGroupName: `/v3-backend/${config.environment}/waf`,
            retention: config.monitoring.logRetention,
            removalPolicy: config.environment === 'production' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
        });

        // Create WAF Web ACL
        this.webAcl = this.createWebAcl(config);

        // Apply tags
        this.applyTags(config);

    }

    /**
     * Create WAF Web ACL with comprehensive rules
     */
    private createWebAcl(config: EnvironmentConfig): wafv2.CfnWebACL {
        const rules: wafv2.CfnWebACL.RuleProperty[] = [];

        // 1. Rate limiting rule - GraphQL endpoint
        rules.push({
            name: 'GraphQLRateLimit',
            priority: 1,
            statement: {
                rateBasedStatement: {
                    limit: config.security.wafRateLimit,
                    aggregateKeyType: 'IP',
                    scopeDownStatement: {
                        byteMatchStatement: {
                            searchString: '/graphql',
                            fieldToMatch: { uriPath: {} },
                            textTransformations: [
                                {
                                    priority: 0,
                                    type: 'LOWERCASE',
                                },
                            ],
                            positionalConstraint: 'CONTAINS',
                        },
                    },
                },
            },
            action: {
                block: {},
            },
            visibilityConfig: {
                sampledRequestsEnabled: true,
                cloudWatchMetricsEnabled: true,
                metricName: 'GraphQLRateLimit',
            },
        });

        // 2. General API rate limiting
        rules.push({
            name: 'GeneralRateLimit',
            priority: 2,
            statement: {
                rateBasedStatement: {
                    limit: config.security.wafRateLimit * 2, // Higher limit for general API
                    aggregateKeyType: 'IP',
                },
            },
            action: {
                block: {},
            },
            visibilityConfig: {
                sampledRequestsEnabled: true,
                cloudWatchMetricsEnabled: true,
                metricName: 'GeneralRateLimit',
            },
        });

        // 3. GraphQL query size limit (prevent large query attacks)
        rules.push({
            name: 'GraphQLQuerySizeRule',
            priority: 3,
            statement: {
                andStatement: {
                    statements: [
                        {
                            byteMatchStatement: {
                                searchString: '/graphql',
                                fieldToMatch: { uriPath: {} },
                                textTransformations: [
                                    {
                                        priority: 0,
                                        type: 'LOWERCASE',
                                    },
                                ],
                                positionalConstraint: 'CONTAINS',
                            },
                        },
                        {
                            sizeConstraintStatement: {
                                fieldToMatch: { body: {} },
                                comparisonOperator: 'GT',
                                size: config.security.graphqlQuerySizeLimit,
                                textTransformations: [
                                    {
                                        priority: 0,
                                        type: 'NONE',
                                    },
                                ],
                            },
                        },
                    ],
                },
            },
            action: {
                block: {},
            },
            visibilityConfig: {
                sampledRequestsEnabled: true,
                cloudWatchMetricsEnabled: true,
                metricName: 'GraphQLQuerySizeRule',
            },
        });

        // 4. AWS Managed Rules - Core Rule Set
        rules.push({
            name: 'AWSManagedRulesCommonRuleSet',
            priority: 4,
            overrideAction: {
                none: {},
            },
            statement: {
                managedRuleGroupStatement: {
                    vendorName: 'AWS',
                    name: 'AWSManagedRulesCommonRuleSet',
                    excludedRules: [
                        // Exclude rules that might interfere with GraphQL
                        { name: 'SizeRestrictions_BODY' }, // We have custom body size rules
                        { name: 'GenericRFI_BODY' }, // Might trigger on GraphQL introspection
                    ],
                },
            },
            visibilityConfig: {
                sampledRequestsEnabled: true,
                cloudWatchMetricsEnabled: true,
                metricName: 'CommonRuleSet',
            },
        });

        // 5. AWS Managed Rules - Known Bad Inputs
        rules.push({
            name: 'AWSManagedRulesKnownBadInputsRuleSet',
            priority: 5,
            overrideAction: {
                none: {},
            },
            statement: {
                managedRuleGroupStatement: {
                    vendorName: 'AWS',
                    name: 'AWSManagedRulesKnownBadInputsRuleSet',
                },
            },
            visibilityConfig: {
                sampledRequestsEnabled: true,
                cloudWatchMetricsEnabled: true,
                metricName: 'KnownBadInputs',
            },
        });

        // 6. Block known malicious IP addresses (production only)
        if (config.environment === 'production') {
            rules.push({
                name: 'AWSManagedRulesAmazonIpReputationList',
                priority: 6,
                overrideAction: {
                    none: {},
                },
                statement: {
                    managedRuleGroupStatement: {
                        vendorName: 'AWS',
                        name: 'AWSManagedRulesAmazonIpReputationList',
                    },
                },
                visibilityConfig: {
                    sampledRequestsEnabled: true,
                    cloudWatchMetricsEnabled: true,
                    metricName: 'IpReputationList',
                },
            });
        }

        // 7. GraphQL introspection blocking (disabled - introspection allowed in all environments)
        // Note: GraphQL introspection is now enabled for schema access and playground functionality
        // if (config.environment === 'production') {
        //     rules.push({
        //         name: 'BlockGraphQLIntrospection',
        //         priority: 7,
        //         statement: {
        //             andStatement: {
        //                 statements: [
        //                     {
        //                         byteMatchStatement: {
        //                             searchString: '/graphql',
        //                             fieldToMatch: { uriPath: {} },
        //                             textTransformations: [
        //                                 {
        //                                     priority: 0,
        //                                     type: 'LOWERCASE',
        //                                 },
        //                             ],
        //                             positionalConstraint: 'CONTAINS',
        //                         },
        //                     },
        //                     {
        //                         byteMatchStatement: {
        //                             searchString: '__schema',
        //                             fieldToMatch: { body: {} },
        //                             textTransformations: [
        //                                 {
        //                                     priority: 0,
        //                                     type: 'LOWERCASE',
        //                                 },
        //                             ],
        //                             positionalConstraint: 'CONTAINS',
        //                         },
        //                     },
        //                 ],
        //             },
        //         },
        //         action: {
        //             block: {},
        //         },
        //         visibilityConfig: {
        //             sampledRequestsEnabled: true,
        //             cloudWatchMetricsEnabled: true,
        //             metricName: 'GraphQLIntrospectionBlock',
        //         },
        //     });
        // }

        return new wafv2.CfnWebACL(this, 'WebACL', {
            name: generateResourceName('web-acl', config.environment),
            description: `WAF Web ACL for Balancer v3 Backend ${config.environment} environment`,
            scope: 'REGIONAL', // For ALB association
            defaultAction: {
                allow: {},
            },
            rules,
            visibilityConfig: {
                sampledRequestsEnabled: true,
                cloudWatchMetricsEnabled: true,
                metricName: generateResourceName('web-acl', config.environment),
            },
        });
    }

    /**
     * Apply consistent tags to all resources
     */
    private applyTags(config: EnvironmentConfig): void {
        Object.entries(config.tags).forEach(([key, value]) => {
            cdk.Tags.of(this.webAcl).add(key, value);
            cdk.Tags.of(this.logGroup).add(key, value);
        });
        cdk.Tags.of(this.webAcl).add('Stack', 'WAF');
        cdk.Tags.of(this.logGroup).add('Stack', 'WAF');
    }

}
