import { type CrudAdapterSession, CrudAdapterError } from "@nestm/crud/adapter";
import {
	Brackets,
	type EntityManager,
	type EntityMetadata,
	type EntityTarget,
	type Repository,
} from "typeorm";
import { describe, expect, it, vi } from "vitest";

import {
	createTypeOrmCrudAdapter,
	createTypeOrmCrudReferenceChecker,
	TYPEORM_CRUD_REFERENCE_ALIAS,
	type TypeOrmCrudTransactionRunnerContext,
} from "../src/index.ts";

interface SourceEntity {
	readonly id: number;
}

interface ServerEntity {
	readonly id: string;
	readonly organizationId: string | null;
	readonly ownerUserId: string;
	readonly secret: string;
}

const SERVER_TARGET: EntityTarget<ServerEntity> = "Server";
const REFERENCE = {
	kind: "and",
	predicates: [
		{ kind: "comparison", field: "id", operator: "eq", value: "server-1" },
		{ kind: "comparison", field: "organizationId", operator: "eq", value: "org-1" },
	],
} as const;

interface ReferenceCapture {
	readonly aliases: string[];
	readonly selected: unknown[][];
	readonly where: unknown[][];
	readonly locks: unknown[][];
	readonly targets: unknown[];
	queryBuilders: number;
	rawReads: number;
	entityReads: number;
	runnerCalls: number;
}

function capture(): ReferenceCapture {
	return {
		aliases: [],
		selected: [],
		where: [],
		locks: [],
		targets: [],
		queryBuilders: 0,
		rawReads: 0,
		entityReads: 0,
		runnerCalls: 0,
	};
}

interface TargetRepositoryOptions {
	readonly found?: boolean;
	readonly rawFailure?: unknown;
	readonly nativeParameters?: Readonly<Record<string, unknown>>;
	readonly knownProperties?: readonly string[];
}

function targetRepository(
	state: ReferenceCapture,
	options: TargetRepositoryOptions = {},
): Repository<ServerEntity> {
	const known = new Set(
		options.knownProperties ?? ["id", "organizationId", "ownerUserId", "secret"],
	);
	let nativeApplied = false;
	const builder = {
		alias: TYPEORM_CRUD_REFERENCE_ALIAS,
		select(...args: unknown[]) {
			state.selected.push(args);
			return builder;
		},
		andWhere(...args: unknown[]) {
			state.where.push(args);
			if (args[0] instanceof Brackets) nativeApplied = true;
			return builder;
		},
		getParameters() {
			return nativeApplied ? (options.nativeParameters ?? {}) : {};
		},
		take(_limit: number) {
			return builder;
		},
		setLock(...args: unknown[]) {
			state.locks.push(args);
			return builder;
		},
		async getRawOne() {
			state.rawReads += 1;
			if (options.rawFailure !== undefined) throw options.rawFailure;
			return options.found === false ? undefined : { crud_reference_exists: 1 };
		},
		async getOne() {
			state.entityReads += 1;
			throw new Error("reference checks must not hydrate entities");
		},
	};
	const metadata = {
		findColumnWithPropertyPathStrict: (path: string) =>
			known.has(path)
				? { propertyPath: path, isVirtual: false, isVirtualProperty: false }
				: undefined,
	} as EntityMetadata;
	return {
		target: SERVER_TARGET,
		metadata,
		createQueryBuilder(alias: string) {
			state.queryBuilders += 1;
			state.aliases.push(alias);
			return builder;
		},
	} as unknown as Repository<ServerEntity>;
}

function sourceRepository(): Repository<SourceEntity> {
	return {
		target: "SourceEntity",
		metadata: {
			findColumnWithPropertyPath: (path: string) =>
				path === "id" ? { propertyPath: "id" } : undefined,
		},
	} as Repository<SourceEntity>;
}

function harness(options: TargetRepositoryOptions = {}) {
	const state = capture();
	const target = targetRepository(state, options);
	const manager = {
		getRepository(entityTarget: unknown) {
			state.targets.push(entityTarget);
			return target;
		},
	} as EntityManager;
	const adapter = createTypeOrmCrudAdapter({
		repository: sourceRepository(),
		columns: { id: "id" },
		transaction: {
			runner: {
				async run<Result>(
					_context: TypeOrmCrudTransactionRunnerContext,
					work: (activeManager: EntityManager) => Promise<Result>,
				): Promise<Result> {
					state.runnerCalls += 1;
					return work(manager);
				},
			},
		},
	});
	const checker = createTypeOrmCrudReferenceChecker({
		target: SERVER_TARGET,
		columns: {
			id: "id",
			organizationId: "organizationId",
			ownerUserId: "ownerUserId",
		},
	});
	return { adapter, checker, manager, state, target };
}

function mutationContext(operation: "create" | "update" | "upsert" = "upsert") {
	return { resource: "source", operation } as const;
}

describe("TypeOrmCrudReferenceChecker", () => {
	it("checks and locks a scoped target through the source mutation manager", async () => {
		const { adapter, checker, state, target } = harness();
		const originalContext = { marker: "original" };
		const nativePredicate = vi.fn(
			({
				repository,
				alias,
				context,
			}: Parameters<NonNullable<Parameters<typeof checker.exists>[0]["nativePredicate"]>>[0]) => {
				expect(repository).toBe(target);
				expect(alias).toBe(TYPEORM_CRUD_REFERENCE_ALIAS);
				expect(context).toMatchObject(originalContext);
				return new Brackets((where) =>
					where.where(`${alias}.ownerUserId = :owner`, { owner: "user-1" }),
				);
			},
		);

		const found = await adapter.transaction(async (session) => {
			const validationContext = { ...originalContext, session };
			return checker.exists({ predicate: REFERENCE, nativePredicate }, validationContext);
		}, mutationContext());

		expect(found).toBe(true);
		expect(state.runnerCalls).toBe(1);
		expect(state.targets).toEqual([SERVER_TARGET]);
		expect(state.aliases).toEqual([TYPEORM_CRUD_REFERENCE_ALIAS]);
		expect(state.selected).toEqual([["1", "crud_reference_exists"]]);
		expect(state.where).toHaveLength(2);
		expect(state.where[0]?.[0]).toBeInstanceOf(Brackets);
		expect(state.where[1]).toEqual([
			"(crud_reference.id = :crud_0 AND crud_reference.organizationId = :crud_1)",
			{ crud_0: "server-1", crud_1: "org-1" },
		]);
		expect(state.locks).toEqual([["pessimistic_read", undefined, [TYPEORM_CRUD_REFERENCE_ALIAS]]]);
		expect(state.rawReads).toBe(1);
		expect(state.entityReads).toBe(0);
		expect(nativePredicate).toHaveBeenCalledOnce();
	});

	it("returns false without hydrating an entity when the scoped row is absent", async () => {
		const { adapter, checker, state } = harness({ found: false });
		const found = await adapter.transaction(
			async (session) => checker.exists({ predicate: REFERENCE }, { session }),
			mutationContext(),
		);

		expect(found).toBe(false);
		expect(state.rawReads).toBe(1);
		expect(state.entityReads).toBe(0);
	});

	it("fails before target access for missing, foreign, expired, and read-only sessions", async () => {
		const { adapter, checker, state } = harness();
		const input = { predicate: REFERENCE } as const;

		await expect(
			// @ts-expect-error Runtime fail-closed coverage for an omitted transaction session.
			checker.exists(input, {}),
		).rejects.toMatchObject({ code: "unknown" });
		await expect(
			checker.exists(input, { session: { adapter: Symbol("foreign"), value: {} } }),
		).rejects.toMatchObject({ code: "unknown" });

		let expired: CrudAdapterSession | undefined;
		await adapter.transaction(async (session) => {
			expired = session;
			return undefined;
		}, mutationContext());
		expect(expired).toBeDefined();
		await expect(checker.exists(input, { session: expired! })).rejects.toMatchObject({
			code: "unknown",
		});

		await expect(
			adapter.transaction(async (session) => checker.exists(input, { session }), {
				resource: "source",
				operation: "read",
			}),
		).rejects.toMatchObject({ code: "unsupported" });
		expect(state.targets).toHaveLength(0);
		expect(state.queryBuilders).toBe(0);
	});

	it("fails closed for unconstrained calls and invalid target metadata", async () => {
		const unconstrained = harness();
		await expect(
			unconstrained.adapter.transaction(
				async (session) =>
					unconstrained.checker.exists(
						// @ts-expect-error Runtime fail-closed coverage for a missing predicate.
						{},
						{ session },
					),
				mutationContext(),
			),
		).rejects.toMatchObject({ code: "unsupported" });
		expect(unconstrained.state.targets).toHaveLength(0);

		const invalid = harness({ knownProperties: ["id", "organizationId"] });
		await expect(
			invalid.adapter.transaction(
				async (session) => invalid.checker.exists({ predicate: REFERENCE }, { session }),
				mutationContext(),
			),
		).rejects.toMatchObject({ code: "unknown" });
		expect(invalid.state.queryBuilders).toBe(0);
		expect(invalid.state.rawReads).toBe(0);
	});

	it("rejects native/neutral parameter collisions before reading", async () => {
		const { adapter, checker, state } = harness({ nativeParameters: { crud_0: "collision" } });
		await expect(
			adapter.transaction(
				async (session) =>
					checker.exists(
						{
							predicate: REFERENCE,
							nativePredicate: () => new Brackets((where) => where.where("1 = 1")),
						},
						{ session },
					),
				mutationContext(),
			),
		).rejects.toMatchObject({ code: "unknown" });
		expect(state.rawReads).toBe(0);
	});

	it("normalizes query and native-predicate failures", async () => {
		const queryFailure = harness({ rawFailure: { code: "57P01" } });
		await expect(
			queryFailure.adapter.transaction(
				async (session) => queryFailure.checker.exists({ predicate: REFERENCE }, { session }),
				mutationContext(),
			),
		).rejects.toMatchObject({
			code: "unknown",
			message: "The database operation failed.",
		});

		const predicateFailure = harness();
		const error = await predicateFailure.adapter
			.transaction(
				async (session) =>
					predicateFailure.checker.exists(
						{
							nativePredicate: async () => {
								throw { code: "23505" };
							},
						},
						{ session },
					),
				mutationContext(),
			)
			.catch((thrown: unknown) => thrown);
		expect(error).toBeInstanceOf(CrudAdapterError);
		expect(error).toMatchObject({ code: "conflict" });
		expect(predicateFailure.state.rawReads).toBe(0);
	});
});
