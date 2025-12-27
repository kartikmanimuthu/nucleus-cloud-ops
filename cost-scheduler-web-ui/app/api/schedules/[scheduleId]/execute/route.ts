import { NextRequest, NextResponse } from "next/server";
import { ScheduleService } from "@/lib/schedule-service";
import { AuditService } from "@/lib/audit-service";
import { ScheduleExecutionService } from "@/lib/schedule-execution-service";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

// Lambda function name from environment
const SCHEDULER_LAMBDA_NAME = process.env.SCHEDULER_LAMBDA_NAME || "cost-scheduler-lambda";
const AWS_REGION = process.env.AWS_REGION || "ap-south-1";

// Initialize Lambda client
const lambdaClient = new LambdaClient({ region: AWS_REGION });

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ scheduleId: string }> }
) {
    try {
        const { scheduleId } = await params;
        console.log(`[API] Execute Now triggered for schedule ${scheduleId}`);

        if (!scheduleId) {
            return NextResponse.json(
                { error: "Schedule ID is required" },
                { status: 400 }
            );
        }

        // 1. Fetch schedule to verify existence
        const schedule = await ScheduleService.getSchedule(scheduleId);
        if (!schedule) {
            console.log(`[API] Schedule ${scheduleId} not found`);
            return NextResponse.json(
                { error: "Schedule not found" },
                { status: 404 }
            );
        }

        const executionTime = new Date().toISOString();
        let lambdaResult = null;
        let executionStatus: 'success' | 'failed' | 'partial' = 'success';

        // 2. Try to invoke Lambda with schedule parameters
        try {
            const payload = {
                scheduleId: schedule.id,
                scheduleName: schedule.name,
                triggeredBy: 'web-ui',
            };

            console.log(`[API] Invoking Lambda ${SCHEDULER_LAMBDA_NAME} with payload:`, payload);

            const command = new InvokeCommand({
                FunctionName: SCHEDULER_LAMBDA_NAME,
                Payload: Buffer.from(JSON.stringify(payload)),
                InvocationType: 'RequestResponse', // Synchronous invocation
            });

            const response = await lambdaClient.send(command);

            if (response.Payload) {
                lambdaResult = JSON.parse(Buffer.from(response.Payload).toString());
                console.log(`[API] Lambda response:`, lambdaResult);

                if (lambdaResult.resourcesFailed > 0) {
                    executionStatus = 'partial';
                }
            }

            // Check for Lambda errors
            if (response.FunctionError) {
                console.error(`[API] Lambda function error:`, response.FunctionError);
                executionStatus = 'failed';
            }

        } catch (lambdaError: any) {
            console.error(`[API] Lambda invocation failed:`, lambdaError);

            // If Lambda invocation fails (e.g., in local dev), log execution locally
            console.log(`[API] Falling back to local execution tracking`);
            executionStatus = 'failed';

            // Log execution record for tracking (even on failure)
            try {
                await ScheduleExecutionService.logExecution({
                    tenantId: 'default',
                    accountId: (schedule.accounts && schedule.accounts[0]) || 'unknown',
                    scheduleId: schedule.id,
                    executionTime,
                    status: 'failed',
                    resourcesStarted: 0,
                    resourcesStopped: 0,
                    resourcesFailed: 0,
                    errorMessage: `Lambda invocation failed: ${lambdaError.message}`,
                    details: { triggeredBy: 'web-ui', error: String(lambdaError) }
                });
            } catch (logError) {
                console.error(`[API] Failed to log execution:`, logError);
            }
        }

        // 3. Update schedule metadata
        await ScheduleService.updateSchedule(schedule.id, {
            lastExecution: executionTime,
            executionCount: (schedule.executionCount || 0) + 1,
            active: true
        }, (schedule.accounts && schedule.accounts[0]) || 'unknown');

        // 4. Log Audit
        await AuditService.logResourceAction({
            action: "Execute Schedule",
            resourceType: "schedule",
            resourceId: schedule.id,
            resourceName: schedule.name,
            status: executionStatus === 'failed' ? 'error' : 'success',
            details: `Manual execution triggered via Dashboard. Status: ${executionStatus}`,
            user: "user", // TODO: Get actual user from session
            source: "web-ui"
        });

        return NextResponse.json({
            success: executionStatus !== 'failed',
            message: executionStatus === 'failed'
                ? "Execution failed - Lambda invocation error"
                : "Schedule execution triggered successfully",
            executionTime,
            executionStatus,
            lambdaResult
        });

    } catch (error: any) {
        console.error("[API] Error executing schedule:", error);
        return NextResponse.json(
            { error: error.message || "Failed to execute schedule" },
            { status: 500 }
        );
    }
}
