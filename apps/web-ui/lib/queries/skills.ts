import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from './query-keys';
import { ClientSkillService, type SkillInput } from '@/lib/client-skill-service';

export function useSkills(all = true) {
    return useQuery({ queryKey: queryKeys.skills.list(all), queryFn: () => ClientSkillService.listSkills(all) });
}
export function useSkill(id: string | null) {
    return useQuery({ queryKey: queryKeys.skills.detail(id ?? ''), queryFn: () => ClientSkillService.getSkill(id as string), enabled: !!id });
}
export function useCreateSkill() {
    const qc = useQueryClient();
    return useMutation({ mutationFn: (input: SkillInput) => ClientSkillService.createSkill(input), onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.skills.all }) });
}
export function useUpdateSkill() {
    const qc = useQueryClient();
    return useMutation({ mutationFn: ({ id, input }: { id: string; input: Partial<SkillInput> }) => ClientSkillService.updateSkill(id, input), onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.skills.all }) });
}
export function useDeleteSkill() {
    const qc = useQueryClient();
    return useMutation({ mutationFn: (id: string) => ClientSkillService.deleteSkill(id), onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.skills.all }) });
}
export function useDistillSkill() {
    return useMutation({ mutationFn: ({ threadId, transcript }: { threadId: string; transcript: string }) => ClientSkillService.distill(threadId, transcript) });
}
