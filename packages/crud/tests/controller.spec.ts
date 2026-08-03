import {
	HTTP_CODE_METADATA,
	METHOD_METADATA,
	PATH_METADATA,
	VERSION_METADATA,
} from "@nestjs/common/constants";
import { HttpStatus, RequestMethod } from "@nestjs/common";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
	createCrudController,
	getCrudControllerName,
} from "../src/controller/controller.factory.ts";
import { defineCrudResource } from "../src/resource/define-resource.ts";
import { crudOperations } from "../src/resource/operations.ts";
import { CRUD_QUERY_OPENAPI_EXTENSION } from "../src/swagger-ui/query-extension.ts";

const routeResource = defineCrudResource({
	name: "billing-items",
	path: "/api/billing-items/",
	itemPath: ":tenantId/:id",
	idFields: { tenantId: "tenantId", id: "id" },
	contracts: {
		id: z.object({ tenantId: z.string(), id: z.coerce.number().int() }),
		create: z.object({ name: z.string() }),
		update: z.object({ name: z.string().optional() }),
		response: z.object({ tenantId: z.string(), id: z.number(), name: z.string() }),
	},
	operations: crudOperations.all({ restore: {} }),
	query: {
		filters: { name: { schema: z.string(), operators: ["eq"] } },
		sort: { fields: ["name"] },
		pagination: { offset: true },
	},
	softDelete: { allowQueryDeleted: true, field: "deletedAt" },
	tags: ["Billing"],
	version: "2",
});

describe("generated CRUD controller metadata", () => {
	it("uses a deterministic class name and normalized controller path", () => {
		const controller = createCrudController(routeResource);

		expect(controller.name).toBe("BillingItemsCrudController");
		expect(getCrudControllerName(routeResource)).toBe("BillingItemsCrudController");
		expect(Reflect.getMetadata(PATH_METADATA, controller)).toBe("api/billing-items");
		expect(Reflect.getMetadata("swagger/apiUseTags", controller)).toEqual(["Billing"]);
	});

	it.each([
		["create", "/", RequestMethod.POST, HttpStatus.CREATED],
		["list", "/", RequestMethod.GET, HttpStatus.OK],
		["read", ":tenantId/:id", RequestMethod.GET, HttpStatus.OK],
		["update", ":tenantId/:id", RequestMethod.PATCH, HttpStatus.OK],
		["delete", ":tenantId/:id", RequestMethod.DELETE, HttpStatus.NO_CONTENT],
		["restore", ":tenantId/:id/restore", RequestMethod.POST, HttpStatus.OK],
	] as const)(
		"decorates %s with its exact Nest route contract",
		(operation, path, method, status) => {
			const controller = createCrudController(routeResource);
			const handler = controller.prototype[operation] as object;

			expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
			expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(method);
			expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(status);
			expect(Reflect.getMetadata(VERSION_METADATA, handler)).toBe("2");
			expect(Reflect.getMetadata("swagger/apiOperation", handler)).toMatchObject({
				operationId: `billing-items_${operation}`,
			});
		},
	);

	it("emits query, success, and standard error Swagger metadata", () => {
		const controller = createCrudController(routeResource);
		const readHandler = controller.prototype.read as object;
		const listHandler = controller.prototype.list as object;
		const deleteHandler = controller.prototype.delete as object;

		const listQueryNames = swaggerParameters(listHandler)
			.filter(({ in: location }) => location === "query")
			.map(({ name }) => name);
		expect(listQueryNames).toEqual(
			expect.arrayContaining(["filter[name][eq]", "sort", "deleted", "page", "limit"]),
		);
		expect(Reflect.getMetadata("swagger/apiExtension", listHandler)).toEqual({
			[CRUD_QUERY_OPENAPI_EXTENSION]: {
				version: 1,
				conjunction: "and",
				conditions: [
					{
						field: "name",
						operator: "eq",
						parameter: "filter[name][eq]",
						valueKind: "scalar",
					},
				],
			},
		});
		expect(Reflect.getMetadata("swagger/apiExtension", readHandler)).toBeUndefined();

		const readResponses = Reflect.getMetadata("swagger/apiResponse", readHandler) as Record<
			string,
			unknown
		>;
		const deleteResponses = Reflect.getMetadata("swagger/apiResponse", deleteHandler) as Record<
			string,
			unknown
		>;
		expect(Object.keys(readResponses)).toEqual(expect.arrayContaining(["200", "400", "404"]));
		expect(readResponses["422"]).toBeUndefined();
		expect(Object.keys(deleteResponses)).toEqual(expect.arrayContaining(["204", "400", "404"]));
	});

	it("documents exact offset-only, cursor-only, and dual pagination parameters", () => {
		const cursorOnly = defineCrudResource({
			...routeResource,
			name: "cursor-only-items",
			path: "cursor-only-items",
			operations: crudOperations.readOnly(),
			query: {
				sort: { fields: ["name"], default: ["name"], cursor: ["name"] },
				pagination: { cursor: true, maxLimit: 25 },
			},
		});
		const dual = defineCrudResource({
			...cursorOnly,
			name: "dual-mode-items",
			path: "dual-mode-items",
			query: {
				...cursorOnly.query,
				pagination: { offset: true, cursor: true, maxLimit: 40 },
			},
		});
		const offsetParameters = parameterMap(createCrudController(routeResource).prototype.list);
		const cursorParameters = parameterMap(createCrudController(cursorOnly).prototype.list);
		const dualParameters = parameterMap(createCrudController(dual).prototype.list);

		expect([...offsetParameters.keys()]).toEqual(expect.arrayContaining(["page", "limit"]));
		expect(offsetParameters.has("after")).toBe(false);
		expect(cursorParameters.has("page")).toBe(false);
		expect([...cursorParameters.keys()]).toEqual(expect.arrayContaining(["after", "limit"]));
		expect(cursorParameters.get("limit")?.schema).toMatchObject({
			type: "integer",
			minimum: 1,
			maximum: 25,
		});
		expect([...dualParameters.keys()]).toEqual(expect.arrayContaining(["page", "after", "limit"]));
	});

	it("advertises relation-bound 422 responses only when includes exist", () => {
		const related = defineCrudResource({
			...routeResource,
			name: "related-items",
			path: "related-items",
			operations: crudOperations.readOnly(),
			relations: {
				children: {
					type: "hasMany",
					target: () => routeResource,
					local: ["id"],
					foreign: ["id"],
				},
			},
		});
		const controller = createCrudController(related);
		const readResponses = Reflect.getMetadata(
			"swagger/apiResponse",
			controller.prototype.read,
		) as Record<string, unknown>;
		const listResponses = Reflect.getMetadata(
			"swagger/apiResponse",
			controller.prototype.list,
		) as Record<string, unknown>;

		expect(readResponses["422"]).toBeDefined();
		expect(listResponses["422"]).toBeDefined();
	});

	it("leaves methods outside an explicit operation preset undecorated", () => {
		const resource = defineCrudResource({
			...routeResource,
			name: "billing-read-model",
			operations: crudOperations.readOnly(),
		});
		const controller = createCrudController(resource);

		expect(Reflect.getMetadata(METHOD_METADATA, controller.prototype.list)).toBe(RequestMethod.GET);
		expect(Reflect.getMetadata(METHOD_METADATA, controller.prototype.read)).toBe(RequestMethod.GET);
		expect(Reflect.getMetadata(METHOD_METADATA, controller.prototype.create)).toBeUndefined();
		expect(Reflect.getMetadata(METHOD_METADATA, controller.prototype.delete)).toBeUndefined();
	});

	it("applies opaque decorators to the controller and generated handlers", () => {
		const classDecorator: ClassDecorator = (target) => {
			Reflect.defineMetadata("test:resource-decorator", true, target);
		};
		const operationDecorator: MethodDecorator = (_target, _propertyKey, descriptor) => {
			Reflect.defineMetadata("test:operation-decorator", true, descriptor.value as object);
		};
		const deletedDecorator: MethodDecorator = (_target, _propertyKey, descriptor) => {
			Reflect.defineMetadata("test:deleted-decorator", true, descriptor.value as object);
		};
		const resource = defineCrudResource({
			...routeResource,
			name: "decorated-items",
			path: "decorated-items",
			enhancers: { decorators: [classDecorator] },
			operations: {
				list: { decorators: [operationDecorator] },
			},
			softDelete: {
				...routeResource.softDelete!,
				queryDeletedEnhancers: { decorators: [deletedDecorator] },
			},
		});
		const controller = createCrudController(resource);

		expect(Reflect.getMetadata("test:resource-decorator", controller)).toBe(true);
		expect(Reflect.getMetadata("test:operation-decorator", controller.prototype.list)).toBe(true);
		expect(Reflect.getMetadata("test:deleted-decorator", controller.prototype.list)).toBe(true);
		expect(
			Reflect.getMetadata("test:operation-decorator", controller.prototype.read),
		).toBeUndefined();
	});
});

interface SwaggerParameterMetadata {
	readonly in: string;
	readonly name: string;
	readonly schema?: unknown;
}

function parameterMap(handler: object): ReadonlyMap<string, SwaggerParameterMetadata> {
	return new Map(swaggerParameters(handler).map((parameter) => [parameter.name, parameter]));
}

function swaggerParameters(handler: object): readonly SwaggerParameterMetadata[] {
	const value: unknown = Reflect.getMetadata("swagger/apiParameters", handler);
	if (!Array.isArray(value)) {
		throw new TypeError("Expected generated Swagger parameter metadata.");
	}
	return value.filter(isSwaggerParameterMetadata);
}

function isSwaggerParameterMetadata(value: unknown): value is SwaggerParameterMetadata {
	return (
		typeof value === "object" &&
		value !== null &&
		"in" in value &&
		typeof value.in === "string" &&
		"name" in value &&
		typeof value.name === "string"
	);
}
