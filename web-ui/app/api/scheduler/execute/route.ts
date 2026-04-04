import { NextResponse } from "next/server";
import { AuditService } from "@/lib/audit-service";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth-options";
import { authorize } from "@/lib/rbac/authorize";
import { getSessionTenantId } from "@/lib/auth-session";

// Lambda ARN from environment
const SCHEDULER_LAMBDA_ARN = process.env.SCHEDULER_LAMBDA_ARN || "";
const AWS_REGION = process.env.AWS_REGION || "ap-south-1";

// Initialize Lambda client
const lambdaClient = new LambdaClient({ region: AWS_REGION });

export async function POST() {
    // Check authorization - execute action on Schedule subject
    const authError = await authorize('execute', 'Schedule');
    if (authError) return authError;

    try {
        console.log(`[API] Execute Now (Full Scan) triggered`);

        // Get user session
        const session = await getServerSession(authOptions);
        const userEmail = session?.user?.email;
        const tenantId = await getSessionTenantId();

        const executionTime = new Date().toISOString();
        let executionStatus: 'success' | 'failed' | 'partial' = 'success';

        // Invoke Lambda for full scan (no scheduleId or scheduleName)
        try {
            const payload = {
                triggeredBy: 'web-ui',
                userEmail: userEmail || 'unknown-web-user',
            };

            console.log(`[API] Invoking Lambda ${SCHEDULER_LAMBDA_ARN} for full scan (Async) with payload:`, payload);

            const command = new InvokeCommand({
                FunctionName: SCHEDULER_LAMBDA_ARN,
                Payload: Buffer.from(JSON.stringify(payload)),
                InvocationType: 'Event', // Asynchronous invocation
            });

            await lambdaClient.send(command);

            // For async, we assume success if no error was thrown during invocation
            executionStatus = 'success';

        } catch (lambdaError) {
            console.error(`[API] Lambda invocation failed:`, lambdaError);
            executionStatus = 'failed';

            const errorMessage = lambdaError instanceof Error ? lambdaError.message : String(lambdaError);

            // Log audit entry for failure
            await AuditService.logUserAction({
                action: "Execute Full Scan",
                resourceType: "scheduler",
                resourceId: "full-scan",
                resourceName: "Scheduler Full Scan",
                status: 'error',
                details: `Manual full scan triggering failed: ${errorMessage}`,
                user: userEmail || "unknown-web-user",
                userType: "user",
                tenantId,
            });

            return NextResponse.json(
                {
                    success: false,
                    error: errorMessage,
                    message: "Lambda invocation failed"
                },
                { status: 500 }
            );
        }

        // Log successful audit entry (Triggered only)
        await AuditService.logUserAction({
            action: "Execute Full Scan",
            resourceType: "scheduler",
            resourceId: "full-scan",
            resourceName: "Scheduler Full Scan",
            status: 'success',
            details: `Manual full scan triggered via Dashboard (Async). Execution running in background.`,
            user: userEmail || "unknown-web-user",
            userType: "user",
            tenantId,
        });

        return NextResponse.json({
            success: true,
            message: "Full scan execution triggered successfully (Background)",
            executionTime,
            executionStatus: 'success',
            isAsync: true
        });

    } catch (error) {
        console.error("[API] Error executing full scan:", error);
        const errorMessage = error instanceof Error ? error.message : "Failed to execute full scan";
        return NextResponse.json(
            { error: errorMessage },
            { status: 500 }
        );
    }
}
