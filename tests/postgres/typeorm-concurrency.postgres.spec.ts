import {
	CrudModule,
	andCrudPredicates,
	crudOperations,
	defineCrudResource,
	type CrudLifecycleHook,
} from "@nestm/crud";
import { createCrudAdapterConformanceCases } from "@nestm/crud/testing";
import { bindTypeOrmCrud, createTypeOrmCrudAdapter } from "@nestm/crud-typeorm";
import {
	Injectable,
	Module,
	StandardSchemaSerializerInterceptor,
	StandardSchemaValidationPipe,
	type INestApplication,
} from "@nestjs/common";
import { APP_INTERCEPTOR, APP_PIPE, Reflector } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { Pool } from "pg";
import request from "supertest";
import { Column, DataSource, Entity, PrimaryColumn, VersionColumn } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

const TABLE = "crud_pg_typeorm_versioned_items";
const skipPostgres = process.env.PG_SKIP === "1";
let dataSource: DataSource | undefined;
let adminPool: Pool | undefined;

@Entity({ name: TABLE, synchronize: false })
class VersionedItem {
	@PrimaryColumn({ name: "id", type: "integer" })
	id!: number;

	@Column({ name: "name", type: "text" })
	name!: string;

	@Column({ name: "status", type: "text" })
	status!: string;

	@Column({ name: "created_at", type: "timestamptz" })
	createdAt!: Date;

	@VersionColumn({ name: "version", type: "integer" })
	version!: number;
}

const COLUMNS = {
	id: "id",
	name: "name",
	status: "status",
	createdAt: "createdAt",
	version: "version",
} as const;

function source(): DataSource {
	if (dataSource === undefined) throw new Error("TypeORM concurrency test was not initialized.");
	return dataSource;
}

function plainAdapter() {
	return createTypeOrmCrudAdapter({
		repository: source().getRepository(VersionedItem),
		columns: COLUMNS,
	});
}

function selectedAdapter() {
	return createTypeOrmCrudAdapter({
		repository: source().getRepository(VersionedItem),
		columns: { id: true, name: true, status: true, createdAt: true, version: true },
	});
}

function day(value: number): Date {
	return new Date(`2026-04-${String(value).padStart(2, "0")}T00:00:00.000Z`);
}

async function reset(): Promise<void> {
	await adminPool!.query(`TRUNCATE ${TABLE}`);
}

async function seed(): Promise<void> {
	await reset();
	await adminPool!.query(
		`INSERT INTO ${TABLE} (id, name, status, created_at, version) VALUES
			(1, 'Acme', 'active', $1, 1),
			(2, 'Birch', 'inactive', $2, 1),
			(3, 'Cedar', 'active', $3, 1),
			(4, 'Dune', 'archived', $4, 1)`,
		[day(1), day(2), day(3), day(4)],
	);
}

beforeAll(async () => {
	const url = process.env.PG_URL;
	if (skipPostgres || url === undefined) return;
	adminPool = new Pool({ connectionString: url, max: 2 });
	await adminPool.query(`DROP TABLE IF EXISTS ${TABLE}`);
	await adminPool.query(`
		CREATE TABLE ${TABLE} (
			id integer PRIMARY KEY,
			name text NOT NULL,
			status text NOT NULL,
			created_at timestamptz NOT NULL,
			version integer NOT NULL
		)
	`);
	dataSource = await new DataSource({
		type: "postgres",
		url,
		entities: [VersionedItem],
		synchronize: false,
	}).initialize();
});

afterAll(async () => {
	await dataSource?.destroy();
	await adminPool?.query(`DROP TABLE IF EXISTS ${TABLE}`);
	await adminPool?.end();
});

describe.skipIf(skipPostgres)("TypeORM version-guarded conformance on PostgreSQL", () => {
	beforeEach(reset);

	for (const [variant, create] of [
		["entity records", plainAdapter],
		["selected records", selectedAdapter],
	] as const) {
		for (const conformanceCase of createCrudAdapterConformanceCases<VersionedItem>()) {
			it(`${variant}: ${conformanceCase.name}`, async () => {
				await conformanceCase.run({
					adapter: create() as never,
					first: { id: 101, name: "Second by name", status: "active", createdAt: day(1) },
					second: { id: 102, name: "First by name", status: "active", createdAt: day(2) },
					update: { name: "Renamed" },
					idField: "id",
					sortField: "name",
					expectedAscendingIds: [102, 101],
					getId: (record) => record.id,
					version: { field: "version", stale: 999, bumpsOnUpdate: true },
				});
			});
		}
	}
});

const Status = z.enum(["active", "inactive", "archived"]);

const ListItemsQuery = z.strictObject({
	page: z.coerce.number().int().min(1).default(1),
	pageSize: z.coerce.number().int().min(1).max(100).default(20),
	sort: z.enum(["name", "-name", "createdAt", "-createdAt"]).optional(),
	status: z
		.union([Status, z.array(Status)])
		.optional()
		.transform((value) => (value === undefined || Array.isArray(value) ? value : [value])),
	createdFrom: z.iso.datetime().optional(),
	createdTo: z.iso.datetime().optional(),
});

const items = defineCrudResource({
	fields: ["id", "name", "status", "createdAt", "version"],
	name: "versioned-items",
	path: "versioned-items",
	itemPath: ":id",
	idFields: { id: "id" },
	contracts: {
		id: z.object({ id: z.coerce.number().int().positive() }),
		create: z.object({ id: z.number().int().positive(), name: z.string(), status: Status }),
		update: z.object({ name: z.string().min(1).optional(), status: Status.optional() }),
		response: z.object({
			id: z.number().int(),
			name: z.string(),
			status: z.string(),
			createdAt: z.string(),
			version: z.number().int(),
		}),
	},
	operations: crudOperations.all(),
	hooks: ["VERSIONED_ITEM_DELAY"],
	query: {
		schema: ListItemsQuery,
		toListQuery: (query: z.output<typeof ListItemsQuery>) => {
			const predicate = andCrudPredicates(
				query.status === undefined
					? undefined
					: { kind: "comparison", field: "status", operator: "in", value: query.status },
				query.createdFrom === undefined
					? undefined
					: { kind: "comparison", field: "createdAt", operator: "gte", value: query.createdFrom },
				query.createdTo === undefined
					? undefined
					: { kind: "comparison", field: "createdAt", operator: "lte", value: query.createdTo },
			);
			return {
				mode: "offset",
				page: query.page,
				limit: query.pageSize,
				...(predicate === undefined ? {} : { predicate }),
				...(query.sort === undefined
					? {}
					: {
							order: [
								{
									field: query.sort.replace("-", "") as "name" | "createdAt",
									direction: query.sort.startsWith("-") ? "desc" : "asc",
								},
							],
						}),
			};
		},
		sort: { fields: ["name", "createdAt"] },
		pagination: {
			offset: true,
			maxLimit: 100,
			meta: {
				offset: {
					schema: z.strictObject({
						page: z.number().int(),
						pageSize: z.number().int(),
						totalItems: z.number().int(),
						totalPages: z.number().int(),
					}),
					format: (meta) => ({
						page: meta.page,
						pageSize: meta.limit,
						totalItems: meta.total,
						totalPages: meta.totalPages,
					}),
				},
			},
		},
	},
	concurrency: { field: "version" },
});

/** Holds each update open after its locked read so concurrent writers overlap. */
@Injectable()
class UpdateDelayHook implements CrudLifecycleHook<typeof items> {
	async beforeUpdate(input: z.output<typeof items.contracts.update>) {
		await new Promise((resolve) => setTimeout(resolve, 150));
		return input;
	}
}

@Module({
	providers: [{ provide: "VERSIONED_ITEM_DELAY", useClass: UpdateDelayHook }],
	exports: ["VERSIONED_ITEM_DELAY"],
})
class UpdateDelayHookModule {}

describe.skipIf(skipPostgres)(
	"schema list contract and If-Match over TypeORM on PostgreSQL",
	() => {
		let app: INestApplication;

		beforeAll(async () => {
			const binding = bindTypeOrmCrud({
				resource: items,
				adapter: { useFactory: () => plainAdapter() },
				mappings: {
					create: (input) => ({ ...input, createdAt: day(9) }),
					update: (input) => input,
					response: (record) => ({
						id: record.id,
						name: record.name,
						status: record.status,
						createdAt: record.createdAt.toISOString(),
						version: record.version,
					}),
				},
			});
			const moduleRef = await Test.createTestingModule({
				imports: [
					CrudModule.forRoot(),
					CrudModule.forFeature({ imports: [UpdateDelayHookModule], resources: [binding] }),
				],
				providers: [
					{ provide: APP_PIPE, useValue: new StandardSchemaValidationPipe() },
					{
						provide: APP_INTERCEPTOR,
						inject: [Reflector],
						useFactory: (reflector: Reflector) =>
							new StandardSchemaSerializerInterceptor(reflector),
					},
				],
			}).compile();
			app = moduleRef.createNestApplication(new ExpressAdapter(), { logger: false });
			await app.init();
		});

		afterAll(async () => {
			await app?.close();
		});

		beforeEach(seed);

		it("lists with repeated keys as IN, a date range, sort, and the custom meta", async () => {
			const page = await request(app.getHttpServer())
				.get("/versioned-items")
				.query(
					"status=active&status=inactive&createdFrom=2026-04-02T00:00:00.000Z&sort=-name&pageSize=1",
				)
				.expect(200);
			expect(page.body).toEqual({
				data: [expect.objectContaining({ id: 3, name: "Cedar", version: 1 })],
				meta: { page: 1, pageSize: 1, totalItems: 2, totalPages: 2 },
			});
			await request(app.getHttpServer())
				.get("/versioned-items")
				.query({ pageSize: 101 })
				.expect(400);
			await request(app.getHttpServer())
				.get("/versioned-items")
				.query("filter[name][eq]=Acme")
				.expect(400);
		});

		it("bumps @VersionColumn, sets ETag, and answers 428/412", async () => {
			const server = app.getHttpServer();
			expect((await request(server).get("/versioned-items/1").expect(200)).headers.etag).toBe(
				'"1"',
			);
			await request(server).patch("/versioned-items/1").send({ name: "Acme 2" }).expect(428);
			await request(server)
				.patch("/versioned-items/1")
				.set("If-Match", '"5"')
				.send({ name: "Acme 2" })
				.expect(412);
			const updated = await request(server)
				.patch("/versioned-items/1")
				.set("If-Match", '"1"')
				.send({ name: "Acme 2" })
				.expect(200);
			expect(updated.headers.etag).toBe('"2"');
			expect(updated.body).toMatchObject({ name: "Acme 2", version: 2 });
			await request(server)
				.patch("/versioned-items/1")
				.set("If-Match", '"1"')
				.send({ name: "Lost" })
				.expect(412);

			await request(server).delete("/versioned-items/1").expect(428);
			await request(server).delete("/versioned-items/1").set("If-Match", '"1"').expect(412);
			await request(server).delete("/versioned-items/1").set("If-Match", '"2"').expect(204);
			const rows = await adminPool!.query(
				`SELECT count(*)::int AS count FROM ${TABLE} WHERE id = 1`,
			);
			expect(rows.rows[0]).toEqual({ count: 0 });
		});

		it("lets exactly one of two concurrent writers with the same If-Match win", async () => {
			const server = app.getHttpServer();
			const attempt = (name: string) =>
				request(server).patch("/versioned-items/2").set("If-Match", '"1"').send({ name });
			const results = await Promise.all([attempt("Writer A"), attempt("Writer B")]);
			expect(results.map((result) => result.status).toSorted((a, b) => a - b)).toEqual([200, 412]);
			const stored = await adminPool!.query(`SELECT name, version FROM ${TABLE} WHERE id = 2`);
			const winner = results.find((result) => result.status === 200);
			expect(stored.rows[0]).toEqual({ name: winner?.body.name, version: 2 });
		});
	},
);
