import { CrudAdapterError, type CrudAdapterContext } from "@nestm/crud/adapter";
import { eq, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { integer, pgTable, PgDialect, text, type PgTransactionConfig } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import {
	createDrizzleCrudAdapter,
	type DrizzleCrudEffectiveTransaction,
	type DrizzleCrudRowPredicate,
	type DrizzleCrudTransactionRunnerContext,
} from "../src/index.ts";

const users = pgTable("crud_drizzle_test_users", {
	id: integer().primaryKey(),
	tenantId: text().notNull(),
	name: text().notNull(),
});

type TestDatabase = NodePgDatabase<{ users: typeof users }>;

const rows = [{ id: 1, tenantId: "tenant-a", name: "Ada" }] as const;
const identity = { kind: "comparison", field: "id", operator: "eq", value: 1 } as const;

interface FakeDatabaseCapture {
	readonly selectPredicates: SQL[];
	readonly updatePredicates: SQL[];
	readonly deletePredicates: SQL[];
	readonly countPredicates: (SQL | undefined)[];
	readonly transactionConfigs: (PgTransactionConfig | undefined)[];
	selectCalls: number;
	transactionCalls: number;
}

function createFakeDatabase(options: { readonly transactionFailure?: unknown } = {}): {
	readonly database: TestDatabase;
	readonly capture: FakeDatabaseCapture;
} {
	const capture: FakeDatabaseCapture = {
		selectPredicates: [],
		updatePredicates: [],
		deletePredicates: [],
		countPredicates: [],
		transactionConfigs: [],
		selectCalls: 0,
		transactionCalls: 0,
	};
	let database: TestDatabase;
	const query = () =>
		Object.assign(Promise.resolve(rows), {
			where(predicate: SQL) {
				capture.selectPredicates.push(predicate);
				return query();
			},
			orderBy(..._order: readonly SQL[]) {
				return query();
			},
			limit(_limit: number) {
				return query();
			},
			offset(_offset: number) {
				return query();
			},
			$dynamic() {
				return query();
			},
		});
	const rawDatabase = {
		async transaction<Result>(
			work: (transaction: TestDatabase) => Promise<Result>,
			config?: PgTransactionConfig,
		): Promise<Result> {
			capture.transactionCalls += 1;
			capture.transactionConfigs.push(config);
			if (options.transactionFailure !== undefined) throw options.transactionFailure;
			return work(database);
		},
		select: (_selection: Readonly<Record<string, unknown>>) => ({
			from: (_table: object) => {
				capture.selectCalls += 1;
				return query();
			},
		}),
		insert: (_table: object) => ({
			values: (_values: object) => ({ returning: () => Promise.resolve(rows) }),
		}),
		update: (_table: object) => ({
			set: (_values: object) => ({
				where: (predicate: SQL) => {
					capture.updatePredicates.push(predicate);
					return { returning: () => Promise.resolve(rows) };
				},
			}),
		}),
		delete: (_table: object) => ({
			where: (predicate: SQL) => {
				capture.deletePredicates.push(predicate);
				return { returning: () => Promise.resolve(rows) };
			},
		}),
		$count: (_table: object, predicate?: SQL) => {
			capture.countPredicates.push(predicate);
			return Promise.resolve(rows.length);
		},
	};
	database = rawDatabase as unknown as TestDatabase;
	return { database, capture };
}

function adapterContext(operation: CrudAdapterContext["operation"]): CrudAdapterContext {
	return { resource: "users", operation };
}

function sqlText(predicate: SQL): string {
	return new PgDialect().sqlToQuery(predicate).sql;
}

class TestTransactionRunner {
	readonly contexts: DrizzleCrudTransactionRunnerContext[] = [];

	constructor(readonly database: TestDatabase) {}

	async run<Result>(
		context: DrizzleCrudTransactionRunnerContext,
		work: (transaction: TestDatabase) => Promise<Result>,
	): Promise<Result> {
		this.contexts.push(context);
		return work(this.database);
	}
}

function createRunner(database: TestDatabase): TestTransactionRunner {
	return new TestTransactionRunner(database);
}

describe("DrizzleCrudAdapter transaction runner and row predicate", () => {
	it("composes one async native predicate across read, list/count, update, and delete", async () => {
		const { database, capture } = createFakeDatabase();
		const runner = createRunner(database);
		const rowPredicate = vi.fn(async ({ table }) => eq(table.tenantId, "tenant-a"));
		const adapter = createDrizzleCrudAdapter({
			database,
			table: users,
			columns: { id: users.id, tenantId: users.tenantId, name: users.name },
			transactionRunner: runner,
			rowPredicate,
		});

		await adapter.findOne({ predicate: identity }, adapterContext("read"));
		await adapter.findMany(
			{ predicate: identity, order: [], limit: 10, count: true },
			adapterContext("list"),
		);
		await adapter.update(
			{ predicate: identity, values: { name: "Grace" } },
			adapterContext("update"),
		);
		await adapter.delete({ predicate: identity }, adapterContext("delete"));

		expect(runner.contexts).toHaveLength(4);
		expect(rowPredicate).toHaveBeenCalledTimes(4);
		expect(rowPredicate.mock.calls.every(([value]) => value.context.session !== undefined)).toBe(
			true,
		);
		expect(capture.selectPredicates).toHaveLength(2);
		expect(capture.updatePredicates).toHaveLength(1);
		expect(capture.deletePredicates).toHaveLength(1);
		for (const predicate of [
			...capture.selectPredicates,
			...capture.updatePredicates,
			...capture.deletePredicates,
		]) {
			expect(sqlText(predicate)).toContain("and");
			expect(new PgDialect().sqlToQuery(predicate).params).toEqual([1, "tenant-a"]);
		}
		expect(capture.countPredicates[0]).toBe(capture.selectPredicates[1]);
		expect(runner.contexts[1]).toMatchObject({
			accessMode: "read only",
			isolationLevel: "repeatable read",
			operation: "list",
		});
	});

	it("self-enters the runner for every bare operation and reuses an explicit session", async () => {
		const { database } = createFakeDatabase();
		const runner = createRunner(database);
		const adapter = createDrizzleCrudAdapter({
			database,
			table: users,
			columns: { id: users.id, tenantId: users.tenantId, name: users.name },
			transactionRunner: runner,
		});

		await adapter.create(
			{ values: { id: 1, tenantId: "tenant-a", name: "Ada" } },
			adapterContext("create"),
		);
		await adapter.findMany({ order: [], limit: 10, count: false }, adapterContext("list"));
		expect(runner.contexts).toHaveLength(2);

		await adapter.transaction(async (session) => {
			await adapter.findOne({ predicate: identity }, { ...adapterContext("read"), session });
			await adapter.update(
				{ predicate: identity, values: { name: "Grace" } },
				{ ...adapterContext("update"), session },
			);
		}, adapterContext("update"));

		expect(runner.contexts).toHaveLength(3);
		expect(runner.contexts[2]).toMatchObject({
			accessMode: "read write",
			isolationLevel: "read committed",
			mustOwnCommit: true,
		});

		await expect(
			adapter.transaction(
				(session) =>
					adapter.update(
						{ predicate: identity, values: { name: "Rejected" } },
						{ ...adapterContext("update"), session },
					),
				adapterContext("read"),
			),
		).rejects.toMatchObject({ code: "unsupported" });
		expect(runner.contexts).toHaveLength(4);
		expect(runner.contexts[3]).toMatchObject({
			accessMode: "read only",
			mustOwnCommit: false,
		});
	});

	it("records strengthened runner isolation for nested session checks", async () => {
		const { database } = createFakeDatabase();
		const contexts: DrizzleCrudTransactionRunnerContext[] = [];
		const adapter = createDrizzleCrudAdapter({
			database,
			table: users,
			columns: { id: users.id, tenantId: users.tenantId, name: users.name },
			transactionRunner: {
				run: (context, workWithTransaction) => {
					contexts.push(context);
					const effective: DrizzleCrudEffectiveTransaction = {
						accessMode: context.accessMode,
						isolationLevel: "repeatable read",
						ownsCommit: true,
					};
					return workWithTransaction(database, effective);
				},
			},
		});

		await adapter.transaction(
			(session) =>
				adapter.findMany(
					{ order: [], limit: 10, count: true },
					{ ...adapterContext("list"), session },
				),
			adapterContext("read"),
		);

		expect(contexts[0]).toMatchObject({ isolationLevel: "read committed" });
	});

	it("lets a row predicate declare repeatable-read before a mutation starts", async () => {
		const { database } = createFakeDatabase();
		const runner = createRunner(database);
		const adapter = createDrizzleCrudAdapter({
			database,
			table: users,
			columns: { id: users.id, tenantId: users.tenantId, name: users.name },
			transactionRunner: runner,
			rowPredicate: {
				resolve: ({ table }) => eq(table.tenantId, "tenant-a"),
				transaction: { isolationLevel: "repeatable read" },
			},
		});

		await adapter.update(
			{ predicate: identity, values: { name: "Grace" } },
			adapterContext("update"),
		);

		expect(runner.contexts[0]).toMatchObject({
			isolationLevel: "repeatable read",
			mustOwnCommit: true,
		});
	});

	it("declares operation-wide isolation before create hooks can run", async () => {
		const { database } = createFakeDatabase();
		const runner = createRunner(database);
		const adapter = createDrizzleCrudAdapter({
			database,
			table: users,
			columns: { id: users.id, tenantId: users.tenantId, name: users.name },
			transaction: { isolationLevel: "repeatable read" },
			transactionRunner: runner,
		});

		await adapter.transaction(
			(session) =>
				adapter.create(
					{ values: { id: 1, tenantId: "tenant-a", name: "Ada" } },
					{ ...adapterContext("create"), session },
				),
			adapterContext("create"),
		);

		expect(runner.contexts).toHaveLength(1);
		expect(runner.contexts[0]).toMatchObject({
			operation: "create",
			accessMode: "read write",
			isolationLevel: "repeatable read",
			mustOwnCommit: true,
		});
	});

	it("forces a native operation transaction when no runner is configured", async () => {
		const { database, capture } = createFakeDatabase();
		const adapter = createDrizzleCrudAdapter({
			database,
			table: users,
			columns: { id: users.id, tenantId: users.tenantId, name: users.name },
			transaction: { isolationLevel: "repeatable read" },
		});

		await adapter.create(
			{ values: { id: 1, tenantId: "tenant-a", name: "Ada" } },
			adapterContext("create"),
		);

		expect(capture.transactionCalls).toBe(1);
		expect(capture.transactionConfigs).toEqual([
			{ accessMode: "read write", isolationLevel: "repeatable read" },
		]);
	});

	it("rejects a mutation runner that reports it does not own the real commit", async () => {
		const { database } = createFakeDatabase();
		const work = vi.fn(async () => undefined);
		const adapter = createDrizzleCrudAdapter({
			database,
			table: users,
			columns: { id: users.id, tenantId: users.tenantId, name: users.name },
			transactionRunner: {
				run: (context, workWithTransaction) =>
					workWithTransaction(database, {
						accessMode: context.accessMode,
						isolationLevel: context.isolationLevel,
						ownsCommit: false,
					}),
			},
		});

		await expect(adapter.transaction(work, adapterContext("update"))).rejects.toMatchObject({
			code: "unsupported",
		});
		expect(work).not.toHaveBeenCalled();
	});

	it("preserves a structurally equivalent adapter error from a runner", async () => {
		const { database } = createFakeDatabase();
		const duplicatedError = {
			name: "CrudAdapterError",
			code: "unsupported" as const,
			message: "duplicate package error",
			retryable: false,
		};
		const adapter = createDrizzleCrudAdapter({
			database,
			table: users,
			columns: { id: users.id, tenantId: users.tenantId, name: users.name },
			transactionRunner: {
				run<Result>(): Promise<Result> {
					return Promise.reject(duplicatedError);
				},
			},
		});

		const failure = await adapter
			.transaction(async () => undefined, adapterContext("update"))
			.catch((error: unknown) => error);
		expect(failure).toBe(duplicatedError);
	});

	it("uses a native repeatable-read, read-only transaction for a counted bare list", async () => {
		const { database, capture } = createFakeDatabase();
		const adapter = createDrizzleCrudAdapter({
			database,
			table: users,
			columns: { id: users.id, tenantId: users.tenantId, name: users.name },
		});

		await adapter.findMany({ order: [], limit: 10, count: true }, adapterContext("list"));

		expect(capture.transactionCalls).toBe(1);
		expect(capture.transactionConfigs).toEqual([
			{ accessMode: "read only", isolationLevel: "repeatable read" },
		]);
	});

	it("preserves legacy bare reads when no runner or row predicate is configured", async () => {
		const { database, capture } = createFakeDatabase();
		const adapter = createDrizzleCrudAdapter({
			database,
			table: users,
			columns: { id: users.id, tenantId: users.tenantId, name: users.name },
		});

		await adapter.findOne({ predicate: identity }, adapterContext("read"));

		expect(capture.transactionCalls).toBe(0);
		expect(capture.selectCalls).toBe(1);
	});

	it("fails closed before issuing SQL when a configured row predicate returns no expression", async () => {
		const { database, capture } = createFakeDatabase();
		const rowPredicate = (() => undefined) as unknown as DrizzleCrudRowPredicate<typeof users>;
		const adapter = createDrizzleCrudAdapter({
			database,
			table: users,
			columns: { id: users.id, tenantId: users.tenantId, name: users.name },
			rowPredicate,
		});

		await expect(
			adapter.findOne({ predicate: identity }, adapterContext("read")),
		).rejects.toMatchObject({ name: "CrudAdapterError", code: "unknown" });
		expect(capture.transactionCalls).toBe(1);
		expect(capture.selectCalls).toBe(0);
	});

	it.each(["40001", "40P01"])("marks PostgreSQL %s conflicts as retryable", async (code) => {
		const { database } = createFakeDatabase({ transactionFailure: { code } });
		const adapter = createDrizzleCrudAdapter({
			database,
			table: users,
			columns: { id: users.id, tenantId: users.tenantId, name: users.name },
		});

		const failure = await adapter
			.findMany({ order: [], limit: 10, count: true }, adapterContext("list"))
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(CrudAdapterError);
		expect(failure).toMatchObject({ code: "conflict", retryable: true });
	});
});
