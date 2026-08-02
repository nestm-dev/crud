import type {
	CrudAdapter,
	CrudAdapterCapabilities,
	CrudAdapterContext,
	CrudAdapterSession,
	CrudCreateInput,
	CrudDeleteInput,
	CrudFindManyInput,
	CrudFindManyResult,
	CrudFindOneInput,
	CrudUpdateInput,
} from "../../src/adapter/adapter.types.ts";
import type { CrudFilterOperator, CrudOrder, CrudPredicate } from "../../src/query/query.types.ts";

export type FakeRecord = Record<string, unknown>;

export class FakeCrudAdapter implements CrudAdapter<FakeRecord> {
	readonly capabilities: CrudAdapterCapabilities;
	readonly events: string[];
	readonly calls = {
		create: 0,
		delete: 0,
		findMany: 0,
		findOne: 0,
		update: 0,
	};

	readonly #adapterId = Symbol("fake-crud-adapter");
	readonly #fieldKeys: Readonly<Record<string, string>>;
	#records: FakeRecord[];
	#nextId: number;

	constructor(
		records: readonly FakeRecord[] = [],
		capabilities: Partial<CrudAdapterCapabilities> = {},
		events: string[] = [],
		fieldKeys: Readonly<Record<string, string>> = {},
	) {
		this.#fieldKeys = fieldKeys;
		this.#records = records.map(cloneRecord);
		this.#nextId = nextNumericId(records, this.#fieldKeys.id ?? "id");
		this.events = events;
		this.capabilities = {
			compositeIds: true,
			containsInsensitive: true,
			returning: true,
			transactions: true,
			...capabilities,
		};
	}

	async transaction<Result>(
		work: (session: CrudAdapterSession) => Promise<Result>,
		_context: CrudAdapterContext,
	): Promise<Result> {
		const working = this.#records.map(cloneRecord);
		const session: CrudAdapterSession = { adapter: this.#adapterId, value: working };
		this.events.push("transaction:begin");
		try {
			const result = await work(session);
			this.#records = working;
			this.events.push("transaction:commit");
			return result;
		} catch (error) {
			this.events.push("transaction:rollback");
			throw error;
		}
	}

	async create(input: CrudCreateInput, context: CrudAdapterContext): Promise<FakeRecord> {
		this.calls.create += 1;
		const records = this.#recordsFor(context);
		const record: FakeRecord = { ...input.values };
		const idKey = this.#fieldKeys.id ?? "id";
		if (record[idKey] === undefined) {
			record[idKey] = this.#nextId;
			this.#nextId += 1;
		}
		records.push(record);
		return cloneRecord(record);
	}

	async findOne(input: CrudFindOneInput, context: CrudAdapterContext): Promise<FakeRecord | null> {
		this.calls.findOne += 1;
		let records = this.#recordsFor(context).filter((record) =>
			matches(record, input.predicate, (item, field) => this.#readField(item, field)),
		);
		if (input.order !== undefined) {
			records = orderRecords(records, input.order, (item, field) => this.#readField(item, field));
		}
		return records[0] === undefined ? null : cloneRecord(records[0]);
	}

	async findMany(
		input: CrudFindManyInput,
		context: CrudAdapterContext,
	): Promise<CrudFindManyResult<FakeRecord>> {
		this.calls.findMany += 1;
		const filtered = this.#recordsFor(context).filter(
			(record) =>
				input.predicate === undefined ||
				matches(record, input.predicate, (item, field) => this.#readField(item, field)),
		);
		const total = filtered.length;
		const offset = input.offset ?? 0;
		const records = orderRecords(filtered, input.order, (item, field) =>
			this.#readField(item, field),
		)
			.slice(offset, offset + input.limit)
			.map(cloneRecord);
		return input.count ? { records, total } : { records };
	}

	async update(input: CrudUpdateInput, context: CrudAdapterContext): Promise<FakeRecord | null> {
		this.calls.update += 1;
		const records = this.#recordsFor(context);
		const index = records.findIndex((record) =>
			matches(record, input.predicate, (item, field) => this.#readField(item, field)),
		);
		if (index < 0) {
			return null;
		}
		const updated = { ...records[index], ...input.values };
		records[index] = updated;
		return cloneRecord(updated);
	}

	async delete(input: CrudDeleteInput, context: CrudAdapterContext): Promise<FakeRecord | null> {
		this.calls.delete += 1;
		const records = this.#recordsFor(context);
		const index = records.findIndex((record) =>
			matches(record, input.predicate, (item, field) => this.#readField(item, field)),
		);
		if (index < 0) {
			return null;
		}
		const [deleted] = records.splice(index, 1);
		return deleted === undefined ? null : cloneRecord(deleted);
	}

	getField(record: FakeRecord, field: string): unknown {
		return this.#readField(record, field);
	}

	snapshot(): readonly FakeRecord[] {
		return this.#records.map(cloneRecord);
	}

	#recordsFor(context: CrudAdapterContext): FakeRecord[] {
		const session = context.session;
		if (session?.adapter === this.#adapterId && Array.isArray(session.value)) {
			return session.value as FakeRecord[];
		}
		return this.#records;
	}

	#readField(record: FakeRecord, field: string): unknown {
		return record[this.#fieldKeys[field] ?? field];
	}
}

function cloneRecord(record: FakeRecord): FakeRecord {
	return { ...record };
}

function nextNumericId(records: readonly FakeRecord[], idKey: string): number {
	let maximum = 0;
	for (const record of records) {
		const id = record[idKey];
		if (typeof id === "number" && Number.isSafeInteger(id)) {
			maximum = Math.max(maximum, id);
		}
	}
	return maximum + 1;
}

type ReadField = (record: FakeRecord, field: string) => unknown;

function matches(record: FakeRecord, predicate: CrudPredicate, readField: ReadField): boolean {
	switch (predicate.kind) {
		case "and":
			return predicate.predicates.every((item) => matches(record, item, readField));
		case "or":
			return predicate.predicates.some((item) => matches(record, item, readField));
		case "not":
			return !matches(record, predicate.predicate, readField);
		case "comparison":
			return matchesComparison(
				readField(record, predicate.field),
				predicate.operator,
				predicate.value,
			);
	}
}

function matchesComparison(
	actual: unknown,
	operator: CrudFilterOperator,
	expected: unknown,
): boolean {
	switch (operator) {
		case "eq":
			return Object.is(actual, expected);
		case "ne":
			return !Object.is(actual, expected);
		case "gt":
			return compareValues(actual, expected) > 0;
		case "gte":
			return compareValues(actual, expected) >= 0;
		case "lt":
			return compareValues(actual, expected) < 0;
		case "lte":
			return compareValues(actual, expected) <= 0;
		case "in":
			return Array.isArray(expected) && expected.some((item) => Object.is(actual, item));
		case "nin":
			return Array.isArray(expected) && expected.every((item) => !Object.is(actual, item));
		case "contains":
			return (
				typeof actual === "string" && typeof expected === "string" && actual.includes(expected)
			);
		case "icontains":
			return (
				typeof actual === "string" &&
				typeof expected === "string" &&
				actual.toLocaleLowerCase().includes(expected.toLocaleLowerCase())
			);
		case "isnull":
			return expected === true
				? actual === null || actual === undefined
				: actual !== null && actual !== undefined;
		case "between":
			return (
				Array.isArray(expected) &&
				expected.length === 2 &&
				compareValues(actual, expected[0]) >= 0 &&
				compareValues(actual, expected[1]) <= 0
			);
	}
}

function orderRecords(
	records: readonly FakeRecord[],
	order: readonly CrudOrder[],
	readField: ReadField,
): FakeRecord[] {
	return [...records].sort((left, right) => {
		for (const item of order) {
			const compared = compareValues(readField(left, item.field), readField(right, item.field));
			if (compared !== 0) {
				return item.direction === "asc" ? compared : -compared;
			}
		}
		return 0;
	});
}

function compareValues(left: unknown, right: unknown): number {
	const normalizedLeft = left instanceof Date ? left.getTime() : left;
	const normalizedRight = right instanceof Date ? right.getTime() : right;
	if (Object.is(normalizedLeft, normalizedRight)) {
		return 0;
	}
	if (normalizedLeft === null || normalizedLeft === undefined) {
		return -1;
	}
	if (normalizedRight === null || normalizedRight === undefined) {
		return 1;
	}
	if (
		(typeof normalizedLeft === "number" && typeof normalizedRight === "number") ||
		(typeof normalizedLeft === "string" && typeof normalizedRight === "string") ||
		(typeof normalizedLeft === "bigint" && typeof normalizedRight === "bigint")
	) {
		return normalizedLeft < normalizedRight ? -1 : 1;
	}
	return stableValueString(normalizedLeft).localeCompare(stableValueString(normalizedRight));
}

function stableValueString(value: unknown): string {
	if (typeof value === "string") return value;
	if (["number", "bigint", "boolean", "symbol"].includes(typeof value)) {
		return String(value);
	}
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return Object.prototype.toString.call(value);
	}
}
