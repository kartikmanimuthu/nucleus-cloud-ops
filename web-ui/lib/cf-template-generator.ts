
export const generateOnboardingTemplate = (hubAccountId: string, externalId: string, accountId?: string, accountName?: string) => {
    // Shortened to satisfy AWS IAM 64-character limit
    const defaultRoleName = `NucleusAccess-${hubAccountId}`;

    return {
        AWSTemplateFormatVersion: "2010-09-09",
        Description: "Nucleus Platform - Cross Account Role for Cost Optimization Scheduler",
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
            }
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
                                            "kms:ReEncrypt"
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
                        }
                    ],
                    ManagedPolicyArns: [
                        "arn:aws:iam::aws:policy/ReadOnlyAccess",
                        "arn:aws:iam::aws:policy/AWSBillingReadOnlyAccess"
                    ]
                }
            }
        },
        Outputs: {
            RoleArn: {
                Description: "The ARN of the cross-account role",
                Value: { "Fn::GetAtt": ["NucleusCrossAccountRole", "Arn"] }
            }
        }
    };
};

export const generateOnboardingYaml = (hubAccountId: string, externalId: string, accountId?: string, accountName?: string) => {
    // Shortened to satisfy AWS IAM 64-character limit
    const defaultRoleName = `NucleusAccess-${hubAccountId}`;

    return `AWSTemplateFormatVersion: '2010-09-09'
Description: Nucleus Platform - Cross Account Role for Cost Optimization Scheduler
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
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/ReadOnlyAccess
        - arn:aws:iam::aws:policy/AWSBillingReadOnlyAccess
Outputs:
  RoleArn:
    Description: The ARN of the cross-account role
    Value: !GetAtt NucleusCrossAccountRole.Arn
`;
};
