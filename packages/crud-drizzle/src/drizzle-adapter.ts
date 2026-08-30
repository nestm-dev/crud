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
	CrudPersistenceField,
	CrudPredicate,
	CrudUpdateInput,
} from "@nestm/crud/adapter";
import {
	and,
	asc,
	desc,
	getTableColumns,
	sql,
	type InferInsertModel,
	type InferSelectModel,
	type SQL,
	type TablesRelationalConfig,
} from "drizzle-orm";
import type { AnyPgTable, PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { compileDrizzlePredicate, type DrizzleCrudColumns } from "./drizzle-predicate.ts";

export type DrizzleCrudCreateValues<Table extends AnyPgTable> = InferInsertModel<Table>;
export type DrizzleCrudUpdateValues<Table extends AnyPgTable> = Partial<InferInsertModel<Table>>;
export type DrizzleCrudLogicalField<Columns extends Readonly<Record<string, unknown>>> = Extract<
	keyof Columns,
	string
>;

export type DrizzleCrudDatabase<
	QueryResult extends PgQueryResultHKT,
	FullSchema extends Record<string, unknown>,
	Schema extends TablesRelationalConfig,
> = PgDatabase<QueryResult, FullSchema, Schema>;

export type DrizzleCrudTransactionAccessMode = "read only" | "read write";
export type DrizzleCrudTransactionIsolationLevel = "read committed" | "repeatable read";

export interface DrizzleCrudTransactionRequirements {
	readonly accessMode: DrizzleCrudTransactionAccessMode;
	readonly isolationLevel: DrizzleCrudTransactionIsolationLevel;
	/** Mutations require the runner to own the real commit, never only a savepoint. */
	readonly mustOwnCommit: boolean;
}

export interface DrizzleCrudTransactionRunnerContext
	extends CrudAdapterContext, DrizzleCrudTransactionRequirements {}

/** Effective transaction state reported by a runner when it strengthens a request. */
export interface DrizzleCrudEffectiveTransaction {
	readonly accessMode: DrizzleCrudTransactionAccessMode;
	readonly isolationLevel: DrizzleCrudTransactionIsolationLevel;
	/** Whether the runner controls the commit that makes this work durable. */
	readonly ownsCommit: boolean;
}

export interface DrizzleCrudTransactionRunner<
	QueryResult extends PgQueryResultHKT,
	FullSchema extends Record<string, unknown>,
	Schema extends TablesRelationalConfig,
> {
	run<Result>(
		context: DrizzleCrudTransactionRunnerContext,
		workWithTransaction: (
			database: DrizzleCrudDatabase<QueryResult, FullSchema, Schema>,
			/**
			 * Required when the runner uses stronger settings than requested or does not
			 * own the real commit. Omission preserves the legacy exact-request contract.
			 */
			effectiveTransaction?: DrizzleCrudEffectiveTransaction,
		) => Promise<Result>,
	): Promise<Result>;
}

export interface DrizzleCrudRowPredicateContext<Table extends AnyPgTable> {
	readonly table: Table;
	readonly context: CrudAdapterContext;
}

export type DrizzleCrudRowPredicate<Table extends AnyPgTable> = (
	context: DrizzleCrudRowPredicateContext<Table>,
) => SQL | Promise<SQL>;

export interface DrizzleCrudRowPredicateOptions<Table extends AnyPgTable> {
	readonly resolve: DrizzleCrudRowPredicate<Table>;
	/** Minimum transaction settings needed while resolving and applying this predicate. */
	readonly transaction?: Pick<DrizzleCrudTransactionRequirements, "isolationLevel">;
}

/** Minimum transaction settings for the complete CRUD operation lifecycle. */
export type DrizzleCrudOperationTransactionOptions = Pick<
	DrizzleCrudTransactionRequirements,
	"isolationLevel"
>;

export interface DrizzleCrudAdapterOptions<
	Table extends AnyPgTable,
	QueryResult extends PgQueryResultHKT,
	FullSchema extends Record<string, unknown>,
	Schema extends TablesRelationalConfig,
	Columns extends DrizzleCrudColumns<Table> = DrizzleCrudColumns<Table>,
> {
	/** A Drizzle database owned and lifecycle-managed by the consuming application. */
	readonly database: PgDatabase<QueryResult, FullSchema, Schema>;
	readonly table: Table;
	/** Maps public logical field names to columns on `table`. */
	readonly columns: Columns;
	/** Maps logical fields to keys in returned row objects; defaults to the logical field. */
	readonly recordKeys?: Readonly<
		Partial<Record<Extract<keyof Columns, string>, Extract<keyof InferSelectModel<Table>, string>>>
	>;
	/**
	 * Minimum isolation for the complete CRUD operation, including scopes,
	 * lifecycle hooks, validators, mappings, projections, and persistence.
	 *
	 * Declare this when application work inside `adapter.transaction()` may
	 * require a stable snapshot before the adapter issues its first statement.
	 */
	readonly transaction?: DrizzleCrudOperationTransactionOptions;
	/** Wraps standalone work in an application-owned transaction, for example a tenant RLS executor. */
	readonly transactionRunner?: DrizzleCrudTransactionRunner<QueryResult, FullSchema, Schema>;
	/** Adds a native, fail-closed SQL predicate to every read, update, and delete statement. */
	readonly rowPredicate?: DrizzleCrudRowPredicate<Table> | DrizzleCrudRowPredicateOptions<Table>;
}

interface PostgreSqlError {
	readonly code?: unknown;
	readonly cause?: unknown;
}

function postgresCode(error: unknown): string | undefined {
	let current = error;
	for (let depth = 0; depth < 3; depth++) {
		if (typeof current !== "object" || current === null) return undefined;
		const candidate = current as PostgreSqlError;
		if (typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code)) {
			return candidate.code;
		}
		current = candidate.cause;
	}
	return undefined;
}

function databaseError(error: unknown): CrudAdapterError {
	if (isCrudAdapterError(error)) return error;
	const code = postgresCode(error);
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

/*
 * Drizzle intentionally exposes highly stateful query-builder conditional types. Keeping the
 * bridge structural prevents those internals from leaking into this package's public API while
 * the public constructor remains pinned to PgDatabase and a concrete PgTable.
 */
interface DrizzleSelectQuery<Row> extends PromiseLike<readonly Row[]> {
	where(predicate: SQL): DrizzleSelectQuery<Row>;
	orderBy(...order: readonly SQL[]): DrizzleSelectQuery<Row>;
	limit(limit: number): DrizzleSelectQuery<Row>;
	offset(offset: number): DrizzleSelectQuery<Row>;
	$dynamic(): DrizzleSelectQuery<Row>;
}

interface DrizzleReturningQuery<Row> extends PromiseLike<readonly Row[]> {}

interface DrizzleDatabaseExecutor<Row, CreateValues extends object, UpdateValues extends object> {
	select(selection: Readonly<Record<string, unknown>>): {
		from(table: object): DrizzleSelectQuery<Row>;
	};
	insert(table: object): {
		values(values: CreateValues): {
			returning(): DrizzleReturningQuery<Row>;
		};
	};
	update(table: object): {
		set(values: UpdateValues): {
			where(predicate: SQL): { returning(): DrizzleReturningQuery<Row> };
		};
	};
	delete(table: object): {
		where(predicate: SQL): { returning(): DrizzleReturningQuery<Row> };
	};
	$count(table: object, predicate?: SQL): PromiseLike<number>;
}

interface DrizzleSessionState<Row, CreateValues extends object, UpdateValues extends object> {
	readonly executor: DrizzleDatabaseExecutor<Row, CreateValues, UpdateValues>;
	readonly transaction: DrizzleCrudEffectiveTransaction;
}

function strongestIsolationLevel(
	...levels: readonly (DrizzleCrudTransactionIsolationLevel | undefined)[]
): DrizzleCrudTransactionIsolationLevel {
	return levels.includes("repeatable read") ? "repeatable read" : "read committed";
}

function transactionRequirements(
	context: CrudAdapterContext,
	operationIsolationLevel?: DrizzleCrudTransactionIsolationLevel,
	rowPredicateIsolationLevel?: DrizzleCrudTransactionIsolationLevel,
): DrizzleCrudTransactionRequirements {
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
	requirements: DrizzleCrudTransactionRequirements,
	reported: DrizzleCrudEffectiveTransaction | undefined,
): DrizzleCrudEffectiveTransaction {
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
			"The Drizzle transaction runner reported invalid effective transaction state.",
		);
	}
	if (effective.accessMode !== requirements.accessMode) {
		throw new CrudAdapterError(
			"unsupported",
			"The Drizzle transaction runner did not honor the requested access mode.",
		);
	}
	if (
		requirements.isolationLevel === "repeatable read" &&
		effective.isolationLevel !== "repeatable read"
	) {
		throw new CrudAdapterError(
			"unsupported",
			"The Drizzle transaction runner did not honor the required isolation level.",
		);
	}
	if (requirements.mustOwnCommit && !effective.ownsCommit) {
		throw new CrudAdapterError(
			"unsupported",
			"A Drizzle CRUD mutation requires a runner that owns the real commit.",
		);
	}
	return Object.freeze({ ...effective });
}

export class DrizzleCrudAdapter<
	Table extends AnyPgTable,
	QueryResult extends PgQueryResultHKT,
	FullSchema extends Record<string, unknown>,
	Schema extends TablesRelationalConfig,
	Columns extends DrizzleCrudColumns<Table> = DrizzleCrudColumns<Table>,
> implements CrudAdapter<
	InferSelectModel<Table>,
	DrizzleCrudCreateValues<Table>,
	DrizzleCrudUpdateValues<Table>,
	CrudPersistenceField<DrizzleCrudCreateValues<Table>>,
	DrizzleCrudLogicalField<Columns>
> {
	readonly capabilities = Object.freeze({
		transactions: true,
		returning: true,
		compositeIds: true,
		containsInsensitive: true,
	});

	readonly #database: PgDatabase<QueryResult, FullSchema, Schema>;
	readonly #table: Table;
	readonly #columns: DrizzleCrudColumns;
	readonly #recordKeys: Readonly<Partial<Record<string, string>>>;
	readonly #operationIsolationLevel: DrizzleCrudTransactionIsolationLevel | undefined;
	readonly #transactionRunner:
		DrizzleCrudTransactionRunner<QueryResult, FullSchema, Schema> | undefined;
	readonly #rowPredicate: DrizzleCrudRowPredicate<Table> | undefined;
	readonly #rowPredicateIsolationLevel: DrizzleCrudTransactionIsolationLevel | undefined;
	readonly #sessionMarker = Symbol("@nestm/crud-drizzle:session");
	readonly #activeSessions = new WeakSet<
		DrizzleSessionState<
			InferSelectModel<Table>,
			DrizzleCrudCreateValues<Table>,
			DrizzleCrudUpdateValues<Table>
		>
	>();

	constructor(options: DrizzleCrudAdapterOptions<Table, QueryResult, FullSchema, Schema, Columns>) {
		this.#database = options.database;
		this.#table = options.table;
		this.#columns = Object.freeze({ ...options.columns });
		this.#recordKeys = Object.freeze({ ...options.recordKeys });
		this.#operationIsolationLevel = options.transaction?.isolationLevel;
		this.#transactionRunner = options.transactionRunner;
		this.#rowPredicate =
			typeof options.rowPredicate === "function"
				? options.rowPredicate
				: options.rowPredicate?.resolve;
		this.#rowPredicateIsolationLevel =
			typeof options.rowPredicate === "function"
				? undefined
				: options.rowPredicate?.transaction?.isolationLevel;
	}

	async transaction<Result>(
		work: (session: CrudAdapterSession) => Promise<Result>,
		context: CrudAdapterContext,
	): Promise<Result> {
		if (context.session !== undefined) {
			this.#executorFrom(context.session);
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
		input: CrudCreateInput<DrizzleCrudCreateValues<Table>>,
		context: CrudAdapterContext,
	): Promise<InferSelectModel<Table>> {
		try {
			return await this.#withExecutor(
				context,
				{
					accessMode: "read write",
					isolationLevel: strongestIsolationLevel(this.#operationIsolationLevel),
					mustOwnCommit: true,
				},
				false,
				async (database) => {
					const rows = await database.insert(this.#table).values(input.values).returning();
					const record = rows[0];
					if (record === undefined) throw new Error("INSERT did not return a row.");
					return record;
				},
			);
		} catch (error) {
			throw databaseError(error);
		}
	}

	async findOne(
		input: CrudFindOneInput<DrizzleCrudLogicalField<Columns>>,
		context: CrudAdapterContext,
	): Promise<InferSelectModel<Table> | null> {
		try {
			return await this.#withExecutor(
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
				async (database, activeContext) => {
					const predicate = await this.#composeRequiredPredicate(input.predicate, activeContext);
					let query = database
						.select(getTableColumns(this.#table) as Readonly<Record<string, unknown>>)
						.from(this.#table)
						.where(predicate)
						.$dynamic();
					const order = this.#order(input.order ?? []);
					if (order.length > 0) query = query.orderBy(...order);
					const rows = await query.limit(1);
					return rows[0] ?? null;
				},
			);
		} catch (error) {
			throw databaseError(error);
		}
	}

	async findMany(
		input: CrudFindManyInput<DrizzleCrudLogicalField<Columns>>,
		context: CrudAdapterContext,
	): Promise<CrudFindManyResult<InferSelectModel<Table>>> {
		try {
			return await this.#withExecutor(
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
				async (database, activeContext) => {
					const predicate = await this.#composePredicate(input.predicate, activeContext);
					let query = database
						.select(getTableColumns(this.#table) as Readonly<Record<string, unknown>>)
						.from(this.#table)
						.$dynamic();
					if (predicate !== undefined) query = query.where(predicate);
					const order = this.#order(input.order);
					if (order.length > 0) query = query.orderBy(...order);
					query = query.limit(input.limit);
					if (input.offset !== undefined) query = query.offset(input.offset);
					const records = await query;
					if (!input.count) return { records };
					const total = await database.$count(this.#table, predicate);
					return { records, total };
				},
			);
		} catch (error) {
			throw databaseError(error);
		}
	}

	async update(
		input: CrudUpdateInput<DrizzleCrudUpdateValues<Table>, DrizzleCrudLogicalField<Columns>>,
		context: CrudAdapterContext,
	): Promise<InferSelectModel<Table> | null> {
		try {
			return await this.#withExecutor(
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
				async (database, activeContext) => {
					const predicate = await this.#composeRequiredPredicate(input.predicate, activeContext);
					const rows = await database
						.update(this.#table)
						.set(input.values)
						.where(predicate)
						.returning();
					return rows[0] ?? null;
				},
			);
		} catch (error) {
			throw databaseError(error);
		}
	}

	async delete(
		input: CrudDeleteInput<DrizzleCrudLogicalField<Columns>>,
		context: CrudAdapterContext,
	): Promise<InferSelectModel<Table> | null> {
		try {
			return await this.#withExecutor(
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
				async (database, activeContext) => {
					const predicate = await this.#composeRequiredPredicate(input.predicate, activeContext);
					const rows = await database.delete(this.#table).where(predicate).returning();
					return rows[0] ?? null;
				},
			);
		} catch (error) {
			throw databaseError(error);
		}
	}

	getField(record: InferSelectModel<Table>, field: DrizzleCrudLogicalField<Columns>): unknown {
		const key = this.#recordKeys[field] ?? field;
		return (record as Readonly<Record<string, unknown>>)[key];
	}

	async #withExecutor<Result>(
		context: CrudAdapterContext,
		requirements: DrizzleCrudTransactionRequirements,
		forceTransaction: boolean,
		work: (
			database: DrizzleDatabaseExecutor<
				InferSelectModel<Table>,
				DrizzleCrudCreateValues<Table>,
				DrizzleCrudUpdateValues<Table>
			>,
			activeContext: CrudAdapterContext,
		) => Promise<Result>,
	): Promise<Result> {
		if (context.session !== undefined) {
			const state = this.#sessionStateFrom(context.session);
			if (
				requirements.accessMode === "read write" &&
				state.transaction.accessMode === "read only"
			) {
				throw new CrudAdapterError(
					"unsupported",
					"A Drizzle CRUD mutation cannot reuse a read-only transaction.",
				);
			}
			if (
				requirements.isolationLevel === "repeatable read" &&
				state.transaction.isolationLevel !== "repeatable read"
			) {
				throw new CrudAdapterError(
					"unsupported",
					"This Drizzle CRUD operation requires a repeatable-read transaction.",
				);
			}
			if (requirements.mustOwnCommit && !state.transaction.ownsCommit) {
				throw new CrudAdapterError(
					"unsupported",
					"A Drizzle CRUD mutation requires a transaction that owns the real commit.",
				);
			}
			return work(state.executor, context);
		}

		if (
			this.#transactionRunner !== undefined ||
			this.#operationIsolationLevel !== undefined ||
			forceTransaction
		) {
			return this.#runTransaction(
				async (session) =>
					work(this.#executorFrom(session), {
						...context,
						session,
					}),
				context,
				requirements,
			);
		}

		return work(this.#baseExecutor(), context);
	}

	async #runTransaction<Result>(
		work: (session: CrudAdapterSession) => Promise<Result>,
		context: CrudAdapterContext,
		requirements: DrizzleCrudTransactionRequirements,
	): Promise<Result> {
		const transactionContext: DrizzleCrudTransactionRunnerContext = {
			...context,
			...requirements,
		};
		const enter = async (
			database: DrizzleCrudDatabase<QueryResult, FullSchema, Schema>,
			reportedTransaction?: DrizzleCrudEffectiveTransaction,
		): Promise<Result> => {
			if (typeof database !== "object" || database === null) {
				throw new CrudAdapterError(
					"unknown",
					"The Drizzle transaction runner did not provide a database transaction.",
				);
			}
			const effectiveTransaction = resolveEffectiveTransaction(requirements, reportedTransaction);
			const state: DrizzleSessionState<
				InferSelectModel<Table>,
				DrizzleCrudCreateValues<Table>,
				DrizzleCrudUpdateValues<Table>
			> = {
				executor: database as unknown as DrizzleDatabaseExecutor<
					InferSelectModel<Table>,
					DrizzleCrudCreateValues<Table>,
					DrizzleCrudUpdateValues<Table>
				>,
				transaction: effectiveTransaction,
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
			return await this.#database.transaction(enter, {
				accessMode: requirements.accessMode,
				isolationLevel: requirements.isolationLevel,
			});
		} catch (error) {
			if (isCrudAdapterError(error)) throw error;
			if (postgresCode(error) !== undefined) throw databaseError(error);
			throw error;
		}
	}

	async #composePredicate(
		predicate: CrudPredicate | undefined,
		context: CrudAdapterContext,
	): Promise<SQL | undefined> {
		const compiled =
			predicate === undefined ? undefined : compileDrizzlePredicate(predicate, this.#columns);
		if (this.#rowPredicate === undefined) return compiled;
		const nativePredicate = await this.#rowPredicate({ table: this.#table, context });
		if (nativePredicate === undefined || nativePredicate === null) {
			throw new CrudAdapterError(
				"unknown",
				"The configured Drizzle row predicate did not return a SQL expression.",
			);
		}
		return compiled === undefined
			? nativePredicate
			: (and(compiled, nativePredicate) ?? sql`false`);
	}

	async #composeRequiredPredicate(
		predicate: CrudPredicate,
		context: CrudAdapterContext,
	): Promise<SQL> {
		const composed = await this.#composePredicate(predicate, context);
		if (composed === undefined) {
			throw new CrudAdapterError("unknown", "A required Drizzle CRUD predicate was omitted.");
		}
		return composed;
	}

	#baseExecutor(): DrizzleDatabaseExecutor<
		InferSelectModel<Table>,
		DrizzleCrudCreateValues<Table>,
		DrizzleCrudUpdateValues<Table>
	> {
		return this.#database as unknown as DrizzleDatabaseExecutor<
			InferSelectModel<Table>,
			DrizzleCrudCreateValues<Table>,
			DrizzleCrudUpdateValues<Table>
		>;
	}

	#executorFrom(
		session: CrudAdapterSession,
	): DrizzleDatabaseExecutor<
		InferSelectModel<Table>,
		DrizzleCrudCreateValues<Table>,
		DrizzleCrudUpdateValues<Table>
	> {
		return this.#sessionStateFrom(session).executor;
	}

	#sessionStateFrom(
		session: CrudAdapterSession,
	): DrizzleSessionState<
		InferSelectModel<Table>,
		DrizzleCrudCreateValues<Table>,
		DrizzleCrudUpdateValues<Table>
	> {
		if (
			session.adapter !== this.#sessionMarker ||
			typeof session.value !== "object" ||
			session.value === null ||
			!this.#activeSessions.has(
				session.value as DrizzleSessionState<
					InferSelectModel<Table>,
					DrizzleCrudCreateValues<Table>,
					DrizzleCrudUpdateValues<Table>
				>,
			)
		) {
			throw new CrudAdapterError(
				"unknown",
				"A transaction session is foreign or no longer active.",
			);
		}
		return session.value as DrizzleSessionState<
			InferSelectModel<Table>,
			DrizzleCrudCreateValues<Table>,
			DrizzleCrudUpdateValues<Table>
		>;
	}

	#order(order: CrudFindManyInput["order"]): SQL[] {
		return order.map((item) => {
			const column = this.#columns[item.field];
			if (column === undefined) {
				throw new CrudAdapterError(
					"unsupported",
					`The Drizzle adapter does not map CRUD field '${item.field}'.`,
				);
			}
			return item.direction === "asc" ? asc(column) : desc(column);
		});
	}
}

export function createDrizzleCrudAdapter<
	Table extends AnyPgTable,
	QueryResult extends PgQueryResultHKT,
	FullSchema extends Record<string, unknown>,
	Schema extends TablesRelationalConfig,
	const Columns extends DrizzleCrudColumns<Table>,
>(
	options: DrizzleCrudAdapterOptions<Table, QueryResult, FullSchema, Schema, Columns>,
): DrizzleCrudAdapter<Table, QueryResult, FullSchema, Schema, Columns> {
	return new DrizzleCrudAdapter(options);
}
