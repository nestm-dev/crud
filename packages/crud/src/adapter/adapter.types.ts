import type { ExecutionContext } from "@nestjs/common";

import type { CrudOperationName } from "../resource/operations.ts";
import type { CrudOrder, CrudPredicate } from "../query/query.types.ts";

export type CrudValues = Readonly<Record<string, unknown>>;

export interface CrudAdapterCapabilities {
	readonly transactions: boolean;
	readonly returning: boolean;
	readonly compositeIds: boolean;
	readonly containsInsensitive: boolean;
	/** Whether this adapter implements the atomic upsert contract. */
	readonly upsert?: boolean;
}

export interface CrudAdapterSession {
	readonly adapter: symbol;
	readonly value: unknown;
}

export interface CrudAdapterContext {
	readonly resource: string;
	readonly operation: CrudOperationName;
	readonly executionContext?: ExecutionContext;
	readonly session?: CrudAdapterSession;
	/** Parsed collection-path parameters for a nested resource. */
	readonly pathParams?: CrudValues;
}

export interface CrudFindOneInput {
	readonly predicate: CrudPredicate;
	readonly order?: readonly CrudOrder[];
}

export interface CrudFindManyInput {
	readonly predicate?: CrudPredicate;
	readonly order: readonly CrudOrder[];
	readonly offset?: number;
	readonly limit: number;
	readonly count: boolean;
}

export interface CrudFindManyResult<RecordType> {
	readonly records: readonly RecordType[];
	readonly total?: number;
}

export interface CrudCreateInput<CreateValues extends object = CrudValues> {
	readonly values: CreateValues;
}

export interface CrudUpdateInput<UpdateValues extends object = CrudValues> {
	readonly predicate: CrudPredicate;
	readonly values: UpdateValues;
}

export interface CrudUpsertInput<CreateValues extends object = CrudValues> {
	/** Complete, non-empty adapter persistence paths forming the conflict target. */
	readonly conflictFields: readonly [string, ...string[]];
	/** Predicate that must still match when the conflict branch updates an existing row. */
	readonly predicate: CrudPredicate;
	/** One proposed insert row. Conflict updates copy only `overwriteFields` from this row. */
	readonly values: CreateValues;
	/** Non-empty adapter persistence paths copied from the proposed row on conflict. */
	readonly overwriteFields: readonly [string, ...string[]];
}

export interface CrudDeleteInput {
	readonly predicate: CrudPredicate;
}

export interface CrudAdapter<
	RecordType = unknown,
	CreateValues extends object = object,
	UpdateValues extends object = object,
> {
	readonly capabilities: CrudAdapterCapabilities;
	/**
	 * Runs work in a transaction and resolves only after the real commit succeeds.
	 * A mutation must not resolve after merely releasing a savepoint or joining an
	 * ambient transaction because CRUD emits `afterCommit` after this promise.
	 */
	transaction<Result>(
		work: (session: CrudAdapterSession) => Promise<Result>,
		context: CrudAdapterContext,
	): Promise<Result>;
	create(input: CrudCreateInput<CreateValues>, context: CrudAdapterContext): Promise<RecordType>;
	findOne(input: CrudFindOneInput, context: CrudAdapterContext): Promise<RecordType | null>;
	findMany(
		input: CrudFindManyInput,
		context: CrudAdapterContext,
	): Promise<CrudFindManyResult<RecordType>>;
	update(
		input: CrudUpdateInput<UpdateValues>,
		context: CrudAdapterContext,
	): Promise<RecordType | null>;
	/**
	 * Atomically inserts or updates one complete resource identity.
	 *
	 * Implementations advertising `capabilities.upsert` must apply `predicate` inside
	 * the conflict-update statement and return `null` when an existing row is not visible.
	 */
	upsert?(
		input: CrudUpsertInput<CreateValues>,
		context: CrudAdapterContext,
	): Promise<RecordType | null>;
	delete(input: CrudDeleteInput, context: CrudAdapterContext): Promise<RecordType | null>;
	getField(record: RecordType, field: string): unknown;
}

/** Adapter refinement for implementations certified for the atomic upsert contract. */
export interface CrudUpsertAdapter<
	RecordType = unknown,
	CreateValues extends object = object,
	UpdateValues extends object = object,
> extends CrudAdapter<RecordType, CreateValues, UpdateValues> {
	readonly capabilities: CrudAdapterCapabilities & { readonly upsert: true };
	upsert(
		input: CrudUpsertInput<CreateValues>,
		context: CrudAdapterContext,
	): Promise<RecordType | null>;
}

export type CrudAdapterFactory<
	RecordType = unknown,
	CreateValues extends object = object,
	UpdateValues extends object = object,
> = () =>
	| CrudAdapter<RecordType, CreateValues, UpdateValues>
	| Promise<CrudAdapter<RecordType, CreateValues, UpdateValues>>;
