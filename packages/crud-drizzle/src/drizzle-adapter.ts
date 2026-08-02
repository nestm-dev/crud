import { CrudAdapterError } from "@nestm/crud/adapter";
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
	asc,
	desc,
	getTableColumns,
	type InferInsertModel,
	type InferSelectModel,
	type SQL,
	type TablesRelationalConfig,
} from "drizzle-orm";
import type { AnyPgTable, PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { compileDrizzlePredicate, type DrizzleCrudColumns } from "./drizzle-predicate.ts";

export type DrizzleCrudCreateValues<Table extends AnyPgTable> = InferInsertModel<Table>;
export type DrizzleCrudUpdateValues<Table extends AnyPgTable> = Partial<InferInsertModel<Table>>;

export interface DrizzleCrudAdapterOptions<
	Table extends AnyPgTable,
	QueryResult extends PgQueryResultHKT,
	FullSchema extends Record<string, unknown>,
	Schema extends TablesRelationalConfig,
> {
	/** A Drizzle database owned and lifecycle-managed by the consuming application. */
	readonly database: PgDatabase<QueryResult, FullSchema, Schema>;
	readonly table: Table;
	/** Maps public logical field names to columns on `table`. */
	readonly columns: DrizzleCrudColumns;
	/** Maps logical fields to keys in returned row objects; defaults to the logical field. */
	readonly recordKeys?: Readonly<Record<string, string>>;
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
	const code = postgresCode(error);
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

export class DrizzleCrudAdapter<
	Table extends AnyPgTable,
	QueryResult extends PgQueryResultHKT,
	FullSchema extends Record<string, unknown>,
	Schema extends TablesRelationalConfig,
> implements CrudAdapter<
	InferSelectModel<Table>,
	DrizzleCrudCreateValues<Table>,
	DrizzleCrudUpdateValues<Table>
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
	readonly #recordKeys: Readonly<Record<string, string>>;
	readonly #sessionMarker = Symbol("@nestm/crud-drizzle:session");
	readonly #activeSessions = new WeakSet<object>();

	constructor(options: DrizzleCrudAdapterOptions<Table, QueryResult, FullSchema, Schema>) {
		this.#database = options.database;
		this.#table = options.table;
		this.#columns = Object.freeze({ ...options.columns });
		this.#recordKeys = Object.freeze({ ...options.recordKeys });
	}

	async transaction<Result>(
		work: (session: CrudAdapterSession) => Promise<Result>,
		context: CrudAdapterContext,
	): Promise<Result> {
		if (context.session !== undefined) {
			this.#executorFrom(context.session);
			return work(context.session);
		}

		let activeTransaction: object | undefined;
		try {
			return await this.#database.transaction(async (transaction) => {
				activeTransaction = transaction;
				this.#activeSessions.add(transaction);
				return work({ adapter: this.#sessionMarker, value: transaction });
			});
		} catch (error) {
			if (error instanceof CrudAdapterError) throw error;
			if (postgresCode(error) !== undefined) throw databaseError(error);
			throw error;
		} finally {
			if (activeTransaction !== undefined) this.#activeSessions.delete(activeTransaction);
		}
	}

	async create(
		input: CrudCreateInput<DrizzleCrudCreateValues<Table>>,
		context: CrudAdapterContext,
	): Promise<InferSelectModel<Table>> {
		try {
			const rows = await this.#databaseFor(context)
				.insert(this.#table)
				.values(input.values)
				.returning();
			const record = rows[0];
			if (record === undefined) throw new Error("INSERT did not return a row.");
			return record;
		} catch (error) {
			throw databaseError(error);
		}
	}

	async findOne(
		input: CrudFindOneInput,
		context: CrudAdapterContext,
	): Promise<InferSelectModel<Table> | null> {
		try {
			const database = this.#databaseFor(context);
			let query = database
				.select(getTableColumns(this.#table) as Readonly<Record<string, unknown>>)
				.from(this.#table)
				.where(compileDrizzlePredicate(input.predicate, this.#columns))
				.$dynamic();
			const order = this.#order(input.order ?? []);
			if (order.length > 0) query = query.orderBy(...order);
			const rows = await query.limit(1);
			return rows[0] ?? null;
		} catch (error) {
			throw databaseError(error);
		}
	}

	async findMany(
		input: CrudFindManyInput,
		context: CrudAdapterContext,
	): Promise<CrudFindManyResult<InferSelectModel<Table>>> {
		try {
			const database = this.#databaseFor(context);
			const predicate = input.predicate
				? compileDrizzlePredicate(input.predicate, this.#columns)
				: undefined;
			let query = database
				.select(getTableColumns(this.#table) as Readonly<Record<string, unknown>>)
				.from(this.#table)
				.$dynamic();
			if (predicate) query = query.where(predicate);
			const order = this.#order(input.order);
			if (order.length > 0) query = query.orderBy(...order);
			query = query.limit(input.limit);
			if (input.offset !== undefined) query = query.offset(input.offset);
			const records = await query;
			if (!input.count) return { records };
			const total = await database.$count(this.#table, predicate);
			return { records, total };
		} catch (error) {
			throw databaseError(error);
		}
	}

	async update(
		input: CrudUpdateInput<DrizzleCrudUpdateValues<Table>>,
		context: CrudAdapterContext,
	): Promise<InferSelectModel<Table> | null> {
		try {
			const rows = await this.#databaseFor(context)
				.update(this.#table)
				.set(input.values)
				.where(compileDrizzlePredicate(input.predicate, this.#columns))
				.returning();
			return rows[0] ?? null;
		} catch (error) {
			throw databaseError(error);
		}
	}

	async delete(
		input: CrudDeleteInput,
		context: CrudAdapterContext,
	): Promise<InferSelectModel<Table> | null> {
		try {
			const rows = await this.#databaseFor(context)
				.delete(this.#table)
				.where(compileDrizzlePredicate(input.predicate, this.#columns))
				.returning();
			return rows[0] ?? null;
		} catch (error) {
			throw databaseError(error);
		}
	}

	getField(record: InferSelectModel<Table>, field: string): unknown {
		const key = this.#recordKeys[field] ?? field;
		return (record as Readonly<Record<string, unknown>>)[key];
	}

	#databaseFor(
		context: CrudAdapterContext,
	): DrizzleDatabaseExecutor<
		InferSelectModel<Table>,
		DrizzleCrudCreateValues<Table>,
		DrizzleCrudUpdateValues<Table>
	> {
		const session = context.session;
		if (!session)
			return this.#database as unknown as DrizzleDatabaseExecutor<
				InferSelectModel<Table>,
				DrizzleCrudCreateValues<Table>,
				DrizzleCrudUpdateValues<Table>
			>;
		return this.#executorFrom(session);
	}

	#executorFrom(
		session: CrudAdapterSession,
	): DrizzleDatabaseExecutor<
		InferSelectModel<Table>,
		DrizzleCrudCreateValues<Table>,
		DrizzleCrudUpdateValues<Table>
	> {
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
		return session.value as DrizzleDatabaseExecutor<
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
>(
	options: DrizzleCrudAdapterOptions<Table, QueryResult, FullSchema, Schema>,
): DrizzleCrudAdapter<Table, QueryResult, FullSchema, Schema> {
	return new DrizzleCrudAdapter(options);
}
