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

export interface TypeOrmCrudAdapterOptions<RecordType extends ObjectLiteral> {
	/** A repository owned and lifecycle-managed by the consuming application. */
	readonly repository: Repository<RecordType>;
	/** Maps public logical field names to TypeORM entity property paths. */
	readonly columns: Readonly<Record<string, string>>;
}

interface PostgreSqlError {
	readonly code?: unknown;
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
	readonly #sessionMarker = Symbol("@nestm/crud-typeorm:session");
	readonly #activeSessions = new WeakSet<object>();

	constructor(options: TypeOrmCrudAdapterOptions<RecordType>) {
		this.#repository = options.repository;
		this.#columns = Object.freeze({ ...options.columns });
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
			this.#managerFrom(context.session);
			return work(context.session);
		}

		let activeManager: EntityManager | undefined;
		try {
			return await this.#repository.manager.transaction(async (manager) => {
				activeManager = manager;
				this.#activeSessions.add(manager);
				return work({ adapter: this.#sessionMarker, value: manager });
			});
		} catch (error) {
			if (isCrudAdapterError(error)) throw error;
			// Preserve application/hook errors; only sanitize recognizable database failures here.
			if (error instanceof QueryFailedError || postgresCode(error) !== undefined)
				throw databaseError(error);
			throw error;
		} finally {
			if (activeManager !== undefined) this.#activeSessions.delete(activeManager);
		}
	}

	async create(
		input: CrudCreateInput<DeepPartial<RecordType>>,
		context: CrudAdapterContext,
	): Promise<RecordType> {
		try {
			const repository = this.#repositoryFor(context);
			const entity = repository.create(input.values);
			return await repository.save(entity);
		} catch (error) {
			throw databaseError(error);
		}
	}

	async findOne(input: CrudFindOneInput, context: CrudAdapterContext): Promise<RecordType | null> {
		try {
			return await this.#findOne(input, context);
		} catch (error) {
			throw databaseError(error);
		}
	}

	async findMany(
		input: CrudFindManyInput,
		context: CrudAdapterContext,
	): Promise<CrudFindManyResult<RecordType>> {
		try {
			const query = this.#query(context);
			if (input.predicate) this.#where(query, input.predicate);
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
		} catch (error) {
			throw databaseError(error);
		}
	}

	async update(
		input: CrudUpdateInput<DeepPartial<RecordType>>,
		context: CrudAdapterContext,
	): Promise<RecordType | null> {
		try {
			const record = await this.#findOne({ predicate: input.predicate }, context, true);
			if (record === null) return null;
			const repository = this.#repositoryFor(context);
			repository.merge(record, input.values);
			return await repository.save(record);
		} catch (error) {
			throw databaseError(error);
		}
	}

	async delete(input: CrudDeleteInput, context: CrudAdapterContext): Promise<RecordType | null> {
		try {
			const record = await this.#findOne({ predicate: input.predicate }, context, true);
			if (record === null) return null;
			const repository = this.#repositoryFor(context);
			const previous = repository.create(record as DeepPartial<RecordType>);
			await repository.remove(record);
			return previous;
		} catch (error) {
			throw databaseError(error);
		}
	}

	getField(record: RecordType, field: string): unknown {
		return getProperty(record, this.#property(field));
	}

	#repositoryFor(context: CrudAdapterContext): Repository<RecordType> {
		const session = context.session;
		if (!session) return this.#repository;
		return this.#managerFrom(session).getRepository(this.#repository.target);
	}

	#managerFrom(session: CrudAdapterSession): EntityManager {
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
		return session.value as EntityManager;
	}

	#query(context: CrudAdapterContext): SelectQueryBuilder<RecordType> {
		return this.#repositoryFor(context).createQueryBuilder("crud_record");
	}

	async #findOne(
		input: CrudFindOneInput,
		context: CrudAdapterContext,
		lock = false,
	): Promise<RecordType | null> {
		const query = this.#query(context);
		this.#where(query, input.predicate);
		for (const order of input.order ?? []) {
			query.addOrderBy(
				this.#fieldExpression(query, order.field),
				order.direction.toUpperCase() as "ASC" | "DESC",
			);
		}
		if (lock && context.session) query.setLock("pessimistic_write");
		return await query.getOne();
	}

	#where(query: SelectQueryBuilder<RecordType>, predicate: CrudFindOneInput["predicate"]): void {
		const compiled = compileTypeOrmPredicate(predicate, (field) =>
			this.#fieldExpression(query, field),
		);
		query.andWhere(compiled.sql, compiled.parameters);
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
