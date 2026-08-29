import { z } from "zod";
import { describe, expect, it } from "vitest";

import { defineCrudBinding } from "../src/adapter/binding.types.ts";
import { defineCrudRelation } from "../src/relation/relation.types.ts";
import { defineCrudResource, isCrudResource } from "../src/resource/define-resource.ts";
import { crudOperations, type CrudOperations } from "../src/resource/operations.ts";
import type { AnyCrudResource, CrudResourceDefinition } from "../src/resource/resource.types.ts";
import { CrudRegistry } from "../src/runtime/crud-registry.ts";
import type { CrudService } from "../src/runtime/crud.service.ts";
import { FakeCrudAdapter } from "./support/fake-crud-adapter.ts";

describe("defineCrudResource", () => {
	it("brands and freezes a valid explicit resource definition", () => {
		const resource = defineCrudResource(validDefinition());

		expect(resource.name).toBe("widgets");
		expect(Object.isFrozen(resource)).toBe(true);
		expect(Object.isFrozen(resource.idFields)).toBe(true);
		expect(Object.isFrozen(resource.contracts)).toBe(true);
		expect(Object.isFrozen(resource.operations)).toBe(true);
		expect(isCrudResource(resource)).toBe(true);
		expect(isCrudResource({ ...resource })).toBe(true);
		expect(isCrudResource({ ...resource, [Symbol.for("@nestm/crud:resource")]: false })).toBe(
			false,
		);
		expect(isCrudResource({ name: "widgets" })).toBe(false);
	});

	it("snapshots nested routing and query configuration", () => {
		const fields = ["id", "name"];
		const operators = ["eq"] as const;
		const operations: CrudOperations = { list: {} };
		const definition = {
			...validDefinition(),
			operations,
			query: {
				filters: { name: { schema: z.string(), operators } },
				sort: { fields, default: ["id"] },
			},
		};
		const resource = defineCrudResource(definition);

		fields.push("mutated");
		operations.read = {};
		expect(resource.query?.sort?.fields).toEqual(["id", "name"]);
		expect(Object.keys(resource.operations)).toEqual(["list"]);
		expect(Object.isFrozen(resource.query)).toBe(true);
		expect(Object.isFrozen(resource.query?.filters?.name?.operators)).toBe(true);
	});

	it("snapshots and freezes nested path parameter configuration", () => {
		const resource = defineCrudResource({
			name: "artifact-versions",
			path: "artifacts/:artifactId/versions",
			itemPath: ":versionId",
			idFields: { artifactId: "artifactId", versionId: "versionId" },
			pathParams: {
				contract: { schema: z.object({ artifactId: z.string().uuid() }) },
				fields: { artifactId: "artifactId" },
			},
			contracts: {
				id: z.object({ artifactId: z.string().uuid(), versionId: z.coerce.number().int() }),
				create: z.object({ name: z.string() }),
				update: z.object({ name: z.string().optional() }),
				upsert: { schema: z.object({ name: z.string() }) },
				response: z.object({
					artifactId: z.string().uuid(),
					versionId: z.number().int(),
					name: z.string(),
				}),
			},
			operations: crudOperations.readOnly(),
		});

		expect(resource.pathParams?.fields).toEqual({ artifactId: "artifactId" });
		expect(Object.isFrozen(resource.pathParams)).toBe(true);
		expect(Object.isFrozen(resource.pathParams?.fields)).toBe(true);
		expect(Object.isFrozen(resource.pathParams?.contract)).toBe(true);
		expect(Object.isFrozen(resource.contracts.upsert)).toBe(true);
	});

	it("snapshots decorator enhancer arrays at every supported level", () => {
		const noopDecorator: ClassDecorator & MethodDecorator = () => undefined;
		const resourceDecorators: (ClassDecorator | MethodDecorator)[] = [noopDecorator];
		const operationDecorators: (ClassDecorator | MethodDecorator)[] = [noopDecorator];
		const deletedDecorators: (ClassDecorator | MethodDecorator)[] = [noopDecorator];
		const resource = defineCrudResource({
			...validDefinition(),
			enhancers: { decorators: resourceDecorators },
			operations: { list: { decorators: operationDecorators } },
			softDelete: {
				field: "deletedAt",
				allowQueryDeleted: true,
				queryDeletedEnhancers: { decorators: deletedDecorators },
			},
		});

		resourceDecorators.push(noopDecorator);
		operationDecorators.push(noopDecorator);
		deletedDecorators.push(noopDecorator);

		expect(resource.enhancers?.decorators).toHaveLength(1);
		expect(resource.operations.list?.decorators).toHaveLength(1);
		expect(resource.softDelete?.queryDeletedEnhancers?.decorators).toHaveLength(1);
		expect(Object.isFrozen(resource.enhancers?.decorators)).toBe(true);
		expect(Object.isFrozen(resource.operations.list?.decorators)).toBe(true);
		expect(Object.isFrozen(resource.softDelete?.queryDeletedEnhancers?.decorators)).toBe(true);
	});

	it("snapshots explicit idempotent delete semantics", () => {
		const resource = defineCrudResource({
			...validDefinition(),
			operations: { delete: { missing: "ignore" } },
		});

		expect(resource.operations.delete?.missing).toBe("ignore");
		expect(Object.isFrozen(resource.operations.delete)).toBe(true);
	});

	it("snapshots and freezes mutation validator tokens", () => {
		const validators = [Symbol("first-validator")];
		const resource = defineCrudResource({ ...validDefinition(), validators });

		validators.push(Symbol("mutated-validator"));
		expect(resource.validators).toHaveLength(1);
		expect(Object.isFrozen(resource.validators)).toBe(true);
	});

	it("snapshots binding fields and provider metadata", () => {
		const resource = defineCrudResource(validDefinition());
		const fields: string[] = ["id", "name"];
		const inject = [Symbol("dependency")];
		const binding = defineCrudBinding({
			resource,
			fields,
			adapter: {
				inject,
				useFactory: () => new FakeCrudAdapter(),
			},
			mappings: {
				create: () => ({}),
				update: () => ({}),
				persistence: (values) => values,
				response: () => ({ id: 1, name: "stable" }),
			},
		});

		fields.push("mutated");
		inject.push(Symbol("mutated"));
		expect(binding.fields).toEqual(["id", "name"]);
		expect("inject" in binding.adapter ? binding.adapter.inject : undefined).toHaveLength(1);
		expect(Object.isFrozen(binding.fields)).toBe(true);
		expect(Object.isFrozen(binding.adapter)).toBe(true);
	});

	it.each([
		[
			"route parameters in the collection path without pathParams",
			() =>
				defineCrudResource({
					...validDefinition(),
					path: "tenants/:tenantId/widgets",
				} as CrudResourceDefinition),
			"must declare pathParams",
		],
		[
			"pathParams on a flat collection path",
			() =>
				defineCrudResource({
					...validDefinition(),
					pathParams: {
						contract: z.object({ tenantId: z.string() }),
						fields: { tenantId: "tenantId" },
					},
				} as CrudResourceDefinition),
			"cannot declare pathParams",
		],
		[
			"non-canonical optional path parameter syntax",
			() =>
				defineCrudResource({
					...validDefinition(),
					path: "tenants/:tenantId?/widgets",
				} as CrudResourceDefinition),
			"canonical",
		],
		[
			"embedded item parameter syntax",
			() =>
				defineCrudResource({
					...validDefinition(),
					itemPath: "widget-:id",
				} as CrudResourceDefinition),
			"canonical",
		],
		[
			"overlapping collection and item parameter names",
			() =>
				defineCrudResource({
					...validDefinition(),
					path: "tenants/:id/widgets",
					pathParams: {
						contract: z.object({ id: z.coerce.number().int() }),
						fields: { id: "id" },
					},
				} as CrudResourceDefinition),
			"must be disjoint",
		],
		[
			"duplicate collection parameter names",
			() =>
				defineCrudResource({
					...validDefinition(),
					path: "tenants/:tenantId/parents/:tenantId/widgets",
					idFields: { tenantId: "tenantId", id: "id" },
					pathParams: {
						contract: z.object({ tenantId: z.string() }),
						fields: { tenantId: "tenantId" },
					},
				} as CrudResourceDefinition),
			"path route parameters must contain unique values",
		],
		[
			"pathParams fields that differ from path parameters",
			() =>
				defineCrudResource({
					...validDefinition(),
					path: "tenants/:tenantId/widgets",
					idFields: { tenantId: "tenantId", id: "id" },
					pathParams: {
						contract: z.object({ organizationId: z.string() }),
						fields: { organizationId: "tenantId" },
					},
				} as CrudResourceDefinition),
			"must match pathParams.fields",
		],
		[
			"pathParams fields that differ from parent ID mappings",
			() =>
				defineCrudResource({
					...validDefinition(),
					path: "tenants/:tenantId/widgets",
					idFields: { tenantId: "organizationId", id: "id" },
					pathParams: {
						contract: z.object({ tenantId: z.string() }),
						fields: { tenantId: "tenantId" },
					},
				} as CrudResourceDefinition),
			"must match parent idFields mappings",
		],
		[
			"duplicate pathParams field mappings",
			() =>
				defineCrudResource({
					...validDefinition(),
					path: "organizations/:organizationId/projects/:projectId/widgets",
					idFields: { organizationId: "tenantId", projectId: "projectId", id: "id" },
					pathParams: {
						contract: z.object({ organizationId: z.string(), projectId: z.string() }),
						fields: { organizationId: "tenantId", projectId: "tenantId" },
					},
				} as CrudResourceDefinition),
			"pathParams.fields mappings must contain unique values",
		],
		[
			"empty ID persistence field",
			() =>
				defineCrudResource({
					...validDefinition(),
					idFields: { id: " " },
				}),
			"idFields must contain non-empty strings",
		],
		[
			"empty soft-delete field",
			() =>
				defineCrudResource({
					...validDefinition(),
					softDelete: { field: "" },
				}),
			"softDelete.field must contain non-empty strings",
		],
		[
			"empty name",
			() => defineCrudResource({ ...validDefinition(), name: " " }),
			"name cannot be empty",
		],
		[
			"missing operation preset",
			() =>
				defineCrudResource({
					...validDefinition(),
					operations: undefined as unknown as CrudOperations,
				}),
			"explicitly select",
		],
		[
			"unknown operation",
			() =>
				defineCrudResource({
					...validDefinition(),
					operations: { explode: {} } as unknown as CrudOperations,
				}),
			"unknown operation",
		],
		[
			"mismatched composite route parameters",
			() =>
				defineCrudResource({
					...validDefinition(),
					itemPath: ":tenantId/:widgetId",
					idFields: { tenantId: "tenantId", id: "id" },
				} as CrudResourceDefinition),
			"full route parameters must match idFields exactly",
		],
		[
			"duplicate ID field mapping",
			() =>
				defineCrudResource({
					...validDefinition(),
					itemPath: ":tenantId/:id",
					idFields: { tenantId: "id", id: "id" },
				} as CrudResourceDefinition),
			"unique fields",
		],
		[
			"duplicate route parameter masking a missing ID parameter",
			() =>
				defineCrudResource({
					...validDefinition(),
					itemPath: ":id/:id",
					idFields: { tenantId: "tenantId", id: "id" },
				} as CrudResourceDefinition),
			"itemPath route parameters must contain unique values",
		],
		[
			"restore without soft delete",
			() =>
				defineCrudResource({
					...validDefinition(),
					operations: crudOperations.only("restore"),
				}),
			"without softDelete",
		],
		[
			"upsert without an upsert contract",
			() =>
				defineCrudResource({
					...validDefinition(),
					operations: { upsert: {} },
				} as CrudResourceDefinition),
			"without contracts.upsert",
		],
		[
			"cursor pagination without declared safe fields",
			() =>
				defineCrudResource({
					...validDefinition(),
					query: { pagination: { cursor: true } },
				}),
			"sort.cursor fields",
		],
		[
			"an operation with an undefined configuration",
			() =>
				defineCrudResource({
					...validDefinition(),
					operations: { list: undefined } as unknown as CrudOperations,
				}),
			"options object",
		],
		[
			"missing-row behavior on a non-delete operation",
			() =>
				defineCrudResource({
					...validDefinition(),
					operations: { read: { missing: "ignore" } } as unknown as CrudOperations,
				}),
			"cannot configure missing-row behavior",
		],
		[
			"invalid delete missing-row behavior",
			() =>
				defineCrudResource({
					...validDefinition(),
					operations: {
						delete: { missing: "explode" },
					} as unknown as CrudOperations,
				}),
			'missing must be "not-found" or "ignore"',
		],
		[
			"disabled pagination modes",
			() =>
				defineCrudResource({
					...validDefinition(),
					query: { pagination: { offset: false, cursor: false } },
				}),
			"enable a pagination mode",
		],
		[
			"an unsafe pagination limit",
			() =>
				defineCrudResource({
					...validDefinition(),
					query: { pagination: { defaultLimit: 0 } },
				}),
			"positive safe integer",
		],
		[
			"a maximum limit below the default",
			() =>
				defineCrudResource({
					...validDefinition(),
					query: { pagination: { defaultLimit: 10, maxLimit: 5 } },
				}),
			"maxLimit must be >= defaultLimit",
		],
		[
			"a cursor field outside the sort allowlist",
			() =>
				defineCrudResource({
					...validDefinition(),
					query: {
						sort: { fields: ["id"], cursor: ["createdAt"] },
						pagination: { cursor: true },
					},
				}),
			"must also appear in sort.fields",
		],
		[
			"a cursor maximum limit without overflow headroom",
			() =>
				defineCrudResource({
					...validDefinition(),
					query: {
						sort: { fields: ["id"], cursor: ["id"] },
						pagination: { cursor: true, maxLimit: Number.MAX_SAFE_INTEGER },
					},
				}),
			"must leave room for overflow detection",
		],
		[
			"a cursor-unsafe default ordering",
			() =>
				defineCrudResource({
					...validDefinition(),
					query: {
						sort: {
							fields: ["id", "nullableName", "createdAt"],
							default: ["nullableName"],
							cursor: ["createdAt"],
						},
						pagination: { cursor: true },
					},
				}),
			"not cursor-safe",
		],
		[
			"a repeated default sort field",
			() =>
				defineCrudResource({
					...validDefinition(),
					query: { sort: { fields: ["name"], default: ["name", "-name"] } },
				}),
			"repeats field",
		],
		[
			"an inverted search range",
			() =>
				defineCrudResource({
					...validDefinition(),
					query: { search: { fields: ["name"], minLength: 10, maxLength: 2 } },
				}),
			"maxLength must be >= minLength",
		],
		[
			"an empty relation tuple",
			() =>
				defineCrudResource({
					...validDefinition(),
					relations: {
						broken: {
							type: "hasMany",
							target: () => defineCrudResource(validDefinition()),
							local: [],
							foreign: [],
						},
					},
				}),
			"equally-sized, non-empty key tuples",
		],
		[
			"duplicate route versions",
			() =>
				defineCrudResource({
					...validDefinition(),
					version: ["1", "1"],
				}),
			"unique route versions",
		],
	] as const)("rejects %s", (_name, action, message) => {
		expect(action).toThrowError(message);
	});
});

describe("defineCrudRelation", () => {
	it("snapshots key tuples and freezes the relation", () => {
		const local = ["tenantId", "id"];
		const foreign = ["tenantId", "widgetId"];
		const relation = defineCrudRelation({
			type: "hasMany",
			target: () => defineCrudResource(validDefinition()),
			local,
			foreign,
			maxItems: 25,
		});

		local.push("mutated");
		foreign.push("mutated");
		expect(relation.local).toEqual(["tenantId", "id"]);
		expect(relation.foreign).toEqual(["tenantId", "widgetId"]);
		expect(Object.isFrozen(relation)).toBe(true);
		expect(Object.isFrozen(relation.local)).toBe(true);
	});

	it.each([
		[
			"an unsupported type",
			{
				type: "manyToMany",
				target: (): undefined => undefined,
				local: ["id"],
				foreign: ["id"],
			},
			"supported relation type",
		],
		[
			"mismatched key tuples",
			{
				type: "hasMany",
				target: (): undefined => undefined,
				local: ["id"],
				foreign: [],
			},
			"equally-sized, non-empty key tuples",
		],
		[
			"duplicate tuple fields",
			{
				type: "hasMany",
				target: (): undefined => undefined,
				local: ["id", "id"],
				foreign: ["first", "second"],
			},
			"unique, non-empty fields",
		],
		[
			"a bound on a to-one relation",
			{
				type: "hasOne",
				target: (): undefined => undefined,
				local: ["id"],
				foreign: ["id"],
				maxItems: 1,
			},
			"Only a hasMany",
		],
		[
			"an unsafe bound",
			{
				type: "hasMany",
				target: (): undefined => undefined,
				local: ["id"],
				foreign: ["id"],
				maxItems: Number.MAX_SAFE_INTEGER + 1,
			},
			"positive safe integer",
		],
		[
			"a maximum safe-integer bound without overflow headroom",
			{
				type: "hasMany",
				target: (): undefined => undefined,
				local: ["id"],
				foreign: ["id"],
				maxItems: Number.MAX_SAFE_INTEGER,
			},
			"below Number.MAX_SAFE_INTEGER",
		],
	] as const)("rejects %s", (_name, relation, message) => {
		expect(() => defineCrudRelation(relation as never)).toThrowError(message);
	});
});

describe("CrudRegistry bootstrap validation", () => {
	it("rejects route collisions across distinct resources", () => {
		const first = defineCrudResource({ ...validDefinition(), name: "first" });
		const second = defineCrudResource({ ...validDefinition(), name: "second" });
		const registry = new CrudRegistry();

		registry.register(bindingFor(first), fakeService());
		expect(() => registry.register(bindingFor(second), fakeService())).toThrowError(
			/registered by both "first" and "second"/,
		);
	});

	it.each([
		["generated before headless", true, false],
		["headless before generated", false, true],
	] as const)(
		"excludes headless entries from generated-route collisions: %s",
		(_name, firstGenerated, secondGenerated) => {
			const first = defineCrudResource({ ...validDefinition(), name: "first" });
			const second = defineCrudResource({ ...validDefinition(), name: "second" });
			const registry = new CrudRegistry();

			registry.register(bindingFor(first), fakeService(), firstGenerated);
			expect(() =>
				registry.register(bindingFor(second), fakeService(), secondGenerated),
			).not.toThrow();
			expect(registry.list().map(({ resource }) => resource.name)).toEqual(["first", "second"]);
		},
	);

	it("treats reordered version arrays as the same route versions", () => {
		const first = defineCrudResource({ ...validDefinition(), name: "first", version: ["1", "2"] });
		const second = defineCrudResource({
			...validDefinition(),
			name: "second",
			version: ["2", "1"],
		});
		const registry = new CrudRegistry();

		registry.register(bindingFor(first), fakeService());
		expect(() => registry.register(bindingFor(second), fakeService())).toThrowError(
			/registered by both "first" and "second"/,
		);
	});

	it("rejects partially overlapping version arrays", () => {
		const first = defineCrudResource({ ...validDefinition(), name: "first", version: ["1", "2"] });
		const second = defineCrudResource({
			...validDefinition(),
			name: "second",
			version: ["2", "3"],
		});
		const registry = new CrudRegistry();

		registry.register(bindingFor(first), fakeService());
		expect(() => registry.register(bindingFor(second), fakeService())).toThrowError(
			/CRUD route v2:GET:\/widgets/,
		);
	});

	it("allows the same method and path on distinct versions", () => {
		const first = defineCrudResource({ ...validDefinition(), name: "first", version: "1" });
		const second = defineCrudResource({ ...validDefinition(), name: "second", version: "2" });
		const registry = new CrudRegistry();

		registry.register(bindingFor(first), fakeService());
		expect(() => registry.register(bindingFor(second), fakeService())).not.toThrow();
	});

	it("rejects a relation whose target was not registered", () => {
		const target = defineCrudResource({
			...validDefinition(),
			name: "targets",
			path: "targets",
		});
		const source = defineCrudResource({
			...validDefinition(),
			name: "sources",
			path: "sources",
			relations: {
				targets: {
					type: "hasMany",
					target: () => target,
					local: ["id"],
					foreign: ["id"],
				},
			},
		});
		const registry = new CrudRegistry();
		registry.register(bindingFor(source), fakeService());

		expect(() => registry.onApplicationBootstrap()).toThrowError(/unregistered resource "targets"/);
	});

	it("rejects a relation whose registered target is nested", () => {
		const target = defineCrudResource({
			...validDefinition(),
			name: "targets",
			path: "parents/:parentId/targets",
			idFields: { parentId: "parentId", id: "id" },
			pathParams: {
				contract: z.object({ parentId: z.string() }),
				fields: { parentId: "parentId" },
			},
			contracts: {
				...validDefinition().contracts,
				id: z.object({ parentId: z.string(), id: z.coerce.number().int() }),
			},
		});
		const source = defineCrudResource({
			...validDefinition(),
			name: "sources",
			path: "sources",
			relations: {
				targets: {
					type: "hasMany",
					target: () => target,
					local: ["id"],
					foreign: ["id"],
				},
			},
		});
		const registry = new CrudRegistry();
		registry.register(bindingFor(source), fakeService());
		registry.register(bindingFor(target), fakeService());

		expect(() => registry.onApplicationBootstrap()).toThrowError(
			/cannot target nested resource "targets"/,
		);
	});

	it("rejects a branded clone that aliases a registered relation target name", () => {
		const target = defineCrudResource({
			...validDefinition(),
			name: "targets",
			path: "targets",
		});
		const targetAlias = { ...target };
		const source = defineCrudResource({
			...validDefinition(),
			name: "sources",
			path: "sources",
			relations: {
				targets: {
					type: "hasMany",
					target: () => targetAlias,
					local: ["id"],
					foreign: ["id"],
				},
			},
		});
		const registry = new CrudRegistry();
		registry.register(bindingFor(source), fakeService());
		registry.register(bindingFor(target), fakeService());

		expect(isCrudResource(targetAlias)).toBe(true);
		expect(() => registry.getResource(targetAlias)).toThrowError(
			/does not match the exact registered resource identity/,
		);
		expect(() => registry.onApplicationBootstrap()).toThrowError(
			/must return the exact registered resource "targets"/,
		);
	});
});

function validDefinition() {
	return {
		name: "widgets",
		path: "widgets",
		itemPath: ":id",
		idFields: { id: "id" },
		contracts: {
			id: z.object({ id: z.coerce.number().int() }),
			create: z.object({ name: z.string() }),
			update: z.object({ name: z.string().optional() }),
			response: z.object({ id: z.number(), name: z.string() }),
		},
		operations: crudOperations.readOnly(),
	} as const;
}

function bindingFor(resource: AnyCrudResource) {
	return defineCrudBinding({
		resource,
		adapter: { useValue: new FakeCrudAdapter() },
		fields: ["id", "name"],
		mappings: {
			create: () => ({}),
			update: () => ({}),
			persistence: (values) => values,
			response: () => ({}),
		},
	});
}

function fakeService(): CrudService {
	return {} as CrudService;
}
