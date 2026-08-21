import { redirect } from "next/navigation";

// Permissions screen removed from the UI. Old URL kept working via redirect.
export default function PermissionsRedirect() {
  redirect("/app/iam/roles");
}
