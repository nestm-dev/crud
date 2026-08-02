import { StandardSchemaModule } from "@nestm/standard-schema";
import {
	CanActivate,
	Injectable,
	Module,
	type CallHandler,
	type ExecutionContext,
	type INestApplication,
	type NestInterceptor,
} from "@nestjs/common";
import { ExpressAdapter } from "@nestjs/platform-express";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defineCrudBinding } from "../src/adapter/binding.types.ts";
import { CrudModule } from "../src/module/crud.module.ts";
import { defineCrudResource } from "../src/resource/define-resource.ts";
import { crudOperations } from "../src/resource/operations.ts";
import type { CrudLifecycleHook, CrudScope } from "../src/runtime/runtime.types.ts";
import { FakeCrudAdapter } from "./support/fake-crud-adapter.ts";

const platforms = [
	["Express", () => new ExpressAdapter()],
	["Fastify", () => new FastifyAdapter()],
] as const;

const ROLLBACK_HOOK = Symbol("advanced-http-rollback-hook");
const TENANT_SCOPE = Symbol("advanced-http-tenant-scope");

@Injectable()
class AuthorizationGuard implements CanActivate {
	canActivate(context: ExecutionContext): boolean {
		const request = context
			.switchToHttp()
			.getRequest<{ readonly headers: Record<string, unknown> }>();
		return request.headers.authorization === "Bearer allowed";
	}
}

@Injectable()
class ResponseMarkerInterceptor implements NestInterceptor {
	intercept(context: ExecutionContext, next: CallHandler) {
		const response = context.switchToHttp().getResponse<{
			header(name: string, value: string): unknown;
		}>();
		response.header("x-crud-interceptor", "active");
		return next.handle();
	}
}

@Injectable()
class TenantScope implements CrudScope {
	resolve(context: Parameters<CrudScope["resolve"]>[0]) {
		const request = context.executionContext?.switchToHttp().getRequest<{
			readonly headers: Record<string, unknown>;
		}>();
		const tenantId = request?.headers["x-tenant-id"];
		return {
			predicate: {
				kind: "comparison" as const,
				field: "tenantId",
				operator: "eq" as const,
				value: tenantId,
			},
		};
	}
}

@Injectable()
class RollbackHook implements CrudLifecycleHook {
	afterCreate(): never {
		throw new Error("in-transaction hook rejected the mutation");
	}
}

@Module({
	providers: [
		AuthorizationGuard,
		ResponseMarkerInterceptor,
		{ provide: TENANT_SCOPE, useClass: TenantScope },
		{ provide: ROLLBACK_HOOK, useClass: RollbackHook },
	],
	exports: [AuthorizationGuard, ResponseMarkerInterceptor, TENANT_SCOPE, ROLLBACK_HOOK],
})
class AdvancedHttpSupportModule {}

const membershipResource = defineCrudResource({
	name: "advanced-memberships",
	path: "advanced/memberships",
	itemPath: ":tenantId/:id",
	idFields: { tenantId: "tenantId", id: "id" },
	contracts: {
		id: z.object({ tenantId: z.string().min(1), id: z.coerce.number().int().positive() }),
		create: z.object({
			tenantId: z.string(),
			id: z.number().int(),
			name: z.string(),
			createdAt: z.number(),
		}),
		update: z.object({ name: z.string().optional() }),
		response: z.object({
			tenantId: z.string(),
			id: z.number().int(),
			name: z.string(),
			createdAt: z.number(),
		}),
	},
	operations: crudOperations.readOnly(),
	query: {
		filters: { name: { schema: z.string(), operators: ["eq", "icontains"] } },
		sort: {
			fields: ["createdAt", "tenantId", "id"],
			default: ["createdAt"],
			cursor: ["createdAt"],
		},
		pagination: { cursor: true, defaultLimit: 1, maxLimit: 5 },
	},
});

const childResource = defineCrudResource({
	name: "advanced-children",
	path: "advanced/children",
	itemPath: ":id",
	idFields: { id: "id" },
	contracts: {
		id: z.object({ id: z.coerce.number().int() }),
		create: z.object({ parentId: z.number(), name: z.string() }),
		update: z.object({ name: z.string().optional() }),
		response: z.object({ id: z.number(), parentId: z.number(), name: z.string() }),
	},
	operations: crudOperations.readOnly(),
	query: { pagination: { offset: true } },
});

const parentResource = defineCrudResource({
	name: "advanced-parents",
	path: "advanced/parents",
	itemPath: ":id",
	idFields: { id: "id" },
	contracts: {
		id: z.object({ id: z.coerce.number().int() }),
		create: z.object({ name: z.string() }),
		update: z.object({ name: z.string().optional() }),
		response: z.object({
			id: z.number(),
			name: z.string(),
			children: z
				.array(z.object({ id: z.number(), parentId: z.number(), name: z.string() }))
				.optional(),
		}),
	},
	operations: crudOperations.readOnly(),
	query: { pagination: { offset: true } },
	relations: {
		children: {
			type: "hasMany",
			target: () => childResource,
			local: ["id"],
			foreign: ["parentId"],
			maxItems: 1,
		},
	},
});

const scopedResource = defineCrudResource({
	name: "advanced-scoped-records",
	path: "advanced/scoped-records",
	itemPath: ":id",
	idFields: { id: "id" },
	contracts: {
		id: z.object({ id: z.coerce.number().int() }),
		create: z.object({ tenantId: z.string(), name: z.string() }),
		update: z.object({ name: z.string().optional() }),
		response: z.object({ id: z.number(), tenantId: z.string(), name: z.string() }),
	},
	operations: crudOperations.readOnly(),
	query: { pagination: { offset: true } },
	scopes: [TENANT_SCOPE],
});

const rollbackResource = defineCrudResource({
	name: "advanced-rollback-records",
	path: "advanced/rollback-records",
	itemPath: ":id",
	idFields: { id: "id" },
	contracts: {
		id: z.object({ id: z.coerce.number().int() }),
		create: z.object({ name: z.string().min(1) }),
		update: z.object({ name: z.string().optional() }),
		response: z.object({ id: z.number(), name: z.string() }),
	},
	operations: crudOperations.only("create", "list"),
	query: { pagination: { offset: true } },
	hooks: [ROLLBACK_HOOK],
});

const protectedResource = defineCrudResource({
	name: "advanced-protected-records",
	path: "advanced/protected-records",
	itemPath: ":id",
	idFields: { id: "id" },
	contracts: {
		id: z.object({ id: z.coerce.number().int() }),
		create: z.object({ name: z.string() }),
		update: z.object({ name: z.string().optional() }),
		response: z.object({ id: z.number(), name: z.string() }),
	},
	operations: crudOperations.readOnly(),
	query: { pagination: { offset: true } },
	enhancers: {
		guards: [AuthorizationGuard],
		interceptors: [ResponseMarkerInterceptor],
	},
});

const failingResource = defineCrudResource({
	name: "advanced-failing-records",
	path: "advanced/failing-records",
	itemPath: ":id",
	idFields: { id: "id" },
	contracts: {
		id: z.object({ id: z.coerce.number().int() }),
		create: z.object({ name: z.string() }),
		update: z.object({ name: z.string().optional() }),
		response: z.object({ id: z.number(), name: z.string() }),
	},
	operations: crudOperations.only("read"),
});

describe.each(platforms)("advanced generated HTTP contract on %s", (_name, createAdapter) => {
	let app: INestApplication;
	let rollbackAdapter: FakeCrudAdapter;

	beforeAll(async () => {
		rollbackAdapter = new FakeCrudAdapter();
		const failingAdapter = new FakeCrudAdapter([{ id: 1, name: "secret" }]);
		failingAdapter.findOne = async () => {
			throw new Error("raw database credentials must never escape");
		};
		const bindings = [
			membershipBinding(),
			childBinding(),
			parentBinding(),
			scopedBinding(),
			rollbackBinding(rollbackAdapter),
			protectedBinding(),
			failingBinding(failingAdapter),
		] as const;
		const moduleRef = await Test.createTestingModule({
			imports: [
				StandardSchemaModule.forRoot(),
				CrudModule.forRoot({
					cursor: { secret: "an advanced HTTP cursor secret with at least 32 bytes" },
				}),
				CrudModule.forFeature({ imports: [AdvancedHttpSupportModule], resources: bindings }),
			],
		}).compile();
		const platform = createAdapter();
		app = moduleRef.createNestApplication(platform, { logger: false });
		await app.init();
		if (platform instanceof FastifyAdapter) await platform.getInstance().ready();
	});

	afterAll(async () => {
		await app.close();
	});

	it("round-trips signed composite keyset cursors and rejects tampering", async () => {
		const first = await request(app.getHttpServer())
			.get("/advanced/memberships")
			.query({ limit: 1 })
			.expect(200);
		expect(first.body).toMatchObject({
			data: [{ tenantId: "t1", id: 1, name: "alpha" }],
			meta: { mode: "cursor", hasNextPage: true },
		});
		const cursor = readCursor(first.body);
		await request(app.getHttpServer())
			.get("/advanced/memberships")
			.query({ after: cursor, limit: 1 })
			.expect(200)
			.expect(({ body }) => {
				expect(body).toMatchObject({ data: [{ tenantId: "t1", id: 2, name: "bravo" }] });
			});

		const last = cursor.at(-1);
		const tampered = `${cursor.slice(0, -1)}${last === "A" ? "B" : "A"}`;
		await request(app.getHttpServer())
			.get("/advanced/memberships")
			.query({ after: tampered })
			.expect(400);
		await request(app.getHttpServer()).get("/advanced/memberships").query({ page: 1 }).expect(400);
	});

	it("uses every composite ID component and parses allowlisted filters", async () => {
		await request(app.getHttpServer())
			.get("/advanced/memberships/t1/2")
			.expect(200)
			.expect(({ body }) => {
				expect(body).toMatchObject({ tenantId: "t1", id: 2, name: "bravo" });
			});
		await request(app.getHttpServer()).get("/advanced/memberships/t2/2").expect(404);
		await request(app.getHttpServer())
			.get("/advanced/memberships")
			.query({ "filter[name][icontains]": "ALP", limit: 5 })
			.expect(200)
			.expect(({ body }) => {
				expect(body.data).toEqual([{ tenantId: "t1", id: 1, name: "alpha", createdAt: 10 }]);
			});
	});

	it("enforces target scopes and returns scope-hidden records as 404", async () => {
		await request(app.getHttpServer())
			.get("/advanced/scoped-records/2")
			.set("x-tenant-id", "tenant-a")
			.expect(404);
		await request(app.getHttpServer())
			.get("/advanced/scoped-records?page=1")
			.set("x-tenant-id", "tenant-a")
			.expect(200)
			.expect(({ body }) => {
				expect(body.data).toEqual([{ id: 1, tenantId: "tenant-a", name: "visible" }]);
			});
	});

	it("batches one-hop relations and returns 422 instead of truncating", async () => {
		await request(app.getHttpServer())
			.get("/advanced/parents/2?include=children")
			.expect(200)
			.expect(({ body }) => {
				expect(body.children).toEqual([{ id: 20, parentId: 2, name: "only" }]);
			});
		await request(app.getHttpServer()).get("/advanced/parents/1?include=children").expect(422);
	});

	it("runs Nest enhancers around generated handlers", async () => {
		await request(app.getHttpServer()).get("/advanced/protected-records?page=1").expect(403);
		await request(app.getHttpServer())
			.get("/advanced/protected-records?page=1")
			.set("authorization", "Bearer allowed")
			.expect("x-crud-interceptor", "active")
			.expect(200);
	});

	it("rolls back hook failures and suppresses raw persistence errors", async () => {
		await request(app.getHttpServer())
			.post("/advanced/rollback-records")
			.send({ name: "must roll back" })
			.expect(500);
		expect(rollbackAdapter.snapshot()).toEqual([]);

		const failure = await request(app.getHttpServer())
			.get("/advanced/failing-records/1")
			.expect(500);
		expect(JSON.stringify(failure.body)).not.toContain("database credentials");
		expect(failure.body).toMatchObject({
			statusCode: 500,
			message: "Persistence operation failed.",
		});
	});
});

function membershipBinding() {
	const adapter = new FakeCrudAdapter([
		{ tenantId: "t1", id: 1, name: "alpha", createdAt: 10 },
		{ tenantId: "t1", id: 2, name: "bravo", createdAt: 20 },
		{ tenantId: "t2", id: 3, name: "charlie", createdAt: 30 },
	]);
	return defineCrudBinding({
		resource: membershipResource,
		adapter: { useValue: adapter },
		fields: ["tenantId", "id", "name", "createdAt"],
		mappings: {
			create: (input) => input,
			update: (input) => input,
			persistence: (values) => values,
			response: (record) => ({
				tenantId: requiredString(record.tenantId),
				id: requiredNumber(record.id),
				name: requiredString(record.name),
				createdAt: requiredNumber(record.createdAt),
			}),
		},
	});
}

function childBinding() {
	const adapter = new FakeCrudAdapter([
		{ id: 10, parentId: 1, name: "first" },
		{ id: 11, parentId: 1, name: "second" },
		{ id: 20, parentId: 2, name: "only" },
	]);
	return defineCrudBinding({
		resource: childResource,
		adapter: { useValue: adapter },
		fields: ["id", "parentId", "name"],
		mappings: {
			create: (input) => input,
			update: (input) => input,
			persistence: (values) => values,
			response: (record) => ({
				id: requiredNumber(record.id),
				parentId: requiredNumber(record.parentId),
				name: requiredString(record.name),
			}),
		},
	});
}

function parentBinding() {
	const adapter = new FakeCrudAdapter([
		{ id: 1, name: "over bound" },
		{ id: 2, name: "within bound" },
	]);
	return defineCrudBinding({
		resource: parentResource,
		adapter: { useValue: adapter },
		fields: ["id", "name"],
		mappings: {
			create: (input) => input,
			update: (input) => input,
			persistence: (values) => values,
			response: (record, relations) => ({
				id: requiredNumber(record.id),
				name: requiredString(record.name),
				...(relations.children === undefined
					? {}
					: { children: readRelationChildren(relations.children) }),
			}),
		},
	});
}

function scopedBinding() {
	const adapter = new FakeCrudAdapter([
		{ id: 1, tenantId: "tenant-a", name: "visible" },
		{ id: 2, tenantId: "tenant-b", name: "hidden" },
	]);
	return defineCrudBinding({
		resource: scopedResource,
		adapter: { useValue: adapter },
		fields: ["id", "tenantId", "name"],
		mappings: {
			create: (input) => input,
			update: (input) => input,
			persistence: (values) => values,
			response: (record) => ({
				id: requiredNumber(record.id),
				tenantId: requiredString(record.tenantId),
				name: requiredString(record.name),
			}),
		},
	});
}

function rollbackBinding(adapter: FakeCrudAdapter) {
	return defineCrudBinding({
		resource: rollbackResource,
		adapter: { useValue: adapter },
		fields: ["id", "name"],
		mappings: basicMappings,
	});
}

function protectedBinding() {
	const adapter = new FakeCrudAdapter([{ id: 1, name: "protected" }]);
	return defineCrudBinding({
		resource: protectedResource,
		adapter: { useValue: adapter },
		fields: ["id", "name"],
		mappings: basicMappings,
	});
}

function failingBinding(adapter: FakeCrudAdapter) {
	return defineCrudBinding({
		resource: failingResource,
		adapter: { useValue: adapter },
		fields: ["id", "name"],
		mappings: basicMappings,
	});
}

const basicMappings = {
	create: (input: { readonly name: string }) => input,
	update: (input: { readonly name?: string | undefined }) => input,
	persistence: (values: Readonly<Record<string, unknown>>) => values,
	response: (record: Readonly<Record<string, unknown>>) => ({
		id: requiredNumber(record.id),
		name: requiredString(record.name),
	}),
};

function readRelationChildren(value: unknown) {
	if (!Array.isArray(value)) throw new TypeError("Expected relation children.");
	return value.map((child) => {
		if (typeof child !== "object" || child === null) {
			throw new TypeError("Expected a relation child record.");
		}
		return {
			id: requiredNumber("id" in child ? child.id : undefined),
			parentId: requiredNumber("parentId" in child ? child.parentId : undefined),
			name: requiredString("name" in child ? child.name : undefined),
		};
	});
}

function readCursor(body: unknown): string {
	if (
		typeof body !== "object" ||
		body === null ||
		!("meta" in body) ||
		typeof body.meta !== "object" ||
		body.meta === null ||
		!("nextCursor" in body.meta) ||
		typeof body.meta.nextCursor !== "string"
	) {
		throw new TypeError("Expected a next cursor in the response.");
	}
	return body.meta.nextCursor;
}

function requiredNumber(value: unknown): number {
	if (typeof value !== "number") throw new TypeError("Expected a number.");
	return value;
}

function requiredString(value: unknown): string {
	if (typeof value !== "string") throw new TypeError("Expected a string.");
	return value;
}
