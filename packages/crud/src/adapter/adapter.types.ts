import type { ExecutionContext } from "@nestjs/common";

import type { CrudOperationName } from "../resource/operations.ts";
import type { CrudOrder, CrudPredicate } from "../query/query.types.ts";

export type CrudValues = Readonly<Record<string, unknown>>;

export interface CrudAdapterCapabilities {
	readonly transactions: boolean;
	readonly returning: boolean;
	readonly compositeIds: boolean;
	readonly containsInsensitive: boolean;
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

export interface CrudDeleteInput {
	readonly predicate: CrudPredicate;
}

export interface CrudAdapter<
	RecordType = unknown,
	CreateValues extends object = object,
	UpdateValues extends object = object,
> {
	readonly capabilities: CrudAdapterCapabilities;
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
	delete(input: CrudDeleteInput, context: CrudAdapterContext): Promise<RecordType | null>;
	getField(record: RecordType, field: string): unknown;
}

export type CrudAdapterFactory<
	RecordType = unknown,
	CreateValues extends object = object,
	UpdateValues extends object = object,
> = () =>
	| CrudAdapter<RecordType, CreateValues, UpdateValues>
	| Promise<CrudAdapter<RecordType, CreateValues, UpdateValues>>;
