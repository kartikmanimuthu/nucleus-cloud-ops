import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '../.env') });

export interface NetworkingConfig {
    vpcCidr: string;
    maxAzs: number;
    natGateways: number;
}

export interface EcsConfig {
    webUi: {
        cpu: number;
        memory: number;
        desiredCount: number;
        minCapacity: number;
        maxCapacity: number;
    };
}

export interface CustomDomainConfig {
    enableCustomDomain: boolean;
    domainName?: string;
    certificateArn?: string;
    fallbackDomainName?: string;
}

export interface AppConfig {
    appName: string;
    awsAccountId: string;
    awsRegion: string;
    networking: NetworkingConfig;
    ecs: EcsConfig;
    customDomain: CustomDomainConfig;
    subscriptionEmails: string[];
}

export const getConfig = (): AppConfig => {
    const {
        APP_NAME,
        AWS_ACCOUNT_ID,
        AWS_REGION,
        VPC_CIDR,
        MAX_AZS,
        NAT_GATEWAYS,
        WEB_UI_CPU,
        WEB_UI_MEMORY,
        WEB_UI_DESIRED_COUNT,
        WEB_UI_MIN_CAPACITY,
        WEB_UI_MAX_CAPACITY,
        ENABLE_CUSTOM_DOMAIN,
        DOMAIN_NAME,
        CERTIFICATE_ARN,
        FALLBACK_DOMAIN_NAME,
        SUBSCRIPTION_EMAILS,
    } = process.env;

    if (!APP_NAME || !AWS_ACCOUNT_ID || !AWS_REGION) {
        throw new Error('Missing required environment variables: APP_NAME, AWS_ACCOUNT_ID, AWS_REGION');
    }

    return {
        appName: APP_NAME,
        awsAccountId: AWS_ACCOUNT_ID,
        awsRegion: AWS_REGION,
        networking: {
            vpcCidr: VPC_CIDR || '10.0.0.0/16',
            maxAzs: MAX_AZS ? parseInt(MAX_AZS) : 2,
            natGateways: NAT_GATEWAYS ? parseInt(NAT_GATEWAYS) : 2,
        },
        ecs: {
            webUi: {
                cpu: WEB_UI_CPU ? parseInt(WEB_UI_CPU) : 1024,
                memory: WEB_UI_MEMORY ? parseInt(WEB_UI_MEMORY) : 2048,
                desiredCount: WEB_UI_DESIRED_COUNT ? parseInt(WEB_UI_DESIRED_COUNT) : 1,
                minCapacity: WEB_UI_MIN_CAPACITY ? parseInt(WEB_UI_MIN_CAPACITY) : 1,
                maxCapacity: WEB_UI_MAX_CAPACITY ? parseInt(WEB_UI_MAX_CAPACITY) : 10,
            },
        },
        customDomain: {
            enableCustomDomain: ENABLE_CUSTOM_DOMAIN === 'true',
            domainName: DOMAIN_NAME,
            certificateArn: CERTIFICATE_ARN,
            fallbackDomainName: FALLBACK_DOMAIN_NAME,
        },
        subscriptionEmails: SUBSCRIPTION_EMAILS ? SUBSCRIPTION_EMAILS.split(',') : [],
    };
};
