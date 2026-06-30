"use client";

import { useState } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { useSkills, useDeleteSkill } from "@/lib/queries/skills";
import { SkillFormDialog } from "./skill-form-dialog";
import type { SkillDTO } from "@/lib/client-skill-service";

export function SkillsClient() {
  const { data: skills, isLoading } = useSkills(true);
  const deleteSkill = useDeleteSkill();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<SkillDTO | null>(null);

  const openCreate = () => { setEditing(null); setDialogOpen(true); };
  const openEdit = (s: SkillDTO) => { setEditing(s); setDialogOpen(true); };
  const onDelete = async (s: SkillDTO) => {
    if (!confirm(`Delete skill "${s.name}"?`)) return;
    try { await deleteSkill.mutateAsync(s.id); toast.success("Skill deleted", { description: s.name }); }
    catch (e) { toast.error("Delete failed", { description: e instanceof Error ? e.message : "Try again" }); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Skills</h1>
          <p className="text-sm text-muted-foreground">Reusable agent skills for AI Ops and Agent Ops.</p>
        </div>
        <Button onClick={openCreate}><Plus className="w-4 h-4 mr-1" /> Create skill</Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : !skills?.length ? (
        <div className="text-center py-12 text-muted-foreground">No skills yet. Create your first skill.</div>
      ) : (
        <div className="border rounded-lg divide-y">
          {skills.map((s) => (
            <div key={s.id} className="flex items-center justify-between p-4 gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate">{s.name}</span>
                  <Badge variant="outline">{s.tier}</Badge>
                  <Badge variant={s.source === "system" ? "secondary" : "default"}>{s.source === "system" ? "System" : "User"}</Badge>
                  {!s.isEnabled && <Badge variant="outline" className="text-muted-foreground">Disabled</Badge>}
                </div>
                <p className="text-sm text-muted-foreground truncate">{s.description}</p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button variant="ghost" size="icon" onClick={() => openEdit(s)} title="Edit"><Pencil className="w-4 h-4" /></Button>
                <Button variant="ghost" size="icon" onClick={() => onDelete(s)} title="Delete" className="hover:text-destructive"><Trash2 className="w-4 h-4" /></Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <SkillFormDialog open={dialogOpen} onOpenChange={setDialogOpen} skill={editing} />
    </div>
  );
}
