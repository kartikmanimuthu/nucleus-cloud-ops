import { redirect } from "next/navigation";

// Access Control's Roles tab moved into the new IAM nav section as a
// standalone page; Permissions and Modules were removed from the UI
// entirely. Old URL (and its ?tab= deep links) kept working via redirect.
export default function AccessControlRedirect() {
  redirect("/app/iam/roles");
}
