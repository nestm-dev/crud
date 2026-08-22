import { CrudAdapterError, type CrudAdapterContext } from "@nestm/crud/adapter";
import { Brackets, QueryFailedError, type EntityManager, type Repository } from "typeorm";
import { describe, expect, it, vi } from "vitest";

import {
	createTypeOrmCrudAdapter,
	TYPEORM_CRUD_ALIAS,
	type TypeOrmCrudEffectiveTransaction,
	type TypeOrmCrudRowPredicateContext,
	type TypeOrmCrudTransactionRunnerContext,
} from "../src/index.ts";

/**
 * Unit coverage for the behaviour the shared Postgres conformance suite structurally
 * cannot reach: constructor validation, SQLSTATE classification without a live server,
 * session ownership, and the fail-closed edges of the runner and row predicate.
 *
 * The fakes here record what the adapter *asked the database to do*. They deliberately
 * do not emulate SQL — a fake that returns plausible rows for a wrong predicate would
 * defeat the point of the tests that assert the predicate was applied at all.
 */

interface UserEntity {
	readonly id: number;
	name: string;
	tenantId: string;
	profile?: { readonly nickname: string };
}

const ROW: UserEntity = { id: 1, tenantId: "tenant-a", name: "Ada" };
const IDENTITY = { kind: "comparison", field: "id", operator: "eq", value: 1 } as const;
const COLUMNS = { id: "id", name: "name", tenantId: "tenantId" } as const;

interface Capture {
	readonly whereArgs: unknown[][];
	readonly orderArgs: [string, string][];
	readonly locks: string[];
	readonly startedTransactions: (string | undefined)[];
	readonly rawQueries: string[];
	commits: number;
	rollbacks: number;
	releases: number;
	queryRunnersCreated: number;
	getOneCalls: number;
	getManyCalls: number;
	countCalls: number;
	saves: number;
	removes: number;
}

function createCapture(): Capture {
	return {
		whereArgs: [],
		orderArgs: [],
		locks: [],
		startedTransactions: [],
		rawQueries: [],
		commits: 0,
		rollbacks: 0,
		releases: 0,
		queryRunnersCreated: 0,
		getOneCalls: 0,
		getManyCalls: 0,
		countCalls: 0,
		saves: 0,
		removes: 0,
	};
}

interface FakeRepositoryOptions {
	/** Columns the entity metadata knows about; defaults to the mapped set. */
	readonly knownProperties?: readonly string[];
	/** Thrown by `getOne`/`getMany`/`save`, to drive error-classification tests. */
	readonly failure?: unknown;
	/** `getOne` resolves to null, to drive the not-found paths. */
	readonly missing?: boolean;
}

function createFakeRepository(
	capture: Capture,
	options: FakeRepositoryOptions = {},
): Repository<UserEntity> {
	const known = new Set(options.knownProperties ?? Object.values(COLUMNS));
	const reject = <T>(): Promise<T> =>
		options.failure === undefined
			? Promise.resolve(undefined as T)
			: Promise.reject(options.failure);

	const builder = {
		alias: TYPEORM_CRUD_ALIAS,
		andWhere(...args: unknown[]) {
			capture.whereArgs.push(args);
			return builder;
		},
		getParameters() {
			return {};
		},
		addOrderBy(field: string, direction: string) {
			capture.orderArgs.push([field, direction]);
			return builder;
		},
		skip(_offset: number) {
			return builder;
		},
		take(_limit: number) {
			return builder;
		},
		setLock(mode: string) {
			capture.locks.push(mode);
			return builder;
		},
		async getOne() {
			capture.getOneCalls += 1;
			if (options.failure !== undefined) return reject<UserEntity | null>();
			return options.missing === true ? null : { ...ROW };
		},
		async getMany() {
			capture.getManyCalls += 1;
			if (options.failure !== undefined) return reject<UserEntity[]>();
			return [{ ...ROW }];
		},
		async getManyAndCount() {
			capture.getManyCalls += 1;
			capture.countCalls += 1;
			if (options.failure !== undefined) return reject<[UserEntity[], number]>();
			return [[{ ...ROW }], 1] as [UserEntity[], number];
		},
	};

	const queryRunner = {
		manager: undefined as unknown as EntityManager,
		isTransactionActive: false,
		async connect() {},
		async startTransaction(isolationLevel?: string) {
			capture.startedTransactions.push(isolationLevel);
			this.isTransactionActive = true;
		},
		async query(sql: string) {
			capture.rawQueries.push(sql);
		},
		async commitTransaction() {
			capture.commits += 1;
			this.isTransactionActive = false;
		},
		async rollbackTransaction() {
			capture.rollbacks += 1;
			this.isTransactionActive = false;
		},
		async release() {
			capture.releases += 1;
		},
	};

	const repository = {
		// An EntityTarget only has to round-trip through the fake manager's getRepository.
		target: "User",
		metadata: {
			findColumnWithPropertyPath: (path: string) =>
				known.has(path) ? { propertyPath: path } : undefined,
		},
		createQueryBuilder: (_alias: string) => builder,
		create: (values: object) => ({ ...values }),
		merge: (record: object, values: object) => Object.assign(record, values),
		async save(entity: UserEntity) {
			capture.saves += 1;
			if (options.failure !== undefined) return reject<UserEntity>();
			return entity;
		},
		async remove(entity: UserEntity) {
			capture.removes += 1;
			if (options.failure !== undefined) return reject<UserEntity>();
			return entity;
		},
	} as unknown as Repository<UserEntity>;

	const manager = {
		getRepository: (_target: unknown) => repository,
		connection: {
			createQueryRunner: () => {
				capture.queryRunnersCreated += 1;
				return queryRunner;
			},
		},
	} as unknown as EntityManager;

	queryRunner.manager = manager;
	(repository as { manager: EntityManager }).manager = manager;
	return repository;
}

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("expected the value to be captured");
	return value;
}

function context(operation: CrudAdapterContext["operation"]): CrudAdapterContext {
	return { resource: "users", operation };
}

class TestRunner {
	readonly contexts: TypeOrmCrudTransactionRunnerContext[] = [];

	constructor(
		private readonly manager: EntityManager,
		private readonly reported?: TypeOrmCrudEffectiveTransaction,
	) {}

	async run<Result>(
		runnerContext: TypeOrmCrudTransactionRunnerContext,
		work: (
			manager: EntityManager,
			effectiveTransaction?: TypeOrmCrudEffectiveTransaction,
		) => Promise<Result>,
	): Promise<Result> {
		this.contexts.push(runnerContext);
		return work(this.manager, this.reported);
	}
}

function managerOf(repository: Repository<UserEntity>): EntityManager {
	return (repository as unknown as { manager: EntityManager }).manager;
}

describe("TypeOrmCrudAdapter construction", () => {
	it("rejects every column that does not resolve to an entity property", () => {
		const repository = createFakeRepository(createCapture(), { knownProperties: ["id", "name"] });
		expect(() =>
			createTypeOrmCrudAdapter({ repository, columns: { id: "id", tenantId: "tenant_id" } }),
		).toThrow(TypeError);
		expect(() =>
			createTypeOrmCrudAdapter({ repository, columns: { id: "id", tenantId: "tenant_id" } }),
		).toThrow("CRUD field 'tenantId' maps to unknown TypeORM property 'tenant_id'.");
	});

	it("reports the capabilities the runtime relies on", () => {
		const adapter = createTypeOrmCrudAdapter({
			repository: createFakeRepository(createCapture()),
			columns: COLUMNS,
		});
		expect(adapter.capabilities).toEqual({
			transactions: true,
			returning: true,
			compositeIds: true,
			containsInsensitive: true,
			upsert: true,
		});
	});

	it("refuses an unmapped field at query time rather than guessing a column", async () => {
		const adapter = createTypeOrmCrudAdapter({
			repository: createFakeRepository(createCapture()),
			columns: COLUMNS,
		});
		await expect(
			adapter.findOne(
				{ predicate: { kind: "comparison", field: "secret", operator: "eq", value: 1 } },
				context("read"),
			),
		).rejects.toMatchObject({ code: "unsupported" });
	});
});

describe("TypeOrmCrudAdapter error classification", () => {
	// A live Postgres cannot be made to emit these on demand; the mapping is only
	// observable from a unit test that hands the adapter a synthetic driver error.
	const cases = [
		["23505", "conflict", true, false],
		["23503", "constraint", false, false],
		["23514", "constraint", false, false],
		["40001", "conflict", false, true],
		["40P01", "conflict", false, true],
		["08006", "unknown", false, false],
	] as const;

	for (const [code, kind, unique, retryable] of cases) {
		it(`maps SQLSTATE ${code} to ${kind}${retryable ? " (retryable)" : ""}`, async () => {
			const repository = createFakeRepository(createCapture(), { failure: { code } });
			const adapter = createTypeOrmCrudAdapter({ repository, columns: COLUMNS });
			const error = await adapter
				.findOne({ predicate: IDENTITY }, context("read"))
				.catch((thrown: unknown) => thrown);

			expect(error).toBeInstanceOf(CrudAdapterError);
			const adapterError = error as CrudAdapterError;
			expect(adapterError.code).toBe(kind);
			expect(adapterError.retryable ?? false).toBe(retryable);
			expect(adapterError.cause).toEqual({ code });
			if (unique) expect(adapterError.message).toContain("unique values");
		});
	}

	it("reads the SQLSTATE out of a QueryFailedError driver error", async () => {
		const driverError = Object.assign(new Error("duplicate key"), { code: "23505" });
		const failure = new QueryFailedError("insert", [], driverError);
		const repository = createFakeRepository(createCapture(), { failure });
		const adapter = createTypeOrmCrudAdapter({ repository, columns: COLUMNS });

		await expect(adapter.findOne({ predicate: IDENTITY }, context("read"))).rejects.toMatchObject({
			code: "conflict",
		});
	});

	it("never leaks a raw driver error to the caller", async () => {
		const repository = createFakeRepository(createCapture(), {
			failure: Object.assign(new Error("connection terminated"), { code: "57P01" }),
		});
		const adapter = createTypeOrmCrudAdapter({ repository, columns: COLUMNS });
		const error = await adapter
			.findOne({ predicate: IDENTITY }, context("read"))
			.catch((thrown: unknown) => thrown);

		expect(error).toBeInstanceOf(CrudAdapterError);
		expect((error as CrudAdapterError).message).toBe("The database operation failed.");
	});
});

describe("TypeOrmCrudAdapter sessions", () => {
	it("rejects a session belonging to another adapter", async () => {
		const adapter = createTypeOrmCrudAdapter({
			repository: createFakeRepository(createCapture()),
			columns: COLUMNS,
		});
		const foreign = { adapter: Symbol("other"), value: {} };

		await expect(
			adapter.transaction(async () => "unreachable", { ...context("read"), session: foreign }),
		).rejects.toMatchObject({ code: "unknown" });
	});

	it("stops honouring a session once its transaction has ended", async () => {
		const repository = createFakeRepository(createCapture());
		const adapter = createTypeOrmCrudAdapter({ repository, columns: COLUMNS });

		let escaped: { adapter: symbol; value: object } | undefined;
		await adapter.transaction(async (session) => {
			escaped = session as { adapter: symbol; value: object };
			return null;
		}, context("update"));

		expect(escaped).toBeDefined();
		await expect(
			adapter.findOne({ predicate: IDENTITY }, { ...context("read"), session: required(escaped) }),
		).rejects.toMatchObject({ code: "unknown" });
	});

	it("releases the session when the work throws", async () => {
		const capture = createCapture();
		const repository = createFakeRepository(capture);
		const adapter = createTypeOrmCrudAdapter({ repository, columns: COLUMNS });

		let escaped: { adapter: symbol; value: object } | undefined;
		await expect(
			adapter.transaction(async (session) => {
				escaped = session as { adapter: symbol; value: object };
				throw new Error("hook failed");
			}, context("update")),
		).rejects.toThrow("hook failed");

		expect(capture.rollbacks).toBe(1);
		expect(capture.releases).toBe(1);
		await expect(
			adapter.findOne({ predicate: IDENTITY }, { ...context("read"), session: required(escaped) }),
		).rejects.toMatchObject({ code: "unknown" });
	});
});

describe("TypeOrmCrudAdapter row predicate", () => {
	it("applies the native predicate to read, list, update, and delete", async () => {
		const capture = createCapture();
		const repository = createFakeRepository(capture);
		const rowPredicate = vi.fn(
			(_predicateContext: TypeOrmCrudRowPredicateContext<UserEntity>) =>
				new Brackets((qb) => qb.where("1 = 1")),
		);
		const adapter = createTypeOrmCrudAdapter({ repository, columns: COLUMNS, rowPredicate });

		await adapter.findOne({ predicate: IDENTITY }, context("read"));
		await adapter.findMany(
			{ predicate: IDENTITY, order: [], limit: 10, count: true },
			context("list"),
		);
		await adapter.update({ predicate: IDENTITY, values: { name: "Grace" } }, context("update"));
		await adapter.delete({ predicate: IDENTITY }, context("delete"));

		expect(rowPredicate).toHaveBeenCalledTimes(4);
		// Every call runs inside a transaction: the predicate's tenant setting is
		// transaction-local, so a read outside one is a read it never constrained.
		expect(rowPredicate.mock.calls.every(([value]) => value.context.session !== undefined)).toBe(
			true,
		);
		// The alias is handed over rather than inferred — see the Brackets alias hazard.
		expect(rowPredicate.mock.calls.every(([value]) => value.alias === TYPEORM_CRUD_ALIAS)).toBe(
			true,
		);
		expect(rowPredicate.mock.calls.every(([value]) => value.repository === repository)).toBe(true);

		// Two andWhere calls per statement: native first so its named parameters can be
		// checked for collisions, then the compiled CRUD predicate.
		const bracketCalls = capture.whereArgs.filter(([first]) => first instanceof Brackets);
		expect(bracketCalls).toHaveLength(4);
		expect(capture.whereArgs).toHaveLength(8);
	});

	it("fails closed when the predicate does not return a Brackets expression", async () => {
		const capture = createCapture();
		const repository = createFakeRepository(capture);
		const adapter = createTypeOrmCrudAdapter({
			repository,
			columns: COLUMNS,
			rowPredicate: (() => undefined) as never,
		});

		await expect(adapter.findOne({ predicate: IDENTITY }, context("read"))).rejects.toMatchObject({
			code: "unknown",
		});
		// The statement must never reach the database unconstrained.
		expect(capture.getOneCalls).toBe(0);
	});

	it("lets a predicate demand repeatable read before a mutation starts", async () => {
		const capture = createCapture();
		const repository = createFakeRepository(capture);
		const adapter = createTypeOrmCrudAdapter({
			repository,
			columns: COLUMNS,
			rowPredicate: {
				resolve: () => new Brackets((qb) => qb.where("1 = 1")),
				transaction: { isolationLevel: "repeatable read" },
			},
		});

		await adapter.update({ predicate: IDENTITY, values: { name: "Grace" } }, context("update"));
		expect(capture.startedTransactions).toEqual(["REPEATABLE READ"]);
	});

	it("declares operation-wide isolation before create hooks can run", async () => {
		const capture = createCapture();
		const repository = createFakeRepository(capture);
		const runner = new TestRunner(managerOf(repository));
		const adapter = createTypeOrmCrudAdapter({
			repository,
			columns: COLUMNS,
			transaction: { isolationLevel: "repeatable read" },
			transactionRunner: runner,
		});

		await adapter.transaction(
			(session) =>
				adapter.create(
					{ values: { name: "Ada", tenantId: "tenant-a" } },
					{ ...context("create"), session },
				),
			context("create"),
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
		const capture = createCapture();
		const repository = createFakeRepository(capture);
		const adapter = createTypeOrmCrudAdapter({
			repository,
			columns: COLUMNS,
			transaction: { isolationLevel: "repeatable read" },
		});

		await adapter.create({ values: { name: "Ada", tenantId: "tenant-a" } }, context("create"));

		expect(capture.startedTransactions).toEqual(["REPEATABLE READ"]);
		expect(capture.commits).toBe(1);
	});

	it("opens a read-only transaction for a bare counted list", async () => {
		const capture = createCapture();
		const repository = createFakeRepository(capture);
		const adapter = createTypeOrmCrudAdapter({ repository, columns: COLUMNS });

		await adapter.findMany({ order: [], limit: 10, count: true }, context("list"));

		expect(capture.startedTransactions).toEqual(["REPEATABLE READ"]);
		expect(capture.rawQueries).toEqual(["SET TRANSACTION READ ONLY"]);
		expect(capture.commits).toBe(1);
		expect(capture.releases).toBe(1);
	});

	it("preserves bare reads when neither a runner nor a predicate is configured", async () => {
		const capture = createCapture();
		const repository = createFakeRepository(capture);
		const adapter = createTypeOrmCrudAdapter({ repository, columns: COLUMNS });

		await adapter.findOne({ predicate: IDENTITY }, context("read"));

		expect(capture.queryRunnersCreated).toBe(0);
		expect(capture.getOneCalls).toBe(1);
		expect(capture.whereArgs).toHaveLength(1);
	});
});

describe("TypeOrmCrudAdapter transaction runner", () => {
	it("self-enters the runner for every bare operation", async () => {
		const capture = createCapture();
		const repository = createFakeRepository(capture);
		const runner = new TestRunner(managerOf(repository));
		const adapter = createTypeOrmCrudAdapter({
			repository,
			columns: COLUMNS,
			transactionRunner: runner,
		});

		await adapter.create({ values: { name: "Ada", tenantId: "tenant-a" } }, context("create"));
		await adapter.findMany({ order: [], limit: 10, count: false }, context("list"));

		expect(runner.contexts).toHaveLength(2);
		expect(runner.contexts[0]).toMatchObject({
			operation: "create",
			accessMode: "read write",
			isolationLevel: "read committed",
			mustOwnCommit: true,
		});
		// An uncounted list stays at read committed: there is no second statement for a
		// snapshot to keep consistent with. Only `count: true` pairs page and total.
		expect(runner.contexts[1]).toMatchObject({
			operation: "list",
			accessMode: "read only",
			isolationLevel: "read committed",
			mustOwnCommit: false,
		});
		// The runner owns the transaction; the adapter must not open its own.
		expect(capture.queryRunnersCreated).toBe(0);
	});

	it("rejects a mutation runner that does not own the real commit", async () => {
		const repository = createFakeRepository(createCapture());
		const runner = new TestRunner(managerOf(repository), {
			accessMode: "read write",
			isolationLevel: "read committed",
			ownsCommit: false,
		});
		const adapter = createTypeOrmCrudAdapter({
			repository,
			columns: COLUMNS,
			transactionRunner: runner,
		});

		await expect(
			adapter.update({ predicate: IDENTITY, values: { name: "Grace" } }, context("update")),
		).rejects.toMatchObject({ code: "unsupported" });
	});

	it("rejects a runner that weakens the requested access mode", async () => {
		const repository = createFakeRepository(createCapture());
		const runner = new TestRunner(managerOf(repository), {
			accessMode: "read only",
			isolationLevel: "read committed",
			ownsCommit: true,
		});
		const adapter = createTypeOrmCrudAdapter({
			repository,
			columns: COLUMNS,
			transactionRunner: runner,
		});

		await expect(
			adapter.update({ predicate: IDENTITY, values: { name: "Grace" } }, context("update")),
		).rejects.toMatchObject({ code: "unsupported" });
	});

	it("rejects a runner that weakens a required repeatable-read isolation level", async () => {
		const repository = createFakeRepository(createCapture());
		const runner = new TestRunner(managerOf(repository), {
			accessMode: "read only",
			isolationLevel: "read committed",
			ownsCommit: true,
		});
		const adapter = createTypeOrmCrudAdapter({
			repository,
			columns: COLUMNS,
			transactionRunner: runner,
		});

		await expect(
			adapter.findMany({ order: [], limit: 10, count: true }, context("list")),
		).rejects.toMatchObject({ code: "unsupported" });
	});

	it("rejects a runner that reports malformed transaction state", async () => {
		const repository = createFakeRepository(createCapture());
		const runner = new TestRunner(managerOf(repository), {
			accessMode: "snapshot",
			isolationLevel: "read committed",
			ownsCommit: true,
		} as never);
		const adapter = createTypeOrmCrudAdapter({
			repository,
			columns: COLUMNS,
			transactionRunner: runner,
		});

		await expect(adapter.findOne({ predicate: IDENTITY }, context("read"))).rejects.toMatchObject({
			code: "unknown",
		});
	});

	it("refuses to mutate inside a reused read-only session", async () => {
		const repository = createFakeRepository(createCapture());
		const adapter = createTypeOrmCrudAdapter({ repository, columns: COLUMNS });

		await adapter.transaction(async (session) => {
			await expect(
				adapter.update(
					{ predicate: IDENTITY, values: { name: "Grace" } },
					{ ...context("update"), session },
				),
			).rejects.toMatchObject({ code: "unsupported" });
		}, context("read"));
	});
});

describe("TypeOrmCrudAdapter field access", () => {
	it("reads a dotted property path off a record", () => {
		const adapter = createTypeOrmCrudAdapter({
			repository: createFakeRepository(createCapture(), {
				knownProperties: ["id", "profile.nickname"],
			}),
			columns: { id: "id", nickname: "profile.nickname" },
		});

		expect(adapter.getField({ ...ROW, profile: { nickname: "ada" } }, "nickname")).toBe("ada");
		expect(adapter.getField({ ...ROW }, "nickname")).toBeUndefined();
	});
});
