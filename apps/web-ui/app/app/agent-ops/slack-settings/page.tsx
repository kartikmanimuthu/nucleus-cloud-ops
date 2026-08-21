import { redirect } from "next/navigation";

// Slack settings live under Channels, beside Telegram/Discord/Jira/Webhook.
// The duplicate under agent-ops meant one feature had two URLs and only one
// could be gated by the Channel subject. Old URL kept working via redirect.
export default function AgentOpsSlackSettingsRedirect() {
  redirect("/app/channels/slack-settings");
}
