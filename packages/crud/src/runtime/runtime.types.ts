import type { ExecutionContext } from "@nestjs/common";

import type { CrudAdapterSession, CrudValues } from "../adapter/adapter.types.ts";
import type { CrudPredicate } from "../query/query.types.ts";
import type {
	AnyCrudResource,
	CrudCreate,
	CrudResponseInput,
	CrudUpdate,
} from "../resource/resource.types.ts";
import type { CrudOperationName } from "../resource/operations.ts";

export interface CrudOperationContext<Resource extends AnyCrudResource = AnyCrudResource> {
	readonly resource: Resource;
	readonly operation: CrudOperationName;
	readonly executionContext?: ExecutionContext;
	readonly session?: CrudAdapterSession;
	readonly prior?: unknown;
}

export interface CrudLifecycleHook<Resource extends AnyCrudResource = AnyCrudResource> {
	beforeCreate?(
		input: CrudCreate<Resource>,
		context: CrudOperationContext<Resource>,
	): CrudCreate<Resource> | Promise<CrudCreate<Resource>>;
	afterCreate?(record: unknown, context: CrudOperationContext<Resource>): void | Promise<void>;
	beforeUpdate?(
		input: CrudUpdate<Resource>,
		context: CrudOperationContext<Resource>,
	): CrudUpdate<Resource> | Promise<CrudUpdate<Resource>>;
	afterUpdate?(record: unknown, context: CrudOperationContext<Resource>): void | Promise<void>;
	beforeDelete?(context: CrudOperationContext<Resource>): void | Promise<void>;
	afterDelete?(record: unknown, context: CrudOperationContext<Resource>): void | Promise<void>;
	beforeRestore?(context: CrudOperationContext<Resource>): void | Promise<void>;
	afterRestore?(record: unknown, context: CrudOperationContext<Resource>): void | Promise<void>;
	afterCommit?(event: CrudMutationEvent<Resource>): void | Promise<void>;
}

/**
 * Resolves response fields that are not columns of the resource's own table.
 *
 * The motivating shape is an aggregate — `artifactCount` on a project, `memberCount` on an
 * organization — which an adapter cannot select without a join and a `groupBy`, and which is
 * therefore invisible to the persistence layer by design.
 *
 * `project` receives the WHOLE page at once and returns one entry per record, index-aligned with
 * `records`. Batching is the entire point: a per-record hook would issue one aggregate query per
 * row, which is the N+1 that made these resources not worth generating in the first place.
 *
 * Returning a shorter array, or one with holes, is a programming error — the missing indices
 * simply contribute nothing, and the response mapping sees `undefined` for those fields.
 *
 * @example
 * ```ts
 * @Injectable()
 * export class ProjectArtifactCounts implements CrudProjection {
 *   constructor(private readonly projects: ProjectsRepository) {}
 *
 *   async project(records: readonly ProjectRow[]) {
 *     const counts = await this.projects.countArtifactsByProject(records.map((r) => r.id));
 *     return records.map((record) => ({ artifactCount: counts.get(record.id) ?? 0 }));
 *   }
 * }
 * ```
 */
export interface CrudProjection<Resource extends AnyCrudResource = AnyCrudResource> {
	project(
		records: readonly unknown[],
		context: CrudOperationContext<Resource>,
	):
		| readonly Readonly<Record<string, unknown>>[]
		| Promise<readonly Readonly<Record<string, unknown>>[]>;
}

export interface CrudMutationEvent<Resource extends AnyCrudResource = AnyCrudResource> {
	readonly resource: Resource;
	readonly operation: Extract<CrudOperationName, "create" | "update" | "delete" | "restore">;
	readonly response?: CrudResponseInput<Resource>;
	readonly prior?: unknown;
	readonly executionContext?: ExecutionContext;
}

export interface CrudScopeResult {
	readonly predicate?: CrudPredicate;
	/** Logical persistence values applied only while creating a record. */
	readonly createValues?: CrudValues;
	/**
	 * Logical persistence values applied only to an explicit update operation.
	 * Unlike `createValues`, these values may overwrite API-mapped update fields.
	 */
	readonly updateValues?: CrudValues;
}

export interface CrudScope<Resource extends AnyCrudResource = AnyCrudResource> {
	resolve(context: CrudOperationContext<Resource>): CrudScopeResult | Promise<CrudScopeResult>;
}

export interface CrudAfterCommitErrorContext {
	readonly error: unknown;
	readonly hook: CrudLifecycleHook;
	readonly event: CrudMutationEvent;
}

export type CrudAfterCommitErrorHandler = (
	context: CrudAfterCommitErrorContext,
) => void | Promise<void>;
