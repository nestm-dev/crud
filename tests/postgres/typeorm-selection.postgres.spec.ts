import { createTypeOrmCrudAdapter } from "@nestm/crud-typeorm";
import { Pool } from "pg";
import {
	BeforeInsert,
	Brackets,
	ChildEntity,
	Column,
	DataSource,
	Entity,
	EntitySchema,
	type FindOptionsSelect,
	type Logger,
	PrimaryColumn,
	type QueryRunner,
	TableInheritance,
	UpdateDateColumn,
	type ValueTransformer,
	VersionColumn,
} from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TABLE = "crud_pg_typeorm_selected_items";
const CHILD_TABLE = "crud_pg_typeorm_selected_children";
const skipPostgres = process.env.PG_SKIP === "1";
const queries: string[] = [];
let secretHydrations = 0;
let dataSource: DataSource | undefined;
let adminPool: Pool | undefined;

const secretTransformer: ValueTransformer = {
	to: (value: unknown) => value,
	from: () => {
		secretHydrations += 1;
		throw new Error("the unselected secret column was hydrated");
	},
};

const visibleTransformer: ValueTransformer = {
	to: (value: unknown) => `stored:${String(value)}`,
	from: (value: unknown) => String(value).replace(/^stored:/, ""),
};

@Entity({ name: TABLE, synchronize: false })
class SelectedItem {
	@PrimaryColumn({ name: "tenant_id", type: "text" })
	readonly tenantId!: string;

	@PrimaryColumn({ type: "text" })
	readonly id!: string;

	@Column({ type: "text", transformer: visibleTransformer })
	visible = "constructor-default";

	@Column({ name: "secret_ciphertext", type: "text", transformer: secretTransformer })
	secret = "constructor-placeholder";

	@Column({
		name: "hidden_secret",
		type: "text",
		select: false,
		transformer: secretTransformer,
	})
	hiddenSecret = "hidden-constructor-placeholder";

	@UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
	readonly updatedAt!: Date;

	@VersionColumn({ type: "integer" })
	readonly version!: number;

	@BeforeInsert()
	sealSecret(): void {
		this.secret = `sealed:${this.secret}`;
	}
}

@Entity({ name: "crud_pg_typeorm_selection_sti", synchronize: false })
@TableInheritance({ column: { name: "kind", type: "varchar" } })
class SelectionBaseItem {
	@PrimaryColumn({ type: "text" })
	readonly id!: string;

	@Column({ type: "text" })
	visible!: string;
}

@ChildEntity("child")
class SelectionChildItem extends SelectionBaseItem {}

class SelectionOwner {
	readonly id!: string;
}

class SelectionRelationItem {
	readonly id!: string;
	ownerId!: string;
	owner!: SelectionOwner;
}

const selectionOwnerSchema = new EntitySchema<SelectionOwner>({
	name: "CrudPgTypeOrmSelectionOwner",
	target: SelectionOwner,
	tableName: "crud_pg_typeorm_selection_owners",
	columns: { id: { type: String, primary: true } },
});

const selectionRelationItemSchema = new EntitySchema<SelectionRelationItem>({
	name: "CrudPgTypeOrmSelectionRelationItem",
	target: SelectionRelationItem,
	tableName: "crud_pg_typeorm_selection_relation_items",
	columns: {
		id: { type: String, primary: true },
		ownerId: { name: "owner_id", type: String },
	},
	relations: {
		owner: {
			type: "many-to-one",
			target: () => SelectionOwner,
			joinColumn: { name: "owner_id", referencedColumnName: "id" },
		},
	},
});

class QueryCaptureLogger implements Logger {
	logQuery(query: string, _parameters?: unknown[], _queryRunner?: QueryRunner): void {
		queries.push(query);
	}

	logQueryError(): void {}
	logQuerySlow(): void {}
	logSchemaBuild(): void {}
	logMigration(): void {}
	log(): void {}
}

function adapter() {
	if (dataSource === undefined) throw new Error("TypeORM selection test was not initialized.");
	return createTypeOrmCrudAdapter({
		repository: dataSource.getRepository(SelectedItem),
		columns: {
			tenantId: "tenantId",
			id: "id",
			visible: "visible",
			secret: "secret",
			updatedAt: "updatedAt",
			version: "version",
		},
		select: {
			tenantId: true,
			id: true,
			visible: true,
			updatedAt: true,
			version: true,
		},
		rowPredicate: ({ alias }) =>
			new Brackets((where) =>
				where.where(`${alias}.tenantId = :selectedTenant`, {
					selectedTenant: "tenant-a",
				}),
			),
	});
}

function operation(name: "create" | "list" | "read" | "update" | "delete") {
	return { resource: "selected-items", operation: name } as const;
}

function expectNoSecretReadsOrReturns(): void {
	for (const query of queries) {
		if (/^\s*SELECT\b/i.test(query)) {
			expect(query).not.toContain("secret_ciphertext");
			expect(query).not.toContain("hidden_secret");
		}
		const returning = query.match(/\bRETURNING\b([\s\S]*)$/i)?.[1];
		if (returning !== undefined) {
			expect(returning).not.toContain("secret_ciphertext");
			expect(returning).not.toContain("hidden_secret");
		}
	}
	// The transformer is a second, independent proof: even an aliased or reformatted
	// statement fails the test if TypeORM turns the ciphertext into an entity property.
	expect(secretHydrations).toBe(0);
}

function expectConstructorOnlySecret(record: object | null | undefined): void {
	expect(record).toBeDefined();
	expect((record as unknown as Readonly<Record<string, unknown>>).secret).toBe(
		"constructor-placeholder",
	);
}

describe.skipIf(skipPostgres)("TypeORM selected record hydration", () => {
	beforeAll(async () => {
		const pgUrl = process.env.PG_URL;
		if (pgUrl === undefined || pgUrl.length === 0) return;
		adminPool = new Pool({ connectionString: pgUrl, max: 1 });
		await adminPool.query(`
			DROP TABLE IF EXISTS ${CHILD_TABLE};
			DROP TABLE IF EXISTS ${TABLE};
			CREATE TABLE ${TABLE} (
				tenant_id text NOT NULL,
				id text NOT NULL,
				visible text NOT NULL,
				secret_ciphertext text NOT NULL,
				hidden_secret text NOT NULL DEFAULT 'hidden-default',
				updated_at timestamptz NOT NULL DEFAULT now(),
				version integer NOT NULL DEFAULT 1,
				PRIMARY KEY (tenant_id, id)
			);
			CREATE TABLE ${CHILD_TABLE} (
				tenant_id text NOT NULL,
				item_id text NOT NULL,
				PRIMARY KEY (tenant_id, item_id),
				FOREIGN KEY (tenant_id, item_id)
					REFERENCES ${TABLE} (tenant_id, id) ON DELETE CASCADE
			)
		`);
		dataSource = await new DataSource({
			type: "postgres",
			url: pgUrl,
			entities: [
				SelectedItem,
				SelectionBaseItem,
				SelectionChildItem,
				selectionOwnerSchema,
				selectionRelationItemSchema,
			],
			logging: ["query"],
			logger: new QueryCaptureLogger(),
		}).initialize();
	});

	beforeEach(async () => {
		if (adminPool === undefined) throw new Error("PostgreSQL selection test was not initialized.");
		await adminPool.query(`TRUNCATE TABLE ${CHILD_TABLE}, ${TABLE}`);
		queries.length = 0;
		secretHydrations = 0;
	});

	afterAll(async () => {
		await dataSource?.destroy();
		if (adminPool !== undefined) {
			await adminPool.query(`DROP TABLE IF EXISTS ${CHILD_TABLE}, ${TABLE}`);
			await adminPool.end();
		}
	});

	it("rejects relation selections even when TypeORM can resolve their join column", () => {
		if (dataSource === undefined) throw new Error("TypeORM selection test was not initialized.");
		const repository = dataSource.getRepository(SelectionRelationItem);
		expect(() =>
			createTypeOrmCrudAdapter({
				repository,
				columns: { id: "id", ownerId: "ownerId", owner: "owner" },
				select: {
					id: true,
					owner: true,
				} as FindOptionsSelect<SelectionRelationItem>,
			}),
		).toThrow("TypeORM CRUD select references unknown scalar property 'owner'.");

		expect(() =>
			createTypeOrmCrudAdapter({
				repository,
				columns: { id: "id", ownerId: "ownerId" },
				select: { id: true, ownerId: true },
			}),
		).not.toThrow();
	});

	it("rejects selected base STI repositories without blocking concrete children", () => {
		const source = dataSource;
		if (source === undefined) throw new Error("TypeORM selection test was not initialized.");
		expect(() =>
			createTypeOrmCrudAdapter({
				repository: source.getRepository(SelectionBaseItem),
				columns: { id: "id", visible: "visible" },
				select: { id: true, visible: true },
			}),
		).toThrow(
			"TypeORM CRUD selected records do not support base single-table inheritance repositories.",
		);
		expect(() =>
			createTypeOrmCrudAdapter({
				repository: source.getRepository(SelectionChildItem),
				columns: { id: "id", visible: "visible" },
				select: { id: true, visible: true },
			}),
		).not.toThrow();
	});

	it("instantiates selected inserts so constructor defaults and insert listeners run", async () => {
		const created = await adapter().create(
			{
				values: {
					tenantId: "tenant-a",
					id: "defaults",
					secret: "plaintext",
				},
			},
			operation("create"),
		);

		expect(created).toMatchObject({ visible: "constructor-default", version: 1 });
		expectConstructorOnlySecret(created);
		if (adminPool === undefined) throw new Error("PostgreSQL selection test was not initialized.");
		const stored = await adminPool.query<{ secret_ciphertext: string; visible: string }>(
			`SELECT secret_ciphertext, visible FROM ${TABLE} WHERE tenant_id = $1 AND id = $2`,
			["tenant-a", "defaults"],
		);
		expect(stored.rows[0]).toEqual({
			secret_ciphertext: "sealed:plaintext",
			visible: "stored:constructor-default",
		});
		expectNoSecretReadsOrReturns();
	});

	it("rechecks the native row predicate in the actual selected DML", async () => {
		if (adminPool === undefined || dataSource === undefined) {
			throw new Error("PostgreSQL selection test was not initialized.");
		}
		await adminPool.query(
			`INSERT INTO ${TABLE} (tenant_id, id, visible, secret_ciphertext) VALUES ($1, $2, $3, $4)`,
			["tenant-a", "reauthorized", "stored:before", "sealed:secret"],
		);
		let predicateCalls = 0;
		const guarded = createTypeOrmCrudAdapter({
			repository: dataSource.getRepository(SelectedItem),
			columns: {
				tenantId: "tenantId",
				id: "id",
				visible: "visible",
				secret: "secret",
				updatedAt: "updatedAt",
				version: "version",
			},
			select: {
				tenantId: true,
				id: true,
				visible: true,
				updatedAt: true,
				version: true,
			},
			rowPredicate: ({ alias }) => {
				predicateCalls += 1;
				return new Brackets((where) =>
					where.where(`${alias}.tenantId = :reauthorizedTenant`, {
						reauthorizedTenant: predicateCalls === 1 ? "tenant-a" : "tenant-b",
					}),
				);
			},
		});
		const identity = {
			kind: "and",
			predicates: [
				{ kind: "comparison", field: "tenantId", operator: "eq", value: "tenant-a" },
				{ kind: "comparison", field: "id", operator: "eq", value: "reauthorized" },
			],
		} as const;

		await expect(
			guarded.update(
				{ predicate: identity, values: { visible: "must-not-write" } },
				operation("update"),
			),
		).resolves.toBeNull();
		expect(predicateCalls).toBe(2);
		const stored = await adminPool.query<{ visible: string }>(
			`SELECT visible FROM ${TABLE} WHERE tenant_id = $1 AND id = $2`,
			["tenant-a", "reauthorized"],
		);
		expect(stored.rows[0]?.visible).toBe("stored:before");
		expectNoSecretReadsOrReturns();
	});

	it("fails closed when a native predicate reuses a reserved CRUD parameter", async () => {
		if (dataSource === undefined) throw new Error("TypeORM selection test was not initialized.");
		const guarded = createTypeOrmCrudAdapter({
			repository: dataSource.getRepository(SelectedItem),
			columns: { tenantId: "tenantId", id: "id" },
			select: { tenantId: true, id: true },
			rowPredicate: ({ alias }) =>
				new Brackets((where) => where.where(`${alias}.tenantId = :crud_0`, { crud_0: "native" })),
		});

		await expect(
			guarded.findOne(
				{
					predicate: {
						kind: "comparison",
						field: "tenantId",
						operator: "eq",
						value: "tenant-a",
					},
				},
				operation("read"),
			),
		).rejects.toMatchObject({ code: "unknown" });
		expect(queries.some((query) => /^\s*SELECT\b/i.test(query))).toBe(false);
	});

	it("binds mutation identity after native parameters to prevent TypeORM name collisions", async () => {
		if (adminPool === undefined || dataSource === undefined) {
			throw new Error("PostgreSQL selection test was not initialized.");
		}
		await adminPool.query(
			`INSERT INTO ${TABLE} (tenant_id, id, visible, secret_ciphertext) VALUES ($1, $2, $3, $4)`,
			["tenant-a", "identity-parameters", "stored:before", "sealed:secret"],
		);
		const guarded = createTypeOrmCrudAdapter({
			repository: dataSource.getRepository(SelectedItem),
			columns: { tenantId: "tenantId", id: "id", visible: "visible" },
			select: { tenantId: true, id: true, visible: true },
			rowPredicate: ({ alias }) =>
				new Brackets((where) =>
					where.where(`${alias}.tenantId = :orm_param_0`, { orm_param_0: "tenant-a" }),
				),
		});
		const identity = {
			kind: "and",
			predicates: [
				{ kind: "comparison", field: "tenantId", operator: "eq", value: "tenant-a" },
				{
					kind: "comparison",
					field: "id",
					operator: "eq",
					value: "identity-parameters",
				},
			],
		} as const;

		await expect(
			guarded.update({ predicate: identity, values: { visible: "updated" } }, operation("update")),
		).resolves.toMatchObject({ visible: "updated" });
		const stored = await adminPool.query<{ visible: string }>(
			`SELECT visible FROM ${TABLE} WHERE tenant_id = $1 AND id = $2`,
			["tenant-a", "identity-parameters"],
		);
		expect(stored.rows[0]?.visible).toBe("stored:updated");
		expectNoSecretReadsOrReturns();
	});

	it("never hydrates an unselected column across create, read, list, update, and delete", async () => {
		const crud = adapter();
		const identity = {
			kind: "and",
			predicates: [
				{ kind: "comparison", field: "tenantId", operator: "eq", value: "tenant-a" },
				{ kind: "comparison", field: "id", operator: "eq", value: "one" },
			],
		} as const;

		const created = await crud.create(
			{
				values: {
					tenantId: "tenant-a",
					id: "one",
					visible: "before",
					secret: "ciphertext",
				},
			},
			operation("create"),
		);
		expect(created).toMatchObject({ tenantId: "tenant-a", id: "one", visible: "before" });
		expectConstructorOnlySecret(created);

		const read = await crud.findOne({ predicate: identity }, operation("read"));
		expect(read).toMatchObject({ id: "one", visible: "before", version: 1 });
		expectConstructorOnlySecret(read);

		const page = await crud.findMany(
			{ predicate: identity, order: [], limit: 10, count: true },
			operation("list"),
		);
		expect(page.total).toBe(1);
		expect(page.records).toHaveLength(1);
		expectConstructorOnlySecret(page.records[0]);

		const updated = await crud.update(
			{ predicate: identity, values: { visible: "after" } },
			operation("update"),
		);
		expect(updated).toMatchObject({ id: "one", visible: "after", version: 2 });
		expectConstructorOnlySecret(updated);

		if (adminPool === undefined) throw new Error("PostgreSQL selection test was not initialized.");
		const stored = await adminPool.query<{ secret_ciphertext: string }>(
			`SELECT secret_ciphertext FROM ${TABLE} WHERE tenant_id = $1 AND id = $2`,
			["tenant-a", "one"],
		);
		expect(stored.rows[0]?.secret_ciphertext).toBe("sealed:ciphertext");
		await adminPool.query(`INSERT INTO ${CHILD_TABLE} (tenant_id, item_id) VALUES ($1, $2)`, [
			"tenant-a",
			"one",
		]);

		const deleted = await crud.delete({ predicate: identity }, operation("delete"));
		expect(deleted).toMatchObject({ id: "one", visible: "after", version: 2 });
		expectConstructorOnlySecret(deleted);
		const children = await adminPool.query<{ total: number }>(
			`SELECT COUNT(*)::int AS total FROM ${CHILD_TABLE}`,
		);
		expect(children.rows[0]?.total).toBe(0);

		expectNoSecretReadsOrReturns();
	});
});
