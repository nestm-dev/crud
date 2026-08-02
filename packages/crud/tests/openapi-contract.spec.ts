import { StandardSchemaModule } from "@nestm/standard-schema";
import { Test } from "@nestjs/testing";
import {
	DocumentBuilder,
	SwaggerModule,
	type OpenAPIObject,
	type StandardSchemaConverter,
} from "@nestjs/swagger";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createCrudController } from "../src/controller/controller.factory.ts";
import { getCrudServiceToken } from "../src/module/crud.tokens.ts";
import { defineCrudResource } from "../src/resource/define-resource.ts";
import { crudOperations } from "../src/resource/operations.ts";
import { withCrudStandardSchemaConverter } from "../src/schema/page-schema.ts";

const contracts = {
	id: z.object({ id: z.coerce.number().int().positive() }),
	create: z.object({ name: z.string().min(1) }),
	update: z.object({ name: z.string().min(1).optional() }),
	response: z.object({
		id: z.number().int(),
		name: z.string(),
		createdAt: z.string(),
		deletedAt: z.string().nullable(),
	}),
} as const;

const offsetResource = defineCrudResource({
	name: "openapi-offset",
	path: "matrix/offset",
	itemPath: ":id",
	idFields: { id: "id" },
	contracts,
	operations: crudOperations.all({ restore: {} }),
	query: { pagination: { offset: true, defaultLimit: 10, maxLimit: 25 } },
	softDelete: { field: "deletedAt", allowQueryDeleted: true },
});

const cursorResource = defineCrudResource({
	name: "openapi-cursor",
	path: "matrix/cursor",
	itemPath: ":id",
	idFields: { id: "id" },
	contracts,
	operations: crudOperations.readOnly(),
	query: {
		sort: { fields: ["createdAt"], default: ["-createdAt"], cursor: ["createdAt"] },
		pagination: { cursor: true, defaultLimit: 5, maxLimit: 15 },
	},
});

const dualResource = defineCrudResource({
	name: "openapi-dual",
	path: "matrix/dual",
	itemPath: ":id",
	idFields: { id: "id" },
	contracts,
	operations: crudOperations.only("list"),
	query: {
		sort: { fields: ["createdAt"], default: ["createdAt"], cursor: ["createdAt"] },
		pagination: { offset: true, cursor: true, defaultLimit: 8, maxLimit: 30 },
	},
});

const compositeResource = defineCrudResource({
	name: "openapi-composite",
	path: "matrix/composite",
	itemPath: ":tenantId/:id",
	idFields: { tenantId: "tenantId", id: "id" },
	contracts: {
		id: z.object({ tenantId: z.string().min(1), id: z.coerce.number().int().positive() }),
		create: z.object({ tenantId: z.string(), id: z.number().int(), name: z.string() }),
		update: z.object({ name: z.string().optional() }),
		response: z.object({ tenantId: z.string(), id: z.number().int(), name: z.string() }),
	},
	operations: crudOperations.readOnly(),
	query: { pagination: { offset: true } },
});

const relatedResource = defineCrudResource({
	name: "openapi-related",
	path: "matrix/related",
	itemPath: ":id",
	idFields: { id: "id" },
	contracts,
	operations: crudOperations.readOnly(),
	query: { pagination: { offset: true } },
	relations: {
		children: {
			type: "hasMany",
			target: () => offsetResource,
			local: ["id"],
			foreign: ["id"],
			maxItems: 10,
		},
	},
});

const resources = [
	offsetResource,
	cursorResource,
	dualResource,
	compositeResource,
	relatedResource,
] as const;

describe("generated OpenAPI contract matrix", () => {
	let document: OpenAPIObject;
	let nativeDocument: OpenAPIObject;
	let close: () => Promise<void>;

	beforeAll(async () => {
		const controllers = resources.map((resource) => createCrudController(resource));
		const moduleRef = await Test.createTestingModule({
			imports: [StandardSchemaModule.forRoot()],
			controllers,
			providers: resources.map((resource) => ({
				provide: getCrudServiceToken(resource),
				useValue: {},
			})),
		}).compile();
		const app = moduleRef.createNestApplication({ logger: false });
		await app.init();
		document = SwaggerModule.createDocument(
			app,
			new DocumentBuilder().setTitle("CRUD OpenAPI matrix").setVersion("1").build(),
			{
				standardSchemaConverter: withCrudStandardSchemaConverter(zodStandardSchemaConverter),
			},
		);
		nativeDocument = SwaggerModule.createDocument(
			app,
			new DocumentBuilder().setTitle("CRUD native schemas").setVersion("1").build(),
		);
		close = () => app.close();
	});

	afterAll(async () => {
		await close();
	});

	it("matches the complete generated OpenAPI document", () => {
		expect(document).toMatchSnapshot();
	});

	it("uses an underlying native Standard JSON Schema converter without Swagger options", () => {
		const list = operation(nativeDocument, "/matrix/offset", "get");
		expect(responseSchema(list, "200")).toMatchObject({
			properties: {
				data: { type: "array", items: { type: "object" } },
				meta: { properties: { mode: { enum: ["offset"] } } },
			},
			type: "object",
		});
	});

	it("matches pagination parameters and response envelopes for every enabled mode", () => {
		const offset = operation(document, "/matrix/offset", "get");
		const cursor = operation(document, "/matrix/cursor", "get");
		const dual = operation(document, "/matrix/dual", "get");

		expect(queryParameterNames(offset)).toEqual(["deleted", "limit", "page"]);
		expect(queryParameterNames(cursor)).toEqual(["after", "limit", "sort"]);
		expect(queryParameterNames(dual)).toEqual(["after", "limit", "page", "sort"]);
		expect(pageMetaModes(responseSchema(offset, "200"))).toEqual(["offset"]);
		expect(pageMetaModes(responseSchema(cursor, "200"))).toEqual(["cursor"]);
		expect(pageMetaModes(responseSchema(dual, "200"))).toEqual(["cursor", "offset"]);
	});

	it("expands composite IDs into unique path parameters", () => {
		const read = operation(document, "/matrix/composite/{tenantId}/{id}", "get");
		const pathParameters = parameters(read)
			.filter((parameter) => parameter.in === "path")
			.map((parameter) => parameter.name);

		expect(pathParameters).toEqual(["tenantId", "id"]);
		expect(new Set(pathParameters).size).toBe(pathParameters.length);
	});

	it("emits only routes selected by all, readOnly, and only presets", () => {
		expect(methodsAt(document, "/matrix/offset")).toEqual(["get", "post"]);
		expect(methodsAt(document, "/matrix/offset/{id}")).toEqual(["delete", "get", "patch"]);
		expect(methodsAt(document, "/matrix/offset/{id}/restore")).toEqual(["post"]);
		expect(methodsAt(document, "/matrix/cursor")).toEqual(["get"]);
		expect(methodsAt(document, "/matrix/cursor/{id}")).toEqual(["get"]);
		expect(methodsAt(document, "/matrix/dual")).toEqual(["get"]);
		expect(document.paths["/matrix/dual/{id}"]).toBeUndefined();
	});

	it("documents soft-delete access and relation includes only where configured", () => {
		const offsetList = operation(document, "/matrix/offset", "get");
		const relatedList = operation(document, "/matrix/related", "get");
		const relatedRead = operation(document, "/matrix/related/{id}", "get");

		expect(parameterSchema(offsetList, "deleted")).toMatchObject({
			type: "string",
			enum: ["include", "only"],
		});
		expect(queryParameterNames(relatedList)).toContain("include");
		expect(queryParameterNames(relatedRead)).toContain("include");
		expect(offsetList.responses["422"]).toBeUndefined();
		expect(relatedList.responses["422"]).toBeDefined();
		expect(relatedRead.responses["422"]).toBeDefined();
	});

	it("emits operation-specific Nest exception responses", () => {
		expect(responseStatuses(operation(document, "/matrix/offset", "post"))).toEqual([
			"201",
			"400",
			"409",
			"500",
		]);
		expect(responseStatuses(operation(document, "/matrix/offset", "get"))).toEqual([
			"200",
			"400",
			"500",
		]);
		expect(responseStatuses(operation(document, "/matrix/offset/{id}", "get"))).toEqual([
			"200",
			"400",
			"404",
			"500",
		]);
		expect(responseStatuses(operation(document, "/matrix/offset/{id}", "patch"))).toEqual([
			"200",
			"400",
			"404",
			"409",
			"500",
		]);
		expect(responseStatuses(operation(document, "/matrix/offset/{id}", "delete"))).toEqual([
			"204",
			"400",
			"404",
			"409",
			"500",
		]);
		expect(responseStatuses(operation(document, "/matrix/offset/{id}/restore", "post"))).toEqual([
			"200",
			"400",
			"404",
			"409",
			"500",
		]);
	});

	it.each([
		["400", "Bad Request"],
		["404", "Not Found"],
		["409", "Conflict"],
		["422", "Unprocessable Entity"],
		["500", "Internal Server Error"],
	] as const)("uses the exact native Nest %s error envelope", (status, error) => {
		const source =
			status === "422"
				? operation(document, "/matrix/related", "get")
				: operation(document, "/matrix/offset/{id}", status === "409" ? "patch" : "get");

		expect(responseSchema(source, status)).toEqual({
			additionalProperties: false,
			properties: {
				statusCode: { type: "integer", enum: [Number(status)] },
				message: {
					oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
				},
				error: { type: "string", enum: [error] },
			},
			required: ["statusCode", "message", "error"],
			type: "object",
		});
	});
});

const zodStandardSchemaConverter: StandardSchemaConverter = (schema, options) => {
	if (!(schema instanceof z.ZodType)) return undefined;
	return {
		schema: z.toJSONSchema(schema, {
			io: options.schemaType,
			target: "openapi-3.0",
			unrepresentable: "any",
		}),
	};
};

type HttpMethod = "delete" | "get" | "patch" | "post";
type PathItem = NonNullable<OpenAPIObject["paths"][string]>;
type OperationObject = NonNullable<PathItem["get"]>;
type Parameter = NonNullable<OperationObject["parameters"]>[number];
type ParameterObject = Exclude<Parameter, { readonly $ref: string }>;
type Response = NonNullable<OperationObject["responses"][string]>;
type ResponseObject = Exclude<Response, { readonly $ref: string }>;
type MediaSchema = NonNullable<NonNullable<ResponseObject["content"]>[string]["schema"]>;
type SchemaObject = Exclude<MediaSchema, { readonly $ref: string }>;

function operation(document: OpenAPIObject, path: string, method: HttpMethod): OperationObject {
	const value = document.paths[path]?.[method];
	if (value === undefined) throw new TypeError(`Missing OpenAPI operation ${method} ${path}.`);
	return value;
}

function methodsAt(document: OpenAPIObject, path: string): readonly string[] {
	const item = document.paths[path];
	if (item === undefined) throw new TypeError(`Missing OpenAPI path ${path}.`);
	return (["delete", "get", "patch", "post"] as const)
		.filter((method) => item[method] !== undefined)
		.toSorted();
}

function parameters(operationObject: OperationObject): readonly ParameterObject[] {
	return (operationObject.parameters ?? []).map((parameter) => {
		if ("$ref" in parameter) throw new TypeError("Unexpected referenced OpenAPI parameter.");
		return parameter;
	});
}

function queryParameterNames(operationObject: OperationObject): readonly string[] {
	return parameters(operationObject)
		.filter((parameter) => parameter.in === "query")
		.map((parameter) => parameter.name)
		.toSorted();
}

function parameterSchema(operationObject: OperationObject, name: string): SchemaObject {
	const schema = parameters(operationObject).find((parameter) => parameter.name === name)?.schema;
	if (schema === undefined || "$ref" in schema) {
		throw new TypeError(`Missing inline OpenAPI schema for parameter ${name}.`);
	}
	return schema;
}

function responseStatuses(operationObject: OperationObject): readonly string[] {
	return Object.keys(operationObject.responses).toSorted(
		(left, right) => Number(left) - Number(right),
	);
}

function responseSchema(operationObject: OperationObject, status: string): SchemaObject {
	const response = operationObject.responses[status];
	if (response === undefined || "$ref" in response) {
		throw new TypeError(`Missing inline OpenAPI response ${status}.`);
	}
	const schema = response.content?.["application/json"]?.schema;
	if (schema === undefined || "$ref" in schema) {
		throw new TypeError(`Missing inline OpenAPI response schema ${status}.`);
	}
	return schema;
}

function pageMetaModes(schema: SchemaObject): readonly string[] {
	const meta = inlineProperty(schema, "meta");
	const variants = meta.oneOf ?? [meta];
	return variants
		.flatMap((variant) => {
			if ("$ref" in variant) throw new TypeError("Unexpected referenced page metadata schema.");
			const mode = inlineProperty(variant, "mode");
			return (mode.enum ?? []).filter((value): value is string => typeof value === "string");
		})
		.toSorted();
}

function inlineProperty(schema: SchemaObject, name: string): SchemaObject {
	const value = schema.properties?.[name];
	if (value === undefined || "$ref" in value) {
		throw new TypeError(`Missing inline OpenAPI property ${name}.`);
	}
	return value;
}
