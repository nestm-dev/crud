import { CrudAdapterError, isCrudAdapterError } from "@nestm/crud/adapter";
import type {
	CrudAdapter,
	CrudAdapterContext,
	CrudAdapterSession,
	CrudCreateInput,
	CrudDeleteInput,
	CrudFindManyInput,
	CrudFindManyResult,
	CrudFindOneInput,
	CrudUpsertInput,
	CrudUpdateInput,
} from "@nestm/crud/adapter";
import {
	Brackets,
	QueryFailedError,
	type DeepPartial,
	type EntityTarget,
	type EntityMetadata,
	type EntityManager,
	type FindOptionsSelect,
	type InsertQueryBuilder,
	type ObjectLiteral,
	type QueryDeepPartialEntity,
	type Repository,
	type SelectQueryBuilder,
} from "typeorm";

import { compileTypeOrmPredicate } from "./typeorm-predicate.ts";

type TypeOrmColumnMetadata = EntityMetadata["columns"][number];

export type TypeOrmCrudCreateValues<RecordType extends ObjectLiteral> = DeepPartial<RecordType>;
export type TypeOrmCrudUpdateValues<RecordType extends ObjectLiteral> = DeepPartial<RecordType>;

type TypeOrmCrudSelectedProperty<Value, Selection> = Selection extends true
	? Value
	: Selection extends object
		? | TypeOrmCrudSelectedRecord<Extract<NonNullable<Value>, object>, Selection>
			| Extract<Value, null | undefined>
		: never;

type TypeOrmCrudSelectedKeys<Entity extends object, Selection extends object> = {
	[Field in keyof Entity]-?: Field extends keyof Selection
		? [Exclude<Selection[Field], false | undefined>] extends [never]
			? never
			: Field
		: never;
}[keyof Entity];

type TypeOrmCrudMaybeSelectedKeys<Entity extends object, Selection extends object> = {
	[Field in TypeOrmCrudSelectedKeys<Entity, Selection>]: Field extends keyof Selection
		? undefined extends Selection[Field]
			? Field
			: false extends Selection[Field]
				? Field
				: never
		: never;
}[TypeOrmCrudSelectedKeys<Entity, Selection>];

/** Entity shape hydrated when a TypeORM-native `select` object is configured. */
export type TypeOrmCrudSelectedRecord<Entity extends object, Selection extends object> = {
	[
		Field in keyof Entity as Field extends Exclude<
			TypeOrmCrudSelectedKeys<Entity, Selection>,
			TypeOrmCrudMaybeSelectedKeys<Entity, Selection>
		>
			? Field
			: never
	]: Field extends keyof Selection
		? TypeOrmCrudSelectedProperty<Entity[Field], Selection[Field]>
		: never;
} & {
	[
		Field in keyof Entity as Field extends TypeOrmCrudMaybeSelectedKeys<Entity, Selection>
			? Field
			: never
	]?: Field extends keyof Selection
		? TypeOrmCrudSelectedProperty<Entity[Field], Exclude<Selection[Field], false | undefined>>
		: never;
};

/** Record returned by an unselected, literal-selected, or widened-selection adapter. */
export type TypeOrmCrudRecord<
	Entity extends ObjectLiteral,
	Selection extends FindOptionsSelect<Entity> | undefined,
> = Selection extends undefined
	? Entity
	: FindOptionsSelect<Entity> extends Selection
		? DeepPartial<Entity>
		: Selection extends object
			? TypeOrmCrudSelectedRecord<Entity, Selection>
			: never;

/** The alias every generated statement selects the resource's rows under. */
export const TYPEORM_CRUD_ALIAS = "crud_record";
/** The alias transaction-scoped reference lookups select their target rows under. */
export const TYPEORM_CRUD_REFERENCE_ALIAS = "crud_reference";

export type TypeOrmCrudTransactionAccessMode = "read only" | "read write";
export type TypeOrmCrudTransactionIsolationLevel = "read committed" | "repeatable read";

export interface TypeOrmCrudTransactionRequirements {
	readonly accessMode: TypeOrmCrudTransactionAccessMode;
	readonly isolationLevel: TypeOrmCrudTransactionIsolationLevel;
	/** Mutations require the runner to own the real commit, never only a savepoint. */
	readonly mustOwnCommit: boolean;
}

export interface TypeOrmCrudTransactionRunnerContext
	extends CrudAdapterContext, TypeOrmCrudTransactionRequirements {}

/** Effective transaction state reported by a runner when it strengthens a request. */
export interface TypeOrmCrudEffectiveTransaction {
	readonly accessMode: TypeOrmCrudTransactionAccessMode;
	readonly isolationLevel: TypeOrmCrudTransactionIsolationLevel;
	/** Whether the runner controls the commit that makes this work durable. */
	readonly ownsCommit: boolean;
}

export interface TypeOrmCrudTransactionRunner {
	run<Result>(
		context: TypeOrmCrudTransactionRunnerContext,
		workWithTransaction: (
			manager: EntityManager,
			/**
			 * Required when the runner uses stronger settings than requested or does not
			 * own the real commit. Omission preserves the legacy exact-request contract.
			 */
			effectiveTransaction?: TypeOrmCrudEffectiveTransaction,
		) => Promise<Result>,
	): Promise<Result>;
}

export interface TypeOrmCrudRowPredicateContext<RecordType extends ObjectLiteral> {
	readonly repository: Repository<RecordType>;
	/**
	 * The alias the resource's rows are selected under.
	 *
	 * Passed explicitly because a compiled authorization predicate that infers its
	 * alias from the builder it lands on produces valid SQL against the wrong table
	 * whenever two entities share a column name — plausible rows, no error.
	 */
	readonly alias: string;
	readonly context: CrudAdapterContext;
}

export type TypeOrmCrudRowPredicate<RecordType extends ObjectLiteral> = (
	context: TypeOrmCrudRowPredicateContext<RecordType>,
) => Brackets | Promise<Brackets>;

export interface TypeOrmCrudRowPredicateOptions<RecordType extends ObjectLiteral> {
	readonly resolve: TypeOrmCrudRowPredicate<RecordType>;
	/** Minimum transaction settings needed while resolving and applying this predicate. */
	readonly transaction?: Pick<TypeOrmCrudTransactionRequirements, "isolationLevel">;
}

/** Minimum transaction settings for the complete CRUD operation lifecycle. */
export type TypeOrmCrudOperationTransactionOptions = Pick<
	TypeOrmCrudTransactionRequirements,
	"isolationLevel"
>;

/** Minimum context needed to reuse an active CRUD mutation transaction. */
export interface TypeOrmCrudReferenceContext {
	readonly session: CrudAdapterSession;
}

export interface TypeOrmCrudReferencePredicateContext<
	EntityType extends ObjectLiteral,
	Context extends TypeOrmCrudReferenceContext = TypeOrmCrudReferenceContext,
> {
	/** Repository rebound to the source CRUD operation's active entity manager. */
	readonly repository: Repository<EntityType>;
	/** Alias used by the reference lookup's select query. */
	readonly alias: string;
	/** The original validation context, including its typed operation facts. */
	readonly context: Context;
}

/** Native target-row constraint applied in addition to a neutral CRUD predicate. */
export type TypeOrmCrudReferencePredicate<
	EntityType extends ObjectLiteral,
	Context extends TypeOrmCrudReferenceContext = TypeOrmCrudReferenceContext,
> = (
	context: TypeOrmCrudReferencePredicateContext<EntityType, Context>,
) => Brackets | Promise<Brackets>;

interface TypeOrmCrudReferenceInputBase<
	EntityType extends ObjectLiteral,
	Context extends TypeOrmCrudReferenceContext,
> {
	/** Neutral predicate whose fields resolve through the checker's logical column map. */
	readonly predicate?: CrudFindOneInput["predicate"];
	/** Native constraint for target-specific SQL or an RLS companion predicate. */
	readonly nativePredicate?: TypeOrmCrudReferencePredicate<EntityType, Context>;
}

/**
 * A reference lookup is never unconstrained: every call must provide a neutral
 * predicate, a native predicate, or both.
 */
export type TypeOrmCrudReferenceInput<
	EntityType extends ObjectLiteral,
	Context extends TypeOrmCrudReferenceContext = TypeOrmCrudReferenceContext,
> =
	| (TypeOrmCrudReferenceInputBase<EntityType, Context> & {
			readonly predicate: CrudFindOneInput["predicate"];
	  })
	| (TypeOrmCrudReferenceInputBase<EntityType, Context> & {
			readonly nativePredicate: TypeOrmCrudReferencePredicate<EntityType, Context>;
	  });

export interface TypeOrmCrudReferenceCheckerOptions<EntityType extends ObjectLiteral> {
	/** Target metadata only; lookups acquire its repository from the active source manager. */
	readonly target: EntityTarget<EntityType>;
	/** Maps reference-predicate logical fields to target entity scalar property paths. */
	readonly columns: Readonly<Record<string, string>>;
}

export interface TypeOrmCrudAdapterOptions<RecordType extends ObjectLiteral> {
	/** A repository owned and lifecycle-managed by the consuming application. */
	readonly repository: Repository<RecordType>;
	/** Maps public logical field names to TypeORM entity property paths. */
	readonly columns: Readonly<Record<string, string>>;
	/**
	 * TypeORM-native scalar column selection used for every hydrated record.
	 *
	 * Omit this to preserve full-entity hydration. When present, every primary
	 * column must be selected. Mutations use primitive DML with a narrow
	 * `RETURNING` list so TypeORM cannot issue an implicit full-entity reload.
	 */
	readonly select?: FindOptionsSelect<RecordType>;
	/**
	 * Minimum isolation for the complete CRUD operation, including scopes,
	 * lifecycle hooks, validators, mappings, projections, and persistence.
	 *
	 * Declare this when application work inside `adapter.transaction()` may
	 * require a stable snapshot before the adapter issues its first statement.
	 */
	readonly transaction?: TypeOrmCrudOperationTransactionOptions;
	/** Wraps standalone work in an application-owned transaction, for example a tenant RLS executor. */
	readonly transactionRunner?: TypeOrmCrudTransactionRunner;
	/** Adds a native, fail-closed SQL predicate to every read, update, and delete statement. */
	readonly rowPredicate?:
		TypeOrmCrudRowPredicate<RecordType> | TypeOrmCrudRowPredicateOptions<RecordType>;
}

interface PostgreSqlError {
	readonly code?: unknown;
}

interface TypeOrmSessionState {
	readonly manager: EntityManager;
	readonly transaction: TypeOrmCrudEffectiveTransaction;
}

/**
 * Active TypeORM sessions keyed by the exact opaque object handed to CRUD work.
 *
 * This registry deliberately lives at package scope instead of on one adapter
 * instance. A reference lookup is issued by the source resource's validator but
 * targets a different entity, so it must reuse the source adapter's manager without
 * pretending that the target resource owns or can join that adapter's session.
 */
const activeTypeOrmSessions = new WeakMap<CrudAdapterSession, TypeOrmSessionState>();

function sqlState(error: PostgreSqlError): string | undefined {
	return typeof error.code === "string" && /^[0-9A-Z]{5}$/.test(error.code)
		? error.code
		: undefined;
}

function postgresCode(error: unknown): string | undefined {
	if (error instanceof QueryFailedError) {
		const driverError: unknown = error.driverError;
		if (typeof driverError === "object" && driverError !== null) {
			return sqlState(driverError as PostgreSqlError);
		}
	}
	if (typeof error === "object" && error !== null) {
		return sqlState(error as PostgreSqlError);
	}
	return undefined;
}

function databaseError(error: unknown): CrudAdapterError {
	if (isCrudAdapterError(error)) return error;
	const code = postgresCode(error);
	// Serialization and deadlock failures are the whole operation's to retry, and only
	// in a fresh transaction. CRUD never retries on the caller's behalf, because a
	// lifecycle hook's side effects would run twice.
	if (code === "40001" || code === "40P01") {
		return new CrudAdapterError(
			"conflict",
			"The transaction conflicted with concurrent database work.",
			{ cause: error, retryable: true },
		);
	}
	if (code === "23505") {
		return new CrudAdapterError(
			"conflict",
			"A record with the same unique values already exists.",
			{ cause: error },
		);
	}
	if (code?.startsWith("23")) {
		return new CrudAdapterError("constraint", "The mutation violates a database constraint.", {
			cause: error,
		});
	}
	return new CrudAdapterError("unknown", "The database operation failed.", { cause: error });
}

function getProperty(record: object, path: string): unknown {
	let value: unknown = record;
	for (const part of path.split(".")) {
		if (typeof value !== "object" || value === null) return undefined;
		value = (value as Readonly<Record<string, unknown>>)[part];
	}
	return value;
}

function flattenTypeOrmSelection(
	selection: Readonly<Record<string, unknown>>,
	prefix = "",
): string[] {
	const fields: string[] = [];
	for (const [field, value] of Object.entries(selection)) {
		const propertyPath = prefix === "" ? field : `${prefix}.${field}`;
		if (value === true) {
			fields.push(propertyPath);
			continue;
		}
		if (value === false || value === undefined) continue;
		if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			const nested = flattenTypeOrmSelection(
				value as Readonly<Record<string, unknown>>,
				propertyPath,
			);
			if (nested.length === 0) {
				throw new TypeError(
					`TypeORM CRUD select field '${propertyPath}' must include at least one scalar column.`,
				);
			}
			fields.push(...nested);
			continue;
		}
		throw new TypeError(`TypeORM CRUD select field '${propertyPath}' must be true or nested.`);
	}
	return fields;
}

function setProperty(record: Record<string, unknown>, path: string, value: unknown): void {
	const parts = path.split(".");
	let target = record;
	for (const part of parts.slice(0, -1)) {
		const existing = target[part];
		if (existing !== null && typeof existing === "object" && !Array.isArray(existing)) {
			target = existing as Record<string, unknown>;
		} else {
			const nested: Record<string, unknown> = {};
			target[part] = nested;
			target = nested;
		}
	}
	const leaf = parts.at(-1);
	if (leaf !== undefined) target[leaf] = value;
}

function normalizeSelectedUpdateValues(
	metadata: EntityMetadata,
	values: Readonly<Record<string, unknown>>,
	prefix = "",
): Record<string, unknown> {
	const normalized: Record<string, unknown> = {};
	for (const [field, value] of Object.entries(values)) {
		if (value === undefined) continue;
		const propertyPath = prefix === "" ? field : `${prefix}.${field}`;
		const column = metadata.findColumnWithPropertyPathStrict(propertyPath);
		if (column !== undefined) {
			if (column.isUpdate) normalized[field] = value;
			continue;
		}
		const embedded = metadata.findEmbeddedWithPropertyPath(propertyPath);
		if (embedded !== undefined && value === null) {
			const embeddedValues: Record<string, unknown> = {};
			for (const embeddedColumn of embedded.columnsFromTree) {
				if (!embeddedColumn.isUpdate) continue;
				setProperty(
					embeddedValues,
					embeddedColumn.propertyPath.slice(propertyPath.length + 1),
					null,
				);
			}
			if (Object.keys(embeddedValues).length > 0) normalized[field] = embeddedValues;
			continue;
		}
		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			const nested = normalizeSelectedUpdateValues(
				metadata,
				value as Readonly<Record<string, unknown>>,
				propertyPath,
			);
			if (Object.keys(nested).length > 0) {
				normalized[field] = nested;
			} else if (embedded === undefined) {
				// Preserve unknown and relation objects for TypeORM to validate instead
				// of silently turning malformed runtime input into a no-op.
				normalized[field] = value;
			}
			continue;
		}
		// Let TypeORM validate relation and unknown runtime inputs. They are not
		// silently reclassified as a no-op by the adapter.
		normalized[field] = value;
	}
	return normalized;
}

function scalarMutationColumn(
	metadata: EntityMetadata,
	propertyPath: string,
): TypeOrmColumnMetadata | undefined {
	const column = metadata.findColumnWithPropertyPathStrict(propertyPath);
	return column === undefined || column.isVirtual || column.isVirtualProperty ? undefined : column;
}

function isUpsertConflictIdentity(
	metadata: EntityMetadata,
	columns: readonly TypeOrmColumnMetadata[],
): boolean {
	if (sameColumnSet(columns, metadata.primaryColumns)) return true;
	if (
		metadata.uniques.some(
			(unique) => unique.deferrable === undefined && sameColumnSet(columns, unique.columns),
		)
	) {
		return true;
	}
	return metadata.indices.some(
		(index) => index.isUnique && index.where === undefined && sameColumnSet(columns, index.columns),
	);
}

function sameColumnSet(
	left: readonly TypeOrmColumnMetadata[],
	right: readonly TypeOrmColumnMetadata[],
): boolean {
	if (left.length === 0 || left.length !== right.length) return false;
	const expected = new Set(right);
	return expected.size === right.length && left.every((column) => expected.has(column));
}

function strongestIsolationLevel(
	...levels: readonly (TypeOrmCrudTransactionIsolationLevel | undefined)[]
): TypeOrmCrudTransactionIsolationLevel {
	return levels.includes("repeatable read") ? "repeatable read" : "read committed";
}

function transactionRequirements(
	context: CrudAdapterContext,
	operationIsolationLevel?: TypeOrmCrudTransactionIsolationLevel,
	rowPredicateIsolationLevel?: TypeOrmCrudTransactionIsolationLevel,
): TypeOrmCrudTransactionRequirements {
	const readOnly = context.operation === "list" || context.operation === "read";
	const defaultIsolationLevel = context.operation === "list" ? "repeatable read" : "read committed";
	return {
		accessMode: readOnly ? "read only" : "read write",
		isolationLevel: strongestIsolationLevel(
			defaultIsolationLevel,
			operationIsolationLevel,
			rowPredicateIsolationLevel,
		),
		mustOwnCommit: !readOnly,
	};
}

function resolveEffectiveTransaction(
	requirements: TypeOrmCrudTransactionRequirements,
	reported: TypeOrmCrudEffectiveTransaction | undefined,
): TypeOrmCrudEffectiveTransaction {
	const effective = reported ?? {
		accessMode: requirements.accessMode,
		isolationLevel: requirements.isolationLevel,
		ownsCommit: true,
	};
	if (
		(effective.accessMode !== "read only" && effective.accessMode !== "read write") ||
		(effective.isolationLevel !== "read committed" &&
			effective.isolationLevel !== "repeatable read") ||
		typeof effective.ownsCommit !== "boolean"
	) {
		throw new CrudAdapterError(
			"unknown",
			"The TypeORM transaction runner reported invalid effective transaction state.",
		);
	}
	if (effective.accessMode !== requirements.accessMode) {
		throw new CrudAdapterError(
			"unsupported",
			"The TypeORM transaction runner did not honor the requested access mode.",
		);
	}
	if (
		requirements.isolationLevel === "repeatable read" &&
		effective.isolationLevel !== "repeatable read"
	) {
		throw new CrudAdapterError(
			"unsupported",
			"The TypeORM transaction runner did not honor the required isolation level.",
		);
	}
	if (requirements.mustOwnCommit && !effective.ownsCommit) {
		throw new CrudAdapterError(
			"unsupported",
			"A TypeORM CRUD mutation requires a runner that owns the real commit.",
		);
	}
	return Object.freeze({ ...effective });
}

function activeTypeOrmSession(context: {
	readonly session?: CrudAdapterSession;
}): TypeOrmSessionState {
	const session = context.session;
	const state = session === undefined ? undefined : activeTypeOrmSessions.get(session);
	if (state === undefined) {
		throw new CrudAdapterError(
			"unknown",
			"A TypeORM reference lookup requires an active TypeORM CRUD transaction session.",
		);
	}
	if (state.transaction.accessMode !== "read write") {
		throw new CrudAdapterError(
			"unsupported",
			"A locked TypeORM reference lookup requires a read-write transaction.",
		);
	}
	return state;
}

/**
 * Checks a target row through the source CRUD mutation's active TypeORM transaction.
 *
 * The checker owns neither a repository nor a transaction. It rebinds `target` through
 * the active source manager, applies an explicit predicate, and takes a shared
 * row lock. The query selects only a constant and uses a raw result, so TypeORM never
 * hydrates the target entity or invokes its transformers and `@AfterLoad` lifecycle.
 */
export class TypeOrmCrudReferenceChecker<EntityType extends ObjectLiteral> {
	readonly #target: EntityTarget<EntityType>;
	readonly #columns: Readonly<Record<string, string>>;
	readonly #validatedMetadata = new WeakSet<EntityMetadata>();

	constructor(options: TypeOrmCrudReferenceCheckerOptions<EntityType>) {
		this.#target = options.target;
		this.#columns = Object.freeze({ ...options.columns });
	}

	async exists<Context extends TypeOrmCrudReferenceContext>(
		input: TypeOrmCrudReferenceInput<EntityType, Context>,
		context: Context,
	): Promise<boolean> {
		try {
			if (input.predicate === undefined && input.nativePredicate === undefined) {
				throw new CrudAdapterError(
					"unsupported",
					"A TypeORM CRUD reference lookup requires an explicit predicate.",
				);
			}

			const state = activeTypeOrmSession(context);
			const repository = state.manager.getRepository(this.#target);
			this.#validateMetadata(repository.metadata);

			const query = repository.createQueryBuilder(TYPEORM_CRUD_REFERENCE_ALIAS);
			query.select("1", "crud_reference_exists");

			let nativeParameters: Readonly<Record<string, unknown>> | undefined;
			if (input.nativePredicate !== undefined) {
				const nativePredicate = await input.nativePredicate({
					repository,
					alias: query.alias,
					context,
				});
				if (!(nativePredicate instanceof Brackets)) {
					throw new CrudAdapterError(
						"unknown",
						"The TypeORM CRUD reference predicate did not return a Brackets expression.",
					);
				}
				query.andWhere(nativePredicate);
				nativeParameters = query.getParameters();
			}

			if (input.predicate !== undefined) {
				const compiled = compileTypeOrmPredicate(input.predicate, (field) =>
					this.#fieldExpression(query, field),
				);
				for (const parameter of Object.keys(compiled.parameters)) {
					if (nativeParameters !== undefined && Object.hasOwn(nativeParameters, parameter)) {
						throw new CrudAdapterError(
							"unknown",
							`The TypeORM CRUD reference predicate collides with reserved CRUD parameter '${parameter}'.`,
						);
					}
				}
				query.andWhere(compiled.sql, compiled.parameters);
			}

			query.take(1).setLock("pessimistic_read", undefined, [query.alias]);
			const found: unknown = await query.getRawOne();
			return found !== undefined && found !== null;
		} catch (error) {
			throw databaseError(error);
		}
	}

	#validateMetadata(metadata: EntityMetadata): void {
		if (this.#validatedMetadata.has(metadata)) return;

		for (const [field, propertyPath] of Object.entries(this.#columns)) {
			const column = metadata.findColumnWithPropertyPathStrict(propertyPath);
			if (column === undefined || column.isVirtual || column.isVirtualProperty) {
				throw new TypeError(
					`CRUD reference field '${field}' maps to unknown scalar TypeORM property '${propertyPath}'.`,
				);
			}
		}
		this.#validatedMetadata.add(metadata);
	}

	#fieldExpression(query: SelectQueryBuilder<EntityType>, field: string): string {
		const propertyPath = this.#columns[field];
		if (propertyPath === undefined) {
			throw new CrudAdapterError(
				"unsupported",
				`The TypeORM CRUD reference checker does not map field '${field}'.`,
			);
		}
		return `${query.alias}.${propertyPath}`;
	}
}

export function createTypeOrmCrudReferenceChecker<EntityType extends ObjectLiteral>(
	options: TypeOrmCrudReferenceCheckerOptions<EntityType>,
): TypeOrmCrudReferenceChecker<EntityType> {
	return new TypeOrmCrudReferenceChecker(options);
}

export class TypeOrmCrudAdapter<
	EntityType extends ObjectLiteral,
	RecordType extends ObjectLiteral = EntityType,
> implements CrudAdapter<RecordType, DeepPartial<EntityType>, DeepPartial<EntityType>> {
	readonly capabilities = Object.freeze({
		transactions: true,
		returning: true,
		compositeIds: true,
		containsInsensitive: true,
		upsert: true,
	});

	readonly #repository: Repository<EntityType>;
	readonly #columns: Readonly<Record<string, string>>;
	readonly #selectedPropertyPaths: readonly string[] | undefined;
	readonly #operationIsolationLevel: TypeOrmCrudTransactionIsolationLevel | undefined;
	readonly #transactionRunner: TypeOrmCrudTransactionRunner | undefined;
	readonly #rowPredicate: TypeOrmCrudRowPredicate<EntityType> | undefined;
	readonly #rowPredicateIsolationLevel: TypeOrmCrudTransactionIsolationLevel | undefined;
	readonly #sessionMarker = Symbol("@nestm/crud-typeorm:session");
	readonly #activeSessions = new WeakSet<object>();

	constructor(
		options: Omit<TypeOrmCrudAdapterOptions<EntityType>, "select"> & {
			readonly select?: undefined;
		},
	);
	constructor(options: unknown) {
		const adapterOptions = options as TypeOrmCrudAdapterOptions<EntityType>;
		this.#repository = adapterOptions.repository;
		this.#columns = Object.freeze({ ...adapterOptions.columns });
		this.#selectedPropertyPaths = this.#resolveSelection(adapterOptions.select);
		if (
			this.#selectedPropertyPaths !== undefined &&
			this.#repository.metadata.treeType !== undefined
		) {
			throw new TypeError("TypeORM CRUD selected records do not support tree entities.");
		}
		if (
			this.#selectedPropertyPaths !== undefined &&
			this.#repository.metadata.inheritancePattern === "STI" &&
			this.#repository.metadata.childEntityMetadatas.length > 0
		) {
			throw new TypeError(
				"TypeORM CRUD selected records do not support base single-table inheritance repositories.",
			);
		}
		this.#operationIsolationLevel = adapterOptions.transaction?.isolationLevel;
		this.#transactionRunner = adapterOptions.transactionRunner;
		this.#rowPredicate =
			typeof adapterOptions.rowPredicate === "function"
				? adapterOptions.rowPredicate
				: adapterOptions.rowPredicate?.resolve;
		this.#rowPredicateIsolationLevel =
			typeof adapterOptions.rowPredicate === "function"
				? undefined
				: adapterOptions.rowPredicate?.transaction?.isolationLevel;
		for (const [field, propertyPath] of Object.entries(this.#columns)) {
			if (!this.#repository.metadata.findColumnWithPropertyPath(propertyPath)) {
				throw new TypeError(
					`CRUD field '${field}' maps to unknown TypeORM property '${propertyPath}'.`,
				);
			}
		}
	}

	async transaction<Result>(
		work: (session: CrudAdapterSession) => Promise<Result>,
		context: CrudAdapterContext,
	): Promise<Result> {
		if (context.session !== undefined) {
			this.#stateFrom(context.session);
			return work(context.session);
		}
		return this.#runTransaction(
			work,
			context,
			transactionRequirements(
				context,
				this.#operationIsolationLevel,
				context.operation === "create" ? undefined : this.#rowPredicateIsolationLevel,
			),
		);
	}

	async create(
		input: CrudCreateInput<DeepPartial<EntityType>>,
		context: CrudAdapterContext,
	): Promise<RecordType> {
		try {
			return await this.#withRepository(
				context,
				{
					accessMode: "read write",
					isolationLevel: strongestIsolationLevel(this.#operationIsolationLevel),
					mustOwnCommit: true,
				},
				false,
				async (repository) => {
					if (this.#selectedPropertyPaths !== undefined) {
						const entity = repository.create(input.values);
						const result = await repository
							.createQueryBuilder()
							.insert()
							.into(repository.target)
							.values(entity as QueryDeepPartialEntity<EntityType>)
							.updateEntity(false)
							.returning([...this.#selectedPropertyPaths])
							.execute();
						return this.#hydrateReturning(repository, result.raw[0]);
					}
					const entity = repository.create(input.values);
					return (await repository.save(entity)) as unknown as RecordType;
				},
			);
		} catch (error) {
			throw databaseError(error);
		}
	}

	async upsert(
		input: CrudUpsertInput<DeepPartial<EntityType>>,
		context: CrudAdapterContext,
	): Promise<RecordType | null> {
		try {
			return await this.#withRepository(
				context,
				{
					accessMode: "read write",
					isolationLevel: strongestIsolationLevel(
						this.#operationIsolationLevel,
						this.#rowPredicateIsolationLevel,
					),
					mustOwnCommit: true,
				},
				this.#rowPredicate !== undefined,
				async (repository, activeContext) => {
					this.#assertUpsertSupported(repository);
					const entity = repository.create(input.values);
					const conflictColumns = this.#upsertConflictColumns(
						repository,
						entity,
						input.conflictFields,
					);
					const overwriteColumns = this.#upsertOverwriteColumns(
						repository,
						entity,
						input.overwriteFields,
					);
					const overwriteCondition = await this.#upsertOverwriteCondition(
						repository,
						input.predicate,
						activeContext,
					);
					const returning = this.#returningPropertyPaths(repository);
					const mutation = repository
						.createQueryBuilder()
						.insert()
						.into(repository.target)
						.values(entity);
					this.#aliasUpsertTarget(mutation);
					const result = await mutation
						.orUpdate(overwriteColumns, conflictColumns, {
							overwriteCondition,
						})
						.updateEntity(false)
						.returning([...returning])
						.execute();
					return result.raw.length === 0
						? null
						: this.#hydrateReturning(repository, result.raw[0], returning);
				},
			);
		} catch (error) {
			throw databaseError(error);
		}
	}

	async findOne(input: CrudFindOneInput, context: CrudAdapterContext): Promise<RecordType | null> {
		try {
			return await this.#withRepository(
				context,
				{
					accessMode: "read only",
					isolationLevel: strongestIsolationLevel(
						this.#operationIsolationLevel,
						this.#rowPredicateIsolationLevel,
					),
					mustOwnCommit: false,
				},
				this.#rowPredicate !== undefined,
				async (repository, activeContext) => await this.#findOne(repository, input, activeContext),
			);
		} catch (error) {
			throw databaseError(error);
		}
	}

	async findMany(
		input: CrudFindManyInput,
		context: CrudAdapterContext,
	): Promise<CrudFindManyResult<RecordType>> {
		try {
			return await this.#withRepository(
				context,
				{
					accessMode: "read only",
					isolationLevel: strongestIsolationLevel(
						input.count ? "repeatable read" : undefined,
						this.#operationIsolationLevel,
						this.#rowPredicateIsolationLevel,
					),
					mustOwnCommit: false,
				},
				input.count || this.#rowPredicate !== undefined,
				async (repository, activeContext) => {
					const query = this.#query(repository);
					await this.#where(query, input.predicate, activeContext);
					for (const order of input.order) {
						query.addOrderBy(
							this.#fieldExpression(query, order.field),
							order.direction.toUpperCase() as "ASC" | "DESC",
						);
					}
					query.skip(input.offset ?? 0).take(input.limit);
					if (input.count) {
						const [records, total] = await query.getManyAndCount();
						return { records: records as unknown as RecordType[], total };
					}
					return { records: (await query.getMany()) as unknown as RecordType[] };
				},
			);
		} catch (error) {
			throw databaseError(error);
		}
	}

	async update(
		input: CrudUpdateInput<DeepPartial<EntityType>>,
		context: CrudAdapterContext,
	): Promise<RecordType | null> {
		try {
			return await this.#withRepository(
				context,
				{
					accessMode: "read write",
					isolationLevel: strongestIsolationLevel(
						this.#operationIsolationLevel,
						this.#rowPredicateIsolationLevel,
					),
					mustOwnCommit: true,
				},
				this.#rowPredicate !== undefined,
				async (repository, activeContext) => {
					const record = await this.#findOne(
						repository,
						{ predicate: input.predicate },
						activeContext,
						true,
					);
					if (record === null) return null;
					if (this.#selectedPropertyPaths !== undefined) {
						const values = normalizeSelectedUpdateValues(
							repository.metadata,
							input.values as Readonly<Record<string, unknown>>,
						);
						if (Object.keys(values).length === 0) return record;
						const mutation = await this.#selectedMutation(
							repository,
							record,
							input.predicate,
							activeContext,
						);
						const result = await mutation
							.update()
							.set(values as QueryDeepPartialEntity<EntityType>)
							.updateEntity(false)
							.returning([...this.#selectedPropertyPaths])
							.execute();
						return result.raw.length === 0
							? null
							: this.#hydrateReturning(repository, result.raw[0]);
					}
					const entity = record as unknown as EntityType;
					repository.merge(entity, input.values);
					return (await repository.save(entity)) as unknown as RecordType;
				},
			);
		} catch (error) {
			throw databaseError(error);
		}
	}

	async delete(input: CrudDeleteInput, context: CrudAdapterContext): Promise<RecordType | null> {
		try {
			return await this.#withRepository(
				context,
				{
					accessMode: "read write",
					isolationLevel: strongestIsolationLevel(
						this.#operationIsolationLevel,
						this.#rowPredicateIsolationLevel,
					),
					mustOwnCommit: true,
				},
				this.#rowPredicate !== undefined,
				async (repository, activeContext) => {
					const record = await this.#findOne(
						repository,
						{ predicate: input.predicate },
						activeContext,
						true,
					);
					if (record === null) return null;
					if (this.#selectedPropertyPaths !== undefined) {
						const mutation = await this.#selectedMutation(
							repository,
							record,
							input.predicate,
							activeContext,
						);
						const result = await mutation
							.delete()
							.returning([...this.#selectedPropertyPaths])
							.execute();
						return result.raw.length === 0
							? null
							: this.#hydrateReturning(repository, result.raw[0]);
					}
					const entity = record as unknown as EntityType;
					const previous = repository.create(entity as DeepPartial<EntityType>);
					await repository.remove(entity);
					return previous as unknown as RecordType;
				},
			);
		} catch (error) {
			throw databaseError(error);
		}
	}

	getField(record: RecordType, field: string): unknown {
		const propertyPath = this.#property(field);
		if (
			this.#selectedPropertyPaths !== undefined &&
			!this.#selectedPropertyPaths.includes(propertyPath)
		) {
			throw new CrudAdapterError(
				"unsupported",
				`The TypeORM adapter did not select CRUD field '${field}'.`,
			);
		}
		return getProperty(record, propertyPath);
	}

	/**
	 * Resolves the repository this operation runs against, opening a transaction when
	 * one is required.
	 *
	 * A configured runner or row predicate forces a transaction even for reads: the
	 * predicate's tenant setting is transaction-local, so a read issued outside the
	 * transaction is a read the predicate never constrained.
	 */
	async #withRepository<Result>(
		context: CrudAdapterContext,
		requirements: TypeOrmCrudTransactionRequirements,
		forceTransaction: boolean,
		work: (
			repository: Repository<EntityType>,
			activeContext: CrudAdapterContext,
		) => Promise<Result>,
	): Promise<Result> {
		if (context.session !== undefined) {
			const state = this.#stateFrom(context.session);
			if (
				requirements.accessMode === "read write" &&
				state.transaction.accessMode === "read only"
			) {
				throw new CrudAdapterError(
					"unsupported",
					"A TypeORM CRUD mutation cannot reuse a read-only transaction.",
				);
			}
			if (
				requirements.isolationLevel === "repeatable read" &&
				state.transaction.isolationLevel !== "repeatable read"
			) {
				throw new CrudAdapterError(
					"unsupported",
					"This TypeORM CRUD operation requires a repeatable-read transaction.",
				);
			}
			if (requirements.mustOwnCommit && !state.transaction.ownsCommit) {
				throw new CrudAdapterError(
					"unsupported",
					"A TypeORM CRUD mutation requires a transaction that owns the real commit.",
				);
			}
			return work(this.#repositoryFrom(state.manager), context);
		}

		if (
			this.#transactionRunner !== undefined ||
			this.#operationIsolationLevel !== undefined ||
			forceTransaction
		) {
			return this.#runTransaction(
				async (session) => {
					const state = this.#stateFrom(session);
					return work(this.#repositoryFrom(state.manager), { ...context, session });
				},
				context,
				requirements,
			);
		}

		return work(this.#repository, context);
	}

	async #runTransaction<Result>(
		work: (session: CrudAdapterSession) => Promise<Result>,
		context: CrudAdapterContext,
		requirements: TypeOrmCrudTransactionRequirements,
	): Promise<Result> {
		const transactionContext: TypeOrmCrudTransactionRunnerContext = {
			...context,
			...requirements,
		};
		const enter = async (
			manager: EntityManager,
			reportedTransaction?: TypeOrmCrudEffectiveTransaction,
		): Promise<Result> => {
			if (typeof manager !== "object" || manager === null) {
				throw new CrudAdapterError(
					"unknown",
					"The TypeORM transaction runner did not provide an entity manager.",
				);
			}
			const state: TypeOrmSessionState = {
				manager,
				transaction: resolveEffectiveTransaction(requirements, reportedTransaction),
			};
			const session: CrudAdapterSession = Object.freeze({
				adapter: this.#sessionMarker,
				value: state,
			});
			this.#activeSessions.add(state);
			activeTypeOrmSessions.set(session, state);
			try {
				return await work(session);
			} finally {
				activeTypeOrmSessions.delete(session);
				this.#activeSessions.delete(state);
			}
		};

		try {
			if (this.#transactionRunner !== undefined) {
				return await this.#transactionRunner.run(transactionContext, enter);
			}
			return await this.#runOwnTransaction(requirements, enter);
		} catch (error) {
			if (isCrudAdapterError(error)) throw error;
			if (error instanceof QueryFailedError || postgresCode(error) !== undefined)
				throw databaseError(error);
			throw error;
		}
	}

	/**
	 * Opens the adapter's own transaction.
	 *
	 * A `QueryRunner` rather than `EntityManager.transaction`, because only the runner
	 * lets the access mode be set: `SET TRANSACTION READ ONLY` has to be issued after
	 * the transaction is open and before any statement in it.
	 */
	async #runOwnTransaction<Result>(
		requirements: TypeOrmCrudTransactionRequirements,
		enter: (manager: EntityManager) => Promise<Result>,
	): Promise<Result> {
		const queryRunner = this.#repository.manager.connection.createQueryRunner();
		await queryRunner.connect();
		await queryRunner.startTransaction(
			requirements.isolationLevel === "repeatable read" ? "REPEATABLE READ" : "READ COMMITTED",
		);
		try {
			if (requirements.accessMode === "read only") {
				await queryRunner.query("SET TRANSACTION READ ONLY");
			}
			const result = await enter(queryRunner.manager);
			await queryRunner.commitTransaction();
			return result;
		} catch (error) {
			if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
			throw error;
		} finally {
			await queryRunner.release();
		}
	}

	#repositoryFrom(manager: EntityManager): Repository<EntityType> {
		return manager.getRepository(this.#repository.target);
	}

	#stateFrom(session: CrudAdapterSession): TypeOrmSessionState {
		if (
			session.adapter !== this.#sessionMarker ||
			typeof session.value !== "object" ||
			session.value === null ||
			!this.#activeSessions.has(session.value)
		) {
			throw new CrudAdapterError(
				"unknown",
				"A transaction session is foreign or no longer active.",
			);
		}
		return session.value as TypeOrmSessionState;
	}

	#query(repository: Repository<EntityType>): SelectQueryBuilder<EntityType> {
		const query = repository.createQueryBuilder(TYPEORM_CRUD_ALIAS);
		if (this.#selectedPropertyPaths !== undefined) {
			query.select(
				this.#selectedPropertyPaths.map((propertyPath) => `${query.alias}.${propertyPath}`),
			);
		}
		return query;
	}

	#resolveSelection(
		selection: FindOptionsSelect<EntityType> | undefined,
	): readonly string[] | undefined {
		if (selection === undefined) return undefined;
		const propertyPaths = flattenTypeOrmSelection(selection);
		if (propertyPaths.length === 0) {
			throw new TypeError("TypeORM CRUD select must include at least one scalar column.");
		}
		for (const propertyPath of propertyPaths) {
			const column = this.#repository.metadata.findColumnWithPropertyPathStrict(propertyPath);
			if (column === undefined || column.isVirtual || column.isVirtualProperty) {
				throw new TypeError(
					`TypeORM CRUD select references unknown scalar property '${propertyPath}'.`,
				);
			}
		}
		for (const primary of this.#repository.metadata.primaryColumns) {
			if (!propertyPaths.includes(primary.propertyPath)) {
				throw new TypeError(
					`TypeORM CRUD select must include primary property '${primary.propertyPath}'.`,
				);
			}
		}
		return Object.freeze(propertyPaths);
	}

	async #selectedMutation(
		repository: Repository<EntityType>,
		record: RecordType,
		predicate: CrudFindOneInput["predicate"],
		context: CrudAdapterContext,
	): Promise<SelectQueryBuilder<EntityType>> {
		const identity = repository.metadata.getEntityIdMap(record);
		if (identity === undefined) {
			throw new CrudAdapterError(
				"unknown",
				"The selected TypeORM record did not contain its complete identity.",
			);
		}

		const selector = repository.createQueryBuilder(TYPEORM_CRUD_ALIAS);
		selector.select(
			repository.metadata.primaryColumns.map(
				(column) => `${selector.alias}.${column.propertyPath}`,
			),
		);
		await this.#where(selector, predicate, context);
		// Bind identity last so TypeORM allocates its automatic parameter names
		// around every explicit native/CRUD name already present on the builder.
		selector.andWhereInIds(identity).limit(1);

		const mutation = repository.createQueryBuilder();
		const targetColumns = repository.metadata.primaryColumns.map((column) =>
			mutation.escape(column.databaseName),
		);
		const target = targetColumns.length === 1 ? targetColumns[0]! : `(${targetColumns.join(", ")})`;
		return mutation.where(`${target} IN (${selector.getQuery()})`, selector.getParameters());
	}

	#returningPropertyPaths(repository: Repository<EntityType>): readonly string[] {
		return (
			this.#selectedPropertyPaths ??
			repository.metadata.columns
				.filter((column) => !column.isVirtual && !column.isVirtualProperty)
				.map((column) => column.propertyPath)
		);
	}

	#aliasUpsertTarget(query: InsertQueryBuilder<EntityType>): void {
		const alias = query.expressionMap.mainAlias;
		if (alias === undefined) {
			throw new CrudAdapterError(
				"unknown",
				"TypeORM did not register the CRUD upsert target table.",
			);
		}
		// `into()` resets an explicit QueryBuilder alias to the target table name.
		// Restoring the dedicated alias makes the ON CONFLICT authorization predicate
		// unambiguous, including for schema-qualified tables and a table named excluded.
		alias.name = TYPEORM_CRUD_ALIAS;
	}

	#assertUpsertSupported(repository: Repository<EntityType>): void {
		if (repository.metadata.treeType !== undefined) {
			throw new CrudAdapterError(
				"unsupported",
				"TypeORM CRUD upsert does not support tree entities.",
			);
		}
		if (
			repository.metadata.inheritancePattern === "STI" &&
			repository.metadata.childEntityMetadatas.length > 0
		) {
			throw new CrudAdapterError(
				"unsupported",
				"TypeORM CRUD upsert does not support base single-table inheritance repositories.",
			);
		}
	}

	#hydrateReturning(
		repository: Repository<EntityType>,
		raw: unknown,
		propertyPaths: readonly string[] = this.#selectedPropertyPaths ?? [],
	): RecordType {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			throw new CrudAdapterError(
				"unknown",
				"TypeORM did not return the requested columns for the CRUD mutation.",
			);
		}
		const values = raw as Readonly<Record<string, unknown>>;
		const record = repository.metadata.create(repository.queryRunner, { fromDeserializer: true });
		for (const propertyPath of propertyPaths) {
			const column = repository.metadata.findColumnWithPropertyPathStrict(propertyPath);
			if (column === undefined || !Object.hasOwn(values, column.databaseName)) {
				throw new CrudAdapterError(
					"unknown",
					`TypeORM omitted requested property '${propertyPath}' from the CRUD mutation result.`,
				);
			}
			column.setEntityValue(
				record,
				repository.manager.connection.driver.prepareHydratedValue(
					values[column.databaseName],
					column,
				),
			);
		}
		return record as RecordType;
	}

	#upsertConflictColumns(
		repository: Repository<EntityType>,
		entity: EntityType,
		propertyPaths: readonly string[],
	): string[] {
		if (propertyPaths.length === 0) {
			throw new CrudAdapterError(
				"unsupported",
				"TypeORM CRUD upsert conflict fields must map to a complete primary or unique identity.",
			);
		}

		const seenColumns = new Set<TypeOrmColumnMetadata>();
		const conflictColumns: TypeOrmColumnMetadata[] = [];
		const databaseNames: string[] = [];
		for (const propertyPath of propertyPaths) {
			const column = scalarMutationColumn(repository.metadata, propertyPath);
			if (column === undefined || !column.isInsert || seenColumns.has(column)) {
				throw new CrudAdapterError(
					"unsupported",
					"TypeORM CRUD upsert conflict fields must map to a complete physical primary or unique identity.",
				);
			}
			if (column.getEntityValue(entity) === undefined || column.getEntityValue(entity) === null) {
				throw new CrudAdapterError(
					"unsupported",
					`TypeORM CRUD upsert conflict field '${propertyPath}' is absent from the proposed row.`,
				);
			}
			seenColumns.add(column);
			conflictColumns.push(column);
			databaseNames.push(column.databaseName);
		}
		if (!isUpsertConflictIdentity(repository.metadata, conflictColumns)) {
			throw new CrudAdapterError(
				"unsupported",
				"TypeORM CRUD upsert conflict fields must map to the complete primary identity, a non-deferrable unique constraint, or a non-partial unique index.",
			);
		}
		return databaseNames;
	}

	#upsertOverwriteColumns(
		repository: Repository<EntityType>,
		entity: EntityType,
		propertyPaths: readonly string[],
	): string[] {
		if (propertyPaths.length === 0) {
			throw new CrudAdapterError(
				"unsupported",
				"TypeORM CRUD upsert requires at least one overwrite field.",
			);
		}
		const seen = new Set<TypeOrmColumnMetadata>();
		const databaseNames: string[] = [];
		for (const propertyPath of propertyPaths) {
			const column = scalarMutationColumn(repository.metadata, propertyPath);
			if (
				column === undefined ||
				column.isPrimary ||
				!column.isInsert ||
				!column.isUpdate ||
				seen.has(column)
			) {
				throw new CrudAdapterError(
					"unsupported",
					`TypeORM CRUD upsert overwrite field '${propertyPath}' must be a unique, mutable scalar persistence property.`,
				);
			}
			if (column.getEntityValue(entity) === undefined) {
				throw new CrudAdapterError(
					"unsupported",
					`TypeORM CRUD upsert overwrite field '${propertyPath}' is absent from the proposed row.`,
				);
			}
			seen.add(column);
			databaseNames.push(column.databaseName);
		}
		return databaseNames;
	}

	async #upsertOverwriteCondition(
		repository: Repository<EntityType>,
		predicate: CrudFindOneInput["predicate"],
		context: CrudAdapterContext,
	): Promise<{ where: string; parameters: Readonly<Record<string, unknown>> }> {
		const selector = repository.createQueryBuilder(TYPEORM_CRUD_ALIAS).select("1");
		await this.#where(selector, predicate, context);
		const sql = selector.getQuery();
		const marker = " WHERE ";
		const whereIndex = sql.indexOf(marker);
		if (whereIndex < 0) {
			throw new CrudAdapterError(
				"unknown",
				"TypeORM did not compile the required CRUD upsert authorization predicate.",
			);
		}
		return {
			where: sql.slice(whereIndex + marker.length),
			parameters: selector.getParameters(),
		};
	}

	async #findOne(
		repository: Repository<EntityType>,
		input: CrudFindOneInput,
		context: CrudAdapterContext,
		lock = false,
	): Promise<RecordType | null> {
		const query = this.#query(repository);
		await this.#where(query, input.predicate, context);
		for (const order of input.order ?? []) {
			query.addOrderBy(
				this.#fieldExpression(query, order.field),
				order.direction.toUpperCase() as "ASC" | "DESC",
			);
		}
		if (lock && context.session) query.setLock("pessimistic_write");
		return (await query.getOne()) as RecordType | null;
	}

	/**
	 * Applies the compiled CRUD predicate and, when configured, the native row predicate.
	 *
	 * Both are ANDed onto the same builder. A row predicate that resolves to nothing is
	 * an error rather than an omission — the failure mode it exists to prevent is a
	 * statement that quietly stops being constrained.
	 */
	async #where(
		query: SelectQueryBuilder<EntityType>,
		predicate: CrudFindOneInput["predicate"] | undefined,
		context: CrudAdapterContext,
	): Promise<void> {
		const compiled =
			predicate === undefined
				? undefined
				: compileTypeOrmPredicate(predicate, (field) => this.#fieldExpression(query, field));
		let nativeParameters: Readonly<Record<string, unknown>> | undefined;
		if (this.#rowPredicate !== undefined) {
			const nativePredicate = await this.#rowPredicate({
				repository: this.#repository,
				alias: query.alias,
				context,
			});
			if (!(nativePredicate instanceof Brackets)) {
				throw new CrudAdapterError(
					"unknown",
					"The configured TypeORM row predicate did not return a Brackets expression.",
				);
			}
			query.andWhere(nativePredicate);
			nativeParameters = query.getParameters();
		}
		if (compiled === undefined) return;
		for (const parameter of Object.keys(compiled.parameters)) {
			if (nativeParameters !== undefined && Object.hasOwn(nativeParameters, parameter)) {
				throw new CrudAdapterError(
					"unknown",
					`The TypeORM row predicate collides with reserved CRUD parameter '${parameter}'.`,
				);
			}
		}
		query.andWhere(compiled.sql, compiled.parameters);
	}

	#fieldExpression(query: SelectQueryBuilder<EntityType>, field: string): string {
		return `${query.alias}.${this.#property(field)}`;
	}

	#property(field: string): string {
		const property = this.#columns[field];
		if (property === undefined) {
			throw new CrudAdapterError(
				"unsupported",
				`The TypeORM adapter does not map CRUD field '${field}'.`,
			);
		}
		return property;
	}
}

export function createTypeOrmCrudAdapter<EntityType extends ObjectLiteral>(
	options: Omit<TypeOrmCrudAdapterOptions<EntityType>, "select"> & { readonly select?: undefined },
): TypeOrmCrudAdapter<EntityType>;
export function createTypeOrmCrudAdapter<
	EntityType extends ObjectLiteral,
	const Selection extends FindOptionsSelect<EntityType> = FindOptionsSelect<EntityType>,
>(
	options: Omit<TypeOrmCrudAdapterOptions<EntityType>, "select"> & { readonly select: Selection },
): TypeOrmCrudAdapter<EntityType, TypeOrmCrudSelectedRecord<EntityType, Selection>>;
export function createTypeOrmCrudAdapter<EntityType extends ObjectLiteral>(
	options: TypeOrmCrudAdapterOptions<EntityType>,
): TypeOrmCrudAdapter<EntityType, TypeOrmCrudRecord<EntityType, FindOptionsSelect<EntityType>>>;
export function createTypeOrmCrudAdapter(options: unknown): unknown {
	const AdapterConstructor = TypeOrmCrudAdapter as unknown as new <
		EntityType extends ObjectLiteral,
		RecordType extends ObjectLiteral = EntityType,
	>(
		options: TypeOrmCrudAdapterOptions<EntityType>,
	) => TypeOrmCrudAdapter<EntityType, RecordType>;
	return new AdapterConstructor(options as TypeOrmCrudAdapterOptions<ObjectLiteral>);
}
