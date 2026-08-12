import { createTypeOrmCrudAdapter, createTypeOrmCrudReferenceChecker } from "@nestm/crud-typeorm";
import { Pool, type PoolClient } from "pg";
import {
	AfterLoad,
	Column,
	DataSource,
	Entity,
	type Logger,
	PrimaryColumn,
	type QueryRunner,
	type ValueTransformer,
} from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const SOURCE_TABLE = "crud_pg_typeorm_reference_sources";
const TARGET_TABLE = "crud_pg_typeorm_reference_servers";
const skipPostgres = process.env.PG_SKIP === "1";
const queries: string[] = [];
let entityHydrations = 0;
let secretHydrations = 0;
let dataSource: DataSource | undefined;
let adminPool: Pool | undefined;

const secretTransformer: ValueTransformer = {
	to: (value: unknown) => value,
	from: () => {
		secretHydrations += 1;
		throw new Error("a reference existence check hydrated the target secret");
	},
};

@Entity({ name: SOURCE_TABLE, synchronize: false })
class ReferenceSource {
	@PrimaryColumn({ type: "text" })
	readonly id!: string;
}

@Entity({ name: TARGET_TABLE, synchronize: false })
class ReferenceServer {
	@PrimaryColumn({ type: "text" })
	readonly id!: string;

	@Column({ name: "organization_id", type: "text", nullable: true })
	organizationId!: string | null;

	@Column({ name: "owner_user_id", type: "text" })
	ownerUserId!: string;

	@Column({ name: "secret_ciphertext", type: "text", transformer: secretTransformer })
	secret!: string;

	@AfterLoad()
	onLoad(): void {
		entityHydrations += 1;
		throw new Error("a reference existence check hydrated the target entity");
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

function source(): DataSource {
	if (dataSource === undefined) throw new Error("TypeORM reference test was not initialized.");
	return dataSource;
}

function pool(): Pool {
	if (adminPool === undefined) throw new Error("TypeORM reference test was not initialized.");
	return adminPool;
}

function predicate(organizationId: string) {
	return {
		kind: "and",
		predicates: [
			{ kind: "comparison", field: "id", operator: "eq", value: "server-1" },
			{ kind: "comparison", field: "organizationId", operator: "eq", value: organizationId },
		],
	} as const;
}

function sourceAdapter() {
	return createTypeOrmCrudAdapter({
		repository: source().getRepository(ReferenceSource),
		columns: { id: "id" },
	});
}

function checker() {
	return createTypeOrmCrudReferenceChecker({
		target: ReferenceServer,
		columns: {
			id: "id",
			organizationId: "organizationId",
			ownerUserId: "ownerUserId",
		},
	});
}

function operation() {
	return { resource: "postgres-reference-source", operation: "upsert" } as const;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve: () => {
			if (resolvePromise === undefined) throw new Error("deferred was not initialized");
			resolvePromise();
		},
	};
}

async function rollback(client: PoolClient): Promise<void> {
	try {
		await client.query("ROLLBACK");
	} finally {
		client.release();
	}
}

describe.skipIf(skipPostgres)("TypeORM transaction-scoped reference checks", () => {
	beforeAll(async () => {
		const pgUrl = process.env.PG_URL;
		if (pgUrl === undefined || pgUrl.length === 0) return;
		adminPool = new Pool({ connectionString: pgUrl, max: 3 });
		await adminPool.query(`
			DROP TABLE IF EXISTS ${SOURCE_TABLE};
			DROP TABLE IF EXISTS ${TARGET_TABLE};
			CREATE TABLE ${SOURCE_TABLE} (
				id text PRIMARY KEY
			);
			CREATE TABLE ${TARGET_TABLE} (
				id text PRIMARY KEY,
				organization_id text,
				owner_user_id text NOT NULL,
				secret_ciphertext text NOT NULL
			)
		`);
		dataSource = await new DataSource({
			type: "postgres",
			url: pgUrl,
			entities: [ReferenceSource, ReferenceServer],
			logging: ["query"],
			logger: new QueryCaptureLogger(),
		}).initialize();
	});

	beforeEach(async () => {
		await pool().query(`TRUNCATE TABLE ${SOURCE_TABLE}, ${TARGET_TABLE}`);
		await pool().query(
			`INSERT INTO ${TARGET_TABLE}
				(id, organization_id, owner_user_id, secret_ciphertext)
			 VALUES ($1, $2, $3, $4)`,
			["server-1", "org-1", "user-1", "encrypted"],
		);
		queries.length = 0;
		entityHydrations = 0;
		secretHydrations = 0;
	});

	afterAll(async () => {
		await dataSource?.destroy();
		if (adminPool !== undefined) {
			await adminPool.query(`DROP TABLE IF EXISTS ${SOURCE_TABLE}, ${TARGET_TABLE}`);
			await adminPool.end();
		}
	});

	it("executes a raw SELECT 1 with FOR SHARE and the complete visibility predicate", async () => {
		const adapter = sourceAdapter();
		const references = checker();
		const visible = await adapter.transaction(
			async (session) => references.exists({ predicate: predicate("org-1") }, { session }),
			operation(),
		);
		const hidden = await adapter.transaction(
			async (session) => references.exists({ predicate: predicate("org-2") }, { session }),
			operation(),
		);

		expect(visible).toBe(true);
		expect(hidden).toBe(false);
		const checks = queries.filter((query) => query.includes(`FROM "${TARGET_TABLE}"`));
		expect(checks).toHaveLength(2);
		for (const query of checks) {
			expect(query).toContain('SELECT 1 AS "crud_reference_exists"');
			expect(query).toContain('"crud_reference"."id" = $1');
			expect(query).toContain('"crud_reference"."organization_id" = $2');
			expect(query).toMatch(/FOR SHARE OF "?crud_reference"?/i);
			expect(query).not.toContain("owner_user_id");
			expect(query).not.toContain("secret_ciphertext");
		}
		expect(entityHydrations).toBe(0);
		expect(secretHydrations).toBe(0);
	});

	it("holds the shared target-row lock until the source transaction completes", async () => {
		const adapter = sourceAdapter();
		const references = checker();
		const locked = deferred();
		const release = deferred();
		const validation = adapter.transaction(async (session) => {
			expect(await references.exists({ predicate: predicate("org-1") }, { session })).toBe(true);
			locked.resolve();
			await release.promise;
		}, operation());
		await locked.promise;

		const concurrent = await pool().connect();
		await concurrent.query("BEGIN");
		await concurrent.query("SET LOCAL lock_timeout = '250ms'");
		const failure = await concurrent
			.query(`UPDATE ${TARGET_TABLE} SET organization_id = 'org-2' WHERE id = 'server-1'`)
			.catch((error: unknown) => error);
		expect(failure).toMatchObject({ code: "55P03" });
		await rollback(concurrent);

		release.resolve();
		await validation;
		const updated = await pool().query(
			`UPDATE ${TARGET_TABLE} SET organization_id = 'org-2' WHERE id = 'server-1' RETURNING organization_id`,
		);
		expect(updated.rows[0]).toEqual({ organization_id: "org-2" });
	});
});
