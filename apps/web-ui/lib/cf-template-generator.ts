
/**
 * Version of the onboarding template contract.
 *
 * Bumped whenever the template gains resources or permissions a customer must redeploy
 * to receive. Emitted three ways — template Metadata, an Output, and (the load-bearing
 * one) TAGS on the cross-account role.
 *
 * The role tag is what makes the migration story work: iam:ListRoleTags is already
 * covered by the ReadOnlyAccess managed policy the role attaches, so Nucleus can read an
 * ALREADY-ONBOARDED customer's deployed version with zero new permissions and zero
 * action from them. Metadata and Outputs are only readable via CloudFormation APIs in
 * the customer's account, which we may not have.
 *
 * v2: added the optional Fargate Spot Guard resources (EnableSpotAutomation).
 */
export const ONBOARDING_TEMPLATE_VERSION = 2;

export interface OnboardingTemplateOptions {
    /**
     * Deploy the Spot Guard forwarding rule, forward role, and ALB pre-drain policy.
     * Defaults to FALSE, which is what makes v2 non-breaking: an existing customer who
     * redeploys with defaults gets a template whose only diff is two role tags.
     */
    enableSpotAutomation?: boolean;
    /** Hub Spot Guard event bus ARN (Pulumi output spotGuardBusArn). */
    hubEventBusArn?: string;
}

/**
 * Placeholder used when Spot automation is off, so the parameter still has a valid
 * default and the template remains deployable. Never targeted, because the rule that
 * would use it does not exist unless the condition is true.
 */
const NO_BUS_ARN = 'arn:aws:events:ap-south-1:000000000000:event-bus/not-configured';

export const generateOnboardingTemplate = (
    hubAccountId: string,
    externalId: string,
    accountId?: string,
    accountName?: string,
    opts: OnboardingTemplateOptions = {},
) => {
    // Shortened to satisfy AWS IAM 64-character limit
    const defaultRoleName = `NucleusAccess-${hubAccountId}`;
    const enableSpotAutomation = opts.enableSpotAutomation ?? false;
    const hubEventBusArn = opts.hubEventBusArn ?? NO_BUS_ARN;

    return {
        AWSTemplateFormatVersion: "2010-09-09",
        Description: "Nucleus Platform - Cross Account Role for Cost Optimization Scheduler",
        Metadata: {
            NucleusTemplateVersion: String(ONBOARDING_TEMPLATE_VERSION)
        },
        Parameters: {
            HubAccountId: {
                Type: "String",
                Description: "The AWS Account ID of the Nucleus Platform Hub",
                Default: hubAccountId
            },
            ExternalId: {
                Type: "String",
                Description: "External ID for secure role assumption",
                Default: externalId
            },
            RoleName: {
                Type: "String",
                Description: "The name of the cross-account role",
                Default: defaultRoleName
            },
            // A full ARN rather than a HubRegion + HubEventBusName pair, because !Sub with
            // ${AWS::Region} would resolve to the SPOKE's region, not the hub's — silently
            // wrong for any customer deploying outside the hub region.
            HubEventBusArn: {
                Type: "String",
                Description: "ARN of the Nucleus hub event bus that ECS Spot events are forwarded to",
                Default: hubEventBusArn
            },
            // CloudFormation has no Boolean parameter type. String + AllowedValues gives a
            // console dropdown and rejects 'True'/'yes'/'1', which a bare String would
            // accept and then silently evaluate as false in Fn::Equals.
            EnableSpotAutomation: {
                Type: "String",
                Description: "Set to 'true' to enable Nucleus Fargate Spot Guard: forwards ECS Spot events to Nucleus and grants ALB pre-drain permissions. Leave 'false' for no change to existing behaviour.",
                Default: enableSpotAutomation ? "true" : "false",
                AllowedValues: ["true", "false"]
            }
        },
        Conditions: {
            SpotAutomationEnabled: { "Fn::Equals": [{ "Ref": "EnableSpotAutomation" }, "true"] }
        },
        Resources: {
            NucleusCrossAccountRole: {
                Type: "AWS::IAM::Role",
                Properties: {
                    RoleName: { "Ref": "RoleName" },
                    AssumeRolePolicyDocument: {
                        Version: "2012-10-17",
                        Statement: [
                            {
                                Effect: "Allow",
                                Principal: {
                                    AWS: [
                                        { "Fn::Sub": "arn:aws:iam::${HubAccountId}:root" }
                                    ]
                                },
                                Action: "sts:AssumeRole",
                                Condition: {
                                    StringEquals: {
                                        "sts:ExternalId": { "Ref": "ExternalId" }
                                    }
                                }
                            }
                        ]
                    },
                    Policies: [
                        {
                            PolicyName: "NucleusResourceSchedulerPolicy",
                            PolicyDocument: {
                                Version: "2012-10-17",
                                Statement: [
                                    {
                                        Effect: "Allow",
                                        Action: [
                                            "ec2:DescribeInstances",
                                            "ec2:StartInstances",
                                            "ec2:StopInstances",
                                            "rds:DescribeDBInstances",
                                            "rds:StartDBInstance",
                                            "rds:StopDBInstance",
                                            "rds:StartDBCluster",
                                            "rds:StopDBCluster",
                                            "rds:DescribeDBClusters",
                                            "ecs:ListClusters",
                                            "ecs:ListServices",
                                            "ecs:DescribeServices",
                                            "ecs:UpdateService",
                                            "ecs:ListTagsForResource",
                                            "rds:ListTagsForResource",
                                            "autoscaling:DescribeAutoScalingGroups",
                                            "autoscaling:UpdateAutoScalingGroup",
                                            "kms:CreateGrant",
                                            "kms:Decrypt",
                                            "kms:DescribeKey",
                                            "kms:GenerateDataKeyWithoutPlainText",
                                            "kms:ReEncrypt",
                                            "kms:ListKeys",
                                            "kms:ListResourceTags"
                                        ],
                                        Resource: "*"
                                    }
                                ]
                            }
                        },
                        {
                            // SSM Session Manager & Run Command — allows AI agent to
                            // log into EC2 instances for live troubleshooting without SSH/bastion
                            PolicyName: "NucleusAgentSSMPolicy",
                            PolicyDocument: {
                                Version: "2012-10-17",
                                Statement: [
                                    {
                                        // Session Manager: start, resume, terminate interactive sessions
                                        Sid: "SSMSessionManager",
                                        Effect: "Allow",
                                        Action: [
                                            "ssm:StartSession",
                                            "ssm:ResumeSession",
                                            "ssm:TerminateSession",
                                            "ssm:DescribeSessions",
                                            "ssm:GetConnectionStatus"
                                        ],
                                        Resource: "*"
                                    },
                                    {
                                        // Run Command: execute diagnostic scripts remotely on EC2
                                        Sid: "SSMRunCommand",
                                        Effect: "Allow",
                                        Action: [
                                            "ssm:SendCommand",
                                            "ssm:GetCommandInvocation",
                                            "ssm:ListCommandInvocations",
                                            "ssm:ListCommands",
                                            "ssm:CancelCommand"
                                        ],
                                        Resource: "*"
                                    },
                                    {
                                        // SSM Inventory & Agent Health: check which instances
                                        // have the SSM agent installed and are reachable
                                        Sid: "SSMInventoryAndAgentHealth",
                                        Effect: "Allow",
                                        Action: [
                                            "ssm:DescribeInstanceInformation",
                                            "ssm:DescribeInstanceProperties",
                                            "ssm:DescribeInstancePatchStates",
                                            "ssm:ListInstanceAssociations",
                                            "ssm:DescribeAssociation",
                                            "ssm:GetDocument",
                                            "ssm:DescribeDocument",
                                            "ssm:ListDocuments",
                                            "ssm:ListAssociations"
                                        ],
                                        Resource: "*"
                                    },
                                    {
                                        // SSM Parameter Store: read-only access for config/secrets lookup
                                        Sid: "SSMParameterStoreReadOnly",
                                        Effect: "Allow",
                                        Action: [
                                            "ssm:GetParameter",
                                            "ssm:GetParameters",
                                            "ssm:GetParametersByPath",
                                            "ssm:DescribeParameters"
                                        ],
                                        Resource: "*"
                                    }
                                ]
                            }
                        },
                        {
                            // Certificate Manager — deploy (ImportCertificate, no ARN) and
                            // reimport/renew (ImportCertificate with the existing ARN) of TLS
                            // certificates into this account's ACM. Read actions are also covered
                            // by ReadOnlyAccess; listed here so the role is self-sufficient.
                            PolicyName: "NucleusCertificateManagerPolicy",
                            PolicyDocument: {
                                Version: "2012-10-17",
                                Statement: [
                                    {
                                        Sid: "ACMCertificateManagement",
                                        Effect: "Allow",
                                        Action: [
                                            "acm:ImportCertificate",
                                            "acm:DescribeCertificate",
                                            "acm:ListCertificates",
                                            "acm:GetCertificate",
                                            "acm:ListTagsForCertificate",
                                            "acm:AddTagsToCertificate"
                                        ],
                                        Resource: "*"
                                    }
                                ]
                            }
                        },
                        {
                            // Scaling Audit (SA-001) — read-only. Every action here is
                            // already covered by the attached ReadOnlyAccess managed
                            // policy; listed explicitly so a customer who strips
                            // ReadOnlyAccess still gets these reads, since a silently
                            // empty scaling-activity poll is indistinguishable from "no
                            // scaling happened" — the worst possible failure mode for a
                            // compliance record. NOT version-gated: purely additive
                            // defense-in-depth, so existing customers are not prompted
                            // to redeploy for it.
                            PolicyName: "NucleusScalingAuditPolicy",
                            PolicyDocument: {
                                Version: "2012-10-17",
                                Statement: [
                                    {
                                        Sid: "ScalingAuditReadOnly",
                                        Effect: "Allow",
                                        Action: [
                                            "autoscaling:DescribeScalingActivities",
                                            "autoscaling:DescribePolicies",
                                            "autoscaling:DescribeScheduledActions",
                                            "application-autoscaling:DescribeScalingActivities",
                                            "application-autoscaling:DescribeScalingPolicies",
                                            "application-autoscaling:DescribeScheduledActions",
                                            "application-autoscaling:DescribeScalableTargets",
                                            // Out-of-band capacity changes: a direct ecs:UpdateService
                                            // never reaches Application Auto Scaling, so CloudTrail is
                                            // the ONLY source for it (and the only source of the human
                                            // principal behind a manual ASG change). Reads Event
                                            // history — no trail required, no cost.
                                            "cloudtrail:LookupEvents"
                                        ],
                                        Resource: "*"
                                    }
                                ]
                            }
                        }
                    ],
                    ManagedPolicyArns: [
                        "arn:aws:iam::aws:policy/ReadOnlyAccess",
                        "arn:aws:iam::aws:policy/AWSBillingReadOnlyAccess"
                    ],
                    // Readable via iam:ListRoleTags, which ReadOnlyAccess above already
                    // grants — so Nucleus can detect a stale stack without the customer
                    // doing anything. Present unconditionally, including when Spot
                    // automation is off.
                    Tags: [
                        { Key: "nucleus:template-version", Value: String(ONBOARDING_TEMPLATE_VERSION) },
                        { Key: "nucleus:spot-automation", Value: { "Ref": "EnableSpotAutomation" } }
                    ]
                }
            },
            // ── Fargate Spot Guard (all three gated on SpotAutomationEnabled) ────────
            //
            // A STANDALONE AWS::IAM::Policy attached to the role, rather than an
            // Fn::If + AWS::NoValue entry inside the role's own Policies array. Four
            // reasons, in order of weight:
            //   1. With the flag off the resource simply does not exist, so
            //      NucleusCrossAccountRole is character-identical to v1 — provable by
            //      diffing the generated output, not by reasoning about intrinsic
            //      function semantics.
            //   2. AWS::NoValue is documented for removing a PROPERTY, not an individual
            //      list ELEMENT; inside IAM policy documents it is a known failure
            //      (cfn-lint E2507) because documents reach IAM after intrinsics resolve,
            //      and Policies sits right at that boundary.
            //   3. Flipping true -> false deletes a resource instead of rewriting a role
            //      that the scheduler, discovery, SSM and ACM features all depend on.
            //   4. !Ref on a role returns its NAME, which is exactly what Roles wants,
            //      and creates an implicit DependsOn.
            NucleusSpotAutomationPolicy: {
                Type: "AWS::IAM::Policy",
                Condition: "SpotAutomationEnabled",
                Properties: {
                    PolicyName: "NucleusSpotAutomationPolicy",
                    Roles: [{ "Ref": "NucleusCrossAccountRole" }],
                    PolicyDocument: {
                        Version: "2012-10-17",
                        Statement: [
                            {
                                // ONLY the two mutating actions are new. Everything Spot
                                // Guard READS is already covered by the attached
                                // ReadOnlyAccess managed policy (ecs:Describe*/List*,
                                // elasticloadbalancing:Describe*, events:Describe*/List*,
                                // iam:List*), and ecs:UpdateService is already granted by
                                // NucleusResourceSchedulerPolicy above — so it is
                                // deliberately NOT repeated here.
                                Sid: "SpotGuardAlbPreDrain",
                                Effect: "Allow",
                                Action: [
                                    "elasticloadbalancing:DeregisterTargets",
                                    "elasticloadbalancing:ModifyTargetGroupAttributes"
                                ],
                                Resource: "*"
                            }
                        ]
                    }
                }
            },
            NucleusSpotForwardRole: {
                Type: "AWS::IAM::Role",
                Condition: "SpotAutomationEnabled",
                Properties: {
                    RoleName: { "Fn::Sub": "NucleusSpotForward-${HubAccountId}" },
                    Description: "Allows EventBridge to forward ECS Spot events to the Nucleus hub event bus",
                    AssumeRolePolicyDocument: {
                        Version: "2012-10-17",
                        Statement: [
                            {
                                Effect: "Allow",
                                Principal: { Service: "events.amazonaws.com" },
                                Action: "sts:AssumeRole"
                            }
                        ]
                    },
                    Policies: [
                        {
                            PolicyName: "AllowPutEventsToNucleusHubBus",
                            PolicyDocument: {
                                Version: "2012-10-17",
                                Statement: [
                                    {
                                        Effect: "Allow",
                                        Action: "events:PutEvents",
                                        // Scoped to the single hub bus. The CDK predecessor's
                                        // forward role could PutEvents anywhere.
                                        Resource: { "Ref": "HubEventBusArn" }
                                    }
                                ]
                            }
                        }
                    ]
                }
            },
            NucleusSpotForwardRule: {
                Type: "AWS::Events::Rule",
                Condition: "SpotAutomationEnabled",
                Properties: {
                    // Deterministic name — this is what the Nucleus readiness probe calls
                    // events:DescribeRule on. Changing it requires a template version bump.
                    Name: { "Fn::Sub": "NucleusSpotForward-${HubAccountId}" },
                    Description: "Forward ECS Fargate Spot events to the Nucleus hub event bus",
                    State: "ENABLED",
                    // Two-branch $or, NOT a single flat pattern. A blanket
                    // detail.capacityProviderName exists-filter would silently DROP every
                    // placement-failure event, because those carry capacityProviderArns
                    // instead — disabling the most important behaviour while looking right.
                    // The filter is still worth having on the task-state branch: it excludes
                    // bare launchType:FARGATE services, which have no Spot to fall back
                    // from, and that is where most event volume lives.
                    // lastStatus is narrowed because ECS emits 6-8 task-state events per
                    // task lifecycle and the hours report needs exactly two. THE SENDING
                    // ACCOUNT PAYS for cross-account custom events, so this is the
                    // customer's bill, not ours.
                    EventPattern: {
                        source: ["aws.ecs"],
                        $or: [
                            {
                                "detail-type": ["ECS Task State Change"],
                                detail: {
                                    capacityProviderName: [{ exists: true }],
                                    lastStatus: ["RUNNING", "STOPPED"]
                                }
                            },
                            {
                                "detail-type": ["ECS Deployment State Change", "ECS Service Action"],
                                detail: {
                                    eventName: ["SERVICE_TASK_PLACEMENT_FAILURE"],
                                    capacityProviderArns: [{ exists: true }]
                                }
                            }
                        ]
                    },
                    Targets: [
                        {
                            Id: "NucleusHubBus",
                            Arn: { "Ref": "HubEventBusArn" },
                            RoleArn: { "Fn::GetAtt": ["NucleusSpotForwardRole", "Arn"] }
                        }
                    ]
                }
            }
        },
        Outputs: {
            RoleArn: {
                Description: "The ARN of the cross-account role",
                Value: { "Fn::GetAtt": ["NucleusCrossAccountRole", "Arn"] }
            },
            TemplateVersion: {
                Description: "Nucleus onboarding template version deployed in this account",
                Value: String(ONBOARDING_TEMPLATE_VERSION)
            },
            SpotForwardRuleName: {
                Condition: "SpotAutomationEnabled",
                Description: "Name of the EventBridge rule forwarding ECS Spot events to Nucleus",
                Value: { "Ref": "NucleusSpotForwardRule" }
            },
            SpotForwardRoleArn: {
                Condition: "SpotAutomationEnabled",
                Description: "ARN of the EventBridge forward role",
                Value: { "Fn::GetAtt": ["NucleusSpotForwardRole", "Arn"] }
            }
        }
    };
};

export const generateOnboardingYaml = (
    hubAccountId: string,
    externalId: string,
    accountId?: string,
    accountName?: string,
    opts: OnboardingTemplateOptions = {},
) => {
    // Shortened to satisfy AWS IAM 64-character limit
    const defaultRoleName = `NucleusAccess-${hubAccountId}`;
    const enableSpotAutomation = opts.enableSpotAutomation ?? false;
    const hubEventBusArn = opts.hubEventBusArn ?? NO_BUS_ARN;

    // NOTE: this is a JS template literal, so every CloudFormation ${...} must be
    // escaped as \${...} — see the existing !Sub on the trust policy below. This is the
    // single likeliest place for the YAML variant to silently diverge from the JSON one,
    // which is exactly what cf-template-generator.test.ts guards against.
    return `AWSTemplateFormatVersion: '2010-09-09'
Description: Nucleus Platform - Cross Account Role for Cost Optimization Scheduler
Metadata:
  NucleusTemplateVersion: '${ONBOARDING_TEMPLATE_VERSION}'
Parameters:
  HubAccountId:
    Type: String
    Description: The AWS Account ID of the Nucleus Platform Hub
    Default: '${hubAccountId}'
  ExternalId:
    Type: String
    Description: External ID for secure role assumption
    Default: '${externalId}'
  RoleName:
    Type: String
    Description: The name of the cross-account role
    Default: '${defaultRoleName}'
  HubEventBusArn:
    Type: String
    Description: ARN of the Nucleus hub event bus that ECS Spot events are forwarded to
    Default: '${hubEventBusArn}'
  EnableSpotAutomation:
    Type: String
    Description: Set to 'true' to enable Nucleus Fargate Spot Guard. Leave 'false' for no change to existing behaviour.
    Default: '${enableSpotAutomation ? 'true' : 'false'}'
    AllowedValues:
      - 'true'
      - 'false'
Conditions:
  SpotAutomationEnabled: !Equals [!Ref EnableSpotAutomation, 'true']
Resources:
  NucleusCrossAccountRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: !Ref RoleName
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              AWS:
                - !Sub 'arn:aws:iam::\${HubAccountId}:root'
            Action: sts:AssumeRole
            Condition:
              StringEquals:
                sts:ExternalId: !Ref ExternalId
      Policies:
        - PolicyName: NucleusResourceSchedulerPolicy
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Effect: Allow
                Action:
                  - ec2:DescribeInstances
                  - ec2:StartInstances
                  - ec2:StopInstances
                  - rds:DescribeDBInstances
                  - rds:StartDBInstance
                  - rds:StopDBInstance
                  - rds:StartDBCluster
                  - rds:StopDBCluster
                  - rds:DescribeDBClusters
                  - ecs:ListClusters
                  - ecs:ListServices
                  - ecs:DescribeServices
                  - ecs:UpdateService
                  - ecs:ListTagsForResource
                  - rds:ListTagsForResource
                  - autoscaling:DescribeAutoScalingGroups
                  - autoscaling:UpdateAutoScalingGroup
                  - kms:CreateGrant
                  - kms:Decrypt
                  - kms:DescribeKey
                  - kms:GenerateDataKeyWithoutPlainText
                  - kms:ReEncrypt
                  - kms:ListKeys
                  - kms:ListResourceTags
                Resource: '*'
        # SSM Session Manager & Run Command — allows AI agent to
        # log into EC2 instances for live troubleshooting without SSH/bastion
        - PolicyName: NucleusAgentSSMPolicy
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              # Session Manager: start, resume, terminate interactive sessions
              - Sid: SSMSessionManager
                Effect: Allow
                Action:
                  - ssm:StartSession
                  - ssm:ResumeSession
                  - ssm:TerminateSession
                  - ssm:DescribeSessions
                  - ssm:GetConnectionStatus
                Resource: '*'
              # Run Command: execute diagnostic scripts remotely on EC2
              - Sid: SSMRunCommand
                Effect: Allow
                Action:
                  - ssm:SendCommand
                  - ssm:GetCommandInvocation
                  - ssm:ListCommandInvocations
                  - ssm:ListCommands
                  - ssm:CancelCommand
                Resource: '*'
              # SSM Inventory & Agent Health: check which instances
              # have the SSM agent installed and are reachable
              - Sid: SSMInventoryAndAgentHealth
                Effect: Allow
                Action:
                  - ssm:DescribeInstanceInformation
                  - ssm:DescribeInstanceProperties
                  - ssm:DescribeInstancePatchStates
                  - ssm:ListInstanceAssociations
                  - ssm:DescribeAssociation
                  - ssm:GetDocument
                  - ssm:DescribeDocument
                  - ssm:ListDocuments
                  - ssm:ListAssociations
                Resource: '*'
              # SSM Parameter Store: read-only access for config/secrets lookup
              - Sid: SSMParameterStoreReadOnly
                Effect: Allow
                Action:
                  - ssm:GetParameter
                  - ssm:GetParameters
                  - ssm:GetParametersByPath
                  - ssm:DescribeParameters
                Resource: '*'
        # Certificate Manager — deploy (ImportCertificate, no ARN) and reimport/renew
        # (ImportCertificate with the existing ARN) of TLS certificates into this account's ACM.
        - PolicyName: NucleusCertificateManagerPolicy
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Sid: ACMCertificateManagement
                Effect: Allow
                Action:
                  - acm:ImportCertificate
                  - acm:DescribeCertificate
                  - acm:ListCertificates
                  - acm:GetCertificate
                  - acm:ListTagsForCertificate
                  - acm:AddTagsToCertificate
                Resource: '*'
        # Scaling Audit (SA-001) — read-only. Already covered by ReadOnlyAccess
        # below; listed explicitly so a customer who strips ReadOnlyAccess still
        # gets these reads, since a silently empty scaling-activity poll is
        # indistinguishable from "no scaling happened". NOT version-gated: purely
        # additive defense-in-depth, so existing customers are not prompted to
        # redeploy for it.
        - PolicyName: NucleusScalingAuditPolicy
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Sid: ScalingAuditReadOnly
                Effect: Allow
                Action:
                  - autoscaling:DescribeScalingActivities
                  - autoscaling:DescribePolicies
                  - autoscaling:DescribeScheduledActions
                  - application-autoscaling:DescribeScalingActivities
                  - application-autoscaling:DescribeScalingPolicies
                  - application-autoscaling:DescribeScheduledActions
                  - application-autoscaling:DescribeScalableTargets
                  # Out-of-band capacity changes: a direct ecs:UpdateService never
                  # reaches Application Auto Scaling, so CloudTrail is the ONLY
                  # source for it (and for the human principal behind a manual ASG
                  # change). Reads Event history — no trail required, no cost.
                  - cloudtrail:LookupEvents
                Resource: '*'
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/ReadOnlyAccess
        - arn:aws:iam::aws:policy/AWSBillingReadOnlyAccess
      # Readable via iam:ListRoleTags, already granted by ReadOnlyAccess above, so
      # Nucleus can detect a stale stack with no action from the customer. Present
      # unconditionally, including when Spot automation is off.
      Tags:
        - Key: nucleus:template-version
          Value: '${ONBOARDING_TEMPLATE_VERSION}'
        - Key: nucleus:spot-automation
          Value: !Ref EnableSpotAutomation

  # ── Fargate Spot Guard (all three gated on SpotAutomationEnabled) ──────────
  #
  # A standalone AWS::IAM::Policy rather than an Fn::If + AWS::NoValue entry inside
  # the role's own Policies array: with the flag off the resource simply does not
  # exist, so NucleusCrossAccountRole is character-identical to v1. AWS::NoValue is
  # documented for removing a property, not a list element, and inside IAM policy
  # documents it is a known failure (cfn-lint E2507).
  NucleusSpotAutomationPolicy:
    Type: AWS::IAM::Policy
    Condition: SpotAutomationEnabled
    Properties:
      PolicyName: NucleusSpotAutomationPolicy
      Roles:
        - !Ref NucleusCrossAccountRole
      PolicyDocument:
        Version: '2012-10-17'
        Statement:
          # ONLY the two mutating actions are new. Every Spot Guard read is already
          # covered by the attached ReadOnlyAccess managed policy, and
          # ecs:UpdateService is already granted by NucleusResourceSchedulerPolicy.
          - Sid: SpotGuardAlbPreDrain
            Effect: Allow
            Action:
              - elasticloadbalancing:DeregisterTargets
              - elasticloadbalancing:ModifyTargetGroupAttributes
            Resource: '*'

  NucleusSpotForwardRole:
    Type: AWS::IAM::Role
    Condition: SpotAutomationEnabled
    Properties:
      RoleName: !Sub 'NucleusSpotForward-\${HubAccountId}'
      Description: Allows EventBridge to forward ECS Spot events to the Nucleus hub event bus
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: events.amazonaws.com
            Action: sts:AssumeRole
      Policies:
        - PolicyName: AllowPutEventsToNucleusHubBus
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Effect: Allow
                Action: events:PutEvents
                # Scoped to the single hub bus, not '*'.
                Resource: !Ref HubEventBusArn

  NucleusSpotForwardRule:
    Type: AWS::Events::Rule
    Condition: SpotAutomationEnabled
    Properties:
      # Deterministic name — the Nucleus readiness probe calls events:DescribeRule on
      # exactly this. Changing it requires a template version bump.
      Name: !Sub 'NucleusSpotForward-\${HubAccountId}'
      Description: Forward ECS Fargate Spot events to the Nucleus hub event bus
      State: ENABLED
      # Two-branch $or, NOT a flat pattern: a blanket capacityProviderName exists-filter
      # would silently drop every placement-failure event (those carry
      # capacityProviderArns instead). lastStatus is narrowed because ECS emits 6-8
      # task-state events per lifecycle and the report needs two — and the SENDING
      # account pays for cross-account custom events.
      EventPattern:
        source:
          - aws.ecs
        $or:
          - detail-type:
              - ECS Task State Change
            detail:
              capacityProviderName:
                - exists: true
              lastStatus:
                - RUNNING
                - STOPPED
          - detail-type:
              - ECS Deployment State Change
              - ECS Service Action
            detail:
              eventName:
                - SERVICE_TASK_PLACEMENT_FAILURE
              capacityProviderArns:
                - exists: true
      Targets:
        - Id: NucleusHubBus
          Arn: !Ref HubEventBusArn
          RoleArn: !GetAtt NucleusSpotForwardRole.Arn
Outputs:
  RoleArn:
    Description: The ARN of the cross-account role
    Value: !GetAtt NucleusCrossAccountRole.Arn
  TemplateVersion:
    Description: Nucleus onboarding template version deployed in this account
    Value: '${ONBOARDING_TEMPLATE_VERSION}'
  SpotForwardRuleName:
    Condition: SpotAutomationEnabled
    Description: Name of the EventBridge rule forwarding ECS Spot events to Nucleus
    Value: !Ref NucleusSpotForwardRule
  SpotForwardRoleArn:
    Condition: SpotAutomationEnabled
    Description: ARN of the EventBridge forward role
    Value: !GetAtt NucleusSpotForwardRole.Arn
`;
};
