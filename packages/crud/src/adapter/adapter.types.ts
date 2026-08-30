import type { ExecutionContext } from "@nestjs/common";

import type { CrudOperationName } from "../resource/operations.ts";
import type { CrudOrder, CrudPredicate } from "../query/query.types.ts";

export type CrudValues = Readonly<Record<string, unknown>>;

/** String property names exposed by a statically known persistence value shape. */
type CrudKnownPersistenceField<Values extends object> = Values extends unknown
	? Extract<keyof Values, string>
	: never;

export type CrudPersistenceField<Values extends object> = [
	CrudKnownPersistenceField<Values>,
] extends [never]
	? string
	: CrudKnownPersistenceField<Values>;

/** A readonly tuple containing at least one persistence field. */
export type CrudPersistenceFieldTuple<Field extends string = string> = readonly [Field, ...Field[]];

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

export interface CrudFindOneInput<QueryField extends string = string> {
	readonly predicate: CrudPredicate<QueryField>;
	readonly order?: readonly CrudOrder<QueryField>[];
}

export interface CrudFindManyInput<QueryField extends string = string> {
	readonly predicate?: CrudPredicate<QueryField>;
	readonly order: readonly CrudOrder<QueryField>[];
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

export interface CrudUpdateInput<
	UpdateValues extends object = CrudValues,
	QueryField extends string = string,
> {
	readonly predicate: CrudPredicate<QueryField>;
	readonly values: UpdateValues;
}

export interface CrudUpsertInput<
	CreateValues extends object = CrudValues,
	PersistenceField extends string = CrudPersistenceField<CreateValues>,
	QueryField extends string = string,
> {
	/** Complete, non-empty adapter persistence paths forming the conflict target. */
	readonly conflictFields: CrudPersistenceFieldTuple<PersistenceField>;
	/** Predicate that must still match when the conflict branch updates an existing row. */
	readonly predicate: CrudPredicate<QueryField>;
	/** One proposed insert row. Conflict updates copy only `overwriteFields` from this row. */
	readonly values: CreateValues;
	/** Non-empty adapter persistence paths copied from the proposed row on conflict. */
	readonly overwriteFields: CrudPersistenceFieldTuple<PersistenceField>;
}

export interface CrudDeleteInput<QueryField extends string = string> {
	readonly predicate: CrudPredicate<QueryField>;
}

export interface CrudAdapter<
	RecordType = unknown,
	CreateValues extends object = object,
	UpdateValues extends object = object,
	PersistenceField extends string = CrudPersistenceField<CreateValues>,
	QueryField extends string = string,
> {
	readonly capabilities: CrudAdapterCapabilities;
	/**
	 * Runs one complete read or mutation lifecycle in a transaction. It resolves only
	 * after the real commit succeeds. A mutation must not resolve after merely releasing
	 * a savepoint or joining an ambient transaction because CRUD emits `afterCommit`
	 * after this promise.
	 */
	transaction<Result>(
		work: (session: CrudAdapterSession) => Promise<Result>,
		context: CrudAdapterContext,
	): Promise<Result>;
	create(input: CrudCreateInput<CreateValues>, context: CrudAdapterContext): Promise<RecordType>;
	findOne(
		input: CrudFindOneInput<QueryField>,
		context: CrudAdapterContext,
	): Promise<RecordType | null>;
	findMany(
		input: CrudFindManyInput<QueryField>,
		context: CrudAdapterContext,
	): Promise<CrudFindManyResult<RecordType>>;
	update(
		input: CrudUpdateInput<UpdateValues, QueryField>,
		context: CrudAdapterContext,
	): Promise<RecordType | null>;
	/**
	 * Atomically inserts or updates one complete resource identity.
	 *
	 * Implementations advertising `capabilities.upsert` must apply `predicate` inside
	 * the conflict-update statement and return `null` when an existing row is not visible.
	 */
	upsert?(
		input: CrudUpsertInput<CreateValues, PersistenceField, QueryField>,
		context: CrudAdapterContext,
	): Promise<RecordType | null>;
	delete(
		input: CrudDeleteInput<QueryField>,
		context: CrudAdapterContext,
	): Promise<RecordType | null>;
	getField(record: RecordType, field: QueryField): unknown;
}

/** Logical query/order field vocabulary exposed by an adapter type. */
export type CrudAdapterQueryField<Adapter> =
	Adapter extends CrudAdapter<
		infer _RecordType,
		infer _CreateValues extends object,
		infer _UpdateValues extends object,
		infer _PersistenceField extends string,
		infer QueryField extends string
	>
		? QueryField
		: never;

/** Adapter refinement for implementations certified for the atomic upsert contract. */
export interface CrudUpsertAdapter<
	RecordType = unknown,
	CreateValues extends object = object,
	UpdateValues extends object = object,
	PersistenceField extends string = CrudPersistenceField<CreateValues>,
	QueryField extends string = string,
> extends CrudAdapter<RecordType, CreateValues, UpdateValues, PersistenceField, QueryField> {
	readonly capabilities: CrudAdapterCapabilities & { readonly upsert: true };
	upsert(
		input: CrudUpsertInput<CreateValues, PersistenceField, QueryField>,
		context: CrudAdapterContext,
	): Promise<RecordType | null>;
}

export type CrudAdapterFactory<
	RecordType = unknown,
	CreateValues extends object = object,
	UpdateValues extends object = object,
	PersistenceField extends string = CrudPersistenceField<CreateValues>,
	QueryField extends string = string,
> = () =>
	| CrudAdapter<RecordType, CreateValues, UpdateValues, PersistenceField, QueryField>
	| Promise<CrudAdapter<RecordType, CreateValues, UpdateValues, PersistenceField, QueryField>>;
