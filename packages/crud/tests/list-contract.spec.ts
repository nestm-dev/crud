import {
	PreconditionFailedException,
	StandardSchemaSerializerInterceptor,
	StandardSchemaValidationPipe,
	type INestApplication,
} from "@nestjs/common";
import { APP_INTERCEPTOR, APP_PIPE, Reflector } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import {
	DocumentBuilder,
	SwaggerModule,
	type OpenAPIObject,
	type StandardSchemaConverter,
} from "@nestjs/swagger";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineCrudBinding } from "../src/adapter/binding.types.ts";
import { CrudModule } from "../src/module/crud.module.ts";
import { resolveCrudModuleOptions } from "../src/module/crud-module.options.ts";
import { getCrudServiceToken } from "../src/module/crud.tokens.ts";
import { andCrudPredicates } from "../src/query/predicate.ts";
import { CrudQueryValidationError } from "../src/query/query.error.ts";
import { defineCrudResource } from "../src/resource/define-resource.ts";
import { crudOperations } from "../src/resource/operations.ts";
import {
	CrudPreconditionRequiredException,
	parseCrudEntityTags,
} from "../src/runtime/concurrency.ts";
import { CrudRegistry } from "../src/runtime/crud-registry.ts";
import { CrudService } from "../src/runtime/crud.service.ts";
import type { CrudLifecycleHook } from "../src/runtime/runtime.types.ts";
import { withCrudStandardSchemaConverter } from "../src/schema/page-schema.ts";
import { FakeCrudAdapter, type FakeRecord } from "./support/fake-crud-adapter.ts";

const CURSOR_SECRET = "a list-contract cursor secret with at least 32 bytes";

const Status = z.enum(["active", "inactive"]);
const SortField = z.enum(["name", "createdAt"]);

/** One strict query object per endpoint: repeated keys mean IN, ranges are `<field>From/To`. */
const ListBuildersQuery = z.strictObject({
	page: z.coerce.number().int().min(1).default(1),
	pageSize: z.coerce.number().int().min(1).max(100).default(20),
	sort: z
		.string()
		.regex(/^-?(name|createdAt)(,-?(name|createdAt))*$/)
		.optional()
		.transform((value) =>
			value?.split(",").map((item) => ({
				field: SortField.parse(item.replace(/^-/, "")),
				direction: item.startsWith("-") ? ("desc" as const) : ("asc" as const),
			})),
		),
	status: z
		.union([Status, z.array(Status)])
		.optional()
		.transform((value) => (value === undefined || Array.isArray(value) ? value : [value])),
	createdFrom: z.iso.datetime().optional(),
	createdTo: z.iso.datetime().optional(),
});

const OffsetMeta = z.strictObject({
	page: z.number().int().min(1),
	pageSize: z.number().int().min(1),
	totalItems: z.number().int().min(0),
	totalPages: z.number().int().min(0),
});

const CursorMeta = z.strictObject({
	limit: z.number().int().min(1),
	nextCursor: z.string().nullable(),
});

const builderResponse = z.object({
	id: z.number().int(),
	name: z.string(),
	status: z.string(),
	createdAt: z.string(),
	version: z.number().int(),
});

const builders = defineCrudResource({
	fields: ["id", "name", "status", "createdAt", "version"],
	name: "builders",
	path: "builders",
	itemPath: ":id",
	idFields: { id: "id" },
	contracts: {
		id: z.object({ id: z.coerce.number().int().positive() }),
		create: z.object({ name: z.string().min(1), status: Status }),
		update: z.object({ name: z.string().min(1).optional(), status: Status.optional() }),
		upsert: z.object({ name: z.string().min(1), status: Status }),
		response: builderResponse,
	},
	operations: crudOperations.all({ upsert: {} }),
	query: {
		schema: ListBuildersQuery,
		toListQuery: (query: z.output<typeof ListBuildersQuery>) => ({
			mode: "offset",
			page: query.page,
			limit: query.pageSize,
			...(query.sort === undefined ? {} : { order: query.sort }),
			...withPredicate(
				andCrudPredicates(
					query.status === undefined
						? undefined
						: { kind: "comparison", field: "status", operator: "in", value: query.status },
					query.createdFrom === undefined
						? undefined
						: {
								kind: "comparison",
								field: "createdAt",
								operator: "gte",
								value: new Date(query.createdFrom),
							},
					query.createdTo === undefined
						? undefined
						: {
								kind: "comparison",
								field: "createdAt",
								operator: "lte",
								value: new Date(query.createdTo),
							},
				),
			),
		}),
		sort: { fields: ["name", "createdAt"] },
		pagination: {
			offset: true,
			defaultLimit: 20,
			maxLimit: 100,
			meta: {
				offset: {
					schema: OffsetMeta,
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
	concurrency: { field: "version", increment: true },
});

/** A bracket-grammar resource that renames its pagination parameters and meta. */
const plans = defineCrudResource({
	fields: ["id", "name", "status", "createdAt", "version"],
	name: "floor-plans",
	path: "floor-plans",
	itemPath: ":id",
	idFields: { id: "id" },
	contracts: {
		id: z.object({ id: z.coerce.number().int().positive() }),
		create: z.object({ name: z.string().min(1), status: Status }),
		update: z.object({ name: z.string().min(1).optional() }),
		response: builderResponse,
	},
	operations: crudOperations.readOnly(),
	query: {
		filters: { status: { schema: Status, operators: ["eq", "in"] } },
		sort: { fields: ["name", "createdAt"], default: ["createdAt"], cursor: ["createdAt"] },
		pagination: {
			offset: true,
			cursor: true,
			defaultLimit: 2,
			maxLimit: 100,
			parameters: { limit: "pageSize", after: "cursor" },
			meta: {
				offset: {
					schema: OffsetMeta,
					format: (meta) => ({
						page: meta.page,
						pageSize: meta.limit,
						totalItems: meta.total,
						totalPages: meta.totalPages,
					}),
				},
				cursor: {
					schema: CursorMeta,
					format: (meta) => ({ limit: meta.limit, nextCursor: meta.nextCursor }),
				},
			},
		},
	},
});

function withPredicate<Predicate>(predicate: Predicate | undefined) {
	return predicate === undefined ? {} : { predicate };
}

function seed(): FakeRecord[] {
	return [
		{ id: 1, name: "Acme", status: "active", createdAt: date(1), version: 1 },
		{ id: 2, name: "Birch", status: "inactive", createdAt: date(2), version: 1 },
		{ id: 3, name: "Cedar", status: "active", createdAt: date(3), version: 1 },
		{ id: 4, name: "Dune", status: "archived", createdAt: date(4), version: 1 },
	];
}

function date(day: number): Date {
	return new Date(`2026-03-0${day}T00:00:00.000Z`);
}

function response(record: FakeRecord): z.input<typeof builderResponse> {
	return {
		id: Number(record.id),
		name: String(record.name),
		status: String(record.status),
		createdAt: (record.createdAt as Date).toISOString(),
		version: Number(record.version),
	};
}

function buildersBinding(adapter: FakeCrudAdapter) {
	return defineCrudBinding({
		resource: builders,
		adapter: { useValue: adapter },
		mappings: {
			create: (input) => ({ ...input, createdAt: date(9), version: 1 }),
			update: (input) => input,
			upsert: (id, input) => ({ id: id.id, ...input, createdAt: date(9), version: 1 }),
			persistence: (values) => values,
			response,
		},
		upsert: { conflictFields: ["id"], overwriteFields: ["name", "status"] },
	});
}

function plansBinding(adapter: FakeCrudAdapter) {
	return defineCrudBinding({
		resource: plans,
		adapter: { useValue: adapter },
		mappings: {
			create: (input) => input,
			update: (input) => input,
			response,
		},
	});
}

const platforms = [
	["Express", () => new ExpressAdapter()],
	["Fastify", () => new FastifyAdapter()],
] as const;

async function createApp(
	createAdapter: () => ExpressAdapter | FastifyAdapter,
	records: readonly FakeRecord[] = seed(),
): Promise<INestApplication> {
	const moduleRef = await Test.createTestingModule({
		imports: [
			CrudModule.forRoot({ cursor: { secret: CURSOR_SECRET } }),
			CrudModule.forFeature({
				resources: [
					buildersBinding(new FakeCrudAdapter(records)),
					plansBinding(
						new FakeCrudAdapter(records.filter((record) => record.status !== "archived")),
					),
				],
			}),
		],
		// Nest 12's native Standard Schema pipe and serializer; no extra package is required.
		providers: [
			{ provide: APP_PIPE, useValue: new StandardSchemaValidationPipe() },
			{
				provide: APP_INTERCEPTOR,
				inject: [Reflector],
				useFactory: (reflector: Reflector) => new StandardSchemaSerializerInterceptor(reflector),
			},
		],
	}).compile();
	const adapter = createAdapter();
	const app = moduleRef.createNestApplication(adapter, { logger: false });
	await app.init();
	if (adapter instanceof FastifyAdapter) await adapter.getInstance().ready();
	return app;
}

describe.each(platforms)(
	"schema list contract and optimistic concurrency on %s",
	(_name, createAdapter) => {
		let app: INestApplication;

		beforeAll(async () => {
			app = await createApp(createAdapter);
		});

		afterAll(async () => {
			await app.close();
		});

		it("lists through query.schema with repeated keys, ranges, sort, and a custom meta", async () => {
			const page = await request(app.getHttpServer())
				.get("/builders")
				.query(
					"status=active&status=inactive&sort=-name&pageSize=2&createdFrom=2026-03-01T00:00:00.000Z",
				)
				.expect(200);

			expect(page.body).toEqual({
				data: [
					expect.objectContaining({ id: 3, name: "Cedar" }),
					expect.objectContaining({ id: 2, name: "Birch" }),
				],
				meta: { page: 1, pageSize: 2, totalItems: 3, totalPages: 2 },
			});

			const ranged = await request(app.getHttpServer())
				.get("/builders")
				.query(
					"createdFrom=2026-03-02T00:00:00.000Z&createdTo=2026-03-03T00:00:00.000Z&sort=createdAt",
				)
				.expect(200);
			expect(ranged.body.data.map((item: { id: number }) => item.id)).toEqual([2, 3]);
			expect(ranged.body.meta).toEqual({ page: 1, pageSize: 20, totalItems: 2, totalPages: 1 });
		});

		it("rejects queries outside the schema instead of applying the bracket grammar", async () => {
			const server = app.getHttpServer();
			await request(server).get("/builders").query({ pageSize: 101 }).expect(400);
			await request(server).get("/builders").query({ limit: 5 }).expect(400);
			await request(server).get("/builders").query("filter[name][eq]=Acme").expect(400);
			await request(server).get("/builders").query({ sort: "version" }).expect(400);
			await request(server).get("/builders").query({ status: "deleted" }).expect(400);
		});

		it("renames bracket-grammar pagination parameters and formats both meta modes", async () => {
			const server = app.getHttpServer();
			const first = await request(server).get("/floor-plans").query({ pageSize: 1 }).expect(200);
			expect(first.body).toEqual({
				data: [expect.objectContaining({ id: 1 })],
				meta: { limit: 1, nextCursor: expect.any(String) },
			});

			const second = await request(server)
				.get("/floor-plans")
				.query({ pageSize: 1, cursor: first.body.meta.nextCursor })
				.expect(200);
			expect(second.body.data).toEqual([expect.objectContaining({ id: 2 })]);

			const offset = await request(server)
				.get("/floor-plans")
				.query({ page: 2, pageSize: 2, "filter[status][in]": "active,inactive" })
				.expect(200);
			expect(offset.body).toEqual({
				data: [expect.objectContaining({ id: 3 })],
				meta: { page: 2, pageSize: 2, totalItems: 3, totalPages: 2 },
			});

			const renamed = await request(server).get("/floor-plans").query({ limit: 1 }).expect(400);
			expect(renamed.body.message).toBe('Unknown query parameter "limit".');
			await request(server).get("/floor-plans").query({ after: "x" }).expect(400);
		});

		it("sets ETag and enforces If-Match with 428 and 412 on PATCH", async () => {
			const server = app.getHttpServer();
			const read = await request(server).get("/builders/1").expect(200);
			expect(read.headers.etag).toBe('"1"');

			const missing = await request(server)
				.patch("/builders/1")
				.send({ name: "Acme 2" })
				.expect(428);
			expect(missing.body).toMatchObject({ statusCode: 428, error: "Precondition Required" });
			await request(server)
				.patch("/builders/1")
				.set("If-Match", "*")
				.send({ name: "Acme 2" })
				.expect(428);
			const stale = await request(server)
				.patch("/builders/1")
				.set("If-Match", '"7"')
				.send({ name: "Acme 2" })
				.expect(412);
			expect(stale.body).toMatchObject({ statusCode: 412, error: "Precondition Failed" });

			const updated = await request(server)
				.patch("/builders/1")
				.set("If-Match", 'W/"0", "1"')
				.send({ name: "Acme 2" })
				.expect(200);
			expect(updated.headers.etag).toBe('"2"');
			expect(updated.body).toMatchObject({ name: "Acme 2", version: 2 });

			await request(server)
				.patch("/builders/1")
				.set("If-Match", '"1"')
				.send({ name: "Lost update" })
				.expect(412);
			await request(server).patch("/builders/99").set("If-Match", '"1"').send({}).expect(404);
		});

		it("enforces If-Match on DELETE", async () => {
			const server = app.getHttpServer();
			await request(server).delete("/builders/3").expect(428);
			await request(server).delete("/builders/3").set("If-Match", '"2"').expect(412);
			await request(server).delete("/builders/3").set("If-Match", '"1"').expect(204);
			await request(server).get("/builders/3").expect(404);
		});

		it("makes PUT conditional: If-None-Match creates, If-Match replaces", async () => {
			const server = app.getHttpServer();
			const body = { name: "Elm", status: "active" };
			await request(server).put("/builders/10").send(body).expect(428);
			await request(server).put("/builders/10").set("If-Match", '"1"').send(body).expect(412);

			const created = await request(server)
				.put("/builders/10")
				.set("If-None-Match", "*")
				.send(body)
				.expect(200);
			expect(created.headers.etag).toBe('"1"');
			await request(server).put("/builders/10").set("If-None-Match", "*").send(body).expect(412);

			const replaced = await request(server)
				.put("/builders/10")
				.set("If-Match", '"1"')
				.send({ name: "Elm 2", status: "inactive" })
				.expect(200);
			expect(replaced.headers.etag).toBe('"2"');
			expect(replaced.body).toMatchObject({
				id: 10,
				name: "Elm 2",
				status: "inactive",
				version: 2,
			});
			await request(server).put("/builders/10").set("If-Match", '"1"').send(body).expect(412);
		});
	},
);

describe("CrudService.listQuery", () => {
	let app: INestApplication;
	let service: CrudService<typeof builders>;

	beforeAll(async () => {
		app = await createApp(() => new ExpressAdapter());
		service = app.get(getCrudServiceToken(builders));
	});

	afterAll(async () => {
		await app.close();
	});

	it("runs a parser-free request with ID tie-breakers and the formatted meta", async () => {
		const page = await service.listQuery({
			mode: "offset",
			page: 1,
			limit: 3,
			order: [{ field: "createdAt", direction: "desc" }],
			predicate: { kind: "comparison", field: "status", operator: "ne", value: "archived" },
		});
		expect(page.data.map((item) => item.id)).toEqual([3, 2, 1]);
		expect(page.meta).toEqual({ page: 1, pageSize: 3, totalItems: 3, totalPages: 1 });
	});

	it("validates requests against the resource policy", async () => {
		const rejects = (code: string, run: () => Promise<unknown>) =>
			expect(run()).rejects.toSatisfy(
				(error) => error instanceof CrudQueryValidationError && error.code === code,
			);
		await rejects("invalid_pagination", () =>
			service.listQuery({ mode: "offset", page: 1, limit: 101 }),
		);
		await rejects("invalid_pagination", () => service.listQuery({ mode: "offset", page: 0 }));
		await rejects("invalid_pagination", () => service.listQuery({ mode: "cursor" }));
		await rejects("unknown_sort_field", () =>
			service.listQuery({
				mode: "offset",
				page: 1,
				order: [{ field: "version", direction: "asc" }],
			}),
		);
		await rejects("unknown_filter_field", () =>
			service.listQuery({
				mode: "offset",
				page: 1,
				predicate: {
					kind: "comparison",
					field: "secret" as "name",
					operator: "eq",
					value: 1,
				},
			}),
		);
		await rejects("deleted_query_forbidden", () =>
			service.listQuery({ mode: "offset", page: 1, deleted: "include" }),
		);
	});

	it("validates a raw query with query.schema when called through list()", async () => {
		const page = await service.list(
			new URLSearchParams("status=active&status=inactive&pageSize=1"),
		);
		expect(page.meta).toEqual({ page: 1, pageSize: 1, totalItems: 3, totalPages: 3 });
		await expect(service.list({ pageSize: "0" })).rejects.toBeInstanceOf(CrudQueryValidationError);
	});

	it("answers 412 when the version-pinned UPDATE or DELETE affects no row", async () => {
		const adapter = new FakeCrudAdapter(seed());
		const binding = buildersBinding(adapter);
		// Simulates a writer that slipped in after the If-Match comparison: the version moves
		// inside the same transaction, so the version-guarded write matches nothing.
		const racer: CrudLifecycleHook<typeof builders> = {
			beforeUpdate: async (input, context) => {
				await adapter.update(
					{
						predicate: { kind: "comparison", field: "id", operator: "eq", value: 1 },
						values: { version: 9 },
					},
					{ resource: "builders", operation: "update", session: context.session! },
				);
				return input;
			},
			beforeDelete: async (context) => {
				await adapter.update(
					{
						predicate: { kind: "comparison", field: "id", operator: "eq", value: 2 },
						values: { version: 9 },
					},
					{ resource: "builders", operation: "delete", session: context.session! },
				);
			},
		};
		const raced = new CrudService(
			builders,
			binding,
			adapter,
			[racer],
			[],
			new CrudRegistry(),
			resolveCrudModuleOptions({}),
		);
		await expect(
			raced.update({ id: 1 }, { name: "Raced" }, undefined, { ifMatch: '"1"' }),
		).rejects.toBeInstanceOf(PreconditionFailedException);
		await expect(raced.delete({ id: 2 }, undefined, { ifMatch: '"1"' })).rejects.toBeInstanceOf(
			PreconditionFailedException,
		);
		expect(adapter.calls.delete).toBe(1);
	});

	it("accepts explicit preconditions for direct writes", async () => {
		await expect(service.update({ id: 2 }, { name: "Direct" })).rejects.toBeInstanceOf(
			CrudPreconditionRequiredException,
		);
		const updated = await service.update({ id: 2 }, { name: "Direct" }, undefined, {
			ifMatch: '"1"',
		});
		expect(updated).toMatchObject({ name: "Direct", version: 2 });
	});
});

describe("If-Match parsing", () => {
	it.each([
		['"1"', ["1"]],
		['W/"1"', ["1"]],
		["1", ["1"]],
		[' "a" , W/"b",c ', ["a", "b", "c"]],
		['"a,b"', ["a,b"]],
	])("parses %s", (header, tags) => {
		expect(parseCrudEntityTags(header)).toEqual(tags);
	});

	it.each(['"open', '"a" "b"', ",", "W/"])("rejects malformed %s", (header) => {
		expect(parseCrudEntityTags(header)).toBeUndefined();
	});
});

describe("schema list contract OpenAPI", () => {
	let document: OpenAPIObject;
	let close: () => Promise<void>;

	beforeAll(async () => {
		const app = await createApp(() => new ExpressAdapter());
		document = SwaggerModule.createDocument(
			app,
			new DocumentBuilder().setTitle("List contract").setVersion("1").build(),
			{ standardSchemaConverter: withCrudStandardSchemaConverter(zodConverter) },
		);
		close = () => app.close();
	});

	afterAll(async () => {
		await close();
	});

	it("documents the query schema properties instead of the bracket grammar", () => {
		const list = document.paths["/builders"]?.get;
		const names = (list?.parameters ?? [])
			.map((parameter) => ("name" in parameter ? parameter.name : ""))
			.toSorted();
		expect(names).toEqual(["createdFrom", "createdTo", "page", "pageSize", "sort", "status"]);
		expect(list).not.toHaveProperty("x-nestm-crud-query");
	});

	it("documents the custom page meta and renamed bracket parameters", () => {
		const list = document.paths["/builders"]?.get;
		const ok = list?.responses["200"];
		expect(
			ok && "content" in ok ? ok.content?.["application/json"]?.schema : undefined,
		).toMatchObject({
			properties: {
				meta: {
					properties: {
						page: { type: "integer" },
						pageSize: { type: "integer" },
						totalItems: { type: "integer" },
						totalPages: { type: "integer" },
					},
				},
			},
		});
		const planParameters = (document.paths["/floor-plans"]?.get?.parameters ?? [])
			.map((parameter) => ("name" in parameter ? parameter.name : ""))
			.toSorted();
		expect(planParameters).toEqual(expect.arrayContaining(["cursor", "page", "pageSize", "sort"]));
		expect(planParameters).not.toContain("limit");
		expect(planParameters).not.toContain("after");
	});

	it("documents If-Match, ETag, 412 and 428", () => {
		const patch = document.paths["/builders/{id}"]?.patch;
		const ifMatch = patch?.parameters?.find(
			(parameter) => "name" in parameter && parameter.name === "If-Match",
		);
		expect(ifMatch).toMatchObject({ in: "header", required: true });
		expect(Object.keys(patch?.responses ?? {})).toEqual(
			expect.arrayContaining(["200", "412", "428"]),
		);
		const ok = patch?.responses["200"];
		expect(ok && "headers" in ok ? ok.headers : undefined).toHaveProperty("ETag");
		const put = document.paths["/builders/{id}"]?.put;
		expect(
			put?.parameters?.map((parameter) => ("name" in parameter ? parameter.name : "")),
		).toEqual(expect.arrayContaining(["If-Match", "If-None-Match"]));
		expect(document.paths["/builders/{id}"]?.delete?.responses).toHaveProperty("428");
		expect(document.paths["/builders"]?.post?.responses).not.toHaveProperty("428");
	});
});

const zodConverter: StandardSchemaConverter = (schema, options) => {
	if (!(schema instanceof z.ZodType)) return undefined;
	return {
		schema: z.toJSONSchema(schema, {
			io: options.schemaType,
			target: "openapi-3.0",
			unrepresentable: "any",
		}),
	};
};
