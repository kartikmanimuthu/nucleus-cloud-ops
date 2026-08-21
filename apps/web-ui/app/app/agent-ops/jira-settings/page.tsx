import { redirect } from "next/navigation";

// Same duplication as slack-settings. Canonical page is under Channels.
export default function AgentOpsJiraSettingsRedirect() {
  redirect("/app/channels/jira-settings");
}
