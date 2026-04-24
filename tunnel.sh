#!/bin/bash
AWS_PROFILE=STX-CLOUD-PLATFORM aws ssm start-session --target i-0495ea2b853ce6c8e --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters '{"host":["nucleus-cloud-ops-postgres.cxoucc8oef6b.ap-south-1.rds.amazonaws.com"],"portNumber":["5432"],"localPortNumber":["5432"]}' --region ap-south-1
