import type {
	CrudAdapterContext,
	CrudAdapterSession,
	CrudBindingMappings,
	CrudFilterOperator,
	CrudPredicate,
	CrudResourceBinding,
} from "@nestm/crud/adapter";
import { CrudAdapterError } from "@nestm/crud/adapter";
import { describe, expect, it } from "vitest";

import { bindMemoryCrud } from "./bind-memory-crud.ts";
import { MemoryCrudAdapter } from "./memory-crud-adapter.ts";
import { MemoryCrudStore } from "./memory-crud-store.ts";

interface UserRecord {
	id: number;
	name: string;
	age: number;
	teamId: number | null;
}

const initialUsers: readonly UserRecord[] = [
	{ id: 1, name: "Ada", age: 36, teamId: 10 },
	{ id: 2, name: "Grace", age: 28, teamId: null },
	{ id: 3, name: "Linus", age: 36, teamId: 20 },
];

function context(session?: CrudAdapterSession): CrudAdapterContext {
	return {
		resource: "users",
		operation: "list",
		...(session === undefined ? {} : { session }),
	};
}

function comparison<const Field extends string>(
	field: Field,
	operator: CrudFilterOperator,
	value: unknown,
): CrudPredicate<Field> {
	return { kind: "comparison", field, operator, value };
}

function ids(records: readonly UserRecord[]): number[] {
	return records.map((record) => record.id);
}

describe("MemoryCrudAdapter", () => {
	it("commits a private working copy only after a transaction succeeds", async () => {
		const adapter = new MemoryCrudAdapter<UserRecord>({ initialRecords: initialUsers });

		await adapter.transaction(async (session) => {
			await adapter.create(
				{ values: { id: 4, name: "Margaret", age: 29, teamId: 10 } },
				context(session),
			);
			const visibleInside = await adapter.findMany(
				{ order: [{ field: "id", direction: "asc" }], limit: 10, count: false },
				context(session),
			);
			expect(ids(visibleInside.records)).toEqual([1, 2, 3, 4]);

			const committedOutside = await adapter.findMany(
				{ order: [{ field: "id", direction: "asc" }], limit: 10, count: false },
				context(),
			);
			expect(ids(committedOutside.records)).toEqual([1, 2, 3]);
		}, context());

		const committed = await adapter.findMany(
			{ order: [{ field: "id", direction: "asc" }], limit: 10, count: false },
			context(),
		);
		expect(ids(committed.records)).toEqual([1, 2, 3, 4]);
	});

	it("rolls back every write when transaction work rejects", async () => {
		const adapter = new MemoryCrudAdapter<UserRecord>({ initialRecords: initialUsers });
		let expiredSession: CrudAdapterSession | undefined;

		await expect(
			adapter.transaction(async (session) => {
				expiredSession = session;
				await adapter.delete({ predicate: comparison("id", "eq", 1) }, context(session));
				await adapter.update(
					{ predicate: comparison("id", "eq", 2), values: { name: "changed" } },
					context(session),
				);
				throw new Error("hook failed");
			}, context()),
		).rejects.toThrow("hook failed");

		expect(adapter.store.snapshot()).toEqual(initialUsers);
		await expect(
			adapter.findMany({ order: [], limit: 10, count: false }, context(expiredSession)),
		).rejects.toMatchObject({ code: "unknown" });
	});

	it("serializes concurrent transactions without losing committed writes", async () => {
		const adapter = new MemoryCrudAdapter<UserRecord>({ initialRecords: initialUsers });
		let releaseFirst: (() => void) | undefined;
		let markFirstStarted: (() => void) | undefined;
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		const firstMayCommit = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const first = adapter.transaction(async (session) => {
			await adapter.create(
				{ values: { id: 4, name: "Margaret", age: 29, teamId: 10 } },
				context(session),
			);
			markFirstStarted?.();
			await firstMayCommit;
		}, context());
		await firstStarted;

		let secondEntered = false;
		const second = adapter.transaction(async (session) => {
			secondEntered = true;
			const visible = await adapter.findMany(
				{ order: [{ field: "id", direction: "asc" }], limit: 10, count: false },
				context(session),
			);
			expect(ids(visible.records)).toEqual([1, 2, 3, 4]);
			await adapter.create(
				{ values: { id: 5, name: "Barbara", age: 31, teamId: 20 } },
				context(session),
			);
		}, context());

		await Promise.resolve();
		expect(secondEntered).toBe(false);
		releaseFirst?.();
		await Promise.all([first, second]);
		expect(ids(adapter.store.snapshot())).toEqual([1, 2, 3, 4, 5]);
	});

	it("supports the complete predicate AST and filter operator surface", async () => {
		const adapter = new MemoryCrudAdapter<UserRecord>({ initialRecords: initialUsers });
		const cases: readonly [CrudPredicate<keyof UserRecord>, readonly number[]][] = [
			[comparison("age", "eq", 36), [1, 3]],
			[comparison("age", "ne", 36), [2]],
			[comparison("age", "gt", 28), [1, 3]],
			[comparison("age", "gte", 36), [1, 3]],
			[comparison("age", "lt", 36), [2]],
			[comparison("age", "lte", 28), [2]],
			[comparison("id", "in", [1, 3]), [1, 3]],
			[comparison("id", "nin", [1, 3]), [2]],
			[comparison("name", "contains", "inu"), [3]],
			[comparison("name", "icontains", "ADA"), [1]],
			[comparison("teamId", "isnull", true), [2]],
			[comparison("age", "between", [28, 35]), [2]],
			[
				{
					kind: "and",
					predicates: [
						{ kind: "not", predicate: comparison("teamId", "isnull", true) },
						{
							kind: "or",
							predicates: [comparison("id", "eq", 1), comparison("id", "eq", 2)],
						},
					],
				},
				[1],
			],
		];

		for (const [predicate, expectedIds] of cases) {
			const result = await adapter.findMany(
				{
					predicate,
					order: [{ field: "id", direction: "asc" }],
					limit: 10,
					count: false,
				},
				context(),
			);
			expect(ids(result.records)).toEqual(expectedIds);
		}
	});

	it("uses SQL three-valued logic for nullable comparisons and boolean predicates", async () => {
		const adapter = new MemoryCrudAdapter<UserRecord>({ initialRecords: initialUsers });
		const cases: readonly [CrudPredicate<keyof UserRecord>, readonly number[]][] = [
			[comparison("teamId", "eq", null), [2]],
			[comparison("teamId", "ne", null), [1, 3]],
			[comparison("teamId", "ne", 10), [3]],
			[comparison("teamId", "in", [20, null]), [3]],
			[comparison("teamId", "nin", [10]), [3]],
			[{ kind: "not", predicate: comparison("teamId", "eq", 10) }, [3]],
			[{ kind: "not", predicate: comparison("teamId", "in", [20]) }, [1]],
			[
				{
					kind: "or",
					predicates: [comparison("teamId", "eq", 10), comparison("name", "eq", "Grace")],
				},
				[1, 2],
			],
			[
				{
					kind: "and",
					predicates: [comparison("teamId", "ne", 10), comparison("name", "eq", "Grace")],
				},
				[],
			],
		];

		for (const [predicate, expectedIds] of cases) {
			const result = await adapter.findMany(
				{
					predicate,
					order: [{ field: "id", direction: "asc" }],
					limit: 10,
					count: false,
				},
				context(),
			);
			expect(ids(result.records)).toEqual(expectedIds);
		}
	});

	it("sorts deterministically and reports an unsliced total", async () => {
		const adapter = new MemoryCrudAdapter<UserRecord>({ initialRecords: initialUsers });
		const page = await adapter.findMany(
			{
				order: [
					{ field: "age", direction: "desc" },
					{ field: "id", direction: "desc" },
				],
				offset: 1,
				limit: 1,
				count: true,
			},
			context(),
		);

		expect(page.total).toBe(3);
		expect(ids(page.records)).toEqual([1]);
	});

	it("returns detached records across every store boundary", async () => {
		const store = new MemoryCrudStore<UserRecord>({ initialRecords: initialUsers });
		const adapter = new MemoryCrudAdapter<UserRecord>({ store });
		const found = await adapter.findOne({ predicate: comparison("id", "eq", 1) }, context());
		expect(found).not.toBeNull();
		found!.name = "mutated outside";

		expect(store.snapshot()[0]?.name).toBe("Ada");
		const snapshot = store.snapshot();
		snapshot[0]!.name = "also detached";
		expect(store.snapshot()[0]?.name).toBe("Ada");
	});

	it("enforces single and composite unique constraints on create and update", async () => {
		const adapter = new MemoryCrudAdapter<UserRecord>({
			initialRecords: initialUsers,
			unique: [["id"], ["name", "teamId"]],
		});

		await expect(
			adapter.create({ values: { id: 1, name: "Someone", age: 20, teamId: null } }, context()),
		).rejects.toBeInstanceOf(CrudAdapterError);

		await expect(
			adapter.update(
				{
					predicate: comparison("id", "eq", 2),
					values: { name: "Ada", teamId: 10 },
				},
				context(),
			),
		).rejects.toMatchObject({ code: "conflict" });

		expect(adapter.store.snapshot()[1]?.name).toBe("Grace");
	});

	it("updates and deletes the first matching record and returns null when absent", async () => {
		const adapter = new MemoryCrudAdapter<UserRecord>({ initialRecords: initialUsers });
		const updated = await adapter.update(
			{ predicate: comparison("id", "eq", 2), values: { age: 29 } },
			context(),
		);
		expect(updated).toMatchObject({ id: 2, age: 29 });

		const deleted = await adapter.delete({ predicate: comparison("id", "eq", 2) }, context());
		expect(deleted).toMatchObject({ id: 2, age: 29 });
		await expect(
			adapter.delete({ predicate: comparison("id", "eq", 999) }, context()),
		).resolves.toBeNull();
	});
});

describe("bindMemoryCrud", () => {
	const resource = { name: "users" } as unknown as CrudResourceBinding["resource"];
	const mappings: CrudBindingMappings<typeof resource, UserRecord> = {
		create: () => ({}),
		update: () => ({}),
		persistence: (values) => values,
		response: (record: UserRecord) => record,
	};

	it("creates a convenient owned adapter with seeded records", () => {
		const binding = bindMemoryCrud({
			resource,
			initialRecords: initialUsers,
			mappings,
		});

		expect("useValue" in binding.adapter).toBe(true);
		if ("useValue" in binding.adapter) {
			expect(binding.adapter.useValue).toBeInstanceOf(MemoryCrudAdapter);
			expect((binding.adapter.useValue as MemoryCrudAdapter<UserRecord>).store.snapshot()).toEqual(
				initialUsers,
			);
		}
	});

	it("passes an explicit Nest adapter provider through without constructing an owned adapter", () => {
		const token = Symbol("custom-memory-adapter");
		const binding = bindMemoryCrud({
			resource,
			mappings,
			adapter: { useExisting: token },
			// These would be an invalid owned-adapter combination, proving the override is lazy.
			store: new MemoryCrudStore<UserRecord>(),
			initialRecords: initialUsers,
		});

		expect(binding.adapter).toEqual({ useExisting: token });
	});
});
