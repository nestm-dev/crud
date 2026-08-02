import { CrudAdapterError } from "../adapter/adapter.error.ts";
import type {
	CrudAdapter,
	CrudAdapterContext,
	CrudAdapterSession,
	CrudValues,
} from "../adapter/adapter.types.ts";

export interface CrudAdapterConformanceFixture<RecordType> {
	readonly adapter: CrudAdapter<RecordType>;
	readonly first: CrudValues;
	readonly second: CrudValues;
	readonly update: CrudValues;
	readonly idField: string;
	readonly sortField: string;
	/** IDs in the exact order produced by sorting `sortField` ascending. */
	readonly expectedAscendingIds: readonly [unknown, unknown];
	readonly getId: (record: RecordType) => unknown;
}

export interface CrudAdapterConformanceCase<RecordType> {
	readonly name: string;
	readonly run: (fixture: CrudAdapterConformanceFixture<RecordType>) => Promise<void>;
}

/**
 * Framework-independent conformance cases. Adapter packages can register these
 * with Vitest, Jest, or another runner without making one a runtime dependency.
 */
export function createCrudAdapterConformanceCases<
	RecordType,
>(): readonly CrudAdapterConformanceCase<RecordType>[] {
	return [
		{
			name: "creates a record and reads it back by predicate",
			run: async (fixture) => {
				const created = await fixture.adapter.create(
					{ values: fixture.first },
					adapterContext("create"),
				);
				const expectedId = fixture.first[fixture.idField];
				assertSame(fixture.getId(created), expectedId, "create returned the wrong identity.");
				assertSame(
					fixture.adapter.getField(created, fixture.idField),
					expectedId,
					"getField did not read the configured identity field.",
				);
				assertSame(
					fixture.adapter.getField(created, fixture.sortField),
					fixture.first[fixture.sortField],
					"getField did not read the configured sort field.",
				);

				const found = await fixture.adapter.findOne(
					{ predicate: comparison(fixture.idField, "eq", expectedId) },
					adapterContext("read"),
				);
				assert(found !== null, "findOne did not return the created record.");
				assertSame(fixture.getId(found), expectedId, "findOne returned a different record.");
			},
		},
		{
			name: "returns exact counted and uncounted ordered pages",
			run: async (fixture) => {
				await seedPair(fixture);
				const order = [{ field: fixture.sortField, direction: "asc" as const }];
				const uncounted = await fixture.adapter.findMany(
					{ order, limit: 2, count: false },
					adapterContext("list"),
				);
				assertIds(
					uncounted.records,
					fixture.expectedAscendingIds,
					fixture.getId,
					"uncounted findMany returned the wrong order",
				);
				assert(
					uncounted.total === undefined && !("total" in uncounted),
					"uncounted findMany returned a total.",
				);

				const counted = await fixture.adapter.findMany(
					{ order, offset: 1, limit: 1, count: true },
					adapterContext("list"),
				);
				assert(counted.total === 2, `counted findMany returned total ${String(counted.total)}.`);
				assertIds(
					counted.records,
					[fixture.expectedAscendingIds[1]],
					fixture.getId,
					"findMany ignored ordering or offset",
				);
			},
		},
		{
			name: "updates and deletes one record and reports missing mutations",
			run: async (fixture) => {
				const created = await fixture.adapter.create(
					{ values: fixture.first },
					adapterContext("create"),
				);
				const id = fixture.getId(created);
				const predicate = comparison(fixture.idField, "eq", id);
				const updated = await fixture.adapter.update(
					{ predicate, values: fixture.update },
					adapterContext("update"),
				);
				assert(updated !== null, "update did not return the affected record.");
				assertSame(fixture.getId(updated), id, "update changed the record identity.");
				for (const [field, value] of Object.entries(fixture.update)) {
					assertSame(
						fixture.adapter.getField(updated, field),
						value,
						`update did not return the new '${field}' value.`,
					);
				}

				const deleted = await fixture.adapter.delete({ predicate }, adapterContext("delete"));
				assert(deleted !== null, "delete did not return the affected record.");
				assertSame(fixture.getId(deleted), id, "delete returned a different record.");
				assert(
					(await fixture.adapter.findOne({ predicate }, adapterContext("read"))) === null,
					"deleted record remained visible.",
				);
				assert(
					(await fixture.adapter.update(
						{ predicate, values: fixture.update },
						adapterContext("update"),
					)) === null,
					"update did not return null for a missing record.",
				);
				assert(
					(await fixture.adapter.delete({ predicate }, adapterContext("delete"))) === null,
					"delete did not return null for a missing record.",
				);
			},
		},
		{
			name: "commits a successful transaction",
			run: async (fixture) => {
				const context = adapterContext("create");
				const expectedId = fixture.first[fixture.idField];
				const returnedId = await fixture.adapter.transaction(async (session) => {
					const created = await fixture.adapter.create(
						{ values: fixture.first },
						{ ...context, session },
					);
					return fixture.getId(created);
				}, context);
				assertSame(returnedId, expectedId, "transaction changed its work result.");
				const found = await fixture.adapter.findOne(
					{ predicate: comparison(fixture.idField, "eq", expectedId) },
					adapterContext("read"),
				);
				assert(found !== null, "successful transaction did not commit.");
			},
		},
		{
			name: "rolls back and preserves an application failure",
			run: async (fixture) => {
				const sentinel = new Error("adapter conformance rollback sentinel");
				const context = adapterContext("create");
				let createdId: unknown;
				const failure = await captureRejection(() =>
					fixture.adapter.transaction(async (session) => {
						const created = await fixture.adapter.create(
							{ values: fixture.first },
							{ ...context, session },
						);
						createdId = fixture.getId(created);
						throw sentinel;
					}, context),
				);
				assert(failure === sentinel, "transaction replaced the original application failure.");
				assert(createdId !== undefined, "transaction work did not create its test record.");
				const found = await fixture.adapter.findOne(
					{ predicate: comparison(fixture.idField, "eq", createdId) },
					adapterContext("read"),
				);
				assert(found === null, "failed transaction was not rolled back.");
			},
		},
		{
			name: "reuses a nested session so outer rollback includes inner work",
			run: async (fixture) => {
				const sentinel = new Error("adapter conformance nested rollback sentinel");
				const context = adapterContext("create");
				let createdId: unknown;
				const failure = await captureRejection(() =>
					fixture.adapter.transaction(async (outerSession) => {
						await fixture.adapter.transaction(
							async (innerSession) => {
								assert(
									innerSession === outerSession,
									"nested transaction replaced its active session.",
								);
								const created = await fixture.adapter.create(
									{ values: fixture.first },
									{ ...context, session: innerSession },
								);
								createdId = fixture.getId(created);
							},
							{ ...context, session: outerSession },
						);
						throw sentinel;
					}, context),
				);
				assert(failure === sentinel, "nested transaction replaced the outer failure.");
				assert(createdId !== undefined, "nested transaction work did not run.");
				const found = await fixture.adapter.findOne(
					{ predicate: comparison(fixture.idField, "eq", createdId) },
					adapterContext("read"),
				);
				assert(found === null, "nested work committed independently of its outer transaction.");
			},
		},
		{
			name: "rejects foreign and expired transaction sessions",
			run: async (fixture) => {
				const context = adapterContext("create");
				let entered = false;
				const foreignSession = { adapter: Symbol("foreign"), value: {} };
				const foreignFailure = await captureRejection(() =>
					fixture.adapter.transaction(
						async () => {
							entered = true;
						},
						{ ...context, session: foreignSession },
					),
				);
				assertAdapterSessionError(foreignFailure, "foreign transaction session");
				assert(!entered, "foreign transaction work was executed.");
				const foreignOperationFailure = await captureRejection(() =>
					fixture.adapter.findMany(
						{ order: [], limit: 1, count: false },
						{ ...adapterContext("list"), session: foreignSession },
					),
				);
				assertAdapterSessionError(foreignOperationFailure, "foreign operation session");

				let expiredSession: CrudAdapterSession | undefined;
				await fixture.adapter.transaction(async (session) => {
					expiredSession = session;
				}, context);
				const expired = expiredSession;
				assert(expired !== undefined, "transaction did not provide a session.");
				entered = false;
				const expiredFailure = await captureRejection(() =>
					fixture.adapter.transaction(
						async () => {
							entered = true;
						},
						{ ...context, session: expired },
					),
				);
				assertAdapterSessionError(expiredFailure, "expired transaction session");
				assert(!entered, "expired transaction work was executed.");
				const expiredOperationFailure = await captureRejection(() =>
					fixture.adapter.findMany(
						{ order: [], limit: 1, count: false },
						{ ...adapterContext("list"), session: expired },
					),
				);
				assertAdapterSessionError(expiredOperationFailure, "expired operation session");
			},
		},
		{
			name: "preserves an adapter error thrown by transaction work",
			run: async (fixture) => {
				const sentinel = new CrudAdapterError(
					"unsupported",
					"adapter conformance error-preservation sentinel",
				);
				const context = adapterContext("create");
				const failure = await captureRejection(() =>
					fixture.adapter.transaction(async () => {
						throw sentinel;
					}, context),
				);
				assert(failure === sentinel, "transaction replaced an existing CrudAdapterError.");
			},
		},
	];
}

export async function runCrudAdapterConformance<RecordType>(
	createFixture: () =>
		CrudAdapterConformanceFixture<RecordType> | Promise<CrudAdapterConformanceFixture<RecordType>>,
): Promise<void> {
	for (const testCase of createCrudAdapterConformanceCases<RecordType>()) {
		await testCase.run(await createFixture());
	}
}

function adapterContext(operation: CrudAdapterContext["operation"]): CrudAdapterContext {
	return { resource: "conformance", operation };
}

function comparison(field: string, operator: "eq" | "isnull", value: unknown) {
	return { kind: "comparison" as const, field, operator, value };
}

async function seedPair<RecordType>(
	fixture: CrudAdapterConformanceFixture<RecordType>,
): Promise<void> {
	const first = await fixture.adapter.create({ values: fixture.first }, adapterContext("create"));
	const second = await fixture.adapter.create({ values: fixture.second }, adapterContext("create"));
	assert(
		!Object.is(fixture.getId(first), fixture.getId(second)),
		"Conformance records must have distinct IDs.",
	);
}

function assertIds<RecordType>(
	records: readonly RecordType[],
	expected: readonly unknown[],
	getId: (record: RecordType) => unknown,
	message: string,
): void {
	assert(records.length === expected.length, `${message}: wrong record count.`);
	for (const [index, record] of records.entries()) {
		assertSame(getId(record), expected[index], `${message}: mismatch at index ${index}.`);
	}
}

function assertSame(actual: unknown, expected: unknown, message: string): void {
	assert(
		Object.is(actual, expected),
		`${message} Expected ${String(expected)}, received ${String(actual)}.`,
	);
}

function assertAdapterSessionError(error: unknown, source: string): void {
	assert(error instanceof CrudAdapterError, `${source} did not reject with CrudAdapterError.`);
	assert(error.code === "unknown", `${source} rejected with code '${error.code}'.`);
}

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function captureRejection(work: () => Promise<unknown>): Promise<unknown> {
	try {
		await work();
	} catch (error) {
		return error;
	}
	throw new Error("Expected adapter operation to reject.");
}
