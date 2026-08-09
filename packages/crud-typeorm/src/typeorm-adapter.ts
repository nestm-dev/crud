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
	CrudUpdateInput,
} from "@nestm/crud/adapter";
import {
	Brackets,
	QueryFailedError,
	type DeepPartial,
	type EntityManager,
	type ObjectLiteral,
	type Repository,
	type SelectQueryBuilder,
} from "typeorm";

import { compileTypeOrmPredicate } from "./typeorm-predicate.ts";

export type TypeOrmCrudCreateValues<RecordType extends ObjectLiteral> = DeepPartial<RecordType>;
export type TypeOrmCrudUpdateValues<RecordType extends ObjectLiteral> = DeepPartial<RecordType>;

/** The alias every generated statement selects the resource's rows under. */
export const TYPEORM_CRUD_ALIAS = "crud_record";

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

export interface TypeOrmCrudAdapterOptions<RecordType extends ObjectLiteral> {
	/** A repository owned and lifecycle-managed by the consuming application. */
	readonly repository: Repository<RecordType>;
	/** Maps public logical field names to TypeORM entity property paths. */
	readonly columns: Readonly<Record<string, string>>;
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

function transactionRequirements(
	context: CrudAdapterContext,
	rowPredicateIsolationLevel?: TypeOrmCrudTransactionIsolationLevel,
): TypeOrmCrudTransactionRequirements {
	const readOnly = context.operation === "list" || context.operation === "read";
	const operationIsolationLevel =
		context.operation === "list" ? "repeatable read" : "read committed";
	return {
		accessMode: readOnly ? "read only" : "read write",
		isolationLevel:
			operationIsolationLevel === "repeatable read" ||
			rowPredicateIsolationLevel === "repeatable read"
				? "repeatable read"
				: "read committed",
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

export class TypeOrmCrudAdapter<RecordType extends ObjectLiteral> implements CrudAdapter<
	RecordType,
	DeepPartial<RecordType>,
	DeepPartial<RecordType>
> {
	readonly capabilities = Object.freeze({
		transactions: true,
		returning: true,
		compositeIds: true,
		containsInsensitive: true,
	});

	readonly #repository: Repository<RecordType>;
	readonly #columns: Readonly<Record<string, string>>;
	readonly #transactionRunner: TypeOrmCrudTransactionRunner | undefined;
	readonly #rowPredicate: TypeOrmCrudRowPredicate<RecordType> | undefined;
	readonly #rowPredicateIsolationLevel: TypeOrmCrudTransactionIsolationLevel | undefined;
	readonly #sessionMarker = Symbol("@nestm/crud-typeorm:session");
	readonly #activeSessions = new WeakSet<object>();

	constructor(options: TypeOrmCrudAdapterOptions<RecordType>) {
		this.#repository = options.repository;
		this.#columns = Object.freeze({ ...options.columns });
		this.#transactionRunner = options.transactionRunner;
		this.#rowPredicate =
			typeof options.rowPredicate === "function"
				? options.rowPredicate
				: options.rowPredicate?.resolve;
		this.#rowPredicateIsolationLevel =
			typeof options.rowPredicate === "function"
				? undefined
				: options.rowPredicate?.transaction?.isolationLevel;
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
				context.operation === "create" ? undefined : this.#rowPredicateIsolationLevel,
			),
		);
	}

	async create(
		input: CrudCreateInput<DeepPartial<RecordType>>,
		context: CrudAdapterContext,
	): Promise<RecordType> {
		try {
			return await this.#withRepository(
				context,
				{ accessMode: "read write", isolationLevel: "read committed", mustOwnCommit: true },
				false,
				async (repository) => {
					const entity = repository.create(input.values);
					return await repository.save(entity);
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
					isolationLevel: this.#rowPredicateIsolationLevel ?? "read committed",
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
					isolationLevel:
						input.count || this.#rowPredicateIsolationLevel === "repeatable read"
							? "repeatable read"
							: "read committed",
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
						return { records, total };
					}
					return { records: await query.getMany() };
				},
			);
		} catch (error) {
			throw databaseError(error);
		}
	}

	async update(
		input: CrudUpdateInput<DeepPartial<RecordType>>,
		context: CrudAdapterContext,
	): Promise<RecordType | null> {
		try {
			return await this.#withRepository(
				context,
				{
					accessMode: "read write",
					isolationLevel: this.#rowPredicateIsolationLevel ?? "read committed",
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
					repository.merge(record, input.values);
					return await repository.save(record);
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
					isolationLevel: this.#rowPredicateIsolationLevel ?? "read committed",
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
					const previous = repository.create(record as DeepPartial<RecordType>);
					await repository.remove(record);
					return previous;
				},
			);
		} catch (error) {
			throw databaseError(error);
		}
	}

	getField(record: RecordType, field: string): unknown {
		return getProperty(record, this.#property(field));
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
			repository: Repository<RecordType>,
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

		if (this.#transactionRunner !== undefined || forceTransaction) {
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
			this.#activeSessions.add(state);
			try {
				return await work({ adapter: this.#sessionMarker, value: state });
			} finally {
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

	#repositoryFrom(manager: EntityManager): Repository<RecordType> {
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

	#query(repository: Repository<RecordType>): SelectQueryBuilder<RecordType> {
		return repository.createQueryBuilder(TYPEORM_CRUD_ALIAS);
	}

	async #findOne(
		repository: Repository<RecordType>,
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
		return await query.getOne();
	}

	/**
	 * Applies the compiled CRUD predicate and, when configured, the native row predicate.
	 *
	 * Both are ANDed onto the same builder. A row predicate that resolves to nothing is
	 * an error rather than an omission — the failure mode it exists to prevent is a
	 * statement that quietly stops being constrained.
	 */
	async #where(
		query: SelectQueryBuilder<RecordType>,
		predicate: CrudFindOneInput["predicate"] | undefined,
		context: CrudAdapterContext,
	): Promise<void> {
		if (predicate !== undefined) {
			const compiled = compileTypeOrmPredicate(predicate, (field) =>
				this.#fieldExpression(query, field),
			);
			query.andWhere(compiled.sql, compiled.parameters);
		}
		if (this.#rowPredicate === undefined) return;
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
	}

	#fieldExpression(query: SelectQueryBuilder<RecordType>, field: string): string {
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

export function createTypeOrmCrudAdapter<RecordType extends ObjectLiteral>(
	options: TypeOrmCrudAdapterOptions<RecordType>,
): TypeOrmCrudAdapter<RecordType> {
	return new TypeOrmCrudAdapter(options);
}
