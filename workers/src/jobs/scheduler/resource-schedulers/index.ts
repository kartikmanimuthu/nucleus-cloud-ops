// Resource schedulers barrel export (ARN-driven)
export { processEC2Resource, extractEC2InstanceId, extractRegionFromArn as extractEC2Region } from './ec2-scheduler.js';
export { processRDSResource, extractRDSIdentifier, extractRegionFromArn as extractRDSRegion } from './rds-scheduler.js';
export { processECSResource, extractServiceName, extractClusterName, extractRegionFromArn as extractECSRegion } from './ecs-scheduler.js';
export { processASGResource, extractASGName, extractRegionFromArn as extractASGRegion } from './asg-scheduler.js';
export { processDocDBResource } from './docdb-scheduler.js';
