import assert from "node:assert/strict";
import "reflect-metadata";

import { HttpStatus, Module, RequestMethod } from "@nestjs/common";
import {
	HTTP_CODE_METADATA,
	METHOD_METADATA,
	PARAMTYPES_METADATA,
	PATH_METADATA,
	ROUTE_ARGS_METADATA,
	SELF_DECLARED_DEPS_METADATA,
	VERSION_METADATA,
} from "@nestjs/common/constants";
import { NestFactory } from "@nestjs/core";
import { StandardSchemaModule } from "@nestm/standard-schema";
import { CrudModule, crudOperations, defineCrudResource, getCrudServiceToken } from "@nestm/crud";
import { MemoryCrudAdapter, bindMemoryCrud } from "@nestm/crud-memory";

interface ItemId {
	readonly id: number;
}

interface Item {
	readonly id: number;
	readonly name: string;
}

interface UpdateItem {
	readonly name?: string;
}

interface ConsumerSchema<Input, Output> {
	readonly "~standard": {
		readonly version: 1;
		readonly vendor: "nestm-consumer-smoke";
		readonly validate: (value: unknown) => { readonly value: Output };
		readonly types: { readonly input: Input; readonly output: Output };
	};
}

function consumerSchema<Input, Output>(): ConsumerSchema<Input, Output> {
	return {
		"~standard": {
			version: 1,
			vendor: "nestm-consumer-smoke",
			validate: (value) => ({ value: value as Output }),
			types: {
				input: undefined as Input,
				output: undefined as Output,
			},
		},
	};
}

const consumerResourceDecorator: ClassDecorator = (target) => {
	Reflect.defineMetadata("consumer:resource-decorator", true, target);
};
const consumerOperationDecorator: MethodDecorator = (_target, _propertyKey, descriptor) => {
	const handler: unknown = descriptor.value;
	if (typeof handler !== "function") throw new TypeError("Expected a generated CRUD handler.");
	Reflect.defineMetadata("consumer:operation-decorator", true, handler);
};

const resource = defineCrudResource({
	name: "consumer-items",
	path: "/api/consumer-items/",
	itemPath: ":id",
	idFields: { id: "id" },
	contracts: {
		id: consumerSchema<{ readonly id: unknown }, ItemId>(),
		create: consumerSchema<Item, Item>(),
		update: consumerSchema<UpdateItem, UpdateItem>(),
		response: consumerSchema<Item, Item>(),
	},
	operations: crudOperations.all({
		read: {
			decorators: [consumerOperationDecorator],
		},
	}),
	enhancers: {
		decorators: [consumerResourceDecorator],
	},
	query: {
		sort: { fields: ["id"], default: ["id"] },
		pagination: { offset: true },
	},
	tags: ["Consumer smoke"],
	version: "1",
});

const binding = bindMemoryCrud<typeof resource, Item, readonly ["id", "name"], Item, UpdateItem>({
	resource,
	fields: ["id", "name"],
	initialRecords: [{ id: 1, name: "packed artifact" }],
	mappings: {
		create: (input) => input,
		update: (input) => input,
		persistence: (values) => values,
		response: (record) => record,
	},
});

assert.ok("useValue" in binding.adapter);
assert.ok(binding.adapter.useValue instanceof MemoryCrudAdapter);

const feature = CrudModule.forFeature({ resources: [binding] });
const controllerValue = feature.controllers?.[0];
if (typeof controllerValue !== "function") {
	throw new TypeError("CrudModule.forFeature() did not expose its generated controller.");
}
const controller = controllerValue as unknown as {
	readonly name: string;
	readonly prototype: { readonly read: object };
};
const serviceToken = getCrudServiceToken(resource);

assert.equal(controller.name, "ConsumerItemsCrudController");
assert.equal(Reflect.getMetadata(PATH_METADATA, controller), "api/consumer-items");
assert.equal(Reflect.getMetadata(PATH_METADATA, controller.prototype.read), ":id");
assert.equal(Reflect.getMetadata(METHOD_METADATA, controller.prototype.read), RequestMethod.GET);
assert.equal(Reflect.getMetadata(HTTP_CODE_METADATA, controller.prototype.read), HttpStatus.OK);
assert.equal(Reflect.getMetadata(VERSION_METADATA, controller.prototype.read), "1");
assert.equal(Reflect.getMetadata("consumer:resource-decorator", controller), true);
assert.equal(Reflect.getMetadata("consumer:operation-decorator", controller.prototype.read), true);
assert.deepEqual(Reflect.getMetadata(PARAMTYPES_METADATA, controller.prototype, "read"), [
	Object,
	Object,
	Object,
]);

const injections: unknown = Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, controller);
assert.ok(Array.isArray(injections));
assert.equal(injections.length, 1);
assertInjection(injections[0], serviceToken);

const routeArguments: unknown = Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, "read");
assertRecord(routeArguments, "generated read route arguments");
assert.equal(Object.keys(routeArguments).length, 3);

const swaggerOperation: unknown = Reflect.getMetadata(
	"swagger/apiOperation",
	controller.prototype.read,
);
assertRecord(swaggerOperation, "generated Swagger operation");
assert.equal(swaggerOperation.operationId, "consumer-items_read");

@Module({
	imports: [StandardSchemaModule.forRoot(), CrudModule.forRoot(), feature],
})
class ConsumerSmokeModule {}

const application = await NestFactory.createApplicationContext(ConsumerSmokeModule, {
	logger: false,
});
try {
	const service: unknown = application.get(serviceToken);
	assertRecord(service, "injected CRUD service");
	assert.equal(service.resource, resource);
} finally {
	await application.close();
}

process.stdout.write("@nestm/crud-memory bootstrapped with packed Nest and decorator metadata.\n");

function assertInjection(value: unknown, token: unknown): void {
	assertRecord(value, "generated controller injection metadata");
	assert.equal(value.index, 0);
	assert.equal(value.param, token);
}

function assertRecord(
	value: unknown,
	description: string,
): asserts value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError(`Expected ${description} to be an object.`);
	}
}
