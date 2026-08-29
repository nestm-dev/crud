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
import type {
	CrudAdapter,
	CrudAdapterContext,
	CrudAdapterSession,
	CrudValues,
} from "../adapter/adapter.types.ts";
import type {
	CrudMappingValues,
	CrudResourceBinding,
	CrudScopeCreateField,
} from "../adapter/binding.types.ts";
import { encodeCrudCursor } from "../cursor/cursor.ts";
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
	CrudPathParams,
	CrudResponseInput,
	CrudUpdate,
	CrudUpsert,
} from "../resource/resource.types.ts";
import type { CrudOperationName } from "../resource/operations.ts";
import type {
	CrudLifecycleHook,
	CrudCollectionArgs,
	CrudMutationEvent,
	CrudMutationValidator,
	CrudOperationContext,
	CrudProjection,
	CrudScope,
	CrudScopeResult,
	CrudValidationContext,
} from "./runtime.types.ts";
import type { CrudRegistry } from "./crud-registry.ts";
import {
	EMPTY_CRUD_FACTS,
	resolveCrudFacts,
	type CrudFactEntry,
	type CrudFacts,
} from "./crud-facts.ts";

type MutationName = Extract<
	CrudOperationName,
	"create" | "update" | "delete" | "restore" | "upsert"
>;

interface MutationResult<Resource extends AnyCrudResource> {
	readonly response?: CrudResponseInput<Resource>;
	readonly prior?: unknown;
}

interface RelationReadOptions {
	readonly fields: readonly string[];
	readonly tuples: readonly (readonly unknown[])[];
	readonly executionContext?: ExecutionContext;
	readonly limit: number;
	readonly maxItems: number;
	readonly relationName: string;
	readonly relationType: CrudRelationConfig["type"];
}

interface RelationReadResult<RecordType> {
	readonly records: readonly RecordType[];
	readonly responses: readonly unknown[];
}

interface ResolvedCrudScope extends Omit<CrudScopeResult, "facts"> {
	readonly facts: CrudFacts;
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
		readonly validators: readonly CrudMutationValidator<Resource>[] = [],
	) {
		this.resource = resource;
		this.assertCapabilities();
	}

	async create(
		input: CrudCreate<Resource>,
		...args: CrudCollectionArgs<Resource>
	): Promise<CrudResponseInput<Resource>> {
		const { executionContext, pathParams } = this.collectionArguments(args);
		let committed: MutationResult<Resource> | undefined;
		const result = await this.runAdapter(async () =>
			this.adapter.transaction(
				async (session) => {
					const scopeContext = this.operationContext(
						"create",
						executionContext,
						session,
						pathParams,
					);
					const scope = await this.resolveScopes(scopeContext);
					const context = this.mutationContext(
						"create",
						session,
						scope.facts,
						executionContext,
						pathParams,
					);
					let value = input;
					for (const hook of this.hooks) {
						if (hook.beforeCreate !== undefined) {
							value = await hook.beforeCreate(value, context);
						}
					}
					for (const validator of this.validators) {
						await validator.validateCreate?.(value, context);
					}
					const mapped = await this.binding.mappings.create(value);
					const scopeCreateValues = this.scopeCreateValues(scope, pathParams);
					const scoped =
						this.binding.mappings.scopeCreate === undefined
							? await this.mapPersistenceValues(scopeCreateValues)
							: await this.binding.mappings.scopeCreate(scopeCreateValues);
					this.assertScopeCreateFields(scoped);
					// The runtime assertion above establishes the generic Pick that TypeScript cannot
					// normalize back into an arbitrary adapter-defined CreateValues subtype. The
					// final normalization removes explicitly undefined optional mapper properties.
					const values = normalizeCrudMappingValues<CreateValues>({
						...mapped,
						...scoped,
					} as CrudMappingValues<CreateValues>);
					const record = await this.adapter.create({ values }, this.adapterContext(context));
					for (const hook of this.hooks) {
						await hook.afterCreate?.(record, context);
					}
					const response = await this.mapRecord(record, {}, context);
					committed = { response };
					return response;
				},
				this.adapterContext(
					this.operationContext("create", executionContext, undefined, pathParams),
				),
			),
		);
		await this.emitAfterCommit("create", committed, executionContext, pathParams);
		return result;
	}

	async list(
		rawQuery: CrudRawQuery,
		...args: CrudCollectionArgs<Resource>
	): Promise<CrudPage<CrudResponseInput<Resource>>> {
		const { executionContext, pathParams } = this.collectionArguments(args);
		const pathFixedValues = this.pathFixedValues(pathParams);
		const query = await parseCrudListQuery(this.resource, rawQuery, {
			...(this.cursorCodec === undefined ? {} : { cursorCodec: this.cursorCodec }),
			...(pathFixedValues.length === 0 ? {} : { cursorFixedValues: pathFixedValues }),
			defaultLimit: this.options.pagination.defaultLimit,
			maxLimit: this.options.pagination.maxLimit,
		});
		return this.runAdapter(() =>
			this.adapter.transaction(
				async (session) => {
					const baseContext = this.operationContext("list", executionContext, session, pathParams);
					const scope = await this.resolveScopes(baseContext);
					const context: CrudOperationContext<Resource> = {
						...baseContext,
						facts: scope.facts,
					};
					const predicate = andCrudPredicates(
						query.predicate,
						this.searchPredicate(query.search),
						this.deletedPredicate(query),
						this.pathParamsPredicate(pathParams),
						scope.predicate,
					);
					const result = await this.adapter.findMany(
						{
							...(predicate === undefined ? {} : { predicate }),
							order: query.order,
							...(query.mode === "offset" ? { offset: (query.page - 1) * query.limit } : {}),
							limit: query.mode === "cursor" ? query.limit + 1 : query.limit,
							count: query.mode === "offset",
						},
						this.adapterContext(context),
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
								mode: "offset" as const,
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
							? await this.encodeNextCursor(last, query.order, this.cursorCodec, pathFixedValues)
							: null;
					return {
						data,
						meta: { mode: "cursor" as const, limit: query.limit, nextCursor, hasNextPage },
					};
				},
				this.adapterContext(this.operationContext("list", executionContext, undefined, pathParams)),
			),
		);
	}

	async read(
		id: CrudId<Resource>,
		executionContext?: ExecutionContext,
		includes: readonly string[] = [],
	): Promise<CrudResponseInput<Resource>> {
		const pathParams = this.pathParamsFromId(id);
		return this.runAdapter(() =>
			this.adapter.transaction(
				async (session) => {
					const baseContext = this.operationContext("read", executionContext, session, pathParams);
					const scope = await this.resolveScopes(baseContext);
					const context: CrudOperationContext<Resource> = {
						...baseContext,
						facts: scope.facts,
					};
					const predicate = andCrudPredicates(
						this.idPredicate(id),
						this.normalRowsPredicate(),
						scope.predicate,
					)!;
					const record = await this.adapter.findOne({ predicate }, this.adapterContext(context));
					if (record === null) throw this.notFound();
					const relations =
						(await this.loadRelations([record], includes, executionContext))[0] ?? {};
					return this.mapRecord(record, relations, context);
				},
				this.adapterContext(this.operationContext("read", executionContext, undefined, pathParams)),
			),
		);
	}

	async update(
		id: CrudId<Resource>,
		input: CrudUpdate<Resource>,
		executionContext?: ExecutionContext,
	): Promise<CrudResponseInput<Resource>> {
		const pathParams = this.pathParamsFromId(id);
		let committed: MutationResult<Resource> | undefined;
		const result = await this.runAdapter(() =>
			this.adapter.transaction(
				async (session) => {
					const baseContext = this.operationContext(
						"update",
						executionContext,
						session,
						pathParams,
					);
					const scope = await this.resolveScopes(baseContext);
					const predicate = andCrudPredicates(
						this.idPredicate(id),
						this.normalRowsPredicate(),
						scope.predicate,
					)!;
					const prior = await this.adapter.findOne({ predicate }, this.adapterContext(baseContext));
					if (prior === null) throw this.notFound();
					const context: CrudOperationContext<Resource> = {
						...baseContext,
						facts: scope.facts,
						prior,
					};
					let value = input;
					for (const hook of this.hooks) {
						if (hook.beforeUpdate !== undefined) value = await hook.beforeUpdate(value, context);
					}
					for (const validator of this.validators) {
						await validator.validateUpdate?.(
							id,
							value,
							this.mutationContext("update", session, scope.facts, executionContext, pathParams),
						);
					}
					const mapped = await this.binding.mappings.update(value);
					const scoped = await this.mapPersistenceValues(scope.updateValues ?? {});
					const record = await this.adapter.update(
						{
							predicate,
							values: normalizeCrudMappingValues<UpdateValues>({
								...mapped,
								...scoped,
							} as CrudMappingValues<UpdateValues>),
						},
						this.adapterContext(context),
					);
					if (record === null) throw this.notFound();
					for (const hook of this.hooks) await hook.afterUpdate?.(record, context);
					const response = await this.mapRecord(record, {}, context);
					committed = { response, prior };
					return response;
				},
				this.adapterContext(
					this.operationContext("update", executionContext, undefined, pathParams),
				),
			),
		);
		await this.emitAfterCommit("update", committed, executionContext, pathParams);
		return result;
	}

	async upsert(
		id: CrudId<Resource>,
		input: CrudUpsert<Resource>,
		executionContext?: ExecutionContext,
	): Promise<CrudResponseInput<Resource>> {
		const pathParams = this.pathParamsFromId(id);
		const adapter = this.adapter;
		const mappings = this.binding.mappings;
		const config = this.binding.upsert;
		if (adapter.upsert === undefined || mappings.upsert === undefined || config === undefined) {
			throw new InternalServerErrorException(
				`CRUD upsert for "${this.resource.name}" is not configured.`,
			);
		}
		const adapterUpsert = adapter.upsert.bind(adapter);
		const mapUpsert = mappings.upsert.bind(mappings);
		let committed: MutationResult<Resource> | undefined;
		const result = await this.runAdapter(() =>
			adapter.transaction(
				async (session) => {
					const scopeContext = this.operationContext(
						"upsert",
						executionContext,
						session,
						pathParams,
					);
					const scope = await this.resolveScopes(scopeContext);
					const context = this.mutationContext(
						"upsert",
						session,
						scope.facts,
						executionContext,
						pathParams,
					);
					const predicate = andCrudPredicates(
						this.idPredicate(id),
						this.normalRowsPredicate(),
						scope.predicate,
					)!;
					let value = input;
					for (const hook of this.hooks) {
						if (hook.beforeUpsert !== undefined) {
							value = await hook.beforeUpsert(id, value, context);
						}
					}
					for (const validator of this.validators) {
						await validator.validateUpsert?.(id, value, context);
					}
					const mapped = await mapUpsert(id, value);
					const scopeCreateValues = this.scopeCreateValues(scope, pathParams);
					const scoped =
						mappings.scopeCreate === undefined
							? await this.mapPersistenceValues(scopeCreateValues)
							: await mappings.scopeCreate(scopeCreateValues);
					this.assertScopeCreateFields(scoped);
					const values = normalizeCrudMappingValues<CreateValues>({
						...mapped,
						...scoped,
					} as CrudMappingValues<CreateValues>);
					const record = await adapterUpsert(
						{
							conflictFields: config.conflictFields,
							overwriteFields: config.overwriteFields,
							predicate,
							values,
						},
						this.adapterContext(context),
					);
					if (record === null) throw this.notFound();
					for (const hook of this.hooks) await hook.afterUpsert?.(record, context);
					const response = await this.mapRecord(record, {}, context);
					committed = { response };
					return response;
				},
				this.adapterContext(
					this.operationContext("upsert", executionContext, undefined, pathParams),
				),
			),
		);
		await this.emitAfterCommit("upsert", committed, executionContext, pathParams);
		return result;
	}

	async delete(id: CrudId<Resource>, executionContext?: ExecutionContext): Promise<void> {
		const pathParams = this.pathParamsFromId(id);
		const ignoreMissing = this.resource.operations.delete?.missing === "ignore";
		let committed: MutationResult<Resource> | undefined;
		await this.runAdapter(() =>
			this.adapter.transaction(
				async (session) => {
					const baseContext = this.operationContext(
						"delete",
						executionContext,
						session,
						pathParams,
					);
					const scope = await this.resolveScopes(baseContext);
					const predicate = andCrudPredicates(
						this.idPredicate(id),
						this.normalRowsPredicate(),
						scope.predicate,
					)!;
					const prior = await this.adapter.findOne({ predicate }, this.adapterContext(baseContext));
					if (prior === null) {
						if (ignoreMissing) return;
						throw this.notFound();
					}
					const context: CrudOperationContext<Resource> = {
						...baseContext,
						facts: scope.facts,
						prior,
					};
					for (const hook of this.hooks) await hook.beforeDelete?.(context);
					for (const validator of this.validators) {
						await validator.validateDelete?.(
							id,
							this.mutationContext("delete", session, scope.facts, executionContext, pathParams),
						);
					}
					const record =
						this.resource.softDelete === undefined
							? await this.adapter.delete({ predicate }, this.adapterContext(context))
							: await this.adapter.update(
									{
										predicate,
										values: await this.mapPersistenceValues({
											[this.resource.softDelete.field]:
												this.resource.softDelete.deleteValue?.(context) ?? new Date(),
										}),
									},
									this.adapterContext(context),
								);
					if (record === null) {
						if (ignoreMissing) return;
						throw this.notFound();
					}
					for (const hook of this.hooks) await hook.afterDelete?.(record, context);
					committed = { prior };
				},
				this.adapterContext(
					this.operationContext("delete", executionContext, undefined, pathParams),
				),
			),
		);
		await this.emitAfterCommit("delete", committed, executionContext, pathParams);
	}

	async restore(
		id: CrudId<Resource>,
		executionContext?: ExecutionContext,
	): Promise<CrudResponseInput<Resource>> {
		if (this.resource.softDelete === undefined) {
			throw new BadRequestException("Restore is not enabled for this resource.");
		}
		const softDelete = this.resource.softDelete;
		const pathParams = this.pathParamsFromId(id);
		let committed: MutationResult<Resource> | undefined;
		const result = await this.runAdapter(() =>
			this.adapter.transaction(
				async (session) => {
					const baseContext = this.operationContext(
						"restore",
						executionContext,
						session,
						pathParams,
					);
					const scope = await this.resolveScopes(baseContext);
					const predicate = andCrudPredicates(
						this.idPredicate(id),
						this.deletedOnlyPredicate(),
						scope.predicate,
					)!;
					const prior = await this.adapter.findOne({ predicate }, this.adapterContext(baseContext));
					if (prior === null) throw this.notFound();
					const context: CrudOperationContext<Resource> = {
						...baseContext,
						facts: scope.facts,
						prior,
					};
					for (const hook of this.hooks) await hook.beforeRestore?.(context);
					for (const validator of this.validators) {
						await validator.validateRestore?.(
							id,
							this.mutationContext("restore", session, scope.facts, executionContext, pathParams),
						);
					}
					const value = softDelete.restoreValue?.(context) ?? null;
					const persistenceValues = await this.mapPersistenceValues({
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
				this.adapterContext(
					this.operationContext("restore", executionContext, undefined, pathParams),
				),
			),
		);
		await this.emitAfterCommit("restore", committed, executionContext, pathParams);
		return result;
	}

	/** Internal relation batching entry point. Target scopes and response mapping stay transactional. */
	async readForRelation(options: RelationReadOptions): Promise<RelationReadResult<RecordType>> {
		return this.runAdapter(() =>
			this.adapter.transaction(
				async (session) => {
					const scopeContext = this.operationContext("list", options.executionContext, session);
					const scope = await this.resolveScopes(scopeContext);
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
					if (tuplePredicate === undefined) return { records: [], responses: [] };
					const predicate = andCrudPredicates(
						tuplePredicate,
						this.normalRowsPredicate(),
						scope.predicate,
					);
					const result = await this.adapter.findMany(
						{
							...(predicate === undefined ? {} : { predicate }),
							order: [],
							limit: options.limit,
							count: false,
						},
						this.adapterContext(scopeContext),
					);
					if (result.records.length >= options.limit) {
						throw new UnprocessableEntityException(
							`Relation "${options.relationName}" exceeds its configured per-record bound.`,
						);
					}
					this.assertRelationGroupBounds(result.records, options);
					const context: CrudOperationContext<Resource> = {
						...this.operationContext("read", options.executionContext, session),
						facts: scope.facts,
					};
					const projected = await this.projectRecords(result.records, context);
					const responses = await Promise.all(
						result.records.map((record, index) =>
							this.mapRecord(record, {}, context, projected?.[index]),
						),
					);
					return { records: result.records, responses };
				},
				this.adapterContext(this.operationContext("list", options.executionContext)),
			),
		);
	}

	private idPredicate(id: CrudId<Resource>): CrudPredicate {
		const values = this.identifierValues(id);
		return andCrudPredicates(
			...Object.entries(this.resource.idFields).map(([parameter, field]) => ({
				kind: "comparison" as const,
				field,
				operator: "eq" as const,
				value: values[parameter],
			})),
		)!;
	}

	private identifierValues(id: CrudId<Resource>): Readonly<Record<string, unknown>> {
		if (typeof id !== "object" || id === null) {
			throw new BadRequestException("CRUD ID schemas must produce a parameter object.");
		}
		const values = id as Readonly<Record<string, unknown>>;
		for (const parameter of Object.keys(this.resource.idFields)) {
			if (!Object.hasOwn(values, parameter) || values[parameter] === undefined) {
				throw new BadRequestException(`CRUD ID schema did not produce parameter "${parameter}".`);
			}
		}
		return values;
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
		const targetResult = await target.readForRelation({
			fields: relation.foreign,
			tuples: queryTuples,
			...(executionContext === undefined ? {} : { executionContext }),
			limit,
			maxItems,
			relationName: name,
			relationType: relation.type,
		});
		const grouped = new Map<string, unknown[]>();
		for (const [targetIndex, record] of targetResult.records.entries()) {
			const key = tupleKey(relation.foreign.map((field) => target.adapter.getField(record, field)));
			const group = grouped.get(key) ?? [];
			group.push(targetResult.responses[targetIndex]);
			grouped.set(key, group);
		}
		for (const [index, tuple] of tuples.entries()) {
			const matches = grouped.get(tupleKey(tuple)) ?? [];
			maps[index]![name] = relation.type === "hasMany" ? matches : (matches[0] ?? null);
		}
	}

	private assertRelationGroupBounds(
		records: readonly RecordType[],
		options: RelationReadOptions,
	): void {
		const counts = new Map<string, number>();
		for (const record of records) {
			const key = tupleKey(options.fields.map((field) => this.adapter.getField(record, field)));
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		for (const count of counts.values()) {
			if (options.relationType === "hasMany" && count > options.maxItems) {
				throw new UnprocessableEntityException(
					`Relation "${options.relationName}" exceeds its maximum of ${options.maxItems} items.`,
				);
			}
			if (options.relationType !== "hasMany" && count > 1) {
				throw new UnprocessableEntityException(
					`Relation "${options.relationName}" expected at most one target record.`,
				);
			}
		}
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
		fixed: readonly { readonly field: string; readonly value: unknown }[] = [],
	): Promise<string> {
		try {
			const values = order.map(({ field }) => this.adapter.getField(record, field));
			if (values.some((value) => value === null || value === undefined)) {
				throw new TypeError(
					`Cursor ordering for "${this.resource.name}" produced a nullable keyset value.`,
				);
			}
			return await encodeCrudCursor(
				codec,
				{
					resource: this.resource.name,
					order,
					...(fixed.length === 0 ? {} : { fixed }),
				},
				values,
			);
		} catch (cause) {
			throw new InternalServerErrorException("Failed to create a pagination cursor.", { cause });
		}
	}

	private async resolveScopes(context: CrudOperationContext<Resource>): Promise<ResolvedCrudScope> {
		const resolved = await Promise.all(this.scopes.map(async (scope) => scope.resolve(context)));
		const predicate = andCrudPredicates(...resolved.map((result) => result.predicate));
		const createValues: Record<string, unknown> = {};
		const updateValues: Record<string, unknown> = {};
		const factEntries: CrudFactEntry[] = [];
		for (const result of resolved) {
			if (result.createValues !== undefined) Object.assign(createValues, result.createValues);
			if (result.updateValues !== undefined) Object.assign(updateValues, result.updateValues);
			if (result.facts !== undefined) factEntries.push(...result.facts);
		}
		return {
			...(predicate === undefined ? {} : { predicate }),
			createValues,
			updateValues,
			facts: resolveCrudFacts(factEntries),
		};
	}

	private collectionArguments(args: CrudCollectionArgs<Resource>): {
		readonly executionContext?: ExecutionContext;
		readonly pathParams?: CrudPathParams<Resource>;
	} {
		if (this.resource.pathParams === undefined) {
			const executionContext = args[0] as ExecutionContext | undefined;
			return executionContext === undefined ? {} : { executionContext };
		}
		const pathParams = args[0] as CrudPathParams<Resource>;
		if (typeof pathParams !== "object" || pathParams === null || Array.isArray(pathParams)) {
			throw new BadRequestException("CRUD path parameter schemas must produce an object.");
		}
		const executionContext = args[1] as ExecutionContext | undefined;
		return {
			pathParams,
			...(executionContext === undefined ? {} : { executionContext }),
		};
	}

	private pathParamsFromId(id: CrudId<Resource>): CrudPathParams<Resource> | undefined {
		if (this.resource.pathParams === undefined) return undefined;
		const values = this.identifierValues(id);
		return Object.fromEntries(
			Object.keys(this.resource.pathParams.fields).map((parameter) => [
				parameter,
				values[parameter],
			]),
		) as CrudPathParams<Resource>;
	}

	private pathFixedValues(
		pathParams: CrudPathParams<Resource> | undefined,
	): readonly { readonly field: string; readonly value: unknown }[] {
		if (this.resource.pathParams === undefined) return [];
		if (typeof pathParams !== "object" || pathParams === null || Array.isArray(pathParams)) {
			throw new BadRequestException("CRUD path parameter schemas must produce an object.");
		}
		const values = pathParams as Readonly<Record<string, unknown>>;
		return Object.entries(this.resource.pathParams.fields).map(([parameter, field]) => {
			if (!Object.hasOwn(values, parameter) || values[parameter] === undefined) {
				throw new BadRequestException(
					`CRUD path parameter schema did not produce parameter "${parameter}".`,
				);
			}
			return { field, value: values[parameter] };
		});
	}

	private pathParamsPredicate(
		pathParams: CrudPathParams<Resource> | undefined,
	): CrudPredicate | undefined {
		return andCrudPredicates(
			...this.pathFixedValues(pathParams).map(({ field, value }) => ({
				kind: "comparison" as const,
				field,
				operator: "eq" as const,
				value,
			})),
		);
	}

	private scopeCreateValues(
		scope: Pick<ResolvedCrudScope, "createValues">,
		pathParams: CrudPathParams<Resource> | undefined,
	): Readonly<Record<string, unknown>> {
		const values: Record<string, unknown> = { ...scope.createValues };
		for (const { field, value } of this.pathFixedValues(pathParams)) {
			if (Object.hasOwn(values, field) && !persistenceValuesEqual(values[field], value)) {
				throw new InternalServerErrorException(
					"CRUD path parameters conflict with scope-owned create values.",
				);
			}
			values[field] = value;
		}
		return values;
	}

	private async mapPersistenceValues(values: CrudValues): Promise<UpdateValues> {
		if (this.binding.mappings.persistence === undefined) {
			if (Object.keys(values).length > 0) {
				throw new TypeError(
					`CRUD binding for "${this.resource.name}" must define mappings.persistence before scopes or soft delete can contribute update values.`,
				);
			}
			return {} as UpdateValues;
		}
		return normalizeCrudMappingValues<UpdateValues>(
			await this.binding.mappings.persistence(values),
		);
	}

	private operationContext(
		operation: CrudOperationName,
		executionContext?: ExecutionContext,
		session?: CrudOperationContext["session"],
		pathParams?: CrudPathParams<Resource>,
	): CrudOperationContext<Resource> {
		return {
			resource: this.resource,
			operation,
			...(executionContext === undefined ? {} : { executionContext }),
			...(session === undefined ? {} : { session }),
			...(pathParams === undefined ? {} : { pathParams }),
			facts: EMPTY_CRUD_FACTS,
		};
	}

	private mutationContext<Operation extends MutationName>(
		operation: Operation,
		session: CrudAdapterSession,
		facts: CrudFacts,
		executionContext?: ExecutionContext,
		pathParams?: CrudPathParams<Resource>,
	): CrudValidationContext<Resource, Operation> {
		return {
			resource: this.resource,
			operation,
			session,
			facts,
			...(executionContext === undefined ? {} : { executionContext }),
			...(pathParams === undefined ? {} : { pathParams }),
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
			...(context.pathParams === undefined ? {} : { pathParams: context.pathParams }),
		};
	}

	private async emitAfterCommit(
		operation: MutationName,
		result: MutationResult<Resource> | undefined,
		executionContext?: ExecutionContext,
		pathParams?: CrudPathParams<Resource>,
	): Promise<void> {
		if (result === undefined) return;
		const event: CrudMutationEvent<Resource> = {
			resource: this.resource,
			operation,
			...(result.response === undefined ? {} : { response: result.response }),
			...(result.prior === undefined ? {} : { prior: result.prior }),
			...(executionContext === undefined ? {} : { executionContext }),
			...(pathParams === undefined ? {} : { pathParams }),
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
				if (error.code === "conflict") {
					throw new ConflictException("Resource conflict.", { cause: error });
				}
				if (error.code === "constraint") {
					throw new BadRequestException("Constraint violation.", { cause: error });
				}
			}
			throw new InternalServerErrorException("Persistence operation failed.", { cause: error });
		}
	}

	private notFound(): NotFoundException {
		return new NotFoundException(`${this.resource.name} was not found.`);
	}

	private assertScopeCreateFields(
		scoped: UpdateValues | CrudMappingValues<Partial<Pick<CreateValues, ScopeCreateField>>>,
	): void {
		const values = scoped as Readonly<Record<string, unknown>>;
		for (const field of this.binding.scopeCreateFields ?? []) {
			if (!Object.hasOwn(values, field) || values[field] === undefined) {
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
		for (const field of Object.values(this.resource.pathParams?.fields ?? {})) required.add(field);
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
		if (!this.adapter.capabilities.transactions) {
			throw new TypeError(`CRUD adapter for "${this.resource.name}" lacks transactions.`);
		}
		const mutates = ["create", "update", "delete", "restore", "upsert"].some(
			(operation) => this.resource.operations[operation as MutationName] !== undefined,
		);
		if (mutates && !this.adapter.capabilities.returning) {
			throw new TypeError(`CRUD adapter for "${this.resource.name}" lacks returning mutations.`);
		}
		if (this.resource.softDelete !== undefined && this.binding.mappings.persistence === undefined) {
			throw new TypeError(
				`Soft-delete CRUD binding for "${this.resource.name}" must define mappings.persistence.`,
			);
		}
		if (
			this.resource.pathParams !== undefined &&
			(this.resource.operations.create !== undefined ||
				this.resource.operations.upsert !== undefined) &&
			(this.binding.mappings.scopeCreate === undefined ||
				(this.binding.scopeCreateFields?.length ?? 0) === 0)
		) {
			throw new TypeError(
				`Nested CRUD insert binding for "${this.resource.name}" must declare scopeCreate and scopeCreateFields.`,
			);
		}
		if (this.resource.operations.upsert !== undefined) {
			if (this.adapter.capabilities.upsert !== true || this.adapter.upsert === undefined) {
				throw new TypeError(
					`CRUD adapter for "${this.resource.name}" lacks atomic upsert support.`,
				);
			}
			if (this.binding.mappings.upsert === undefined || this.binding.upsert === undefined) {
				throw new TypeError(`CRUD binding for "${this.resource.name}" must configure upsert.`);
			}
			const { conflictFields, overwriteFields } = this.binding.upsert;
			assertPersistenceFieldTuple(this.resource.name, "upsert.conflictFields", conflictFields);
			assertPersistenceFieldTuple(this.resource.name, "upsert.overwriteFields", overwriteFields);
			const conflicts = new Set(conflictFields);
			for (const field of overwriteFields) {
				if (conflicts.has(field)) {
					throw new TypeError(
						`CRUD binding for "${this.resource.name}" cannot overwrite conflict field "${field}".`,
					);
				}
				if (this.binding.scopeCreateFields?.includes(field) === true) {
					throw new TypeError(
						`CRUD binding for "${this.resource.name}" cannot overwrite scope-owned create field "${field}".`,
					);
				}
			}
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

function normalizeCrudMappingValues<Values extends object>(
	values: CrudMappingValues<Values>,
): Values {
	const normalized = { ...values } as Record<PropertyKey, unknown>;
	for (const field of Reflect.ownKeys(normalized)) {
		if (normalized[field] === undefined) delete normalized[field];
	}
	// CrudMappingValues only widens optional properties with `undefined`; deleting
	// those properties restores the adapter's exact-optional Values contract.
	return normalized as Values;
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

function persistenceValuesEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (left instanceof Date || right instanceof Date) {
		return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
	}
	if (left instanceof Uint8Array || right instanceof Uint8Array) {
		return (
			left instanceof Uint8Array &&
			right instanceof Uint8Array &&
			left.length === right.length &&
			left.every((value, index) => value === right[index])
		);
	}
	return false;
}

function assertPersistenceFieldTuple(
	resource: string,
	label: string,
	fields: readonly string[],
): void {
	if (fields.length === 0) {
		throw new TypeError(`CRUD binding for "${resource}" ${label} cannot be empty.`);
	}
	const seen = new Set<string>();
	for (const field of fields) {
		if (typeof field !== "string" || field.trim() === "") {
			throw new TypeError(
				`CRUD binding for "${resource}" ${label} must contain non-empty strings.`,
			);
		}
		if (seen.has(field)) {
			throw new TypeError(`CRUD binding for "${resource}" ${label} repeats field "${field}".`);
		}
		seen.add(field);
	}
}
