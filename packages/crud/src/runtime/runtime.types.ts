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

export interface CrudMutationEvent<Resource extends AnyCrudResource = AnyCrudResource> {
	readonly resource: Resource;
	readonly operation: Extract<CrudOperationName, "create" | "update" | "delete" | "restore">;
	readonly response?: CrudResponseInput<Resource>;
	readonly prior?: unknown;
	readonly executionContext?: ExecutionContext;
}

export interface CrudScopeResult {
	readonly predicate?: CrudPredicate;
	readonly createValues?: CrudValues;
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
