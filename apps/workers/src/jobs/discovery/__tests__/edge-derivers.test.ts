import { describe, it, expect } from 'vitest';
import { CUSTOM_DERIVERS } from '../services/edge-derivers.js';

describe('edge-derivers', () => {
    describe('cloudwatch_alarms', () => {
        it('should derive monitors edge from InstanceId dimension', () => {
            const raw = {
                Dimensions: [{ Name: 'InstanceId', Value: 'i-123' }],
            };
            const edges = CUSTOM_DERIVERS.cloudwatch_alarms(raw, 'alarm-1');
            expect(edges).toEqual([
                {
                    fromType: 'cloudwatch_alarms',
                    fromId: 'alarm-1',
                    relation: 'monitors',
                    toType: 'ec2_instances',
                    toId: 'i-123',
                },
            ]);
        });

        it('should derive monitors edge from DBInstanceIdentifier dimension', () => {
            const raw = {
                Dimensions: [{ Name: 'DBInstanceIdentifier', Value: 'my-db' }],
            };
            const edges = CUSTOM_DERIVERS.cloudwatch_alarms(raw, 'alarm-2');
            expect(edges).toEqual([
                {
                    fromType: 'cloudwatch_alarms',
                    fromId: 'alarm-2',
                    relation: 'monitors',
                    toType: 'rds_db_instances',
                    toId: 'my-db',
                },
            ]);
        });

        it('should derive notifies edge from SNS alarm action', () => {
            const raw = {
                AlarmActions: ['arn:aws:sns:us-east-1:123456789012:my-topic'],
            };
            const edges = CUSTOM_DERIVERS.cloudwatch_alarms(raw, 'alarm-3');
            expect(edges).toEqual([
                {
                    fromType: 'cloudwatch_alarms',
                    fromId: 'alarm-3',
                    relation: 'notifies',
                    toType: 'sns_topics',
                    toId: 'arn:aws:sns:us-east-1:123456789012:my-topic',
                },
            ]);
        });

        it('should ignore non-SNS alarm actions', () => {
            const raw = {
                AlarmActions: ['arn:aws:automate:us-east-1:ec2:recover'],
            };
            const edges = CUSTOM_DERIVERS.cloudwatch_alarms(raw, 'alarm-4');
            expect(edges).toEqual([]);
        });

        it('should ignore unknown dimensions', () => {
            const raw = {
                Dimensions: [{ Name: 'SomeUnknownDimension', Value: 'val' }],
            };
            const edges = CUSTOM_DERIVERS.cloudwatch_alarms(raw, 'alarm-5');
            expect(edges).toEqual([]);
        });

        it('should return empty array when there are no dimensions', () => {
            const edges = CUSTOM_DERIVERS.cloudwatch_alarms({}, 'alarm-6', { accountId: '072097020844', region: 'ap-south-1' });
            expect(edges).toEqual([]);
        });

        // The LoadBalancer dimension carries only the ARN's tail (app/name/id), while
        // elbv2_load_balancers is inventoried on the full ARN — verified against a real
        // row: arn:aws:elasticloadbalancing:ap-south-1:072097020844:loadbalancer/app/stx-notification-center-alb-plfm/ad863efe1f662bec.
        it('should derive monitors edge from LoadBalancer dimension as the full reconstructed arn', () => {
            const raw = {
                Dimensions: [{ Name: 'LoadBalancer', Value: 'app/stx-notification-center-alb-plfm/ad863efe1f662bec' }],
            };
            const edges = CUSTOM_DERIVERS.cloudwatch_alarms(raw, 'alarm-7', { accountId: '072097020844', region: 'ap-south-1' });
            expect(edges).toEqual([
                {
                    fromType: 'cloudwatch_alarms',
                    fromId: 'alarm-7',
                    relation: 'monitors',
                    toType: 'elbv2_load_balancers',
                    toId: 'arn:aws:elasticloadbalancing:ap-south-1:072097020844:loadbalancer/app/stx-notification-center-alb-plfm/ad863efe1f662bec',
                },
            ]);
        });

        // Unlike LoadBalancer, AWS's TargetGroup dimension value already carries the
        // "targetgroup/" resource-type prefix (confirmed against AWS's own CLI example
        // and against a real row: arn:aws:elasticloadbalancing:ap-south-1:072097020844:targetgroup/stx-notification-center-msg-api/8f3c2d5a8b6469aa),
        // so it must not be prepended again when rebuilding the arn.
        it('should derive monitors edge from TargetGroup dimension as the full reconstructed arn', () => {
            const raw = {
                Dimensions: [{ Name: 'TargetGroup', Value: 'targetgroup/stx-notification-center-msg-api/8f3c2d5a8b6469aa' }],
            };
            const edges = CUSTOM_DERIVERS.cloudwatch_alarms(raw, 'alarm-8', { accountId: '072097020844', region: 'ap-south-1' });
            expect(edges).toEqual([
                {
                    fromType: 'cloudwatch_alarms',
                    fromId: 'alarm-8',
                    relation: 'monitors',
                    toType: 'elbv2_targroups',
                    toId: 'arn:aws:elasticloadbalancing:ap-south-1:072097020844:targetgroup/stx-notification-center-msg-api/8f3c2d5a8b6469aa',
                },
            ]);
        });
    });

    describe('cloudfront_distributions', () => {
        it('should derive origin_is edge from S3 origin domain', () => {
            const raw = {
                Origins: {
                    Items: [{ DomainName: 'my-bucket.s3.us-east-1.amazonaws.com' }],
                },
            };
            const edges = CUSTOM_DERIVERS.cloudfront_distributions(raw, 'dist-1');
            expect(edges).toEqual([
                {
                    fromType: 'cloudfront_distributions',
                    fromId: 'dist-1',
                    relation: 'origin_is',
                    toType: 's3_buckets',
                    toId: 'my-bucket',
                },
            ]);
        });

        it('should handle legacy global S3 origin domain form', () => {
            const raw = {
                Origins: {
                    Items: [{ DomainName: 'legacy-bucket.s3.amazonaws.com' }],
                },
            };
            const edges = CUSTOM_DERIVERS.cloudfront_distributions(raw, 'dist-2');
            expect(edges).toEqual([
                {
                    fromType: 'cloudfront_distributions',
                    fromId: 'dist-2',
                    relation: 'origin_is',
                    toType: 's3_buckets',
                    toId: 'legacy-bucket',
                },
            ]);
        });

        it('should ignore non-S3 origin domains', () => {
            const raw = {
                Origins: {
                    Items: [{ DomainName: 'example.com' }],
                },
            };
            const edges = CUSTOM_DERIVERS.cloudfront_distributions(raw, 'dist-3');
            expect(edges).toEqual([]);
        });

        it('should return empty array when no origins', () => {
            const raw = { Origins: { Items: [] } };
            const edges = CUSTOM_DERIVERS.cloudfront_distributions(raw, 'dist-4');
            expect(edges).toEqual([]);
        });
    });

    describe('eventsRules deriver', () => {
        const derive = (raw: Record<string, unknown>) => CUSTOM_DERIVERS.events_rules(raw, 'my-rule');

        it('links a rule to a lambda target', () => {
            const edges = derive({ _targets: [{ Arn: 'arn:aws:lambda:ap-south-1:111:function:my-fn' }] });
            expect(edges).toContainEqual(expect.objectContaining({
                relation: 'triggers', toType: 'lambda_functions', toId: 'my-fn',
            }));
        });

        it('links a rule to an sqs target keyed on the short queue name', () => {
            const edges = derive({ _targets: [{ Arn: 'arn:aws:sqs:ap-south-1:111:my-queue' }] });
            expect(edges).toContainEqual(expect.objectContaining({
                relation: 'triggers', toType: 'sqs_queues', toId: 'my-queue',
            }));
        });

        it('links a rule to an sns target keyed on the full topic arn', () => {
            const arn = 'arn:aws:sns:ap-south-1:111:my-topic';
            const edges = derive({ _targets: [{ Arn: arn }] });
            expect(edges).toContainEqual(expect.objectContaining({
                relation: 'triggers', toType: 'sns_topics', toId: arn,
            }));
        });

        it('links a rule to an ecs target keyed on the full cluster arn', () => {
            const arn = 'arn:aws:ecs:ap-south-1:111:cluster/my-cluster';
            const edges = derive({ _targets: [{ Arn: arn }] });
            expect(edges).toContainEqual(expect.objectContaining({
                relation: 'triggers', toType: 'ecs_clusters', toId: arn,
            }));
        });

        it('emits nothing for a target whose service has no inventory type', () => {
            expect(derive({ _targets: [{ Arn: 'arn:aws:states:ap-south-1:111:stateMachine:sm' }] })).toHaveLength(0);
        });

        it('emits nothing when the enrichment failed and no targets key exists', () => {
            expect(derive({})).toHaveLength(0);
        });
    });

    describe('codepipeline_pipelines', () => {
        const derive = (raw: Record<string, unknown>) => CUSTOM_DERIVERS.codepipeline_pipelines(raw, 'my-pipeline');

        it('links a pipeline to its artifact bucket', () => {
            const edges = derive({ artifactStore: { type: 'S3', location: 'my-pipeline-artifacts' } });
            expect(edges).toContainEqual({
                fromType: 'codepipeline_pipelines',
                fromId: 'my-pipeline',
                relation: 'stores_artifacts_in',
                toType: 's3_buckets',
                toId: 'my-pipeline-artifacts',
            });
        });

        it('links an ECR source action to its repository', () => {
            const raw = {
                stages: [{
                    name: 'Source',
                    actions: [{
                        name: 'Source',
                        actionTypeId: { category: 'Source', owner: 'AWS', provider: 'ECR', version: '1' },
                        configuration: { RepositoryName: 'my-service', ImageTag: 'latest' },
                    }],
                }],
            };
            expect(derive(raw)).toContainEqual({
                fromType: 'codepipeline_pipelines',
                fromId: 'my-pipeline',
                relation: 'sourced_from',
                toType: 'ecr_repositories',
                toId: 'my-service',
            });
        });

        it('links a Lambda invoke action to the function', () => {
            const raw = {
                stages: [{
                    name: 'Invoke',
                    actions: [{
                        name: 'Notify',
                        actionTypeId: { category: 'Invoke', owner: 'AWS', provider: 'Lambda', version: '1' },
                        configuration: { FunctionName: 'my-notifier' },
                    }],
                }],
            };
            expect(derive(raw)).toContainEqual({
                fromType: 'codepipeline_pipelines',
                fromId: 'my-pipeline',
                relation: 'invokes',
                toType: 'lambda_functions',
                toId: 'my-notifier',
            });
        });

        it('links an S3 deploy action to its bucket', () => {
            const raw = {
                stages: [{
                    name: 'Deploy',
                    actions: [{
                        name: 'DeployToS3',
                        actionTypeId: { category: 'Deploy', owner: 'AWS', provider: 'S3', version: '1' },
                        configuration: { BucketName: 'my-static-site', Extract: 'true' },
                    }],
                }],
            };
            expect(derive(raw)).toContainEqual({
                fromType: 'codepipeline_pipelines',
                fromId: 'my-pipeline',
                relation: 'deploys_to',
                toType: 's3_buckets',
                toId: 'my-static-site',
            });
        });

        // ecs_services and ecs_clusters are keyed on their full ARN (verified against
        // inventory_resources); ClusterName/ServiceName cannot be turned into that ARN
        // without the account id and region, neither of which the deriver receives.
        it('emits nothing for an ECS deploy action', () => {
            const raw = {
                stages: [{
                    name: 'Deploy',
                    actions: [{
                        name: 'DeployToECS',
                        actionTypeId: { category: 'Deploy', owner: 'AWS', provider: 'ECS', version: '1' },
                        configuration: { ClusterName: 'my-cluster', ServiceName: 'my-service' },
                    }],
                }],
            };
            expect(derive(raw)).toEqual([]);
        });

        // CodeCommit and ECR both use a "RepositoryName" configuration key; CodeCommit
        // repositories have no inventory type (not scanned), so mapping by key name alone
        // would produce a permanently dangling edge. Keying on actionTypeId.provider instead
        // correctly emits nothing here while still mapping the ECR case above.
        it('emits nothing for a CodeCommit source action', () => {
            const raw = {
                stages: [{
                    name: 'Source',
                    actions: [{
                        name: 'Source',
                        actionTypeId: { category: 'Source', owner: 'AWS', provider: 'CodeCommit', version: '1' },
                        configuration: { RepositoryName: 'my-repo', BranchName: 'main' },
                    }],
                }],
            };
            expect(derive(raw)).toEqual([]);
        });

        it('emits nothing when the enrichment failed and no stages or artifactStore key exists', () => {
            expect(derive({ name: 'my-pipeline', version: 1 })).toEqual([]);
        });
    });

    describe('s3_buckets notifications', () => {
        const derive = (raw: Record<string, unknown>) => CUSTOM_DERIVERS.s3_buckets(raw, 'my-bucket');

        it('links a Lambda notification target keyed on the short function name', () => {
            const raw = {
                LambdaFunctionConfigurations: [{ LambdaFunctionArn: 'arn:aws:lambda:ap-south-1:111:function:my-fn' }],
            };
            expect(derive(raw)).toEqual([
                {
                    fromType: 's3_buckets',
                    fromId: 'my-bucket',
                    relation: 'notifies_on_event',
                    toType: 'lambda_functions',
                    toId: 'my-fn',
                },
            ]);
        });

        it('links an SQS notification target keyed on the short queue name', () => {
            const raw = {
                QueueConfigurations: [{ QueueArn: 'arn:aws:sqs:ap-south-1:111:my-queue' }],
            };
            expect(derive(raw)).toEqual([
                {
                    fromType: 's3_buckets',
                    fromId: 'my-bucket',
                    relation: 'notifies_on_event',
                    toType: 'sqs_queues',
                    toId: 'my-queue',
                },
            ]);
        });

        it('links an SNS notification target keyed on the full topic arn', () => {
            const arn = 'arn:aws:sns:ap-south-1:111:my-topic';
            const raw = {
                TopicConfigurations: [{ TopicArn: arn }],
            };
            expect(derive(raw)).toEqual([
                {
                    fromType: 's3_buckets',
                    fromId: 'my-bucket',
                    relation: 'notifies_on_event',
                    toType: 'sns_topics',
                    toId: arn,
                },
            ]);
        });

        it('derives edges to all three target kinds at once', () => {
            const raw = {
                LambdaFunctionConfigurations: [{ LambdaFunctionArn: 'arn:aws:lambda:ap-south-1:111:function:my-fn' }],
                QueueConfigurations: [{ QueueArn: 'arn:aws:sqs:ap-south-1:111:my-queue' }],
                TopicConfigurations: [{ TopicArn: 'arn:aws:sns:ap-south-1:111:my-topic' }],
            };
            expect(derive(raw)).toHaveLength(3);
        });

        it('emits nothing for a bucket with no notification configuration', () => {
            expect(derive({})).toEqual([]);
        });
    });

    describe('ecs_services runs_image_from', () => {
        const ctx = { accountId: '970547372609', region: 'ap-south-1' };
        const derive = (raw: Record<string, unknown>) => CUSTOM_DERIVERS.ecs_services(raw, 'my-service', ctx);

        it('links to an ECR repository whose name contains a slash', () => {
            const image = '970547372609.dkr.ecr.ap-south-1.amazonaws.com/llm-powerhouse/litellm-proxy:v1.2';
            expect(derive({ _images: [image] })).toEqual([
                {
                    fromType: 'ecs_services',
                    fromId: 'my-service',
                    relation: 'runs_image_from',
                    toType: 'ecr_repositories',
                    toId: 'llm-powerhouse/litellm-proxy',
                },
            ]);
        });

        it('resolves the repository name from a digest-form image, not treating the digest as a tag', () => {
            const image = '970547372609.dkr.ecr.ap-south-1.amazonaws.com/my-repo@sha256:abcdef1234567890';
            expect(derive({ _images: [image] })).toEqual([
                {
                    fromType: 'ecs_services',
                    fromId: 'my-service',
                    relation: 'runs_image_from',
                    toType: 'ecr_repositories',
                    toId: 'my-repo',
                },
            ]);
        });

        it('emits nothing for a public or third-party image', () => {
            expect(derive({ _images: ['nginx:latest'] })).toEqual([]);
            expect(derive({ _images: ['public.ecr.aws/l8k9u7q7/observability-lgtm/grafana/alloy:latest'] })).toEqual([]);
        });

        it('emits nothing for an image from another account\'s registry', () => {
            const image = '111111111111.dkr.ecr.ap-south-1.amazonaws.com/other-account-repo:v1';
            expect(derive({ _images: [image] })).toEqual([]);
        });

        it('emits nothing for an image with no tag and no digest', () => {
            const image = '970547372609.dkr.ecr.ap-south-1.amazonaws.com/my-repo';
            expect(derive({ _images: [image] })).toEqual([]);
        });

        it('emits nothing when the enrichment failed and no images key exists', () => {
            expect(derive({})).toEqual([]);
        });
    });
});
