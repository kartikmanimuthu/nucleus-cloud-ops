import * as cdk from 'aws-cdk-lib';
import * as docdb from 'aws-cdk-lib/aws-docdb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { getConfig } from './config';

export interface DocumentDbStackProps extends cdk.StackProps {
    vpc: ec2.Vpc;
}

export class DocumentDbStack extends cdk.Stack {
    public readonly clusterEndpoint: string;
    public readonly clusterPort: number;
    public readonly secret: secretsmanager.ISecret;
    public readonly connectionStringSecretArn: string;

    constructor(scope: Construct, id: string, props: DocumentDbStackProps) {
        super(scope, id, props);

        const config = getConfig();
        const appName = config.appName;

        // Security group for DocumentDB — only allow inbound from within the VPC
        const docDbSg = new ec2.SecurityGroup(this, `${appName}-DocDbSg`, {
            vpc: props.vpc,
            description: 'DocumentDB security group',
            allowAllOutbound: false,
        });
        docDbSg.addIngressRule(
            ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
            ec2.Port.tcp(27017),
            'Allow DocumentDB from within VPC'
        );

        // Credentials stored in Secrets Manager
        const dbSecret = new secretsmanager.Secret(this, `${appName}-DocDbSecret`, {
            secretName: `/${appName}/docdb/credentials`,
            generateSecretString: {
                secretStringTemplate: JSON.stringify({ username: 'nucleusadmin' }),
                generateStringKey: 'password',
                excludePunctuation: true,
                passwordLength: 32,
            },
        });
        this.secret = dbSecret;

        // DocumentDB Cluster
        const cluster = new docdb.DatabaseCluster(this, `${appName}-DocDbCluster`, {
            masterUser: {
                username: 'nucleusadmin',
                password: dbSecret.secretValueFromJson('password'),
            },
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
            instances: 1,
            vpc: props.vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            securityGroup: docDbSg,
            storageEncrypted: true,
            deletionProtection: false,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            dbClusterName: `${appName}-docdb`,
            engineVersion: '5.0.0',
        });

        this.clusterEndpoint = cluster.clusterEndpoint.hostname;
        this.clusterPort = cluster.clusterEndpoint.port;

        // Build the MongoDB-compatible connection string and store it as a separate secret
        // Format: mongodb://user:password@host:port/?tls=true&tlsCAFile=...&replicaSet=rs0&readPreference=secondaryPreferred&retryWrites=false
        const connectionStringSecret = new secretsmanager.Secret(this, `${appName}-DocDbConnectionString`, {
            secretName: `/${appName}/docdb/connection-string`,
            secretStringValue: cdk.SecretValue.unsafePlainText(
                // The actual password is resolved at deploy time via the cluster's secret.
                // At synth time we store a placeholder; the ECS task reads the real value via Secrets Manager.
                `mongodb://nucleusadmin:PLACEHOLDER@${cluster.clusterEndpoint.hostname}:${cluster.clusterEndpoint.port}/?tls=true&tlsCAFile=/etc/ssl/certs/rds-combined-ca-bundle.pem&replicaSet=rs0&readPreference=secondaryPreferred&retryWrites=false`
            ),
        });
        this.connectionStringSecretArn = connectionStringSecret.secretArn;

        // Outputs
        new cdk.CfnOutput(this, 'DocDbClusterEndpoint', {
            value: cluster.clusterEndpoint.hostname,
            description: 'DocumentDB cluster endpoint',
        });

        new cdk.CfnOutput(this, 'DocDbPort', {
            value: String(cluster.clusterEndpoint.port),
            description: 'DocumentDB port',
        });

        new cdk.CfnOutput(this, 'DocDbSecretArn', {
            value: dbSecret.secretArn,
            description: 'ARN of the DocumentDB credentials secret',
        });

        new cdk.CfnOutput(this, 'DocDbConnectionStringSecretArn', {
            value: connectionStringSecret.secretArn,
            description: 'ARN of the DocumentDB connection string secret',
        });
    }
}
