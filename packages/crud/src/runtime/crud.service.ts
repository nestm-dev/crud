import {
	BadRequestException,
	ConflictException,
	HttpException,
	InternalServerErrorException,
	NotFoundException,
	UnprocessableEntityException,
	type ExecutionContext,
} from "@nestjs/common";

import { isCrudAdapterError } from "../adapter/adapter.error.ts";
import type { CrudAdapter, CrudAdapterContext } from "../adapter/adapter.types.ts";
import type { CrudResourceBinding, CrudScopeCreateField } from "../adapter/binding.types.ts";
import type { CrudCursorCodec } from "../cursor/cursor.types.ts";
import type { ResolvedCrudModuleOptions } from "../module/crud-module.options.ts";
import { andCrudPredicates, orCrudPredicates } from "../query/predicate.ts";
import { parseCrudListQuery } from "../query/query-parser.ts";
import type { CrudListQuery, CrudPage, CrudPredicate, CrudRawQuery } from "../query/query.types.ts";
import type { CrudRelationConfig } from "../relation/relation.types.ts";
import type {
	AnyCrudResource,
	CrudCreate,
	CrudId,
	CrudResponseInput,
	CrudUpdate,
} from "../resource/resource.types.ts";
import type { CrudOperationName } from "../resource/operations.ts";
import type {
	CrudLifecycleHook,
	CrudMutationEvent,
	CrudOperationContext,
	CrudProjection,
	CrudScope,
	CrudScopeResult,
} from "./runtime.types.ts";
import type { CrudRegistry } from "./crud-registry.ts";

type MutationName = Extract<CrudOperationName, "create" | "update" | "delete" | "restore">;

interface MutationResult<Resource extends AnyCrudResource> {
	readonly response?: CrudResponseInput<Resource>;
	readonly prior?: unknown;
}

interface RelationReadOptions {
	readonly fields: readonly string[];
	readonly tuples: readonly (readonly unknown[])[];
	readonly executionContext?: ExecutionContext;
	readonly limit: number;
}

/**
 * ORM-neutral CRUD orchestration. Generated and custom controllers share this
 * class, so authorization scopes and transactional hooks cannot be bypassed.
 */
export class CrudService<
	Resource extends AnyCrudResource = AnyCrudResource,
	RecordType = unknown,
	CreateValues extends object = object,
	UpdateValues extends object = object,
	ScopeCreateField extends CrudScopeCreateField<CreateValues, UpdateValues> = never,
> {
	readonly resource: Resource;

	constructor(
		resource: Resource,
		readonly binding: CrudResourceBinding<
			Resource,
			RecordType,
			readonly string[],
			CreateValues,
			UpdateValues,
			ScopeCreateField
		>,
		readonly adapter: CrudAdapter<RecordType, CreateValues, UpdateValues>,
		readonly hooks: readonly CrudLifecycleHook<Resource>[],
		readonly scopes: readonly CrudScope<Resource>[],
		readonly registry: CrudRegistry,
		readonly options: ResolvedCrudModuleOptions,
		readonly cursorCodec?: CrudCursorCodec,
		readonly projections: readonly CrudProjection<Resource>[] = [],
	) {
		this.resource = resource;
		this.assertCapabilities();
	}

	async create(
		input: CrudCreate<Resource>,
		executionContext?: ExecutionContext,
	): Promise<CrudResponseInput<Resource>> {
		let committed: MutationResult<Resource> | undefined;
		const result = await this.runAdapter(async () =>
			this.adapter.transaction(
				async (session) => {
					const context = this.operationContext("create", executionContext, session);
					const scope = await this.resolveScopes(context);
					let value = input;
					for (const hook of this.hooks) {
						if (hook.beforeCreate !== undefined) {
							value = await hook.beforeCreate(value, context);
						}
					}
					const mapped = await this.binding.mappings.create(value);
					const scoped =
						this.binding.mappings.scopeCreate === undefined
							? await this.binding.mappings.persistence(scope.createValues ?? {})
							: await this.binding.mappings.scopeCreate(scope.createValues ?? {});
					this.assertScopeCreateFields(scoped);
					// The runtime assertion above establishes the generic Pick that TypeScript cannot
					// normalize back into an arbitrary adapter-defined CreateValues subtype.
					const values = { ...mapped, ...scoped } as CreateValues;
					const record = await this.adapter.create({ values }, this.adapterContext(context));
					for (const hook of this.hooks) {
						await hook.afterCreate?.(record, context);
					}
					const response = await this.mapRecord(record, {}, context);
					committed = { response };
					return response;
				},
				this.adapterContext(this.operationContext("create", executionContext)),
			),
		);
		await this.emitAfterCommit("create", committed, executionContext);
		return result;
	}

	async list(
		rawQuery: CrudRawQuery,
		executionContext?: ExecutionContext,
	): Promise<CrudPage<CrudResponseInput<Resource>>> {
		const query = await parseCrudListQuery(this.resource, rawQuery, {
			...(this.cursorCodec === undefined ? {} : { cursorCodec: this.cursorCodec }),
			defaultLimit: this.options.pagination.defaultLimit,
			maxLimit: this.options.pagination.maxLimit,
		});
		const context = this.operationContext("list", executionContext);
		const scope = await this.resolveScopes(context);
		const predicate = andCrudPredicates(
			query.predicate,
			this.searchPredicate(query.search),
			this.deletedPredicate(query),
			scope.predicate,
		);
		const result = await this.runAdapter(() =>
			this.adapter.findMany(
				{
					...(predicate === undefined ? {} : { predicate }),
					order: query.order,
					...(query.mode === "offset" ? { offset: (query.page - 1) * query.limit } : {}),
					limit: query.mode === "cursor" ? query.limit + 1 : query.limit,
					count: query.mode === "offset",
				},
				this.adapterContext(context),
			),
		);

		const hasNextPage = query.mode === "cursor" && result.records.length > query.limit;
		const records = hasNextPage ? result.records.slice(0, query.limit) : result.records;
		const relationMaps = await this.loadRelations(records, query.includes, executionContext);
		const projected = await this.projectRecords(records, context);
		const data = await Promise.all(
			records.map((record, index) =>
				this.mapRecord(record, relationMaps[index] ?? {}, context, projected?.[index]),
			),
		);

		if (query.mode === "offset") {
			if (result.total === undefined) {
				throw new InternalServerErrorException(
					"Persistence adapter omitted the total for a counted CRUD query.",
				);
			}
			const total = result.total;
			if (!Number.isSafeInteger(total) || total < 0) {
				throw new InternalServerErrorException(
					"Persistence adapter returned an invalid total for a counted CRUD query.",
				);
			}
			const totalPages = Math.ceil(total / query.limit);
			return {
				data,
				meta: {
					mode: "offset",
					page: query.page,
					limit: query.limit,
					total,
					totalPages,
					hasNextPage: query.page < totalPages,
					hasPreviousPage: query.page > 1,
				},
			};
		}

		const last = records.at(-1);
		const nextCursor =
			hasNextPage && last !== undefined && this.cursorCodec !== undefined
				? await this.encodeNextCursor(last, query.order, this.cursorCodec)
				: null;
		return {
			data,
			meta: { mode: "cursor", limit: query.limit, nextCursor, hasNextPage },
		};
	}

	async read(
		id: CrudId<Resource>,
		executionContext?: ExecutionContext,
		includes: readonly string[] = [],
	): Promise<CrudResponseInput<Resource>> {
		const context = this.operationContext("read", executionContext);
		const record = await this.findVisible(id, context);
		const relations = (await this.loadRelations([record], includes, executionContext))[0] ?? {};
		return this.mapRecord(record, relations, context);
	}

	async update(
		id: CrudId<Resource>,
		input: CrudUpdate<Resource>,
		executionContext?: ExecutionContext,
	): Promise<CrudResponseInput<Resource>> {
		let committed: MutationResult<Resource> | undefined;
		const result = await this.runAdapter(() =>
			this.adapter.transaction(
				async (session) => {
					const baseContext = this.operationContext("update", executionContext, session);
					const scope = await this.resolveScopes(baseContext);
					const predicate = andCrudPredicates(
						this.idPredicate(id),
						this.normalRowsPredicate(),
						scope.predicate,
					)!;
					const prior = await this.adapter.findOne({ predicate }, this.adapterContext(baseContext));
					if (prior === null) throw this.notFound();
					const context = { ...baseContext, prior };
					let value = input;
					for (const hook of this.hooks) {
						if (hook.beforeUpdate !== undefined) value = await hook.beforeUpdate(value, context);
					}
					const mapped = await this.binding.mappings.update(value);
					const scoped = await this.binding.mappings.persistence(scope.updateValues ?? {});
					const record = await this.adapter.update(
						{ predicate, values: { ...mapped, ...scoped } },
						this.adapterContext(context),
					);
					if (record === null) throw this.notFound();
					for (const hook of this.hooks) await hook.afterUpdate?.(record, context);
					const response = await this.mapRecord(record, {}, context);
					committed = { response, prior };
					return response;
				},
				this.adapterContext(this.operationContext("update", executionContext)),
			),
		);
		await this.emitAfterCommit("update", committed, executionContext);
		return result;
	}

	async delete(id: CrudId<Resource>, executionContext?: ExecutionContext): Promise<void> {
		let committed: MutationResult<Resource> | undefined;
		await this.runAdapter(() =>
			this.adapter.transaction(
				async (session) => {
					const baseContext = this.operationContext("delete", executionContext, session);
					const scope = await this.resolveScopes(baseContext);
					const predicate = andCrudPredicates(
						this.idPredicate(id),
						this.normalRowsPredicate(),
						scope.predicate,
					)!;
					const prior = await this.adapter.findOne({ predicate }, this.adapterContext(baseContext));
					if (prior === null) throw this.notFound();
					const context = { ...baseContext, prior };
					for (const hook of this.hooks) await hook.beforeDelete?.(context);
					const record =
						this.resource.softDelete === undefined
							? await this.adapter.delete({ predicate }, this.adapterContext(context))
							: await this.adapter.update(
									{
										predicate,
										values: await this.binding.mappings.persistence({
											[this.resource.softDelete.field]:
												this.resource.softDelete.deleteValue?.(context) ?? new Date(),
										}),
									},
									this.adapterContext(context),
								);
					if (record === null) throw this.notFound();
					for (const hook of this.hooks) await hook.afterDelete?.(record, context);
					committed = { prior };
				},
				this.adapterContext(this.operationContext("delete", executionContext)),
			),
		);
		await this.emitAfterCommit("delete", committed, executionContext);
	}

	async restore(
		id: CrudId<Resource>,
		executionContext?: ExecutionContext,
	): Promise<CrudResponseInput<Resource>> {
		if (this.resource.softDelete === undefined) {
			throw new BadRequestException("Restore is not enabled for this resource.");
		}
		const softDelete = this.resource.softDelete;
		let committed: MutationResult<Resource> | undefined;
		const result = await this.runAdapter(() =>
			this.adapter.transaction(
				async (session) => {
					const baseContext = this.operationContext("restore", executionContext, session);
					const scope = await this.resolveScopes(baseContext);
					const predicate = andCrudPredicates(
						this.idPredicate(id),
						this.deletedOnlyPredicate(),
						scope.predicate,
					)!;
					const prior = await this.adapter.findOne({ predicate }, this.adapterContext(baseContext));
					if (prior === null) throw this.notFound();
					const context = { ...baseContext, prior };
					for (const hook of this.hooks) await hook.beforeRestore?.(context);
					const value = softDelete.restoreValue?.(context) ?? null;
					const persistenceValues = await this.binding.mappings.persistence({
						[softDelete.field]: value,
					});
					const record = await this.adapter.update(
						{ predicate, values: persistenceValues },
						this.adapterContext(context),
					);
					if (record === null) throw this.notFound();
					for (const hook of this.hooks) await hook.afterRestore?.(record, context);
					const response = await this.mapRecord(record, {}, context);
					committed = { response, prior };
					return response;
				},
				this.adapterContext(this.operationContext("restore", executionContext)),
			),
		);
		await this.emitAfterCommit("restore", committed, executionContext);
		return result;
	}

	/** Internal relation batching entry point. Target scopes and soft-delete rules apply here. */
	async findForRelation(options: RelationReadOptions): Promise<readonly RecordType[]> {
		const context = this.operationContext("list", options.executionContext);
		const scope = await this.resolveScopes(context);
		const tuples = uniqueTuples(options.tuples);
		const tuplePredicate = orCrudPredicates(
			...tuples.map((tuple) =>
				andCrudPredicates(
					...options.fields.map((field, index) => ({
						kind: "comparison" as const,
						field,
						operator: "eq" as const,
						value: tuple[index],
					})),
				),
			),
		);
		if (tuplePredicate === undefined) return [];
		const predicate = andCrudPredicates(
			tuplePredicate,
			this.normalRowsPredicate(),
			scope.predicate,
		);
		const result = await this.runAdapter(() =>
			this.adapter.findMany(
				{
					...(predicate === undefined ? {} : { predicate }),
					order: [],
					limit: options.limit,
					count: false,
				},
				this.adapterContext(context),
			),
		);
		return result.records;
	}

	private async findVisible(
		id: CrudId<Resource>,
		context: CrudOperationContext<Resource>,
	): Promise<RecordType> {
		const scope = await this.resolveScopes(context);
		const predicate = andCrudPredicates(
			this.idPredicate(id),
			this.normalRowsPredicate(),
			scope.predicate,
		)!;
		const record = await this.runAdapter(() =>
			this.adapter.findOne({ predicate }, this.adapterContext(context)),
		);
		if (record === null) throw this.notFound();
		return record;
	}

	private idPredicate(id: CrudId<Resource>): CrudPredicate {
		if (typeof id !== "object" || id === null) {
			throw new BadRequestException("CRUD ID schemas must produce a parameter object.");
		}
		const values = id as Readonly<Record<string, unknown>>;
		for (const parameter of Object.keys(this.resource.idFields)) {
			if (!Object.hasOwn(values, parameter) || values[parameter] === undefined) {
				throw new BadRequestException(`CRUD ID schema did not produce parameter "${parameter}".`);
			}
		}
		return andCrudPredicates(
			...Object.entries(this.resource.idFields).map(([parameter, field]) => ({
				kind: "comparison" as const,
				field,
				operator: "eq" as const,
				value: values[parameter],
			})),
		)!;
	}

	private searchPredicate(search: string | undefined): CrudPredicate | undefined {
		if (search === undefined) return undefined;
		return orCrudPredicates(
			...(this.resource.query?.search?.fields ?? []).map((field) => ({
				kind: "comparison" as const,
				field,
				operator: "icontains" as const,
				value: search,
			})),
		);
	}

	private deletedPredicate(query: CrudListQuery): CrudPredicate | undefined {
		if (this.resource.softDelete === undefined || query.deleted === "include") return undefined;
		return query.deleted === "only" ? this.deletedOnlyPredicate() : this.normalRowsPredicate();
	}

	private normalRowsPredicate(): CrudPredicate | undefined {
		return this.resource.softDelete === undefined
			? undefined
			: {
					kind: "comparison",
					field: this.resource.softDelete.field,
					operator: "isnull",
					value: true,
				};
	}

	private deletedOnlyPredicate(): CrudPredicate | undefined {
		return this.resource.softDelete === undefined
			? undefined
			: {
					kind: "comparison",
					field: this.resource.softDelete.field,
					operator: "isnull",
					value: false,
				};
	}

	private async loadRelations(
		records: readonly RecordType[],
		includes: readonly string[],
		executionContext?: ExecutionContext,
	): Promise<readonly Readonly<Record<string, unknown>>[]> {
		const maps = records.map((): Record<string, unknown> => ({}));
		if (records.length === 0 || includes.length === 0) return maps;
		for (const name of includes) {
			const relation = this.resource.relations?.[name];
			if (relation === undefined) throw new BadRequestException(`Unknown include "${name}".`);
			await this.loadRelation(name, relation, records, maps, executionContext);
		}
		return maps;
	}

	private async loadRelation(
		name: string,
		relation: CrudRelationConfig,
		sources: readonly RecordType[],
		maps: readonly Record<string, unknown>[],
		executionContext?: ExecutionContext,
	): Promise<void> {
		const target = this.registry.getResource(relation.target()).service;
		const tuples = sources.map((record) =>
			relation.local.map((field) => this.adapter.getField(record, field)),
		);
		const queryTuples = tuples.filter((tuple) =>
			tuple.every((value) => value !== null && value !== undefined),
		);
		const maxItems = relation.maxItems ?? this.options.maxRelatedRows;
		const limit = (relation.type === "hasMany" ? maxItems + 1 : 2) * sources.length;
		if (!Number.isSafeInteger(limit)) {
			throw new InternalServerErrorException(`Relation "${name}" produced an unsafe fetch bound.`);
		}
		const targetRecords = await target.findForRelation({
			fields: relation.foreign,
			tuples: queryTuples,
			...(executionContext === undefined ? {} : { executionContext }),
			limit,
		});
		if (targetRecords.length >= limit) {
			throw new UnprocessableEntityException(
				`Relation "${name}" exceeds its configured per-record bound.`,
			);
		}
		const projectedTargets = await target.projectForRelation(
			targetRecords as never,
			executionContext,
		);
		const grouped = new Map<string, unknown[]>();
		for (const record of targetRecords) {
			const key = tupleKey(relation.foreign.map((field) => target.adapter.getField(record, field)));
			const group = grouped.get(key) ?? [];
			group.push(record);
			grouped.set(key, group);
		}
		for (const [index, tuple] of tuples.entries()) {
			const matches = grouped.get(tupleKey(tuple)) ?? [];
			if (relation.type === "hasMany" && matches.length > maxItems) {
				throw new UnprocessableEntityException(
					`Relation "${name}" exceeds its maximum of ${maxItems} items.`,
				);
			}
			if (relation.type !== "hasMany" && matches.length > 1) {
				throw new UnprocessableEntityException(
					`Relation "${name}" expected at most one target record.`,
				);
			}
			const mapped = await Promise.all(
				matches
					.slice(0, relation.type === "hasMany" ? maxItems : 1)
					.map((record) =>
						target.mapRecordForRelation(
							record,
							executionContext,
							projectedTargets.get(record as never),
						),
					),
			);
			maps[index]![name] = relation.type === "hasMany" ? mapped : (mapped[0] ?? null);
		}
	}

	async mapRecordForRelation(
		record: RecordType,
		executionContext?: ExecutionContext,
		projected?: Readonly<Record<string, unknown>>,
	): Promise<unknown> {
		return this.mapRecord(record, {}, this.operationContext("read", executionContext), projected);
	}

	/**
	 * Projects a relation's target records as one batch, keyed by record identity.
	 *
	 * Without this a nested payload would silently lack the projected fields that the same
	 * resource carries at the top level — the response schema is shared, so that asymmetry shows
	 * up as a validation failure on the include, far from its cause.
	 */
	async projectForRelation(
		records: readonly RecordType[],
		executionContext?: ExecutionContext,
	): Promise<ReadonlyMap<RecordType, Readonly<Record<string, unknown>>>> {
		const projected = await this.projectRecords(
			records,
			this.operationContext("read", executionContext),
		);
		const byRecord = new Map<RecordType, Readonly<Record<string, unknown>>>();
		if (projected === undefined) return byRecord;
		for (const [index, record] of records.entries()) {
			const values = projected[index];
			if (values !== undefined) byRecord.set(record, values);
		}
		return byRecord;
	}

	private async mapRecord(
		record: RecordType,
		relations: Readonly<Record<string, unknown>>,
		context: CrudOperationContext<Resource>,
		projected?: Readonly<Record<string, unknown>>,
	): Promise<CrudResponseInput<Resource>> {
		const values = projected ?? (await this.projectRecords([record], context))?.[0];
		return this.binding.mappings.response(record, relations, values);
	}

	/**
	 * Runs every declared projection over the whole batch and merges them per record.
	 *
	 * Returns `undefined` when the resource declares no projections, so bindings written against
	 * the two-argument `response` see exactly the previous behaviour rather than an empty object.
	 *
	 * Projections run concurrently with each other but each sees the entire page, so a resource
	 * with three projections over a 24-row page issues three queries, not seventy-two.
	 */
	private async projectRecords(
		records: readonly RecordType[],
		context: CrudOperationContext<Resource>,
	): Promise<readonly Readonly<Record<string, unknown>>[] | undefined> {
		if (this.projections.length === 0 || records.length === 0) return undefined;
		const results = await Promise.all(
			this.projections.map(async (projection) => {
				const values = await projection.project(records, context);
				if (values.length !== records.length) {
					throw new InternalServerErrorException(
						`Projection for "${this.resource.name}" returned ${values.length} entries for ${records.length} records.`,
					);
				}
				return values;
			}),
		);
		// Declaration order decides collisions, matching how hooks and scopes compose.
		return records.map((_record, index) =>
			results.reduce<Record<string, unknown>>(
				(merged, values) => Object.assign(merged, values[index]),
				{},
			),
		);
	}

	private async encodeNextCursor(
		record: RecordType,
		order: CrudListQuery["order"],
		codec: CrudCursorCodec,
	): Promise<string> {
		try {
			const values = order.map(({ field }) => this.adapter.getField(record, field));
			if (values.some((value) => value === null || value === undefined)) {
				throw new TypeError(
					`Cursor ordering for "${this.resource.name}" produced a nullable keyset value.`,
				);
			}
			return await codec.encode({
				version: 1,
				resource: this.resource.name,
				order,
				values,
			});
		} catch (cause) {
			throw new InternalServerErrorException("Failed to create a pagination cursor.", { cause });
		}
	}

	private async resolveScopes(context: CrudOperationContext<Resource>): Promise<CrudScopeResult> {
		const resolved = await Promise.all(this.scopes.map(async (scope) => scope.resolve(context)));
		const predicate = andCrudPredicates(...resolved.map((result) => result.predicate));
		const createValues: Record<string, unknown> = {};
		const updateValues: Record<string, unknown> = {};
		for (const result of resolved) {
			if (result.createValues !== undefined) Object.assign(createValues, result.createValues);
			if (result.updateValues !== undefined) Object.assign(updateValues, result.updateValues);
		}
		return {
			...(predicate === undefined ? {} : { predicate }),
			createValues,
			updateValues,
		};
	}

	private operationContext(
		operation: CrudOperationName,
		executionContext?: ExecutionContext,
		session?: CrudOperationContext["session"],
	): CrudOperationContext<Resource> {
		return {
			resource: this.resource,
			operation,
			...(executionContext === undefined ? {} : { executionContext }),
			...(session === undefined ? {} : { session }),
		};
	}

	private adapterContext(context: CrudOperationContext<Resource>): CrudAdapterContext {
		return {
			resource: this.resource.name,
			operation: context.operation,
			...(context.executionContext === undefined
				? {}
				: { executionContext: context.executionContext }),
			...(context.session === undefined ? {} : { session: context.session }),
		};
	}

	private async emitAfterCommit(
		operation: MutationName,
		result: MutationResult<Resource> | undefined,
		executionContext?: ExecutionContext,
	): Promise<void> {
		if (result === undefined) return;
		const event: CrudMutationEvent<Resource> = {
			resource: this.resource,
			operation,
			...(result.response === undefined ? {} : { response: result.response }),
			...(result.prior === undefined ? {} : { prior: result.prior }),
			...(executionContext === undefined ? {} : { executionContext }),
		};
		for (const hook of this.hooks) {
			try {
				await hook.afterCommit?.(event);
			} catch (error) {
				try {
					await this.options.afterCommitErrorHandler({ error, hook, event });
				} catch {
					// A committed transaction cannot be represented as rolled back merely
					// because the application's delivery/error sink also failed.
				}
			}
		}
	}

	private async runAdapter<Result>(work: () => Promise<Result>): Promise<Result> {
		try {
			return await work();
		} catch (error) {
			if (error instanceof HttpException) throw error;
			if (isCrudAdapterError(error)) {
				if (error.code === "conflict") throw new ConflictException("Resource conflict.");
				if (error.code === "constraint") throw new BadRequestException("Constraint violation.");
			}
			throw new InternalServerErrorException("Persistence operation failed.", { cause: error });
		}
	}

	private notFound(): NotFoundException {
		return new NotFoundException(`${this.resource.name} was not found.`);
	}

	private assertScopeCreateFields(
		scoped: UpdateValues | Partial<Pick<CreateValues, ScopeCreateField>>,
	): asserts scoped is Pick<CreateValues, ScopeCreateField> {
		for (const field of this.binding.scopeCreateFields ?? []) {
			if (!Object.hasOwn(scoped, field)) {
				throw new TypeError(
					`CRUD scope for "${this.resource.name}" did not supply configured create field "${field}".`,
				);
			}
		}
	}

	private assertCapabilities(): void {
		const defaultLimit =
			this.resource.query?.pagination?.defaultLimit ?? this.options.pagination.defaultLimit;
		const maxLimit = this.resource.query?.pagination?.maxLimit ?? this.options.pagination.maxLimit;
		if (maxLimit < defaultLimit) {
			throw new TypeError(
				`CRUD resource "${this.resource.name}" pagination.maxLimit must be >= defaultLimit.`,
			);
		}
		const fields = new Set(this.binding.fields);
		const required = new Set(Object.values(this.resource.idFields));
		if (this.resource.softDelete !== undefined) required.add(this.resource.softDelete.field);
		for (const field of Object.keys(this.resource.query?.filters ?? {})) required.add(field);
		for (const field of this.resource.query?.sort?.fields ?? []) required.add(field);
		for (const field of this.resource.query?.search?.fields ?? []) required.add(field);
		for (const relation of Object.values(this.resource.relations ?? {})) {
			for (const field of relation.local) required.add(field);
		}
		for (const field of required) {
			if (!fields.has(field)) {
				throw new TypeError(
					`CRUD binding for "${this.resource.name}" does not map required field "${field}".`,
				);
			}
		}
		if (Object.keys(this.resource.idFields).length > 1 && !this.adapter.capabilities.compositeIds) {
			throw new TypeError(`CRUD adapter for "${this.resource.name}" lacks composite ID support.`);
		}
		const mutates = ["create", "update", "delete", "restore"].some(
			(operation) => this.resource.operations[operation as MutationName] !== undefined,
		);
		if (mutates && !this.adapter.capabilities.transactions) {
			throw new TypeError(`CRUD adapter for "${this.resource.name}" lacks transactions.`);
		}
		if (mutates && !this.adapter.capabilities.returning) {
			throw new TypeError(`CRUD adapter for "${this.resource.name}" lacks returning mutations.`);
		}
		const needsInsensitive =
			(this.resource.query?.search?.fields.length ?? 0) > 0 ||
			Object.values(this.resource.query?.filters ?? {}).some(({ operators }) =>
				operators.includes("icontains"),
			);
		if (needsInsensitive && !this.adapter.capabilities.containsInsensitive) {
			throw new TypeError(`CRUD adapter for "${this.resource.name}" lacks icontains support.`);
		}
		if (this.resource.query?.pagination?.cursor === true && this.cursorCodec === undefined) {
			throw new TypeError(
				`Cursor-enabled CRUD resource "${this.resource.name}" requires a secure cursor codec.`,
			);
		}
		if (this.resource.query?.pagination?.cursor === true && maxLimit === Number.MAX_SAFE_INTEGER) {
			throw new TypeError(
				`Cursor-enabled CRUD resource "${this.resource.name}" maxLimit must leave room for overflow detection.`,
			);
		}
		for (const [name, relation] of Object.entries(this.resource.relations ?? {})) {
			const perSourceLimit =
				relation.type === "hasMany" ? (relation.maxItems ?? this.options.maxRelatedRows) + 1 : 2;
			if (!Number.isSafeInteger(perSourceLimit * maxLimit)) {
				throw new TypeError(
					`CRUD relation "${this.resource.name}.${name}" can exceed the safe fetch bound.`,
				);
			}
		}
	}
}

function uniqueTuples(tuples: readonly (readonly unknown[])[]): readonly (readonly unknown[])[] {
	return [...new Map(tuples.map((tuple) => [tupleKey(tuple), tuple])).values()];
}

function tupleKey(tuple: readonly unknown[]): string {
	return JSON.stringify(tuple.map(encodeTupleValue));
}

function encodeTupleValue(value: unknown): unknown {
	if (value === null) return ["null"];
	if (value === undefined) return ["undefined"];
	if (value instanceof Date) return ["date", value.toISOString()];
	if (value instanceof Uint8Array) return ["bytes", Buffer.from(value).toString("base64url")];
	if (typeof value === "bigint") return ["bigint", value.toString()];
	if (typeof value === "number") {
		if (Number.isNaN(value)) return ["number", "NaN"];
		if (Object.is(value, -0)) return ["number", "-0"];
		return ["number", value];
	}
	if (typeof value === "string" || typeof value === "boolean") {
		return [typeof value, value];
	}
	if (Array.isArray(value)) return ["array", value.map(encodeTupleValue)];
	if (typeof value === "object") {
		return [
			"object",
			Object.entries(value)
				.toSorted(([left], [right]) => left.localeCompare(right))
				.map(([key, item]) => [key, encodeTupleValue(item)]),
		];
	}
	throw new TypeError("CRUD relation keys must be serializable values.");
}
