import {
	CrudAdapterError,
	type CrudAdapter,
	type CrudAdapterCapabilities,
	type CrudAdapterContext,
	type CrudAdapterSession,
	type CrudCreateInput,
	type CrudDeleteInput,
	type CrudFindManyInput,
	type CrudFindManyResult,
	type CrudFindOneInput,
	type CrudOrder,
	type CrudPersistenceField,
	type CrudPersistenceFieldTuple,
	type CrudPredicate,
	type CrudUpdateInput,
	type CrudValues,
} from "@nestm/crud/adapter";

import { MemoryCrudStore, type MemoryCrudClone } from "./memory-crud-store.ts";

export type MemoryCrudCreateRecord<RecordType, CreateValues extends object = object> = (
	values: CreateValues,
) => RecordType;
export type MemoryCrudUpdateRecord<RecordType, UpdateValues extends object = object> = (
	record: RecordType,
	values: UpdateValues,
) => RecordType;
export type MemoryCrudField<RecordType> = RecordType extends object
	? CrudPersistenceField<RecordType>
	: string;

export type MemoryCrudGetField<RecordType, Field extends string = MemoryCrudField<RecordType>> = (
	record: RecordType,
	field: Field,
) => unknown;

export interface MemoryCrudAdapterOptions<
	RecordType,
	CreateValues extends object = object,
	UpdateValues extends object = object,
	Field extends string = MemoryCrudField<RecordType>,
> {
	readonly store?: MemoryCrudStore<RecordType>;
	readonly initialRecords?: readonly RecordType[];
	readonly clone?: MemoryCrudClone<RecordType>;
	readonly createRecord?: MemoryCrudCreateRecord<RecordType, CreateValues>;
	readonly updateRecord?: MemoryCrudUpdateRecord<RecordType, UpdateValues>;
	readonly getField?: MemoryCrudGetField<RecordType, Field>;
	/** Logical field tuples that must remain unique. */
	readonly unique?: readonly CrudPersistenceFieldTuple<Field>[];
}

interface MemoryTransaction<RecordType> {
	records: RecordType[];
}

function isObject(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
	return typeof value === "object" && value !== null;
}

function defaultCreateRecord<RecordType, CreateValues extends object>(
	values: CreateValues,
): RecordType {
	return { ...values } as unknown as RecordType;
}

function defaultUpdateRecord<RecordType, UpdateValues extends object>(
	record: RecordType,
	values: UpdateValues,
): RecordType {
	if (!isObject(record)) {
		throw new CrudAdapterError(
			"constraint",
			"The default memory update mapper only supports object records.",
		);
	}
	return { ...record, ...values } as RecordType;
}

function defaultGetField<RecordType>(record: RecordType, field: string): unknown {
	return isObject(record) ? Reflect.get(record, field) : undefined;
}

function valuesEqual(left: unknown, right: unknown): boolean {
	if (left instanceof Date && right instanceof Date) {
		return left.getTime() === right.getTime();
	}
	return Object.is(left, right);
}

function relationalCompare(left: unknown, right: unknown): number | undefined {
	if (left === null || left === undefined || right === null || right === undefined) {
		return undefined;
	}
	if (left instanceof Date && right instanceof Date) {
		return Math.sign(left.getTime() - right.getTime());
	}
	if (typeof left === "number" && typeof right === "number") {
		return Math.sign(left - right);
	}
	if (typeof left === "bigint" && typeof right === "bigint") {
		return left < right ? -1 : left > right ? 1 : 0;
	}
	if (typeof left === "string" && typeof right === "string") {
		return left < right ? -1 : left > right ? 1 : 0;
	}
	if (typeof left === "boolean" && typeof right === "boolean") {
		return left === right ? 0 : left ? 1 : -1;
	}
	return undefined;
}

type SqlTruth = boolean | undefined;

function comparisonTruth(
	actual: unknown,
	predicate: Extract<CrudPredicate, { kind: "comparison" }>,
): SqlTruth {
	const expected = predicate.value;
	switch (predicate.operator) {
		case "eq":
			if (expected === null) return actual === null || actual === undefined;
			if (actual === null || actual === undefined) return undefined;
			return valuesEqual(actual, expected);
		case "ne":
			if (expected === null) return actual !== null && actual !== undefined;
			if (actual === null || actual === undefined) return undefined;
			return !valuesEqual(actual, expected);
		case "gt": {
			const comparison = relationalCompare(actual, expected);
			return comparison === undefined ? undefined : comparison > 0;
		}
		case "gte": {
			const comparison = relationalCompare(actual, expected);
			return comparison === undefined ? undefined : comparison >= 0;
		}
		case "lt": {
			const comparison = relationalCompare(actual, expected);
			return comparison === undefined ? undefined : comparison < 0;
		}
		case "lte": {
			const comparison = relationalCompare(actual, expected);
			return comparison === undefined ? undefined : comparison <= 0;
		}
		case "in": {
			if (!Array.isArray(expected)) return false;
			if (expected.length === 0) return false;
			if (actual === null || actual === undefined) return undefined;
			if (
				expected.some(
					(value) => value !== null && value !== undefined && valuesEqual(actual, value),
				)
			) {
				return true;
			}
			return expected.some((value) => value === null || value === undefined) ? undefined : false;
		}
		case "nin": {
			if (!Array.isArray(expected)) return false;
			if (expected.length === 0) return true;
			if (actual === null || actual === undefined) return undefined;
			if (
				expected.some(
					(value) => value !== null && value !== undefined && valuesEqual(actual, value),
				)
			) {
				return false;
			}
			return expected.some((value) => value === null || value === undefined) ? undefined : true;
		}
		case "contains":
			if (actual === null || actual === undefined) return undefined;
			return (
				typeof actual === "string" && typeof expected === "string" && actual.includes(expected)
			);
		case "icontains":
			if (actual === null || actual === undefined) return undefined;
			return (
				typeof actual === "string" &&
				typeof expected === "string" &&
				actual.toLowerCase().includes(expected.toLowerCase())
			);
		case "isnull":
			return expected === true
				? actual === null || actual === undefined
				: actual !== null && actual !== undefined;
		case "between": {
			if (!Array.isArray(expected) || expected.length !== 2) {
				return false;
			}
			const lower = relationalCompare(actual, expected[0]);
			const upper = relationalCompare(actual, expected[1]);
			return lower === undefined || upper === undefined ? undefined : lower >= 0 && upper <= 0;
		}
		default: {
			const unsupported: never = predicate.operator;
			throw new CrudAdapterError(
				"unsupported",
				`The memory adapter does not support filter operator '${String(unsupported)}'.`,
			);
		}
	}
}

function predicateTruth<RecordType, Field extends string>(
	record: RecordType,
	predicate: CrudPredicate<Field>,
	getField: MemoryCrudGetField<RecordType, Field>,
): SqlTruth {
	switch (predicate.kind) {
		case "comparison":
			return comparisonTruth(getField(record, predicate.field), predicate);
		case "and": {
			let unknown = false;
			for (const child of predicate.predicates) {
				const result = predicateTruth(record, child, getField);
				if (result === false) return false;
				if (result === undefined) unknown = true;
			}
			return unknown ? undefined : true;
		}
		case "or": {
			let unknown = false;
			for (const child of predicate.predicates) {
				const result = predicateTruth(record, child, getField);
				if (result === true) return true;
				if (result === undefined) unknown = true;
			}
			return unknown ? undefined : false;
		}
		case "not": {
			const result = predicateTruth(record, predicate.predicate, getField);
			return result === undefined ? undefined : !result;
		}
		default: {
			const unsupported: never = predicate;
			throw new CrudAdapterError(
				"unsupported",
				`The memory adapter does not support predicate '${String(unsupported)}'.`,
			);
		}
	}
}

function predicateMatches<RecordType, Field extends string>(
	record: RecordType,
	predicate: CrudPredicate<Field>,
	getField: MemoryCrudGetField<RecordType, Field>,
): boolean {
	return predicateTruth(record, predicate, getField) === true;
}

function compareNullable(left: unknown, right: unknown): number {
	if (valuesEqual(left, right)) {
		return 0;
	}
	if (left === null || left === undefined) {
		return 1;
	}
	if (right === null || right === undefined) {
		return -1;
	}
	return (
		relationalCompare(left, right) ??
		stableValueString(left).localeCompare(stableValueString(right))
	);
}

function stableValueString(value: unknown): string {
	if (typeof value === "string") return value;
	if (["number", "bigint", "boolean", "symbol"].includes(typeof value)) {
		return String(value);
	}
	if (value instanceof Date) return value.toISOString();
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return Object.prototype.toString.call(value);
	}
}

function compareRecords<RecordType, Field extends string>(
	left: RecordType,
	right: RecordType,
	order: readonly CrudOrder<Field>[],
	getField: MemoryCrudGetField<RecordType, Field>,
): number {
	for (const item of order) {
		const comparison = compareNullable(getField(left, item.field), getField(right, item.field));
		if (comparison !== 0) {
			return item.direction === "asc" ? comparison : -comparison;
		}
	}
	return 0;
}

/** A deterministic transactional adapter intended for tests, examples, and ephemeral services. */
export class MemoryCrudAdapter<
	RecordType = CrudValues,
	CreateValues extends object = object,
	UpdateValues extends object = object,
	Field extends string = MemoryCrudField<RecordType>,
> implements CrudAdapter<
	RecordType,
	CreateValues,
	UpdateValues,
	CrudPersistenceField<CreateValues>,
	Field
> {
	readonly capabilities: CrudAdapterCapabilities = Object.freeze({
		transactions: true,
		returning: true,
		compositeIds: true,
		containsInsensitive: true,
	});

	readonly store: MemoryCrudStore<RecordType>;
	readonly #createRecord: MemoryCrudCreateRecord<RecordType, CreateValues>;
	readonly #updateRecord: MemoryCrudUpdateRecord<RecordType, UpdateValues>;
	readonly #getField: MemoryCrudGetField<RecordType, Field>;
	readonly #unique: readonly CrudPersistenceFieldTuple<Field>[];
	readonly #sessionKey = Symbol("@nestm/crud-memory:session");
	readonly #activeTransactions = new WeakSet<object>();
	#writeTail: Promise<void> = Promise.resolve();

	constructor(
		options: MemoryCrudAdapterOptions<RecordType, CreateValues, UpdateValues, Field> = {},
	) {
		if (
			options.store !== undefined &&
			(options.initialRecords !== undefined || options.clone !== undefined)
		) {
			throw new TypeError("MemoryCrudAdapter cannot combine store with initialRecords or clone.");
		}
		this.store =
			options.store ??
			new MemoryCrudStore<RecordType>({
				...(options.initialRecords === undefined ? {} : { initialRecords: options.initialRecords }),
				...(options.clone === undefined ? {} : { clone: options.clone }),
			});
		this.#createRecord = options.createRecord ?? defaultCreateRecord;
		this.#updateRecord = options.updateRecord ?? defaultUpdateRecord;
		this.#getField = options.getField ?? defaultGetField;
		this.#unique = options.unique ?? [];
		for (const constraint of this.#unique) {
			if (constraint.length === 0) {
				throw new TypeError("Memory CRUD unique constraints must contain at least one field.");
			}
		}
	}

	async transaction<Result>(
		work: (session: CrudAdapterSession) => Promise<Result>,
		context: CrudAdapterContext,
	): Promise<Result> {
		if (context.session !== undefined) {
			this.#transactionFrom(context);
			return work(context.session);
		}

		return this.#withWriteLock(async () => {
			const transaction: MemoryTransaction<RecordType> = {
				records: [...this.store.snapshot()],
			};
			this.#activeTransactions.add(transaction);
			const session: CrudAdapterSession = {
				adapter: this.#sessionKey,
				value: transaction,
			};
			try {
				const result = await work(session);
				this.store.replace(transaction.records);
				return result;
			} finally {
				this.#activeTransactions.delete(transaction);
			}
		});
	}

	async create(
		input: CrudCreateInput<CreateValues>,
		context: CrudAdapterContext,
	): Promise<RecordType> {
		const transaction = this.#optionalTransaction(context);
		if (transaction !== undefined) {
			return this.#createIn(transaction.records, input);
		}
		return this.#withWriteLock(async () => {
			const records = [...this.store.snapshot()];
			const created = this.#createIn(records, input);
			this.store.replace(records);
			return created;
		});
	}

	async findOne(
		input: CrudFindOneInput<Field>,
		context: CrudAdapterContext,
	): Promise<RecordType | null> {
		const records = this.#recordsFor(context);
		const matches = records.filter((record) =>
			predicateMatches(record, input.predicate, this.#getField),
		);
		const ordered =
			input.order === undefined
				? matches
				: matches.toSorted((left, right) =>
						compareRecords(left, right, input.order!, this.#getField),
					);
		return ordered[0] === undefined ? null : this.store.clone(ordered[0]);
	}

	async findMany(
		input: CrudFindManyInput<Field>,
		context: CrudAdapterContext,
	): Promise<CrudFindManyResult<RecordType>> {
		const records = this.#recordsFor(context)
			.filter(
				(record) =>
					input.predicate === undefined ||
					predicateMatches(record, input.predicate, this.#getField),
			)
			.toSorted((left, right) => compareRecords(left, right, input.order, this.#getField));
		const total = records.length;
		const offset = input.offset ?? 0;
		const page = records
			.slice(offset, offset + input.limit)
			.map((record) => this.store.clone(record));
		return input.count ? { records: page, total } : { records: page };
	}

	async update(
		input: CrudUpdateInput<UpdateValues, Field>,
		context: CrudAdapterContext,
	): Promise<RecordType | null> {
		const transaction = this.#optionalTransaction(context);
		if (transaction !== undefined) {
			return this.#updateIn(transaction.records, input);
		}
		return this.#withWriteLock(async () => {
			const records = [...this.store.snapshot()];
			const updated = this.#updateIn(records, input);
			if (updated !== null) {
				this.store.replace(records);
			}
			return updated;
		});
	}

	async delete(
		input: CrudDeleteInput<Field>,
		context: CrudAdapterContext,
	): Promise<RecordType | null> {
		const transaction = this.#optionalTransaction(context);
		if (transaction !== undefined) {
			return this.#deleteIn(transaction.records, input);
		}
		return this.#withWriteLock(async () => {
			const records = [...this.store.snapshot()];
			const deleted = this.#deleteIn(records, input);
			if (deleted !== null) {
				this.store.replace(records);
			}
			return deleted;
		});
	}

	getField(record: RecordType, field: Field): unknown {
		return this.#getField(record, field);
	}

	#createIn(records: RecordType[], input: CrudCreateInput<CreateValues>): RecordType {
		const created = this.#createRecord(input.values);
		this.#assertUnique(records, created);
		records.push(this.store.clone(created));
		return this.store.clone(created);
	}

	#updateIn(records: RecordType[], input: CrudUpdateInput<UpdateValues, Field>): RecordType | null {
		const index = records.findIndex((record) =>
			predicateMatches(record, input.predicate, this.#getField),
		);
		if (index < 0) {
			return null;
		}
		const current = records[index]!;
		const updated = this.#updateRecord(this.store.clone(current), input.values);
		this.#assertUnique(records, updated, index);
		records[index] = this.store.clone(updated);
		return this.store.clone(updated);
	}

	#deleteIn(records: RecordType[], input: CrudDeleteInput<Field>): RecordType | null {
		const index = records.findIndex((record) =>
			predicateMatches(record, input.predicate, this.#getField),
		);
		if (index < 0) {
			return null;
		}
		const [deleted] = records.splice(index, 1);
		return deleted === undefined ? null : this.store.clone(deleted);
	}

	#assertUnique(records: readonly RecordType[], candidate: RecordType, ignoredIndex = -1): void {
		for (const fields of this.#unique) {
			// PostgreSQL unique constraints treat null values as distinct by default.
			if (fields.some((field) => this.#getField(candidate, field) == null)) {
				continue;
			}
			const conflict = records.some(
				(record, index) =>
					index !== ignoredIndex &&
					fields.every((field) => this.#getField(record, field) != null) &&
					fields.every((field) =>
						valuesEqual(this.#getField(record, field), this.#getField(candidate, field)),
					),
			);
			if (conflict) {
				throw new CrudAdapterError(
					"conflict",
					"A record with the same unique values already exists.",
				);
			}
		}
	}

	#recordsFor(context: CrudAdapterContext): readonly RecordType[] {
		return this.#optionalTransaction(context)?.records ?? this.store.snapshot();
	}

	#optionalTransaction(context: CrudAdapterContext): MemoryTransaction<RecordType> | undefined {
		return context.session === undefined ? undefined : this.#transactionFrom(context);
	}

	#transactionFrom(context: CrudAdapterContext): MemoryTransaction<RecordType> {
		const session = context.session;
		if (
			session === undefined ||
			session.adapter !== this.#sessionKey ||
			!isObject(session.value) ||
			!this.#activeTransactions.has(session.value)
		) {
			throw new CrudAdapterError("unknown", "Invalid or expired memory CRUD transaction session.");
		}
		return session.value as unknown as MemoryTransaction<RecordType>;
	}

	async #withWriteLock<Result>(work: () => Promise<Result>): Promise<Result> {
		const previous = this.#writeTail;
		let release: (() => void) | undefined;
		this.#writeTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await work();
		} finally {
			release?.();
		}
	}
}
