import { redirect } from "next/navigation";

// Roles moved into the new IAM nav section. Old URL kept working via redirect.
export default function RolesPage() {
  redirect("/app/iam/roles");
}
