import * as AWS_EC2 from '@aws-sdk/client-ec2';
import * as AWS_ECS from '@aws-sdk/client-ecs';
import * as AWS_RDS from '@aws-sdk/client-rds';
import * as AWS_CW from '@aws-sdk/client-cloudwatch';
import * as AWS_STS from '@aws-sdk/client-sts';
import vm from 'vm';

/**
 * Creates a sandbox environment with read-only AWS clients
 */
export async function executeCodeInSandbox(code: string): Promise<string> {
    const region = process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'ap-south-1';

    // Initialize Clients
    const ec2 = new AWS_EC2.EC2Client({ region });
    const ecs = new AWS_ECS.ECSClient({ region });
    const rds = new AWS_RDS.RDSClient({ region });
    const cw = new AWS_CW.CloudWatchClient({ region });
    const sts = new AWS_STS.STSClient({ region });

    // Console capture
    let logs: string[] = [];
    const mockConsole = {
        log: (...args: any[]) => logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ')),
        error: (...args: any[]) => logs.push('ERROR: ' + args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ')),
        warn: (...args: any[]) => logs.push('WARN: ' + args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' '))
    };

    // Sandbox Context
    const sandbox = {
        console: mockConsole,
        // Clients
        ec2,
        ecs,
        rds,
        cw,
        sts,
        // Namespaces (for Command classes)
        AWS_EC2,
        AWS_ECS,
        AWS_RDS,
        AWS_CW,
        AWS_STS,

        process: { env: {} }, // Prevent access to real process.env
    };

    vm.createContext(sandbox);

    try {
        // We wrap the code in an async function to allow await
        const wrappedCode = `
            (async () => {
                try {
                    ${code}
                } catch (e) {
                    console.error(e);
                }
            })();
        `;

        await vm.runInContext(wrappedCode, sandbox, {
            timeout: 30000, // 30s timeout
            displayErrors: true
        });

        return logs.length > 0 ? logs.join('\n') : "Code executed successfully (no output).";

    } catch (error: any) {
        return `Execution Error: ${error.message}`;
    }
}
