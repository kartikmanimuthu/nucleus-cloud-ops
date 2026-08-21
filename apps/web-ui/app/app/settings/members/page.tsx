import { redirect } from "next/navigation";

// Members moved to the new IAM nav section. Old URL kept working via redirect.
export default function SettingsMembersRedirect() {
  redirect("/app/iam/members");
}
