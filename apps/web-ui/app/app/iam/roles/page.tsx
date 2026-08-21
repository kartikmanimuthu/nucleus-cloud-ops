import { Users } from "lucide-react"
import { PageHeader } from "@/components/shared/page-header"
import { RolesTab } from "@/components/settings/access-control/roles-tab"
import { requireAuth } from "@/components/auth/AuthorizePage"

export default async function RolesPage() {
  /**
   * Gated on its own submodule, `Role`, not on the IAM module. Inline rather
   * than in the parent layout because that layout also wraps Members, which
   * answers to a different subject — see the note in app/app/iam/layout.tsx.
   * This page is a server component, so the check needs no extra boundary.
   */
  await requireAuth("read", "Role")

  return (
    <div className="space-y-4">
      <PageHeader
        icon={Users}
        title="Roles"
        description="Bind permissions to roles."
      />
      <RolesTab />
    </div>
  )
}
