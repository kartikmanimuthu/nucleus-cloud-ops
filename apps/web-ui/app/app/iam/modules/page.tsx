import { redirect } from "next/navigation";

// Modules screen removed from the UI. Old URL kept working via redirect.
export default function ModulesRedirect() {
  redirect("/app/iam/roles");
}
