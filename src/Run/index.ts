import type * as run from "@distilled.cloud/gcp/run-v2";

export { Job, JobProvider } from "./Job.ts";
export type { JobAttributes, JobProps } from "./Job.ts";
export { jobIamMember, serviceIamMember } from "./IamMember.ts";
export type { RunIamBinding, RunIamBindingContract } from "./IamSync.ts";
export { Service, ServiceProvider } from "./Service.ts";
export type { ServiceAttributes, ServiceProps } from "./Service.ts";

/**
 * Clean aliases for the most commonly-used Cloud Run v2 SDK types,
 * re-exported from `@distilled.cloud/gcp/run-v2` so consumers don't
 * need to import from the underlying SDK directly. The aliases are
 * type-only — they share identity with the distilled types, so values
 * are interchangeable.
 *
 * The `GoogleCloudRunV2*` prefix on the SDK types is generated from
 * the GCP Discovery Document and is awkward to consume; these aliases
 * mirror the casing the GCP REST docs use ("RevisionTemplate",
 * "Container", "TrafficTarget"), which is what most users will
 * already have in their heads.
 *
 * @example
 * ```typescript
 * import * as GCP from "@microagi/alchemy-gcp";
 *
 * const template: GCP.RevisionTemplate = {
 *   containers: [{ image: "..." }],
 * };
 * ```
 */
export type RevisionTemplate = run.GoogleCloudRunV2RevisionTemplate;
export type ExecutionTemplate = run.GoogleCloudRunV2ExecutionTemplate;
export type TaskTemplate = run.GoogleCloudRunV2TaskTemplate;
export type Container = run.GoogleCloudRunV2Container;
export type ContainerPort = run.GoogleCloudRunV2ContainerPort;
export type EnvVar = run.GoogleCloudRunV2EnvVar;
export type EnvVarSource = run.GoogleCloudRunV2EnvVarSource;
export type ResourceRequirements = run.GoogleCloudRunV2ResourceRequirements;
export type Probe = run.GoogleCloudRunV2Probe;
export type VpcAccess = run.GoogleCloudRunV2VpcAccess;
export type NetworkInterface = run.GoogleCloudRunV2NetworkInterface;
export type NodeSelector = run.GoogleCloudRunV2NodeSelector;
export type TrafficTarget = run.GoogleCloudRunV2TrafficTarget;
export type TrafficTargetStatus = run.GoogleCloudRunV2TrafficTargetStatus;
export type ServiceScaling = run.GoogleCloudRunV2ServiceScaling;
export type BinaryAuthorization = run.GoogleCloudRunV2BinaryAuthorization;
export type Volume = run.GoogleCloudRunV2Volume;
export type VolumeMount = run.GoogleCloudRunV2VolumeMount;
export type Condition = run.GoogleCloudRunV2Condition;
export type ExecutionReference = run.GoogleCloudRunV2ExecutionReference;
export type SecretKeySelector = run.GoogleCloudRunV2SecretKeySelector;
