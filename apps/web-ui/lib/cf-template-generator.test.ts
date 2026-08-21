// web-ui/lib/cf-template-generator.test.ts
//
// This file exists because cf-template-generator.ts maintains the SAME CloudFormation
// document in two hand-written representations — a JS object and a YAML template literal.
// Two hand-maintained copies of one document is exactly the thing that silently diverges,
// and the failure mode is a customer with a half-deployed stack. These tests make a
// divergence a red CI run instead.
//
// The YAML is parsed with a deliberately small reader rather than a real YAML library,
// because CloudFormation short-form tags (!Ref, !GetAtt, !Sub, !Equals) are not valid
// plain YAML and js-yaml is not a dependency here. We assert on structure and on the
// presence/absence of specific keys, which is what the equivalence claim actually needs.
import { describe, it, expect } from 'vitest';
import {
    generateOnboardingTemplate,
    generateOnboardingYaml,
    ONBOARDING_TEMPLATE_VERSION,
} from './cf-template-generator';

const HUB = '044656767899';
const EXT = 'nucleus-testexternalid';
const BUS = 'arn:aws:events:ap-south-1:044656767899:event-bus/stx-nucleus-ops-sbx-spot-guard';

/** Top-level YAML keys that begin a section, used to slice the document. */
function yamlSection(yaml: string, section: string): string {
    const lines = yaml.split('\n');
    const start = lines.findIndex((l) => l === `${section}:`);
    if (start === -1) return '';
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
        if (/^[A-Za-z]/.test(lines[i])) {
            end = i;
            break;
        }
    }
    return lines.slice(start, end).join('\n');
}

/**
 * Second-level key names inside a section (two-space indent).
 *
 * Captures the name BEFORE the colon rather than stripping a trailing one, because a key
 * may carry its value inline — `Conditions:` holds
 * `SpotAutomationEnabled: !Equals [...]` on a single line, unlike `Resources:` where every
 * key is followed by a nested block.
 */
function yamlKeys(yaml: string, section: string): string[] {
    return yamlSection(yaml, section)
        .split('\n')
        .map((l) => /^ {2}([A-Za-z][A-Za-z0-9]*):/.exec(l)?.[1])
        .filter((k): k is string => Boolean(k));
}

const matrix = [
    { label: 'spot disabled, no accountId', opts: {}, args: [undefined, undefined] as const },
    { label: 'spot disabled, with accountId', opts: {}, args: ['111111111111', 'Acct'] as const },
    {
        label: 'spot enabled, no accountId',
        opts: { enableSpotAutomation: true, hubEventBusArn: BUS },
        args: [undefined, undefined] as const,
    },
    {
        label: 'spot enabled, with accountId',
        opts: { enableSpotAutomation: true, hubEventBusArn: BUS },
        args: ['111111111111', 'Acct'] as const,
    },
];

describe('JSON and YAML variants stay in lockstep', () => {
    for (const { label, opts, args } of matrix) {
        describe(label, () => {
            const json = generateOnboardingTemplate(HUB, EXT, args[0], args[1], opts);
            const yaml = generateOnboardingYaml(HUB, EXT, args[0], args[1], opts);

            it('declares the same Parameters', () => {
                expect(yamlKeys(yaml, 'Parameters').sort()).toEqual(Object.keys(json.Parameters).sort());
            });

            it('declares the same Resources', () => {
                expect(yamlKeys(yaml, 'Resources').sort()).toEqual(Object.keys(json.Resources).sort());
            });

            it('declares the same Outputs', () => {
                expect(yamlKeys(yaml, 'Outputs').sort()).toEqual(Object.keys(json.Outputs).sort());
            });

            it('declares the same Conditions', () => {
                expect(yamlKeys(yaml, 'Conditions').sort()).toEqual(Object.keys(json.Conditions).sort());
            });

            it('agrees on the EnableSpotAutomation default', () => {
                const expected = opts.enableSpotAutomation ? 'true' : 'false';
                expect(json.Parameters.EnableSpotAutomation.Default).toBe(expected);
                expect(yaml).toContain(`Default: '${expected}'`);
            });

            it('agrees on the template version', () => {
                expect(json.Metadata.NucleusTemplateVersion).toBe(String(ONBOARDING_TEMPLATE_VERSION));
                expect(yaml).toContain(`NucleusTemplateVersion: '${ONBOARDING_TEMPLATE_VERSION}'`);
            });
        });
    }
});

describe('the EnableSpotAutomation gate', () => {
    const off = generateOnboardingTemplate(HUB, EXT);
    const on = generateOnboardingTemplate(HUB, EXT, undefined, undefined, {
        enableSpotAutomation: true,
        hubEventBusArn: BUS,
    });

    it('defaults to false when no options are passed at all', () => {
        // The non-breaking guarantee: an existing customer redeploying with defaults must
        // not suddenly acquire new resources or permissions.
        expect(off.Parameters.EnableSpotAutomation.Default).toBe('false');
    });

    it('uses String + AllowedValues, since CloudFormation has no Boolean type', () => {
        // A bare String would accept 'True'/'yes'/'1' and then silently evaluate false in
        // Fn::Equals — the worst kind of failure, because the stack deploys "fine".
        expect(off.Parameters.EnableSpotAutomation.Type).toBe('String');
        expect(off.Parameters.EnableSpotAutomation.AllowedValues).toEqual(['true', 'false']);
    });

    it('declares all three Spot resources as CONDITIONAL, never unconditional', () => {
        for (const name of ['NucleusSpotAutomationPolicy', 'NucleusSpotForwardRole', 'NucleusSpotForwardRule'] as const) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect((on.Resources as any)[name].Condition).toBe('SpotAutomationEnabled');
        }
    });

    it('emits the Spot resources regardless of the flag, because CFN evaluates the Condition', () => {
        // Deliberate: the resources are always PRESENT in the template but gated by
        // Condition, which is how `true -> false` becomes a resource DELETE rather than a
        // template that no longer mentions them.
        expect(Object.keys(off.Resources)).toContain('NucleusSpotForwardRule');
    });

    it('leaves the shared cross-account role byte-identical whether the flag is on or off', () => {
        // THE non-breaking guarantee, asserted structurally. The Spot permissions live in
        // a standalone AWS::IAM::Policy precisely so this role — which the scheduler,
        // discovery, SSM and ACM features all depend on — is untouched.
        expect(JSON.stringify(off.Resources.NucleusCrossAccountRole)).toBe(
            JSON.stringify(on.Resources.NucleusCrossAccountRole),
        );
    });

    it('adds no new IAM action to the shared role', () => {
        const actions = JSON.stringify(off.Resources.NucleusCrossAccountRole.Properties.Policies);
        expect(actions).not.toContain('DeregisterTargets');
        expect(actions).not.toContain('ModifyTargetGroupAttributes');
    });

    it('puts exactly the two genuinely-new mutating actions in the standalone policy', () => {
        // Everything else Spot Guard needs is already covered: reads by the attached
        // ReadOnlyAccess managed policy, ecs:UpdateService by NucleusResourceSchedulerPolicy.
        const stmt = on.Resources.NucleusSpotAutomationPolicy.Properties.PolicyDocument.Statement[0];
        expect(stmt.Action).toEqual([
            'elasticloadbalancing:DeregisterTargets',
            'elasticloadbalancing:ModifyTargetGroupAttributes',
        ]);
    });

    it('attaches the standalone policy to the existing role by Ref', () => {
        // !Ref on an AWS::IAM::Role returns its NAME, which is what Roles expects, and
        // creates an implicit DependsOn.
        expect(on.Resources.NucleusSpotAutomationPolicy.Properties.Roles).toEqual([{ Ref: 'NucleusCrossAccountRole' }]);
    });
});

describe('the forwarding rule event pattern', () => {
    const on = generateOnboardingTemplate(HUB, EXT, undefined, undefined, {
        enableSpotAutomation: true,
        hubEventBusArn: BUS,
    });
    const pattern = on.Resources.NucleusSpotForwardRule.Properties.EventPattern;

    it('uses two $or branches, not one flat pattern', () => {
        // A blanket detail.capacityProviderName exists-filter would silently DROP every
        // placement-failure event, because those carry capacityProviderArns instead —
        // disabling the single most important behaviour while looking correct.
        expect(pattern.$or).toHaveLength(2);
    });

    it('filters task-state events on capacityProviderName AND lastStatus', () => {
        const branch = pattern.$or[0];
        expect(branch['detail-type']).toEqual(['ECS Task State Change']);
        expect(branch.detail.capacityProviderName).toEqual([{ exists: true }]);
        expect(branch.detail.lastStatus).toEqual(['RUNNING', 'STOPPED']);
    });

    it('matches placement failures on capacityProviderArns, NOT capacityProviderName', () => {
        const branch = pattern.$or[1];
        expect(branch.detail.eventName).toEqual(['SERVICE_TASK_PLACEMENT_FAILURE']);
        expect(branch.detail.capacityProviderArns).toEqual([{ exists: true }]);
        expect(branch.detail.capacityProviderName).toBeUndefined();
    });

    it('does NOT accept the test.aws.ecs source alias', () => {
        // The reference implementation allowed it for manual testing, which was a
        // synthetic-event injection surface.
        expect(pattern.source).toEqual(['aws.ecs']);
    });

    it('stays under the EventBridge 2048-character pattern limit', () => {
        expect(JSON.stringify(pattern).length).toBeLessThan(2048);
    });

    it('scopes the forward role to the single hub bus, never "*"', () => {
        const stmt =
            on.Resources.NucleusSpotForwardRole.Properties.Policies[0].PolicyDocument.Statement[0];
        expect(stmt.Action).toBe('events:PutEvents');
        expect(stmt.Resource).toEqual({ Ref: 'HubEventBusArn' });
    });

    it('takes the hub bus as a full ARN parameter, not a region-interpolated one', () => {
        // !Sub with ${AWS::Region} would resolve to the SPOKE's region, not the hub's —
        // silently wrong for any customer deploying outside the hub region.
        expect(on.Parameters.HubEventBusArn.Default).toBe(BUS);
        expect(JSON.stringify(on.Resources.NucleusSpotForwardRule)).not.toContain('AWS::Region');
    });
});

describe('template versioning', () => {
    const t = generateOnboardingTemplate(HUB, EXT);

    it('tags the role with the version so it is readable via iam:ListRoleTags', () => {
        // The load-bearing mechanism: ReadOnlyAccess already grants iam:List*, so Nucleus
        // can detect a stale stack in an already-onboarded account with zero new
        // permissions and zero customer action.
        const tags = t.Resources.NucleusCrossAccountRole.Properties.Tags;
        expect(tags).toEqual(
            expect.arrayContaining([
                { Key: 'nucleus:template-version', Value: String(ONBOARDING_TEMPLATE_VERSION) },
            ]),
        );
    });

    it('tags the role with the Spot flag, present even when disabled', () => {
        const tags = t.Resources.NucleusCrossAccountRole.Properties.Tags;
        expect(tags).toEqual(
            expect.arrayContaining([{ Key: 'nucleus:spot-automation', Value: { Ref: 'EnableSpotAutomation' } }]),
        );
    });

    it('exposes the version as an Output too', () => {
        expect(t.Outputs.TemplateVersion.Value).toBe(String(ONBOARDING_TEMPLATE_VERSION));
    });

    it('gates the Spot outputs on the condition rather than emitting empty ones', () => {
        expect(t.Outputs.SpotForwardRuleName.Condition).toBe('SpotAutomationEnabled');
        expect(t.Outputs.SpotForwardRoleArn.Condition).toBe('SpotAutomationEnabled');
    });
});

describe('backward compatibility of the signature', () => {
    it('still works with the original four positional arguments', () => {
        // The only importer is app/api/accounts/template/route.ts; the options object is
        // trailing and optional so existing call shapes compile and behave identically.
        expect(() => generateOnboardingTemplate(HUB, EXT, '111111111111', 'Name')).not.toThrow();
        expect(() => generateOnboardingYaml(HUB, EXT, '111111111111', 'Name')).not.toThrow();
    });

    it('keeps the v1 resource and the v1 output', () => {
        const t = generateOnboardingTemplate(HUB, EXT);
        expect(t.Resources.NucleusCrossAccountRole).toBeDefined();
        expect(t.Outputs.RoleArn).toBeDefined();
    });

    it('produces a deployable default bus ARN even with Spot off', () => {
        // The parameter must still have a syntactically valid default or the template
        // fails validation, even though nothing references it when the condition is false.
        expect(generateOnboardingTemplate(HUB, EXT).Parameters.HubEventBusArn.Default).toMatch(
            /^arn:aws:events:/,
        );
    });
});

describe('YAML escaping', () => {
    const yaml = generateOnboardingYaml(HUB, EXT, undefined, undefined, {
        enableSpotAutomation: true,
        hubEventBusArn: BUS,
    });

    it('emits CloudFormation !Sub interpolations unresolved', () => {
        // The YAML is a JS template literal, so every CFN ${...} needs \${...}. Getting
        // this wrong produces "NucleusSpotForward-" with the account silently missing.
        expect(yaml).toContain('!Sub \'NucleusSpotForward-${HubAccountId}\'');
        expect(yaml).not.toContain('NucleusSpotForward-\'');
    });

    it('leaves no unresolved JS template placeholders behind', () => {
        expect(yaml).not.toContain('[object Object]');
        expect(yaml).not.toContain('undefined');
    });
});
