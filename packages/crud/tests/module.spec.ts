import { StandardSchemaModule } from "@nestm/standard-schema";
import { Controller, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule, type StandardSchemaConverter } from "@nestjs/swagger";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import type { CrudCursorCodec } from "../src/cursor/cursor.types.ts";
import { defineCrudBinding } from "../src/adapter/binding.types.ts";
import { InjectCrud } from "../src/controller/inject-crud.decorator.ts";
import { CrudModule } from "../src/module/crud.module.ts";
import type { ResolvedCrudModuleOptions } from "../src/module/crud-module.options.ts";
import {
	CRUD_CURSOR_CODEC,
	CRUD_RESOLVED_OPTIONS,
	getCrudServiceToken,
} from "../src/module/crud.tokens.ts";
import { defineCrudResource } from "../src/resource/define-resource.ts";
import { crudOperations } from "../src/resource/operations.ts";
import { CrudRegistry } from "../src/runtime/crud-registry.ts";
import type { CrudService } from "../src/runtime/crud.service.ts";
import { withCrudStandardSchemaConverter } from "../src/schema/page-schema.ts";
import {
	createCompositeBinding,
	createUserBinding,
	userResource,
} from "./support/core-fixtures.ts";
import { FakeCrudAdapter } from "./support/fake-crud-adapter.ts";

describe("CrudModule", () => {
	it("injects hooks, scopes, projections and validators without crossing positions", async () => {
		// The factory hands the service four slices of one flat `inject` array. Getting an offset
		// wrong would pass a scope where a projection belongs — which type assertions cannot catch,
		// because every slice is cast. Declaring all three, with different counts, is what pins it.
		const HOOK = Symbol("projection-di-hook");
		const SCOPE_A = Symbol("projection-di-scope-a");
		const SCOPE_B = Symbol("projection-di-scope-b");
		const PROJECTION = Symbol("projection-di-projection");
		const VALIDATOR_A = Symbol("projection-di-validator-a");
		const VALIDATOR_B = Symbol("projection-di-validator-b");

		const afterCreate = vi.fn();
		const resource = defineCrudResource({
			name: "di-projected-records",
			path: "di-projected-records",
			itemPath: ":id",
			idFields: { id: "id" },
			contracts: {
				id: z.object({ id: z.coerce.number().int() }),
				create: z.object({ name: z.string() }),
				update: z.object({ name: z.string().optional() }),
				response: z.object({ id: z.number(), name: z.string(), rank: z.number().optional() }),
			},
			operations: crudOperations.readOnly(),
			query: { pagination: { offset: true } },
			hooks: [HOOK],
			scopes: [SCOPE_A, SCOPE_B],
			projections: [PROJECTION],
			validators: [VALIDATOR_A, VALIDATOR_B],
		});
		const adapter = new FakeCrudAdapter([{ id: 1, name: "First" }]);
		const binding = defineCrudBinding({
			resource,
			adapter: { useValue: adapter },
			fields: ["id", "name"],
			mappings: {
				create: (input) => input,
				update: (input) => input,
				persistence: (values) => values,
				response: (record, _relations, projected) => ({
					id: Number(record.id),
					name: String(record.name),
					...(typeof projected?.rank === "number" ? { rank: projected.rank } : {}),
				}),
			},
		});

		// The providers must reach the feature module, exactly as a real consumer would wire them.
		@Module({
			providers: [
				{ provide: HOOK, useValue: { afterCreate } },
				{ provide: SCOPE_A, useValue: { resolve: () => ({}) } },
				{ provide: SCOPE_B, useValue: { resolve: () => ({}) } },
				{
					provide: PROJECTION,
					useValue: { project: (records: readonly unknown[]) => records.map(() => ({ rank: 9 })) },
				},
				{ provide: VALIDATOR_A, useValue: { validateCreate: vi.fn() } },
				{ provide: VALIDATOR_B, useValue: { validateCreate: vi.fn() } },
			],
			exports: [HOOK, SCOPE_A, SCOPE_B, PROJECTION, VALIDATOR_A, VALIDATOR_B],
		})
		class SupportModule {}

		const moduleRef = await Test.createTestingModule({
			imports: [
				StandardSchemaModule.forRoot(),
				CrudModule.forRoot({}),
				CrudModule.forFeature({ imports: [SupportModule], resources: [binding] }),
			],
		}).compile();
		await moduleRef.init();

		const service = moduleRef.get<CrudService<typeof resource>>(getCrudServiceToken(resource));
		expect(service.hooks).toHaveLength(1);
		expect(service.scopes).toHaveLength(2);
		expect(service.projections).toHaveLength(1);
		expect(service.validators).toHaveLength(2);
		await expect(service.list({ page: "1" })).resolves.toMatchObject({
			data: [{ id: 1, name: "First", rank: 9 }],
		});

		await moduleRef.close();
	});

	it("generates a feature controller by default and wires its service token and registry", async () => {
		const adapter = new FakeCrudAdapter();
		const binding = createUserBinding(adapter);
		const feature = CrudModule.forFeature({ resources: [binding] });
		const moduleRef = await Test.createTestingModule({
			imports: [
				StandardSchemaModule.forRoot(),
				CrudModule.forRoot({ pagination: { defaultLimit: 3, maxLimit: 7 } }),
				feature,
			],
		}).compile();
		await moduleRef.init();

		const service = moduleRef.get<CrudService<typeof userResource>>(
			getCrudServiceToken(userResource),
		);
		const resolved = moduleRef.get<ResolvedCrudModuleOptions>(CRUD_RESOLVED_OPTIONS);
		const registry = moduleRef.get(CrudRegistry);
		expect(service.resource).toBe(userResource);
		expect(resolved.pagination).toEqual({ defaultLimit: 3, maxLimit: 7 });
		expect(registry.list().map(({ resource }) => resource.name)).toEqual(["users"]);
		expect(feature.controllers?.[0]?.name).toBe("UsersCrudController");
		expect(feature.exports).toContain(getCrudServiceToken(userResource));

		await moduleRef.close();
	});

	it("registers and exports feature services without generated controllers when disabled", async () => {
		const adapter = new FakeCrudAdapter();
		const binding = createUserBinding(adapter);
		const collidingResource = defineCrudResource({
			name: "legacy-users",
			path: userResource.path,
			itemPath: userResource.itemPath,
			idFields: userResource.idFields,
			contracts: {
				id: z.object({ id: z.coerce.number().int().positive() }),
				create: z.object({ name: z.string().min(1) }),
				update: z.object({ name: z.string().min(1).optional() }),
				response: z.object({ id: z.number().int(), name: z.string() }),
			},
			operations: crudOperations.readOnly(),
		});
		const collidingBinding = defineCrudBinding({
			resource: collidingResource,
			adapter: { useValue: new FakeCrudAdapter() },
			fields: ["id", "name"],
			mappings: {
				create: (input) => input,
				update: (input) => input,
				persistence: (values) => values,
				response: (record) => ({ id: Number(record.id), name: String(record.name) }),
			},
		});
		const feature = CrudModule.forFeature({
			generateControllers: false,
			resources: [binding, collidingBinding],
		});

		@Controller("compatibility/users")
		class CompatibilityUsersController {
			constructor(@InjectCrud(userResource) readonly crud: CrudService<typeof userResource>) {}
		}

		const moduleRef = await Test.createTestingModule({
			imports: [StandardSchemaModule.forRoot(), CrudModule.forRoot(), feature],
			controllers: [CompatibilityUsersController],
		}).compile();
		await moduleRef.init();

		const service = moduleRef.get<CrudService<typeof userResource>>(
			getCrudServiceToken(userResource),
		);
		const controller = moduleRef.get(CompatibilityUsersController);
		const registry = moduleRef.get(CrudRegistry);
		expect(feature.controllers).toEqual([]);
		expect(feature.exports).toContain(getCrudServiceToken(userResource));
		expect(controller.crud).toBe(service);
		expect(registry.list().map(({ resource }) => resource.name)).toEqual(["users", "legacy-users"]);

		await moduleRef.close();
	});

	it("supports asynchronous root configuration and creates the secure codec", async () => {
		const factory = vi.fn(async () => ({
			cursor: { secret: "a secure asynchronous cursor secret with 32+ bytes" },
			pagination: { defaultLimit: 4, maxLimit: 9 },
		}));
		const moduleRef = await Test.createTestingModule({
			imports: [CrudModule.forRootAsync({ useFactory: factory })],
		}).compile();

		const resolved = moduleRef.get<ResolvedCrudModuleOptions>(CRUD_RESOLVED_OPTIONS);
		const codec = moduleRef.get<CrudCursorCodec>(CRUD_CURSOR_CODEC);
		expect(factory).toHaveBeenCalledOnce();
		expect(resolved.pagination).toEqual({ defaultLimit: 4, maxLimit: 9 });
		const token = await codec.encode({
			version: 1,
			resource: "test",
			order: [{ field: "id", direction: "asc" }],
			values: [1],
		});
		expect(await codec.decode(token)).toMatchObject({ resource: "test", values: [1] });

		await moduleRef.close();
	});

	it("rejects duplicate resources synchronously before Nest bootstrap", () => {
		const binding = createUserBinding(new FakeCrudAdapter());

		expect(() => CrudModule.forFeature({ resources: [binding, binding] })).toThrowError(
			'Duplicate CRUD resource name "users".',
		);
	});

	it("fails bootstrap when the required Standard Schema runtime is absent", async () => {
		const binding = createUserBinding(new FakeCrudAdapter());
		const moduleRef = await Test.createTestingModule({
			imports: [CrudModule.forRoot(), CrudModule.forFeature({ resources: [binding] })],
		}).compile();

		await expect(Promise.resolve().then(() => moduleRef.init())).rejects.toThrowError(
			"CRUD resources require StandardSchemaModule.forRoot()",
		);
		try {
			await moduleRef.close();
		} catch {
			// A failed Nest application bootstrap can replay bootstrap hooks during close.
		}
	});

	it("generates OpenAPI routes, composite response envelopes, and Standard Schema bodies", async () => {
		const binding = createUserBinding(new FakeCrudAdapter());
		const compositeBinding = createCompositeBinding(new FakeCrudAdapter());
		const moduleRef = await Test.createTestingModule({
			imports: [
				StandardSchemaModule.forRoot(),
				CrudModule.forRoot(),
				CrudModule.forFeature({ resources: [binding, compositeBinding] }),
			],
		}).compile();
		const app = moduleRef.createNestApplication({ logger: false });
		await app.init();

		const document = SwaggerModule.createDocument(
			app,
			new DocumentBuilder().setTitle("CRUD contract").setVersion("1").build(),
			{
				standardSchemaConverter: withCrudStandardSchemaConverter(zodStandardSchemaConverter),
			},
		);
		const collection = document.paths["/api/users"];
		const item = document.paths["/api/users/{id}"];
		expect(collection?.post?.operationId).toBe("users_create");
		expect(collection?.get?.operationId).toBe("users_list");
		expect(item?.get?.operationId).toBe("users_read");
		expect(item?.patch?.operationId).toBe("users_update");
		expect(item?.delete?.responses["204"]).toBeDefined();
		expect(document.paths["/api/users/{id}/restore"]?.post?.operationId).toBe("users_restore");
		const compositeParameters =
			document.paths["/memberships/{tenantId}/{id}"]?.get?.parameters ?? [];
		expect(
			compositeParameters.map((parameter) =>
				"$ref" in parameter ? parameter.$ref : `${parameter.in}:${parameter.name}`,
			),
		).toEqual(["path:tenantId", "path:id"]);

		const listSchema = responseSchema(collection?.get?.responses["200"]);
		expect(listSchema).toMatchObject({
			properties: {
				data: { type: "array" },
				meta: {
					properties: { mode: { enum: ["offset"] } },
					type: "object",
				},
			},
			required: ["data", "meta"],
			type: "object",
		});
		const listParameters = operationParameters(collection?.get);
		expect(listParameters.get("page")?.schema).toMatchObject({ type: "integer", minimum: 1 });
		expect(listParameters.get("limit")?.schema).toMatchObject({
			type: "integer",
			minimum: 1,
			maximum: 50,
		});
		expect(listParameters.get("deleted")?.schema).toMatchObject({
			type: "string",
			enum: ["include", "only"],
		});
		expect(listParameters.has("after")).toBe(false);
		const createRequestBody = collection?.post?.requestBody;
		expect(createRequestBody).toBeDefined();
		expect(JSON.stringify(createRequestBody)).toContain('"name"');

		await app.close();
	});
});

const zodStandardSchemaConverter: StandardSchemaConverter = (schema, options) => {
	if (!(schema instanceof z.ZodType)) {
		return undefined;
	}
	return {
		schema: z.toJSONSchema(schema, {
			io: options.schemaType,
			target: "openapi-3.0",
			unrepresentable: "any",
		}),
	};
};

function responseSchema(response: unknown): unknown {
	if (typeof response !== "object" || response === null || !("content" in response)) {
		return undefined;
	}
	const content = response.content;
	if (typeof content !== "object" || content === null || !("application/json" in content)) {
		return undefined;
	}
	const media = content["application/json"];
	return typeof media === "object" && media !== null && "schema" in media
		? media.schema
		: undefined;
}

function operationParameters(
	operation: { readonly parameters?: readonly unknown[] } | undefined,
): ReadonlyMap<string, { readonly schema?: unknown }> {
	const result = new Map<string, { readonly schema?: unknown }>();
	for (const parameter of operation?.parameters ?? []) {
		if (
			typeof parameter === "object" &&
			parameter !== null &&
			"name" in parameter &&
			typeof parameter.name === "string"
		) {
			result.set(parameter.name, {
				schema: "schema" in parameter ? parameter.schema : undefined,
			});
		}
	}
	return result;
}
