import os
from diagrams import Diagram, Cluster, Edge
from diagrams.aws.compute import Fargate, EC2
from diagrams.aws.database import Dynamodb
from diagrams.aws.storage import S3
from diagrams.aws.management import Cloudwatch, SystemsManager
from diagrams.aws.security import IAMRole
from diagrams.aws.ml import Bedrock
from diagrams.custom import Custom

# Ensure we are in the correct directory for output
os.chdir(os.path.dirname(os.path.abspath(__file__)))

# Create the detailed diagram for DevOps Agent Workflow
with Diagram("Nucleus Cloud Ops - DevOps Agent Architecture", show=False, filename="devops_agent_architecture", outformat="png", direction="TB"):
    
    with Cluster("AWS Account (Hub)"):
        with Cluster("AI Agent Execution Tier (ECS)"):
            langgraph = Fargate("LangGraph Engine")
            
            with Cluster("Agent Workflow Nodes"):
                planner = Custom("Planner Node", "./assets/gear.png") # Using standard icons or defaults if not found
                executor = Custom("Executor Node", "./assets/gear.png")
                reflector = Custom("Reflector Node", "./assets/gear.png")
                reviser = Custom("Reviser Node", "./assets/gear.png")
                
                with Cluster("Agent Skills & Tools"):
                    local_tools = Custom("Local Tools (AWS CLI)", "./assets/tools.png")
                    mcp_grafana = Custom("MCP Server (Grafana)", "./assets/tools.png")
                    mcp_k8s = Custom("MCP Server (Kubernetes)", "./assets/tools.png")
                    tools = [local_tools, mcp_grafana, mcp_k8s]

                planner >> executor
                executor >> tools
                local_tools >> reflector
                mcp_grafana >> reflector
                mcp_k8s >> reflector
                reflector >> reviser
                reviser >> executor
        
        with Cluster("Agent State & Storage"):
            ddb_checkpoints = Dynamodb("Checkpoints & Writes")
            ddb_conversations = Dynamodb("Agent Conversations")
            s3_temp = S3("Agent Temp Bucket")
            
        with Cluster("AI Models"):
            claude = Bedrock("Claude Sonnet")

        # Connections within Hub
        state_storage = [ddb_checkpoints, ddb_conversations, s3_temp]
        langgraph >> Edge(color="darkgreen", style="dashed", label="Invokes") >> claude
        langgraph >> Edge(color="blue", label="Persists & Offloads") >> state_storage

    with Cluster("AWS Account (Spoke / Target)"):
        target_role = IAMRole("Cross-Account Role")
        
        with Cluster("Target Resources"):
            ec2 = EC2("EC2 Instances")
            ssm = SystemsManager("Systems Manager")
            cloudwatch = Cloudwatch("CloudWatch Logs")
        
        target_role >> ec2
        target_role >> ssm
        target_role >> cloudwatch

    # Cross-Account Connection
    local_tools >> Edge(color="red", style="bold", label="sts:AssumeRole") >> target_role
