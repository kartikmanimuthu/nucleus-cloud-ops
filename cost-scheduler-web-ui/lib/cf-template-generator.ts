
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
                                            "ecs:ListClusters",
                                            "ecs:ListServices",
                                            "ecs:DescribeServices",
                                            "ecs:UpdateService",
                                            "ecs:ListTagsForResource",
                                            "rds:ListTagsForResource",
                                            "autoscaling:DescribeAutoScalingGroups",
                                            "autoscaling:UpdateAutoScalingGroup"
                                        ],
                                        Resource: "*"
                                    }
                                ]
                            }
                        }
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
                  - ecs:ListClusters
                  - ecs:ListServices
                  - ecs:DescribeServices
                  - ecs:UpdateService
                  - ecs:ListTagsForResource
                  - rds:ListTagsForResource
                  - autoscaling:DescribeAutoScalingGroups
                  - autoscaling:UpdateAutoScalingGroup
                Resource: '*'
Outputs:
  RoleArn:
    Description: The ARN of the cross-account role
    Value: !GetAtt NucleusCrossAccountRole.Arn
`;
};
