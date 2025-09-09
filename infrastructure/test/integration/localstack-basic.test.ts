import { isLocalStackRunning, localstackClients, localstackConfig } from '../helpers/localstack-setup';
import { CreateSecretCommand, GetSecretValueCommand, DeleteSecretCommand } from '@aws-sdk/client-secrets-manager';
import { ListStacksCommand } from '@aws-sdk/client-cloudformation';
import axios from 'axios';

describe('LocalStack Basic Integration', () => {
    test('LocalStack is running and accessible', async () => {
        const isRunning = await isLocalStackRunning();
        expect(isRunning).toBe(true);
    });

    test('LocalStack health endpoint returns services status', async () => {
        const response = await axios.get(`${localstackConfig.endpoint}/_localstack/health`);
        expect(response.status).toBe(200);

        const health = response.data;

        // Verify core services are available
        expect(health.services).toHaveProperty('cloudformation');
        expect(health.services).toHaveProperty('s3');
        expect(health.services).toHaveProperty('sqs');
        expect(health.services).toHaveProperty('secretsmanager');
        expect(health.services).toHaveProperty('ec2');
    });

    test('Secrets Manager integration works', async () => {
        const secretName = 'test-secret-' + Date.now();
        const secretValue = {
            testKey: 'testValue',
            timestamp: new Date().toISOString(),
        };

        try {
            // Create a secret
            await localstackClients.secretsManager.send(
                new CreateSecretCommand({
                    Name: secretName,
                    SecretString: JSON.stringify(secretValue),
                }),
            );

            // Retrieve the secret
            const getResult = await localstackClients.secretsManager.send(
                new GetSecretValueCommand({
                    SecretId: secretName,
                }),
            );

            expect(getResult.SecretString).toBeDefined();
            const retrievedValue = JSON.parse(getResult.SecretString!);
            expect(retrievedValue.testKey).toBe(secretValue.testKey);
        } finally {
            // Cleanup
            try {
                await localstackClients.secretsManager.send(
                    new DeleteSecretCommand({
                        SecretId: secretName,
                        ForceDeleteWithoutRecovery: true,
                    }),
                );
            } catch (error) {
                console.warn('Failed to cleanup test secret:', error);
            }
        }
    });

    test('CloudFormation integration works', async () => {
        const result = await localstackClients.cloudFormation.send(new ListStacksCommand({}));

        // Should return a result without errors
        expect(result).toBeDefined();
        expect(result.StackSummaries).toBeDefined();
        expect(Array.isArray(result.StackSummaries)).toBe(true);
    });

    test('LocalStack AWS CLI configuration is valid', async () => {
        // Test that our LocalStack configuration can be used with AWS SDK
        expect(localstackConfig.endpoint).toBe('http://127.0.0.1:4566');
        expect(localstackConfig.region).toBe('us-east-1');
        expect(localstackConfig.accessKeyId).toBe('test');
        expect(localstackConfig.secretAccessKey).toBe('test');
    });
});
