import { ChatInterface } from '@/components/agent/chat-interface';
import { Separator } from '@/components/ui/separator';

export default function AgentPage() {
    return (
        <div className="flex flex-col h-full gap-6 p-4 md:p-6 lg:p-8">
            <div className="space-y-0.5">
                <h1 className="text-2xl font-bold tracking-tight">AI DevOps Agent</h1>
                <p className="text-muted-foreground">
                    Your virtual assistant for troubleshooting and inspecting AWS resources.
                </p>
            </div>
            <Separator />
            <div className="flex-1 min-h-0">
                <ChatInterface />
            </div>
        </div>
    );
}
