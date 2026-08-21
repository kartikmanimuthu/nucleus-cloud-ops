"use client";

import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Plus, Eye, Copy, Pencil, Trash2, Search, MoreHorizontal, Download, FileDown, FileCode, FileArchive, ChevronDown, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Gate, GatedButton, GatedDropdownItem } from "@/components/rbac/gated";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { DataTable } from "@/components/ui/data-table";
import { DataTableColumnHeader } from "@/components/ui/data-table-column-header";
import { useSkills, useDeleteSkill, useUpdateSkill } from "@/lib/queries/skills";
import { SkillFormDialog } from "./skill-form-dialog";
import { SkillDetailDialog } from "./skill-detail-dialog";
import type { SkillDTO } from "@/lib/client-skill-service";
import { ClientSkillService } from "@/lib/client-skill-service";
import { exportSkillToMarkdown, exportAllSkillsToMarkdown, exportSkillToFile, exportAllSkillsToZip } from "@/lib/skill-export";

function formatDate(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function SkillsClient() {
  const { data: skills, isLoading } = useSkills(true);
  const deleteSkill = useDeleteSkill();
  const updateSkill = useUpdateSkill();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<SkillDTO | null>(null);
  const [cloning, setCloning] = useState<SkillDTO | null>(null);
  const [viewOpen, setViewOpen] = useState(false);
  const [viewing, setViewing] = useState<SkillDTO | null>(null);
  const [search, setSearch] = useState("");
  const [exporting, setExporting] = useState(false);

  const openCreate = () => { setEditing(null); setCloning(null); setDialogOpen(true); };
  const openEdit = (s: SkillDTO) => { setEditing(s); setCloning(null); setDialogOpen(true); };
  const openClone = (s: SkillDTO) => { setEditing(null); setCloning(s); setDialogOpen(true); };
  const openView = (s: SkillDTO) => { setViewing(s); setViewOpen(true); };
  const onDelete = async (s: SkillDTO) => {
    if (!confirm(`Delete skill "${s.name}"?`)) return;
    try { await deleteSkill.mutateAsync(s.id); toast.success("Skill deleted", { description: s.name }); }
    catch (e) { toast.error("Delete failed", { description: e instanceof Error ? e.message : "Try again" }); }
  };
  const onToggleEnabled = async (s: SkillDTO, next: boolean) => {
    try {
      await updateSkill.mutateAsync({ id: s.id, input: { isEnabled: next } });
      toast.success(next ? "Skill enabled" : "Skill disabled", { description: s.name });
    } catch (e) {
      toast.error("Update failed", { description: e instanceof Error ? e.message : "Try again" });
    }
  };
  const onExportSkill = async (s: SkillDTO) => {
    try {
      // List DTOs omit content — fetch the full skill before exporting.
      const full = await ClientSkillService.getSkill(s.id);
      exportSkillToMarkdown(full);
      toast.success("Skill exported", { description: `${s.name}.md downloaded` });
    } catch (e) {
      toast.error("Export failed", { description: e instanceof Error ? e.message : "Try again" });
    }
  };
  const onExportSkillFile = async (s: SkillDTO) => {
    try {
      const full = await ClientSkillService.getSkill(s.id);
      exportSkillToFile(full);
      toast.success("SKILL.md exported", { description: `${s.id}.md downloaded` });
    } catch (e) {
      toast.error("Export failed", { description: e instanceof Error ? e.message : "Try again" });
    }
  };
  const fetchAllWithContent = async (): Promise<SkillDTO[] | null> => {
    const all = await ClientSkillService.listSkillsWithContent(true);
    if (all.length === 0) {
      toast.error("Nothing to export", { description: "No skills found." });
      return null;
    }
    return all;
  };
  const onExportAll = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const all = await fetchAllWithContent();
      if (!all) return;
      exportAllSkillsToMarkdown(all);
      toast.success("Skills exported", { description: `${all.length} skill(s) downloaded` });
    } catch (e) {
      toast.error("Export failed", { description: e instanceof Error ? e.message : "Try again" });
    } finally {
      setExporting(false);
    }
  };
  const onExportAllZip = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const all = await fetchAllWithContent();
      if (!all) return;
      await exportAllSkillsToZip(all);
      toast.success("Skills exported", { description: `${all.length} SKILL.md files zipped` });
    } catch (e) {
      toast.error("Export failed", { description: e instanceof Error ? e.message : "Try again" });
    } finally {
      setExporting(false);
    }
  };

  // Filter by search term (name / description / tier), then default-sort newest first.
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = (skills ?? []).filter((s) =>
      !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || s.tier.toLowerCase().includes(q)
    );
    return [...filtered].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [skills, search]);

  const columns = useMemo<ColumnDef<SkillDTO>[]>(() => [
    {
      accessorKey: "name",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
      cell: ({ row }) => {
        const s = row.original;
        return (
          <button type="button" onClick={() => openView(s)} className="text-left min-w-0 max-w-[420px]">
            <div className="font-medium truncate hover:underline">{s.name}</div>
            <div className="text-xs text-muted-foreground truncate">{s.description}</div>
          </button>
        );
      },
    },
    {
      accessorKey: "tier",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Tier" />,
      cell: ({ row }) => <Badge variant="outline">{row.original.tier}</Badge>,
    },
    {
      accessorKey: "source",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Source" />,
      cell: ({ row }) => {
        const s = row.original;
        return <Badge variant={s.source === "system" ? "secondary" : "default"}>{s.source === "system" ? "System" : "User"}</Badge>;
      },
    },
    {
      accessorKey: "isEnabled",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
      cell: ({ row }) => {
        const s = row.original;
        return (
          <Gate action="update" subject="Skill" data={s as unknown as Record<string, unknown>}>
            {({ allowed, reason }) => (
              <div className="flex items-center gap-2">
                <Switch
                  checked={s.isEnabled}
                  disabled={updateSkill.isPending || !allowed}
                  title={allowed ? undefined : (reason ?? undefined)}
                  onCheckedChange={(v) => onToggleEnabled(s, v)}
                  aria-label={s.isEnabled ? "Disable skill" : "Enable skill"}
                />
                <span className="text-xs text-muted-foreground w-14">{s.isEnabled ? "Enabled" : "Disabled"}</span>
              </div>
            )}
          </Gate>
        );
      },
    },
    {
      accessorKey: "createdAt",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Created" />,
      cell: ({ row }) => <span className="text-sm text-muted-foreground whitespace-nowrap">{formatDate(row.original.createdAt)}</span>,
      sortingFn: "datetime",
    },
    {
      id: "actions",
      header: () => <div className="text-right">Actions</div>,
      enableSorting: false,
      cell: ({ row }) => {
        const s = row.original;
        return (
          <div className="flex justify-end">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="h-8 w-8 p-0" aria-label="Open actions menu">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => openView(s)}><Eye className="mr-2 h-4 w-4" /> View</DropdownMenuItem>
                <GatedDropdownItem action="update" subject="Skill" data={s as unknown as Record<string, unknown>} onClick={() => openEdit(s)}><Pencil className="mr-2 h-4 w-4" /> Edit</GatedDropdownItem>
                {/* Clone WRITES a new skill, so it is gated on create, not on
                    update of the row it copies (mirrors schedules-table's Duplicate). */}
                <GatedDropdownItem action="create" subject="Skill" onClick={() => openClone(s)}><Copy className="mr-2 h-4 w-4" /> Clone</GatedDropdownItem>
                <DropdownMenuItem onClick={() => onExportSkill(s)}><FileDown className="mr-2 h-4 w-4" /> Export markdown</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onExportSkillFile(s)}><FileCode className="mr-2 h-4 w-4" /> Export SKILL.md</DropdownMenuItem>
                <DropdownMenuSeparator />
                <GatedDropdownItem action="delete" subject="Skill" data={s as unknown as Record<string, unknown>} onClick={() => onDelete(s)} className="text-destructive"><Trash2 className="mr-2 h-4 w-4" /> Delete</GatedDropdownItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      },
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [updateSkill.isPending]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Skills</h1>
          <p className="text-sm text-muted-foreground">Reusable agent skills for AI Ops and Agent Ops.</p>
        </div>
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" disabled={exporting || isLoading || rows.length === 0}>
                {exporting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Download className="w-4 h-4 mr-1" />}
                Export all
                <ChevronDown className="w-4 h-4 ml-1" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onExportAll}><FileDown className="mr-2 h-4 w-4" /> Markdown (one file)</DropdownMenuItem>
              <DropdownMenuItem onClick={onExportAllZip}><FileArchive className="mr-2 h-4 w-4" /> SKILL.md files (zip)</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <GatedButton action="create" subject="Skill" onClick={openCreate}><Plus className="w-4 h-4 mr-1" /> Create skill</GatedButton>
        </div>
      </div>

      <DataTable
        columns={columns}
        data={rows}
        loading={isLoading}
        enableFiltering={false}
        defaultPageSize={10}
        emptyMessage={search ? "No skills match your search." : "No skills yet. Create your first skill."}
        header={
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input placeholder="Search skills…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
          </div>
        }
      />

      <SkillFormDialog open={dialogOpen} onOpenChange={setDialogOpen} skill={editing} cloneFrom={cloning} />
      <SkillDetailDialog open={viewOpen} onOpenChange={setViewOpen} skill={viewing} onEdit={openEdit} />
    </div>
  );
}
