import { CrudService, crudOperations, defineCrudResource, type CrudScope } from "@nestm/crud";
import {
	defineCrudBinding,
	type CrudAdapter,
	type CrudAdapterContext,
	type CrudOrder,
	type CrudPredicate,
	type CrudValues,
} from "@nestm/crud/adapter";
import { createCrudAdapterConformanceCases } from "@nestm/crud/testing";
import { MemoryCrudAdapter } from "@nestm/crud-memory";
import {
	createDrizzleCrudAdapter,
	type DrizzleCrudTransactionRunnerContext,
} from "@nestm/crud-drizzle";
import { createPrismaCrudAdapter } from "@nestm/crud-prisma";
import {
	createTypeOrmCrudAdapter,
	TypeOrmCrudTransactionIsolationLevel,
	type TypeOrmCrudTransactionRunnerContext,
} from "@nestm/crud-typeorm";
import { PrismaPg } from "@prisma/adapter-pg";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { integer, pgTable, primaryKey, text, timestamp, unique } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { Brackets, DataSource, EntitySchema } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { buildCrudCursorPredicate } from "../../packages/crud/src/cursor/cursor-predicate.ts";
import { resolveCrudModuleOptions } from "../../packages/crud/src/module/crud-module.options.ts";
import { CrudRegistry } from "../../packages/crud/src/runtime/crud-registry.ts";
import { PrismaClient, type CrudPgPrismaItem } from "./prisma/generated/client.ts";

interface ItemRecord {
	readonly tenantId: string;
	readonly id: string;
	readonly name: string;
	readonly score: number;
	readonly category: string | null;
	readonly createdAt: Date;
}

type AdapterName = "typeorm" | "drizzle" | "prisma";

interface AdapterHarness {
	readonly adapter: CrudAdapter<ItemRecord>;
	readonly close: () => Promise<void>;
}

const adapterNames = ["typeorm", "drizzle", "prisma"] as const satisfies readonly AdapterName[];
const tableNames = [
	"crud_pg_typeorm_items",
	"crud_pg_drizzle_items",
	"crud_pg_prisma_items",
] as const;
const skipPostgres = process.env.PG_SKIP === "1";
const harnesses = new Map<AdapterName, AdapterHarness>();
let adminPool: Pool | undefined;
let createSecuredDrizzleAdapter:
	| ((
			runnerContexts: DrizzleCrudTransactionRunnerContext[],
			rowContexts: CrudAdapterContext[],
	  ) => CrudAdapter<ItemRecord>)
	| undefined;
let createSecuredTypeOrmAdapter:
	| ((
			runnerContexts: TypeOrmCrudTransactionRunnerContext[],
			rowContexts: CrudAdapterContext[],
	  ) => CrudAdapter<ItemRecord>)
	| undefined;
let createOperationIsolatedTypeOrmAdapter:
	((observedIsolation: string[]) => CrudAdapter<ItemRecord>) | undefined;

const typeOrmItemSchema = new EntitySchema<ItemRecord>({
	name: "CrudPgTypeOrmItem",
	tableName: "crud_pg_typeorm_items",
	columns: {
		tenantId: { name: "tenant_id", type: String, primary: true },
		id: { type: String, primary: true },
		name: { type: String, unique: true },
		score: { type: Number },
		category: { type: String, nullable: true },
		createdAt: { name: "created_at", type: "timestamptz" },
	},
});

const drizzleItems = pgTable(
	"crud_pg_drizzle_items",
	{
		tenantId: text("tenant_id").notNull(),
		id: text("id").notNull(),
		name: text("name").notNull(),
		score: integer("score").notNull(),
		category: text("category"),
		createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull(),
	},
	(table) => [
		primaryKey({
			columns: [table.tenantId, table.id],
			name: "crud_pg_drizzle_items_pkey",
		}),
		unique("crud_pg_drizzle_items_name_key").on(table.name),
	],
);

const SCOPE_TENANT = "service-scope-a";
const RELATION_PARENT_TENANT = "relation-parents";
const RELATION_CHILD_TENANT = "relation-children-visible";

const scopedServiceResource = defineCrudResource({
	fields: ["tenantId", "id", "name", "score", "category", "createdAt"],
	name: "postgres-scoped-items",
	path: "postgres/scoped-items",
	itemPath: ":id",
	idFields: { id: "id" },
	contracts: {
		id: z.object({ id: z.string().min(1) }),
		create: z.object({
			id: z.string().min(1),
			tenantId: z.string().min(1),
			name: z.string().min(1),
			score: z.number().int(),
		}),
		update: z.object({
			name: z.string().min(1).optional(),
			score: z.number().int().optional(),
		}),
		response: z.object({
			id: z.string(),
			tenantId: z.string(),
			name: z.string(),
			score: z.number().int(),
		}),
	},
	operations: crudOperations.all(),
	query: {
		sort: { fields: ["id"], default: ["id"] },
		pagination: { offset: true, defaultLimit: 10, maxLimit: 20 },
	},
});

const relationChildResource = defineCrudResource({
	fields: ["tenantId", "id", "name", "score", "category", "createdAt"],
	name: "postgres-relation-children",
	path: "postgres/relation-children",
	itemPath: ":id",
	idFields: { id: "id" },
	contracts: {
		id: z.object({ id: z.string().min(1) }),
		create: z.object({ parentId: z.string(), name: z.string() }),
		update: z.object({ name: z.string().optional() }),
		response: z.object({ id: z.string(), parentId: z.string(), name: z.string() }),
	},
	operations: crudOperations.readOnly(),
	query: { pagination: { offset: true, defaultLimit: 10, maxLimit: 20 } },
});

const relationParentResource = defineCrudResource({
	fields: ["tenantId", "id", "name", "score", "category", "createdAt"],
	name: "postgres-relation-parents",
	path: "postgres/relation-parents",
	itemPath: ":id",
	idFields: { id: "id" },
	contracts: {
		id: z.object({ id: z.string().min(1) }),
		create: z.object({ name: z.string() }),
		update: z.object({ name: z.string().optional() }),
		response: z.object({
			id: z.string(),
			name: z.string(),
			children: z
				.array(z.object({ id: z.string(), parentId: z.string(), name: z.string() }))
				.optional(),
		}),
	},
	operations: crudOperations.readOnly(),
	query: {
		sort: { fields: ["id"], default: ["id"] },
		pagination: { offset: true, defaultLimit: 10, maxLimit: 20 },
	},
	relations: {
		children: {
			type: "hasMany",
			target: () => relationChildResource,
			local: ["id"],
			foreign: ["category"],
			maxItems: 2,
		},
	},
});

function context(operation: CrudAdapterContext["operation"]): CrudAdapterContext {
	return { resource: "postgres-conformance", operation };
}

function comparison<const Field extends string>(
	field: Field,
	operator: Extract<CrudPredicate<Field>, { kind: "comparison" }>["operator"],
	value: unknown,
): CrudPredicate<Field> {
	return { kind: "comparison", field, operator, value };
}

function identity(tenantId: string, id: string): CrudPredicate<"tenantId" | "id"> {
	return {
		kind: "and",
		predicates: [comparison("tenantId", "eq", tenantId), comparison("id", "eq", id)],
	};
}

function record(
	fields: Partial<ItemRecord> & Pick<ItemRecord, "tenantId" | "id" | "name">,
): ItemRecord {
	return {
		tenantId: fields.tenantId,
		id: fields.id,
		name: fields.name,
		score: fields.score ?? 0,
		category: fields.category ?? null,
		createdAt: fields.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
	};
}

function values(item: ItemRecord): CrudValues {
	return { ...item };
}

function key(item: ItemRecord): string {
	return `${item.tenantId}/${item.id}`;
}

function harness(name: AdapterName): AdapterHarness {
	const value = harnesses.get(name);
	if (value === undefined) throw new Error(`The ${name} PostgreSQL harness was not initialized.`);
	return value;
}

async function createSchema(pool: Pool): Promise<void> {
	await pool.query(`DROP TABLE IF EXISTS ${tableNames.join(", ")}`);
	for (const tableName of tableNames) {
		await pool.query(`
			CREATE TABLE ${tableName} (
				tenant_id text NOT NULL,
				id text NOT NULL,
				name text NOT NULL,
				score integer NOT NULL,
				category text,
				created_at timestamptz NOT NULL,
				CONSTRAINT ${tableName}_pkey PRIMARY KEY (tenant_id, id),
				CONSTRAINT ${tableName}_name_key UNIQUE (name)
			)
		`);
	}
}

async function initializeHarnesses(pgUrl: string): Promise<void> {
	adminPool = new Pool({ connectionString: pgUrl, max: 2 });
	await createSchema(adminPool);

	const typeOrmDataSource = await new DataSource({
		type: "postgres",
		url: pgUrl,
		entities: [typeOrmItemSchema],
		synchronize: false,
	}).initialize();
	const typeOrmAdapter = createTypeOrmCrudAdapter({
		repository: typeOrmDataSource.getRepository(typeOrmItemSchema),
		columns: {
			tenantId: "tenantId",
			id: "id",
			name: "name",
			score: "score",
			category: "category",
			createdAt: "createdAt",
		},
	});
	createSecuredTypeOrmAdapter = (runnerContexts, rowContexts) =>
		createTypeOrmCrudAdapter({
			repository: typeOrmDataSource.getRepository(typeOrmItemSchema),
			columns: {
				tenantId: "tenantId",
				id: "id",
				name: "name",
				score: "score",
				category: "category",
				createdAt: "createdAt",
			},
			transaction: {
				runner: {
					run: async (runnerContext, workWithTransaction) => {
						runnerContexts.push(runnerContext);
						// A query runner rather than `DataSource.transaction`: only the runner can
						// issue `SET TRANSACTION READ ONLY`, and it has to be the first statement.
						const queryRunner = typeOrmDataSource.createQueryRunner();
						await queryRunner.connect();
						await queryRunner.startTransaction(
							runnerContext.isolationLevel === TypeOrmCrudTransactionIsolationLevel.RepeatableRead
								? "REPEATABLE READ"
								: "READ COMMITTED",
						);
						try {
							if (runnerContext.accessMode === "read only") {
								await queryRunner.query("SET TRANSACTION READ ONLY");
							}
							const result = await workWithTransaction(queryRunner.manager, {
								accessMode: runnerContext.accessMode,
								isolationLevel: runnerContext.isolationLevel,
								ownsCommit: true,
							});
							await queryRunner.commitTransaction();
							return result;
						} catch (error) {
							if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
							throw error;
						} finally {
							await queryRunner.release();
						}
					},
				},
			},
			rowPredicate: ({ alias, context: rowContext }) => {
				rowContexts.push(rowContext);
				// The alias arrives as an argument. Inferring it from the builder is what makes
				// a predicate compiled for one entity silently filter another that happens to
				// share the column name.
				return new Brackets((qb) =>
					qb.where(`${alias}.tenantId = :securedTenantId`, {
						securedTenantId: "typeorm-secured",
					}),
				);
			},
		});
	createOperationIsolatedTypeOrmAdapter = (observedIsolation) =>
		createTypeOrmCrudAdapter({
			repository: typeOrmDataSource.getRepository(typeOrmItemSchema),
			columns: {
				tenantId: "tenantId",
				id: "id",
				name: "name",
				score: "score",
				category: "category",
				createdAt: "createdAt",
			},
			transaction: {
				isolationLevel: TypeOrmCrudTransactionIsolationLevel.RepeatableRead,
				runner: {
					run: async (runnerContext, workWithTransaction) => {
						const queryRunner = typeOrmDataSource.createQueryRunner();
						await queryRunner.connect();
						await queryRunner.startTransaction(
							runnerContext.isolationLevel === TypeOrmCrudTransactionIsolationLevel.RepeatableRead
								? "REPEATABLE READ"
								: "READ COMMITTED",
						);
						try {
							const rows: unknown = await queryRunner.query("SHOW transaction_isolation");
							const first = Array.isArray(rows) ? rows[0] : undefined;
							const isolation =
								typeof first === "object" && first !== null
									? Reflect.get(first, "transaction_isolation")
									: undefined;
							if (typeof isolation !== "string") {
								throw new Error("PostgreSQL did not report transaction_isolation.");
							}
							observedIsolation.push(isolation);
							const result = await workWithTransaction(queryRunner.manager, {
								accessMode: runnerContext.accessMode,
								isolationLevel: runnerContext.isolationLevel,
								ownsCommit: true,
							});
							await queryRunner.commitTransaction();
							return result;
						} catch (error) {
							if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
							throw error;
						} finally {
							await queryRunner.release();
						}
					},
				},
			},
		});
	harnesses.set("typeorm", {
		adapter: typeOrmAdapter,
		close: () => typeOrmDataSource.destroy(),
	});

	const drizzlePool = new Pool({ connectionString: pgUrl, max: 4 });
	const drizzleDatabase = drizzle(drizzlePool);
	const drizzleAdapter = createDrizzleCrudAdapter({
		database: drizzleDatabase,
		table: drizzleItems,
		columns: {
			tenantId: drizzleItems.tenantId,
			id: drizzleItems.id,
			name: drizzleItems.name,
			score: drizzleItems.score,
			category: drizzleItems.category,
			createdAt: drizzleItems.createdAt,
		},
	});
	createSecuredDrizzleAdapter = (runnerContexts, rowContexts) =>
		createDrizzleCrudAdapter({
			database: drizzleDatabase,
			table: drizzleItems,
			columns: {
				tenantId: drizzleItems.tenantId,
				id: drizzleItems.id,
				name: drizzleItems.name,
				score: drizzleItems.score,
				category: drizzleItems.category,
				createdAt: drizzleItems.createdAt,
			},
			transactionRunner: {
				run: (runnerContext, workWithTransaction) => {
					runnerContexts.push(runnerContext);
					return drizzleDatabase.transaction(
						(transaction) =>
							workWithTransaction(transaction, {
								accessMode: runnerContext.accessMode,
								isolationLevel: runnerContext.isolationLevel,
								ownsCommit: true,
							}),
						{
							accessMode: runnerContext.accessMode,
							isolationLevel: runnerContext.isolationLevel,
						},
					);
				},
			},
			rowPredicate: ({ table, context: rowContext }) => {
				rowContexts.push(rowContext);
				return eq(table.tenantId, "drizzle-secured");
			},
		});
	harnesses.set("drizzle", {
		adapter: drizzleAdapter,
		close: () => drizzlePool.end(),
	});

	const prismaClient = new PrismaClient({
		adapter: new PrismaPg({ connectionString: pgUrl }),
	});
	await prismaClient.$connect();
	const prismaAdapter = createPrismaCrudAdapter<
		CrudPgPrismaItem,
		typeof prismaClient,
		typeof prismaClient.crudPgPrismaItem
	>({
		client: prismaClient,
		delegate: (client) => client.crudPgPrismaItem,
		identity: (item) => ({
			tenantId_id: { tenantId: item.tenantId, id: item.id },
		}),
		nonNullableFields: ["tenantId", "id", "name", "score", "createdAt"],
	});
	harnesses.set("prisma", {
		adapter: prismaAdapter,
		close: () => prismaClient.$disconnect(),
	});
}

async function resetData(): Promise<void> {
	if (adminPool === undefined) throw new Error("PostgreSQL admin pool was not initialized.");
	await adminPool.query(`TRUNCATE TABLE ${tableNames.join(", ")}`);
}

async function seed(adapter: CrudAdapter<ItemRecord>, items: readonly ItemRecord[]): Promise<void> {
	for (const item of items) {
		await adapter.create({ values: values(item) }, context("create"));
	}
}

async function findKeys(
	adapter: CrudAdapter<ItemRecord>,
	predicate: CrudPredicate,
	order: readonly CrudOrder[] = [
		{ field: "score", direction: "asc" },
		{ field: "name", direction: "asc" },
		{ field: "tenantId", direction: "asc" },
		{ field: "id", direction: "asc" },
	],
): Promise<readonly string[]> {
	const result = await adapter.findMany(
		{ predicate, order, limit: 100, count: true },
		context("list"),
	);
	return result.records.map(key);
}

function createScopedService(adapter: CrudAdapter<ItemRecord>) {
	const binding = defineCrudBinding({
		resource: scopedServiceResource,
		adapter: { useValue: adapter },
		mappings: {
			create: (input) =>
				record({
					tenantId: input.tenantId,
					id: input.id,
					name: input.name,
					score: input.score,
				}),
			update: (input) => ({
				...(input.name === undefined ? {} : { name: input.name }),
				...(input.score === undefined ? {} : { score: input.score }),
			}),
			persistence: (input) => input,
			response: (item) => ({
				id: item.id,
				tenantId: item.tenantId,
				name: item.name,
				score: item.score,
			}),
		},
	});
	const tenantScope: CrudScope<typeof scopedServiceResource> = {
		resolve: () => ({
			predicate: comparison("tenantId", "eq", SCOPE_TENANT),
			createValues: { tenantId: SCOPE_TENANT },
		}),
	};
	return new CrudService(
		scopedServiceResource,
		binding,
		adapter,
		[],
		[tenantScope],
		new CrudRegistry(),
		resolveCrudModuleOptions({}),
	);
}

function createRelationServices(adapter: CrudAdapter<ItemRecord>) {
	const childBinding = defineCrudBinding({
		resource: relationChildResource,
		adapter: { useValue: adapter },
		mappings: {
			create: (input) =>
				record({
					tenantId: RELATION_CHILD_TENANT,
					id: input.name,
					name: input.name,
					category: input.parentId,
				}),
			update: (input) => input,
			persistence: (input) => input,
			response: (item) => ({
				id: item.id,
				parentId: requiredString(item.category),
				name: item.name,
			}),
		},
	});
	const parentBinding = defineCrudBinding({
		resource: relationParentResource,
		adapter: { useValue: adapter },
		mappings: {
			create: (input) =>
				record({
					tenantId: RELATION_PARENT_TENANT,
					id: input.name,
					name: input.name,
				}),
			update: (input) => input,
			persistence: (input) => input,
			response: (item, relations) => ({
				id: item.id,
				name: item.name,
				...(relations.children === undefined
					? {}
					: { children: readRelationChildren(relations.children) }),
			}),
		},
	});
	const parentScope: CrudScope<typeof relationParentResource> = {
		resolve: () => ({ predicate: comparison("tenantId", "eq", RELATION_PARENT_TENANT) }),
	};
	const childScope: CrudScope<typeof relationChildResource> = {
		resolve: () => ({ predicate: comparison("tenantId", "eq", RELATION_CHILD_TENANT) }),
	};
	const registry = new CrudRegistry();
	const options = resolveCrudModuleOptions({});
	const childService = new CrudService(
		relationChildResource,
		childBinding,
		adapter,
		[],
		[childScope],
		registry,
		options,
	);
	const parentService = new CrudService(
		relationParentResource,
		parentBinding,
		adapter,
		[],
		[parentScope],
		registry,
		options,
	);
	registry.register(childBinding, childService);
	registry.register(parentBinding, parentService);
	registry.onApplicationBootstrap();
	return { parentService };
}

function readRelationChildren(value: unknown) {
	if (!Array.isArray(value)) throw new TypeError("Expected relation children.");
	return value
		.map((child) => {
			if (typeof child !== "object" || child === null) {
				throw new TypeError("Expected a relation child record.");
			}
			return {
				id: requiredString("id" in child ? child.id : undefined),
				parentId: requiredString("parentId" in child ? child.parentId : undefined),
				name: requiredString("name" in child ? child.name : undefined),
			};
		})
		.toSorted((left, right) => left.id.localeCompare(right.id));
}

function requiredString(value: unknown): string {
	if (typeof value !== "string") throw new TypeError("Expected a string.");
	return value;
}

describe.skipIf(skipPostgres)("PostgreSQL adapter conformance", () => {
	beforeAll(async () => {
		const pgUrl = process.env.PG_URL;
		if (pgUrl === undefined || pgUrl.length === 0) return;
		await initializeHarnesses(pgUrl);
	});

	beforeEach(resetData);

	afterAll(async () => {
		await Promise.all([...harnesses.values()].map((entry) => entry.close()));
		harnesses.clear();
		createSecuredDrizzleAdapter = undefined;
		createSecuredTypeOrmAdapter = undefined;
		if (adminPool !== undefined) {
			await adminPool.query(`DROP TABLE IF EXISTS ${tableNames.join(", ")}`);
			await adminPool.end();
			adminPool = undefined;
		}
	});

	for (const adapterName of adapterNames) {
		describe(adapterName, () => {
			for (const conformanceCase of createCrudAdapterConformanceCases<ItemRecord>()) {
				it(`shared contract: ${conformanceCase.name}`, async () => {
					await conformanceCase.run({
						adapter: harness(adapterName).adapter,
						first: values(
							record({
								tenantId: "suite",
								id: "one",
								name: "suite-one",
								score: 10,
								category: "a",
							}),
						),
						second: values(
							record({
								tenantId: "suite",
								id: "two",
								name: "suite-two",
								score: 20,
								category: "b",
							}),
						),
						update: { score: 99 },
						idField: "id",
						sortField: "category",
						expectedAscendingIds: ["one", "two"],
						getId: (item) => item.id,
					});
				});
			}

			it("uses every field of a composite identity for read, update, and delete", async () => {
				const adapter = harness(adapterName).adapter;
				await seed(adapter, [
					record({ tenantId: "tenant-a", id: "shared", name: "composite-a", score: 1 }),
					record({ tenantId: "tenant-b", id: "shared", name: "composite-b", score: 2 }),
				]);

				const found = await adapter.findOne(
					{ predicate: identity("tenant-a", "shared") },
					context("read"),
				);
				expect(found?.name).toBe("composite-a");

				const updated = await adapter.update(
					{ predicate: identity("tenant-a", "shared"), values: { score: 41 } },
					context("update"),
				);
				expect(updated?.score).toBe(41);
				const untouched = await adapter.findOne(
					{ predicate: identity("tenant-b", "shared") },
					context("read"),
				);
				expect(untouched?.score).toBe(2);

				expect(
					await adapter.delete({ predicate: identity("tenant-a", "shared") }, context("delete")),
				).not.toBeNull();
				expect(
					await adapter.findOne({ predicate: identity("tenant-b", "shared") }, context("read")),
				).not.toBeNull();
			});

			it("matches memory semantics for every portable filter operator", async () => {
				const databaseAdapter = harness(adapterName).adapter;
				const items = [
					record({
						tenantId: "t1",
						id: "a",
						name: "alpha",
						score: 10,
						category: "red",
					}),
					record({ tenantId: "t1", id: "b", name: "bravo", score: 20, category: "blue" }),
					record({
						tenantId: "t2",
						id: "c",
						name: "charlie",
						score: 30,
						category: "red",
					}),
					record({ tenantId: "t2", id: "d", name: "delta", score: 40 }),
					record({
						tenantId: "t3",
						id: "injection",
						name: "x%' OR TRUE --",
						score: 50,
						category: "literal",
					}),
				] as const;
				await seed(databaseAdapter, items);
				const memoryAdapter = new MemoryCrudAdapter<ItemRecord>({ initialRecords: items });
				const predicates = [
					comparison("score", "eq", 20),
					comparison("score", "ne", 20),
					comparison("score", "gt", 20),
					comparison("score", "gte", 20),
					comparison("score", "lt", 30),
					comparison("score", "lte", 30),
					comparison("score", "in", [10, 30, 50]),
					comparison("score", "nin", [10, 30, 50]),
					comparison("name", "contains", "ha"),
					comparison("name", "icontains", "AL"),
					comparison("category", "eq", null),
					comparison("category", "ne", null),
					comparison("category", "ne", "red"),
					comparison("category", "in", ["red"]),
					comparison("category", "nin", ["red"]),
					comparison("category", "isnull", true),
					comparison("name", "isnull", true),
					comparison("name", "isnull", false),
					comparison("score", "between", [15, 40]),
					{ kind: "not", predicate: comparison("category", "eq", "red") },
					{
						kind: "or",
						predicates: [comparison("category", "eq", "red"), comparison("name", "eq", "delta")],
					},
				] as const;

				for (const predicate of predicates) {
					expect(await findKeys(databaseAdapter, predicate)).toEqual(
						await findKeys(memoryAdapter, predicate),
					);
				}
			});

			it("executes a mixed-direction cursor predicate with composite tie-breakers", async () => {
				const databaseAdapter = harness(adapterName).adapter;
				const items = [
					record({ tenantId: "a", id: "1", name: "zeta", score: 10, category: "z" }),
					record({ tenantId: "a", id: "2", name: "beta-a", score: 10, category: "b" }),
					record({ tenantId: "b", id: "1", name: "beta-b", score: 10, category: "b" }),
					record({ tenantId: "a", id: "3", name: "omega", score: 20, category: "z" }),
					record({ tenantId: "b", id: "2", name: "alpha", score: 20, category: "a" }),
				] as const;
				await seed(databaseAdapter, items);
				const memoryAdapter = new MemoryCrudAdapter<ItemRecord>({ initialRecords: items });
				const order = [
					{ field: "score", direction: "asc" },
					{ field: "category", direction: "desc" },
					{ field: "tenantId", direction: "asc" },
					{ field: "id", direction: "asc" },
				] as const satisfies readonly CrudOrder[];
				const cursor = record({
					tenantId: "a",
					id: "2",
					name: "beta-a",
					score: 10,
					category: "b",
				});
				const predicate = buildCrudCursorPredicate(order, [
					cursor.score,
					cursor.category,
					cursor.tenantId,
					cursor.id,
				]);

				expect(await findKeys(databaseAdapter, predicate, order)).toEqual(
					await findKeys(memoryAdapter, predicate, order),
				);
			});

			it("binds SQL-injection-shaped strings and preserves the table", async () => {
				const adapter = harness(adapterName).adapter;
				const payload = "x%' OR TRUE --";
				await seed(adapter, [
					record({ tenantId: "safe", id: "one", name: "ordinary", score: 1 }),
					record({ tenantId: "safe", id: "two", name: payload, score: 2 }),
				]);

				expect(await findKeys(adapter, comparison("name", "eq", payload))).toEqual(["safe/two"]);
				expect(await findKeys(adapter, comparison("name", "contains", payload))).toEqual([
					"safe/two",
				]);
				const remaining = await adapter.findMany(
					{
						order: [{ field: "id", direction: "asc" }],
						limit: 10,
						count: true,
					},
					context("list"),
				);
				expect(remaining.total).toBe(2);
			});

			it("enforces CrudService scopes across reads and mutations", async () => {
				const adapter = harness(adapterName).adapter;
				await seed(adapter, [
					record({
						tenantId: SCOPE_TENANT,
						id: "visible",
						name: "scope-visible",
						score: 10,
					}),
					record({
						tenantId: "service-scope-b",
						id: "hidden",
						name: "scope-hidden",
						score: 20,
					}),
				]);
				const service = createScopedService(adapter);

				await expect(service.list({ page: "1", limit: "10" })).resolves.toMatchObject({
					data: [
						{
							id: "visible",
							tenantId: SCOPE_TENANT,
							name: "scope-visible",
							score: 10,
						},
					],
					meta: { mode: "offset", total: 1 },
				});
				await expect(service.read({ id: "hidden" })).rejects.toMatchObject({ status: 404 });
				await expect(
					service.update({ id: "hidden" }, { name: "must-not-update" }),
				).rejects.toMatchObject({ status: 404 });
				await expect(service.delete({ id: "hidden" })).rejects.toMatchObject({ status: 404 });

				await expect(
					service.create({
						id: "created",
						tenantId: "client-controlled-tenant",
						name: "scope-created",
						score: 30,
					}),
				).resolves.toMatchObject({ id: "created", tenantId: SCOPE_TENANT });
				await expect(
					service.update({ id: "visible" }, { name: "scope-updated", score: 11 }),
				).resolves.toMatchObject({
					id: "visible",
					tenantId: SCOPE_TENANT,
					name: "scope-updated",
					score: 11,
				});
				await service.delete({ id: "visible" });

				expect(
					await adapter.findOne(
						{ predicate: identity("service-scope-b", "hidden") },
						context("read"),
					),
				).toMatchObject({ name: "scope-hidden", score: 20 });
				expect(
					await adapter.findOne({ predicate: identity(SCOPE_TENANT, "visible") }, context("read")),
				).toBeNull();
				expect(
					await adapter.findOne({ predicate: identity(SCOPE_TENANT, "created") }, context("read")),
				).toMatchObject({ tenantId: SCOPE_TENANT, name: "scope-created" });
			});

			it("batches scoped one-hop relations and rejects over-bound results", async () => {
				const adapter = harness(adapterName).adapter;
				await seed(adapter, [
					record({
						tenantId: RELATION_PARENT_TENANT,
						id: "parent-a",
						name: "relation-parent-a",
					}),
					record({
						tenantId: RELATION_PARENT_TENANT,
						id: "parent-b",
						name: "relation-parent-b",
					}),
					record({
						tenantId: RELATION_CHILD_TENANT,
						id: "child-a1",
						name: "relation-child-a1",
						category: "parent-a",
					}),
					record({
						tenantId: RELATION_CHILD_TENANT,
						id: "child-a2",
						name: "relation-child-a2",
						category: "parent-a",
					}),
					record({
						tenantId: "relation-children-hidden",
						id: "child-hidden",
						name: "relation-child-hidden",
						category: "parent-a",
					}),
					record({
						tenantId: RELATION_CHILD_TENANT,
						id: "child-b1",
						name: "relation-child-b1",
						category: "parent-b",
					}),
				]);
				const { parentService } = createRelationServices(adapter);
				const findMany = vi.spyOn(adapter, "findMany");

				try {
					await expect(
						parentService.list({ page: "1", limit: "10", include: "children" }),
					).resolves.toEqual({
						data: [
							{
								id: "parent-a",
								name: "relation-parent-a",
								children: [
									{
										id: "child-a1",
										parentId: "parent-a",
										name: "relation-child-a1",
									},
									{
										id: "child-a2",
										parentId: "parent-a",
										name: "relation-child-a2",
									},
								],
							},
							{
								id: "parent-b",
								name: "relation-parent-b",
								children: [
									{
										id: "child-b1",
										parentId: "parent-b",
										name: "relation-child-b1",
									},
								],
							},
						],
						meta: {
							mode: "offset",
							page: 1,
							limit: 10,
							total: 2,
							totalPages: 1,
							hasNextPage: false,
							hasPreviousPage: false,
						},
					});
					expect(findMany).toHaveBeenCalledTimes(2);
					const relationQuery = findMany.mock.calls.at(1)?.[0];
					expect(relationQuery?.limit).toBe(6);
					expect(relationQuery?.count).toBe(false);

					await seed(adapter, [
						record({
							tenantId: RELATION_CHILD_TENANT,
							id: "child-a3",
							name: "relation-child-a3",
							category: "parent-a",
						}),
					]);
					await expect(
						parentService.read({ id: "parent-a" }, undefined, ["children"]),
					).rejects.toMatchObject({ status: 422 });
				} finally {
					findMany.mockRestore();
				}
			});

			it("sanitizes unique conflicts", async () => {
				const adapter = harness(adapterName).adapter;
				await adapter.create(
					{ values: values(record({ tenantId: "a", id: "one", name: "duplicate" })) },
					context("create"),
				);
				await expect(
					adapter.create(
						{ values: values(record({ tenantId: "b", id: "two", name: "duplicate" })) },
						context("create"),
					),
				).rejects.toMatchObject({ name: "CrudAdapterError", code: "conflict" });
			});

			it("preserves unique conflicts raised inside a transaction", async () => {
				const adapter = harness(adapterName).adapter;
				await adapter.create(
					{ values: values(record({ tenantId: "a", id: "one", name: "duplicate" })) },
					context("create"),
				);
				const transactionContext = context("create");
				await expect(
					adapter.transaction(
						(session) =>
							adapter.create(
								{
									values: values(record({ tenantId: "b", id: "two", name: "duplicate" })),
								},
								{ ...transactionContext, session },
							),
						transactionContext,
					),
				).rejects.toMatchObject({ name: "CrudAdapterError", code: "conflict" });
			});
		});
	}

	it("runs Drizzle row policy and counted totals in application-owned transactions", async () => {
		if (createSecuredDrizzleAdapter === undefined) {
			throw new Error("The secured Drizzle adapter factory was not initialized.");
		}
		await seed(harness("drizzle").adapter, [
			record({
				tenantId: "drizzle-secured",
				id: "visible",
				name: "drizzle-secured-visible",
				score: 1,
			}),
			record({
				tenantId: "drizzle-hidden",
				id: "hidden",
				name: "drizzle-secured-hidden",
				score: 2,
			}),
		]);
		const runnerContexts: DrizzleCrudTransactionRunnerContext[] = [];
		const rowContexts: CrudAdapterContext[] = [];
		const adapter = createSecuredDrizzleAdapter(runnerContexts, rowContexts);

		await expect(
			adapter.findMany({ order: [], limit: 10, count: true }, context("list")),
		).resolves.toMatchObject({
			records: [{ tenantId: "drizzle-secured", id: "visible" }],
			total: 1,
		});
		await expect(
			adapter.update(
				{ predicate: identity("drizzle-hidden", "hidden"), values: { score: 99 } },
				context("update"),
			),
		).resolves.toBeNull();
		await expect(
			adapter.delete({ predicate: identity("drizzle-hidden", "hidden") }, context("delete")),
		).resolves.toBeNull();

		expect(runnerContexts).toHaveLength(3);
		expect(runnerContexts[0]).toMatchObject({
			accessMode: "read only",
			isolationLevel: "repeatable read",
			mustOwnCommit: false,
		});
		expect(runnerContexts[1]).toMatchObject({ mustOwnCommit: true });
		expect(runnerContexts[2]).toMatchObject({ mustOwnCommit: true });
		expect(rowContexts).toHaveLength(3);
		expect(rowContexts.every(({ session }) => session !== undefined)).toBe(true);
	});

	it("runs TypeORM row policy and counted totals in application-owned transactions", async () => {
		if (createSecuredTypeOrmAdapter === undefined) {
			throw new Error("The secured TypeORM adapter factory was not initialized.");
		}
		await seed(harness("typeorm").adapter, [
			record({
				tenantId: "typeorm-secured",
				id: "visible",
				name: "typeorm-secured-visible",
				score: 1,
			}),
			record({
				tenantId: "typeorm-hidden",
				id: "hidden",
				name: "typeorm-secured-hidden",
				score: 2,
			}),
		]);
		const runnerContexts: TypeOrmCrudTransactionRunnerContext[] = [];
		const rowContexts: CrudAdapterContext[] = [];
		const adapter = createSecuredTypeOrmAdapter(runnerContexts, rowContexts);

		// The hidden row exists, and the predicate is the only thing keeping it out.
		await expect(
			adapter.findMany({ order: [], limit: 10, count: true }, context("list")),
		).resolves.toMatchObject({
			records: [{ tenantId: "typeorm-secured", id: "visible" }],
			total: 1,
		});
		// A mutation against a hidden row reports "not found" rather than mutating it —
		// the property a generated controller turns into 404-before-403.
		await expect(
			adapter.update(
				{ predicate: identity("typeorm-hidden", "hidden"), values: { score: 99 } },
				context("update"),
			),
		).resolves.toBeNull();
		await expect(
			adapter.delete({ predicate: identity("typeorm-hidden", "hidden") }, context("delete")),
		).resolves.toBeNull();

		expect(runnerContexts).toHaveLength(3);
		expect(runnerContexts[0]).toMatchObject({
			accessMode: "read only",
			isolationLevel: "repeatable read",
			mustOwnCommit: false,
		});
		expect(runnerContexts[1]).toMatchObject({ mustOwnCommit: true });
		expect(runnerContexts[2]).toMatchObject({ mustOwnCommit: true });
		expect(rowContexts).toHaveLength(3);
		expect(rowContexts.every(({ session }) => session !== undefined)).toBe(true);

		// The hidden row survived both mutations.
		await expect(
			harness("typeorm").adapter.findOne(
				{ predicate: identity("typeorm-hidden", "hidden") },
				context("read"),
			),
		).resolves.toMatchObject({ id: "hidden", score: 2 });
	});

	it("starts a create lifecycle at its declared operation-wide isolation", async () => {
		if (createOperationIsolatedTypeOrmAdapter === undefined) {
			throw new Error("The operation-isolated TypeORM adapter factory was not initialized.");
		}
		const observedIsolation: string[] = [];
		const adapter = createOperationIsolatedTypeOrmAdapter(observedIsolation);
		const createContext = context("create");
		const item = record({
			tenantId: "operation-isolation",
			id: "created",
			name: "operation-isolation-created",
		});

		await expect(
			adapter.transaction(
				(session) => adapter.create({ values: values(item) }, { ...createContext, session }),
				createContext,
			),
		).resolves.toMatchObject({ tenantId: item.tenantId, id: item.id });

		expect(observedIsolation).toEqual(["repeatable read"]);
	});
});
