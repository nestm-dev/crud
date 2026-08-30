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
	CrudUpdateInput,
	CrudValues,
} from "@nestm/crud/adapter";

import {
	compilePrismaOrder,
	compilePrismaPredicate,
	type PrismaCrudFields,
	type PrismaCrudOrderBy,
	type PrismaCrudWhere,
} from "./prisma-predicate.ts";

type FirstParameter<Method> = Method extends (...arguments_: infer Parameters) => unknown
	? Parameters extends readonly [infer First, ...(readonly unknown[])]
		? First
		: never
	: never;

type MethodArgument<Delegate, Method extends PropertyKey> = Method extends keyof Delegate
	? FirstParameter<Delegate[Method]>
	: never;

type ObjectArgumentProperty<Argument, Property extends PropertyKey> = Argument extends object
	? Property extends keyof Argument
		? Extract<Argument[Property], object>
		: never
	: never;

type PersistenceValuesOrDefault<Values> = [Values] extends [never]
	? CrudValues
	: Values extends object
		? Values
		: CrudValues;

/** Native `data` accepted by a generated Prisma model delegate's `create` method. */
export type PrismaCrudCreateValues<Delegate> = PersistenceValuesOrDefault<
	ObjectArgumentProperty<MethodArgument<Delegate, "create">, "data">
>;

/** Native `data` accepted by a generated Prisma model delegate's `update` method. */
export type PrismaCrudUpdateValues<Delegate> = PersistenceValuesOrDefault<
	ObjectArgumentProperty<MethodArgument<Delegate, "update">, "data">
>;

/** Native unique selector accepted by a generated Prisma model delegate. */
export type PrismaCrudWhereUnique<Delegate> = PersistenceValuesOrDefault<
	ObjectArgumentProperty<MethodArgument<Delegate, "update">, "where">
>;

export type PrismaCrudRecordField<RecordType> = RecordType extends object
	? CrudPersistenceField<RecordType>
	: string;

export type PrismaCrudModelField<RecordType, Delegate> = RecordType extends object
	? CrudPersistenceField<
			RecordType & PrismaCrudCreateValues<Delegate> & PrismaCrudUpdateValues<Delegate>
		>
	: CrudPersistenceField<PrismaCrudCreateValues<Delegate> & PrismaCrudUpdateValues<Delegate>>;

export type PrismaCrudLogicalField<RecordType, Fields extends PrismaCrudFields> =
	| PrismaCrudRecordField<RecordType>
	| (string extends Extract<keyof Fields, string> ? never : Extract<keyof Fields, string>);

export interface PrismaCrudAdapterOptions<
	RecordType,
	Client,
	Delegate,
	Fields extends PrismaCrudFields<PrismaCrudModelField<RecordType, Delegate>> = PrismaCrudFields<
		PrismaCrudModelField<RecordType, Delegate>
	>,
> {
	/** A generated PrismaClient owned and lifecycle-managed by the consuming application. */
	readonly client: Client;
	/** Selects a generated model delegate, for example `(client) => client.user`. */
	readonly delegate: (client: Client) => Delegate;
	/** Returns the model's native `WhereUniqueInput`, including named compound selectors. */
	readonly identity: (record: RecordType) => Readonly<PrismaCrudWhereUnique<Delegate>>;
	/** Maps public logical field names to Prisma model field names. */
	readonly fields?: Fields;
	/** Maps logical fields to keys in returned records; defaults to `fields[field]` or `field`. */
	readonly recordKeys?: Readonly<
		Partial<Record<PrismaCrudLogicalField<RecordType, Fields>, PrismaCrudRecordField<RecordType>>>
	>;
	/** Logical fields whose Prisma model columns are required (used to compile `isnull` safely). */
	readonly nonNullableFields?: readonly PrismaCrudLogicalField<RecordType, Fields>[];
}

interface PrismaTransactionHost {
	$transaction<Result>(work: (transaction: unknown) => Promise<Result>): Promise<Result>;
}

interface PrismaDelegate<RecordType, CreateValues extends object, UpdateValues extends object> {
	create(args: { readonly data: CreateValues }): PromiseLike<RecordType>;
	findFirst(args: {
		readonly where: PrismaCrudWhere;
		readonly orderBy?: readonly PrismaCrudOrderBy[];
	}): PromiseLike<RecordType | null>;
	findMany(args: {
		readonly where?: PrismaCrudWhere;
		readonly orderBy: readonly PrismaCrudOrderBy[];
		readonly skip?: number;
		readonly take: number;
	}): PromiseLike<readonly RecordType[]>;
	count(args: { readonly where?: PrismaCrudWhere }): PromiseLike<number>;
	update(args: {
		readonly where: Readonly<Record<string, unknown>>;
		readonly data: UpdateValues;
	}): PromiseLike<RecordType>;
	delete(args: { readonly where: Readonly<Record<string, unknown>> }): PromiseLike<RecordType>;
}

interface PrismaError {
	readonly code?: unknown;
	readonly cause?: unknown;
}

function prismaCode(error: unknown): string | undefined {
	let current = error;
	for (let depth = 0; depth < 3; depth++) {
		if (typeof current !== "object" || current === null) return undefined;
		const candidate = current as PrismaError;
		if (typeof candidate.code === "string" && /^P\d{4}$/.test(candidate.code))
			return candidate.code;
		current = candidate.cause;
	}
	return undefined;
}

function databaseError(error: unknown): CrudAdapterError {
	if (isCrudAdapterError(error)) return error;
	const code = prismaCode(error);
	if (code === "P2002") {
		return new CrudAdapterError(
			"conflict",
			"A record with the same unique values already exists.",
			{ cause: error },
		);
	}
	if (["P2000", "P2003", "P2004", "P2011", "P2014"].includes(code ?? "")) {
		return new CrudAdapterError("constraint", "The mutation violates a database constraint.", {
			cause: error,
		});
	}
	return new CrudAdapterError("unknown", "The database operation failed.", { cause: error });
}

function mutationWhere(
	identity: Readonly<Record<string, unknown>>,
	predicate: PrismaCrudWhere,
): Readonly<Record<string, unknown>> {
	if (Object.keys(identity).length === 0) {
		throw new CrudAdapterError(
			"unsupported",
			"Prisma CRUD identity mappings must return at least one unique field.",
		);
	}
	return { ...identity, AND: [predicate] };
}

export class PrismaCrudAdapter<
	RecordType,
	Client,
	Delegate,
	CreateValues extends object = PrismaCrudCreateValues<Delegate>,
	UpdateValues extends object = PrismaCrudUpdateValues<Delegate>,
	Fields extends PrismaCrudFields<PrismaCrudModelField<RecordType, Delegate>> = PrismaCrudFields<
		PrismaCrudModelField<RecordType, Delegate>
	>,
> implements CrudAdapter<
	RecordType,
	CreateValues,
	UpdateValues,
	CrudPersistenceField<CreateValues>,
	PrismaCrudLogicalField<RecordType, Fields>
> {
	readonly capabilities = Object.freeze({
		transactions: true,
		returning: true,
		compositeIds: true,
		containsInsensitive: true,
	});

	readonly #client: Client;
	readonly #delegateFactory: (client: Client) => Delegate;
	readonly #identity: (record: RecordType) => Readonly<Record<string, unknown>>;
	readonly #fields: PrismaCrudFields;
	readonly #recordKeys: Readonly<Partial<Record<string, string>>>;
	readonly #nonNullableFields: ReadonlySet<string>;
	readonly #sessionMarker = Symbol("@nestm/crud-prisma:session");
	readonly #activeSessions = new WeakSet<object>();

	constructor(options: PrismaCrudAdapterOptions<RecordType, Client, Delegate, Fields>) {
		if (
			typeof options.client !== "object" ||
			options.client === null ||
			typeof (options.client as Readonly<Record<string, unknown>>).$transaction !== "function"
		) {
			throw new TypeError(
				"The Prisma CRUD adapter requires a PrismaClient with interactive transactions.",
			);
		}
		this.#client = options.client;
		this.#delegateFactory = options.delegate;
		this.#identity = options.identity;
		this.#fields = Object.freeze({ ...options.fields });
		this.#recordKeys = Object.freeze({ ...options.recordKeys });
		this.#nonNullableFields = new Set(options.nonNullableFields ?? []);
	}

	async transaction<Result>(
		work: (session: CrudAdapterSession) => Promise<Result>,
		context: CrudAdapterContext,
	): Promise<Result> {
		if (context.session !== undefined) {
			this.#clientFrom(context.session);
			return work(context.session);
		}

		let activeTransaction: object | undefined;
		try {
			const host = this.#client as unknown as PrismaTransactionHost;
			return await host.$transaction(async (transaction) => {
				if (typeof transaction !== "object" || transaction === null) {
					throw new CrudAdapterError("unknown", "Prisma returned an invalid transaction client.");
				}
				activeTransaction = transaction;
				this.#activeSessions.add(transaction);
				return work({ adapter: this.#sessionMarker, value: transaction });
			});
		} catch (error) {
			if (isCrudAdapterError(error)) throw error;
			if (prismaCode(error) !== undefined) throw databaseError(error);
			throw error;
		} finally {
			if (activeTransaction !== undefined) this.#activeSessions.delete(activeTransaction);
		}
	}

	async create(
		input: CrudCreateInput<CreateValues>,
		context: CrudAdapterContext,
	): Promise<RecordType> {
		try {
			return await this.#delegate(context).create({ data: input.values });
		} catch (error) {
			throw databaseError(error);
		}
	}

	async findOne(
		input: CrudFindOneInput<PrismaCrudLogicalField<RecordType, Fields>>,
		context: CrudAdapterContext,
	): Promise<RecordType | null> {
		try {
			return await this.#delegate(context).findFirst({
				where: compilePrismaPredicate(input.predicate, this.#fields, this.#nonNullableFields),
				...(input.order === undefined
					? {}
					: { orderBy: compilePrismaOrder(input.order, this.#fields) }),
			});
		} catch (error) {
			throw databaseError(error);
		}
	}

	async findMany(
		input: CrudFindManyInput<PrismaCrudLogicalField<RecordType, Fields>>,
		context: CrudAdapterContext,
	): Promise<CrudFindManyResult<RecordType>> {
		try {
			const delegate = this.#delegate(context);
			const where = input.predicate
				? compilePrismaPredicate(input.predicate, this.#fields, this.#nonNullableFields)
				: undefined;
			const records = await delegate.findMany({
				...(where === undefined ? {} : { where }),
				orderBy: compilePrismaOrder(input.order, this.#fields),
				...(input.offset === undefined ? {} : { skip: input.offset }),
				take: input.limit,
			});
			if (!input.count) return { records };
			return {
				records,
				total: await delegate.count(where === undefined ? {} : { where }),
			};
		} catch (error) {
			throw databaseError(error);
		}
	}

	async update(
		input: CrudUpdateInput<UpdateValues, PrismaCrudLogicalField<RecordType, Fields>>,
		context: CrudAdapterContext,
	): Promise<RecordType | null> {
		try {
			const delegate = this.#delegate(context);
			const predicate = compilePrismaPredicate(
				input.predicate,
				this.#fields,
				this.#nonNullableFields,
			);
			const current = await delegate.findFirst({ where: predicate });
			if (current === null) return null;
			return await delegate.update({
				where: mutationWhere(this.#identity(current), predicate),
				data: input.values,
			});
		} catch (error) {
			if (prismaCode(error) === "P2025") return null;
			throw databaseError(error);
		}
	}

	async delete(
		input: CrudDeleteInput<PrismaCrudLogicalField<RecordType, Fields>>,
		context: CrudAdapterContext,
	): Promise<RecordType | null> {
		try {
			const delegate = this.#delegate(context);
			const predicate = compilePrismaPredicate(
				input.predicate,
				this.#fields,
				this.#nonNullableFields,
			);
			const current = await delegate.findFirst({ where: predicate });
			if (current === null) return null;
			return await delegate.delete({
				where: mutationWhere(this.#identity(current), predicate),
			});
		} catch (error) {
			if (prismaCode(error) === "P2025") return null;
			throw databaseError(error);
		}
	}

	getField(record: RecordType, field: PrismaCrudLogicalField<RecordType, Fields>): unknown {
		if (typeof record !== "object" || record === null) return undefined;
		const key = this.#recordKeys[field] ?? this.#fields[field] ?? field;
		return (record as Readonly<Record<string, unknown>>)[key];
	}

	#delegate(context: CrudAdapterContext): PrismaDelegate<RecordType, CreateValues, UpdateValues> {
		const session = context.session;
		const client = session === undefined ? this.#client : this.#clientFrom(session);
		return this.#delegateFactory(client) as unknown as PrismaDelegate<
			RecordType,
			CreateValues,
			UpdateValues
		>;
	}

	#clientFrom(session: CrudAdapterSession): Client {
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
		// Prisma's TransactionClient is deliberately a narrowed PrismaClient; model delegates are shared.
		return session.value as Client;
	}
}

export function createPrismaCrudAdapter<
	RecordType,
	Client,
	Delegate,
	CreateValues extends object = PrismaCrudCreateValues<Delegate>,
	UpdateValues extends object = PrismaCrudUpdateValues<Delegate>,
	const Fields extends PrismaCrudFields<PrismaCrudModelField<RecordType, Delegate>> =
		PrismaCrudFields<PrismaCrudModelField<RecordType, Delegate>>,
>(
	options: PrismaCrudAdapterOptions<RecordType, Client, Delegate, Fields>,
): PrismaCrudAdapter<RecordType, Client, Delegate, CreateValues, UpdateValues, Fields> {
	return new PrismaCrudAdapter(options);
}
