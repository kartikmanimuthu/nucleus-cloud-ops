// Grouping by kind stops the UI from presenting relations as interchangeable rows.
export type RelationKind =
    | 'traffic'
    | 'reachability'
    | 'containment'
    | 'attachment'
    | 'observation'
    | 'other';

export const KIND_LABEL: Record<RelationKind, string> = {
    traffic: 'Serves traffic',
    reachability: 'Network reachability',
    containment: 'Runs in / contains',
    attachment: 'Attached / uses',
    observation: 'Observed by',
    other: 'Other',
};

const RELATION_KIND: Record<string, RelationKind> = {
    connects_to: 'traffic',
    routes_to_instance: 'traffic',
    attached_to_load_balancer: 'traffic',
    registers_with_target_group: 'traffic',
    origin_is: 'traffic',
    triggers: 'traffic',
    invokes: 'traffic',
    deploys_to: 'traffic',
    notifies_on_event: 'traffic',

    allows_ingress_from: 'reachability',
    allows_egress_to: 'reachability',
    peers_vpc: 'reachability',
    attached_to_tgw: 'reachability',
    attaches_vpc: 'reachability',

    in_vpc: 'containment',
    in_subnet: 'containment',
    in_cluster: 'containment',
    member_of_cluster: 'containment',
    has_member: 'containment',

    has_volume: 'attachment',
    has_network_interface: 'attachment',
    attached_to: 'attachment',
    uses_security_group: 'attachment',
    uses_instance_profile: 'attachment',
    uses_iam_role: 'attachment',
    encrypted_with: 'attachment',
    uses_certificate: 'attachment',
    reads_secret: 'attachment',
    sourced_from: 'attachment',
    stores_artifacts_in: 'attachment',
    runs_image_from: 'attachment',

    monitors: 'observation',
    notifies: 'observation',
};

// Falls back to 'other' for version skew — a deployed UI may read edges from a newer worker.
export function kindOf(relation: string): RelationKind {
    return RELATION_KIND[relation] ?? 'other';
}

const DEPENDENTS_ORDER: RelationKind[] = [
    'traffic', 'reachability', 'containment', 'attachment', 'observation', 'other',
];

const DEPENDS_ON_ORDER: RelationKind[] = [
    'containment', 'attachment', 'reachability', 'traffic', 'observation', 'other',
];

export function kindOrder(direction: 'dependents' | 'dependsOn'): RelationKind[] {
    return direction === 'dependents' ? DEPENDENTS_ORDER.slice() : DEPENDS_ON_ORDER.slice();
}
