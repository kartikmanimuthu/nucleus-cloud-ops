import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { getAuthSession } from "@/lib/auth-session";
import { redirect } from "next/navigation";

export default async function Dashboard() {
  const session = await getAuthSession();
  if (!session?.user) {
    redirect("/api/auth/signin");
  }
  return <DashboardShell />;
}
