import { createTypeOrmCrudAdapter } from "@nestm/crud-typeorm";
import { Pool } from "pg";
import {
	BeforeInsert,
	Brackets,
	Column,
	DataSource,
	Entity,
	type Logger,
	PrimaryColumn,
	type QueryRunner,
	type ValueTransformer,
} from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TABLE = "crud_pg_typeorm_upsert_items";
const skipPostgres = process.env.PG_SKIP === "1";
const queries: string[] = [];
let secretHydrations = 0;
let dataSource: DataSource | undefined;
let adminPool: Pool | undefined;

const visibleTransformer: ValueTransformer = {
	to: (value: unknown) => `stored:${String(value)}`,
	from: (value: unknown) => String(value).replace(/^stored:/, ""),
};

const secretTransformer: ValueTransformer = {
	to: (value: unknown) => value,
	from: (value: unknown) => {
		secretHydrations += 1;
		return `hydrated:${String(value)}`;
	},
};

@Entity({ name: TABLE, synchronize: false })
class UpsertItem {
	@PrimaryColumn({ name: "tenant_id", type: "text" })
	readonly tenantId!: string;

	@PrimaryColumn({ name: "viewer_user_id", type: "text" })
	readonly viewerUserId!: string;

	@PrimaryColumn({ name: "server_id", type: "text" })
	readonly serverId!: string;

	@Column({ name: "display_name", type: "text", transformer: visibleTransformer })
	displayName!: string;

	@Column({ name: "allowed_tools", type: "jsonb", nullable: true })
	allowedTools!: readonly string[] | null;

	@Column({ name: "secret_ciphertext", type: "text", transformer: secretTransformer })
	secret = "constructor-placeholder";

	@BeforeInsert()
	sealSecret(): void {
		this.secret = `sealed:${this.secret}`;
	}
}

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

const COLUMNS = {
	tenantId: "tenantId",
	viewerUserId: "viewerUserId",
	serverId: "serverId",
	displayName: "displayName",
	allowedTools: "allowedTools",
	secret: "secret",
} as const;

const CONFLICT_FIELDS = ["tenantId", "viewerUserId", "serverId"] as const;
const OVERWRITE_FIELDS = ["displayName", "allowedTools"] as const;

function source(): DataSource {
	if (dataSource === undefined) throw new Error("TypeORM upsert test was not initialized.");
	return dataSource;
}

function selectedAdapter(authorizedTenant = "tenant-a") {
	return createTypeOrmCrudAdapter({
		repository: source().getRepository(UpsertItem),
		columns: COLUMNS,
		select: {
			tenantId: true,
			viewerUserId: true,
			serverId: true,
			displayName: true,
			allowedTools: true,
		},
		rowPredicate: ({ alias }) =>
			new Brackets((where) =>
				where.where(`${alias}.tenantId = :authorizedTenant`, { authorizedTenant }),
			),
	});
}

function predicate(tenantId: string, viewerUserId: string, serverId: string) {
	return {
		kind: "and",
		predicates: [
			{ kind: "comparison", field: "tenantId", operator: "eq", value: tenantId },
			{ kind: "comparison", field: "viewerUserId", operator: "eq", value: viewerUserId },
			{ kind: "comparison", field: "serverId", operator: "eq", value: serverId },
		],
	} as const;
}

function input(
	tenantId: string,
	viewerUserId: string,
	serverId: string,
	displayName: string,
	allowedTools: readonly string[] | null,
) {
	return {
		conflictFields: CONFLICT_FIELDS,
		predicate: predicate(tenantId, viewerUserId, serverId),
		values: {
			tenantId,
			viewerUserId,
			serverId,
			displayName,
			allowedTools,
			secret: `${tenantId}:${displayName}`,
		},
		overwriteFields: OVERWRITE_FIELDS,
	} as const;
}

function operation() {
	return {
		resource: "postgres-upsert-items",
		operation: "upsert",
		pathParams: { tenantId: "tenant-a" },
	} as const;
}

function mutationQueries(): string[] {
	return queries.filter((query) => /^\s*INSERT\b/i.test(query));
}

function expectNarrowReturning(): void {
	for (const query of mutationQueries()) {
		const returning = query.match(/\bRETURNING\b([\s\S]*)$/i)?.[1];
		expect(returning).toBeDefined();
		expect(returning).not.toContain("secret_ciphertext");
	}
	expect(queries.some((query) => /^\s*SELECT\b/i.test(query))).toBe(false);
	expect(secretHydrations).toBe(0);
}

describe.skipIf(skipPostgres)("TypeORM atomic upsert", () => {
	beforeAll(async () => {
		const pgUrl = process.env.PG_URL;
		if (pgUrl === undefined || pgUrl.length === 0) return;
		adminPool = new Pool({ connectionString: pgUrl, max: 4 });
		await adminPool.query(`
			DROP TABLE IF EXISTS ${TABLE};
			CREATE TABLE ${TABLE} (
				tenant_id text NOT NULL,
				viewer_user_id text NOT NULL,
				server_id text NOT NULL,
				display_name text NOT NULL,
				allowed_tools jsonb,
				secret_ciphertext text NOT NULL,
				PRIMARY KEY (tenant_id, viewer_user_id, server_id)
			)
		`);
		dataSource = await new DataSource({
			type: "postgres",
			url: pgUrl,
			entities: [UpsertItem],
			logging: ["query"],
			logger: new QueryCaptureLogger(),
		}).initialize();
	});

	beforeEach(async () => {
		if (adminPool === undefined) throw new Error("TypeORM upsert test was not initialized.");
		await adminPool.query(`TRUNCATE TABLE ${TABLE}`);
		queries.length = 0;
		secretHydrations = 0;
	});

	afterAll(async () => {
		await dataSource?.destroy();
		if (adminPool !== undefined) {
			await adminPool.query(`DROP TABLE IF EXISTS ${TABLE}`);
			await adminPool.end();
		}
	});

	it("inserts and updates with one authorized ON CONFLICT statement and explicit fields", async () => {
		const adapter = selectedAdapter();
		const created = await adapter.upsert(
			input("tenant-a", "viewer-1", "server-1", "first", ["read"]),
			operation(),
		);
		const updated = await adapter.upsert(
			input("tenant-a", "viewer-1", "server-1", "second", ["read", "write"]),
			operation(),
		);

		expect(created).toMatchObject({ displayName: "first", allowedTools: ["read"] });
		expect(updated).toMatchObject({ displayName: "second", allowedTools: ["read", "write"] });
		expect((created as unknown as Readonly<UpsertItem>).secret).toBe("constructor-placeholder");
		expect((updated as unknown as Readonly<UpsertItem>).secret).toBe("constructor-placeholder");
		expect(mutationQueries()).toHaveLength(2);
		for (const query of mutationQueries()) {
			expect(query).toMatch(
				/ON CONFLICT\s*\(\s*"tenant_id",\s*"viewer_user_id",\s*"server_id"\s*\)/i,
			);
			expect(query).toContain('DO UPDATE SET "display_name" = EXCLUDED."display_name"');
			expect(query).toContain('"allowed_tools" = EXCLUDED."allowed_tools"');
			expect(query).toContain(" WHERE ");
		}
		expectNarrowReturning();

		if (adminPool === undefined) throw new Error("TypeORM upsert test was not initialized.");
		const stored = await adminPool.query<{
			display_name: string;
			allowed_tools: readonly string[];
			secret_ciphertext: string;
		}>(
			`SELECT display_name, allowed_tools, secret_ciphertext FROM ${TABLE}
			 WHERE tenant_id = $1 AND viewer_user_id = $2 AND server_id = $3`,
			["tenant-a", "viewer-1", "server-1"],
		);
		expect(stored.rows[0]).toEqual({
			display_name: "stored:second",
			allowed_tools: ["read", "write"],
			secret_ciphertext: "sealed:tenant-a:first",
		});
	});

	it("returns null and leaves an unauthorized conflicting row unchanged", async () => {
		if (adminPool === undefined) throw new Error("TypeORM upsert test was not initialized.");
		await adminPool.query(
			`INSERT INTO ${TABLE}
			 (tenant_id, viewer_user_id, server_id, display_name, allowed_tools, secret_ciphertext)
			 VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
			["tenant-b", "viewer-1", "server-1", "stored:before", '["read"]', "sealed:original"],
		);

		const result = await selectedAdapter("tenant-a").upsert(
			input("tenant-b", "viewer-1", "server-1", "must-not-write", ["write"]),
			operation(),
		);

		expect(result).toBeNull();
		const stored = await adminPool.query<{ display_name: string; secret_ciphertext: string }>(
			`SELECT display_name, secret_ciphertext FROM ${TABLE}
			 WHERE tenant_id = $1 AND viewer_user_id = $2 AND server_id = $3`,
			["tenant-b", "viewer-1", "server-1"],
		);
		expect(stored.rows[0]).toEqual({
			display_name: "stored:before",
			secret_ciphertext: "sealed:original",
		});
		expect(mutationQueries()).toHaveLength(1);
		expectNarrowReturning();
	});

	it("fails closed on native/CRUD parameter collisions before issuing DML", async () => {
		const adapter = createTypeOrmCrudAdapter({
			repository: source().getRepository(UpsertItem),
			columns: COLUMNS,
			select: {
				tenantId: true,
				viewerUserId: true,
				serverId: true,
				displayName: true,
			},
			rowPredicate: ({ alias }) =>
				new Brackets((where) => where.where(`${alias}.tenantId = :crud_0`, { crud_0: "native" })),
		});

		await expect(
			adapter.upsert(
				input("tenant-a", "viewer-collision", "server-collision", "blocked", null),
				operation(),
			),
		).rejects.toMatchObject({ code: "unknown" });
		expect(mutationQueries()).toHaveLength(0);
	});

	it("serializes concurrent proposals without duplicate rows or a read-before-write race", async () => {
		const adapter = selectedAdapter();
		const names = Array.from({ length: 12 }, (_value, index) => `proposal-${index}`);
		const results = await Promise.all(
			names.map((name) =>
				adapter.upsert(input("tenant-a", "viewer-race", "server-race", name, [name]), operation()),
			),
		);

		expect(results.every((result) => result !== null)).toBe(true);
		expect(mutationQueries()).toHaveLength(names.length);
		expectNarrowReturning();
		if (adminPool === undefined) throw new Error("TypeORM upsert test was not initialized.");
		const stored = await adminPool.query<{ total: number; display_name: string }>(
			`SELECT COUNT(*)::int AS total, MIN(display_name) AS display_name FROM ${TABLE}
			 WHERE tenant_id = $1 AND viewer_user_id = $2 AND server_id = $3`,
			["tenant-a", "viewer-race", "server-race"],
		);
		expect(stored.rows[0]?.total).toBe(1);
		expect(names.map((name) => `stored:${name}`)).toContain(stored.rows[0]?.display_name);
	});

	it("hydrates all physical scalar columns from explicit RETURNING in full-record mode", async () => {
		const adapter = createTypeOrmCrudAdapter({
			repository: source().getRepository(UpsertItem),
			columns: COLUMNS,
		});
		const result = await adapter.upsert(
			input("tenant-a", "viewer-full", "server-full", "full", null),
			operation(),
		);

		expect(result).toMatchObject({
			tenantId: "tenant-a",
			viewerUserId: "viewer-full",
			serverId: "server-full",
			displayName: "full",
			allowedTools: null,
			secret: "hydrated:sealed:tenant-a:full",
		});
		expect(secretHydrations).toBe(1);
		expect(mutationQueries()).toHaveLength(1);
		expect(queries.some((query) => /^\s*SELECT\b/i.test(query))).toBe(false);
		expect(mutationQueries()[0]?.match(/\bRETURNING\b([\s\S]*)$/i)?.[1]).toContain(
			"secret_ciphertext",
		);
	});
});
