import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	HttpStatus,
	Inject,
	Param,
	Patch,
	Post,
	Put,
	Query,
	SerializeOptions,
	UseFilters,
	UseGuards,
	UseInterceptors,
	UsePipes,
	Version,
	BadRequestException,
	type ExecutionContext,
	type Type,
} from "@nestjs/common";
import { PARAMTYPES_METADATA } from "@nestjs/common/constants";
import { ApiExtension, ApiOperation, ApiQuery, ApiResponse, ApiTags } from "@nestjs/swagger";

import { getCrudServiceToken } from "../module/crud.tokens.ts";
import { resolveCrudPaginationModes } from "../query/pagination.ts";
import type { CrudRawQuery } from "../query/query.types.ts";
import type {
	AnyCrudResource,
	CrudCreate,
	CrudId,
	CrudPathParams,
	CrudRelationName,
	CrudUpdate,
	CrudUpsert,
} from "../resource/resource.types.ts";
import type {
	CrudEnhancers,
	CrudOperationName,
	CrudOperationOptions,
	CrudDeleteOperationOptions,
} from "../resource/operations.ts";
import type { CrudService } from "../runtime/crud.service.ts";
import type { CrudCollectionArgs } from "../runtime/runtime.types.ts";
import { createCrudPageSchema } from "../schema/page-schema.ts";
import { getCrudSchema } from "../schema/schema.types.ts";
import {
	CRUD_QUERY_OPENAPI_EXTENSION,
	createCrudQueryOpenApiExtension,
} from "../swagger-ui/query-extension.ts";
import { CrudContext } from "./crud-context.decorator.ts";
import {
	createNestErrorResponseSchema,
	type CrudSwaggerErrorStatus,
} from "./swagger-error-response.ts";

type CrudController = Type<object>;

const OPERATION_STATUS: Readonly<Record<CrudOperationName, number>> = {
	create: HttpStatus.CREATED,
	list: HttpStatus.OK,
	read: HttpStatus.OK,
	update: HttpStatus.OK,
	delete: HttpStatus.NO_CONTENT,
	restore: HttpStatus.OK,
	upsert: HttpStatus.OK,
};

export function createCrudController<Resource extends AnyCrudResource>(
	resource: Resource,
): CrudController {
	class GeneratedCrudController {
		constructor(readonly service: CrudService<Resource>) {}

		create(
			input: CrudCreate<Resource>,
			pathParamsOrContext: CrudPathParams<Resource> | ExecutionContext,
			context?: ExecutionContext,
		) {
			return this.service.create(
				input,
				...collectionArguments(resource, pathParamsOrContext, context),
			);
		}

		list(
			query: CrudRawQuery,
			pathParamsOrContext: CrudPathParams<Resource> | ExecutionContext,
			context?: ExecutionContext,
		) {
			return this.service.list(
				query,
				...collectionArguments(resource, pathParamsOrContext, context),
			);
		}

		read(id: CrudId<Resource>, query: CrudRawQuery, context: ExecutionContext) {
			return this.service.read(id, context, readIncludes(resource, query));
		}

		update(id: CrudId<Resource>, input: CrudUpdate<Resource>, context: ExecutionContext) {
			return this.service.update(id, input, context);
		}

		upsert(id: CrudId<Resource>, input: CrudUpsert<Resource>, context: ExecutionContext) {
			return this.service.upsert(id, input, context);
		}

		delete(id: CrudId<Resource>, context: ExecutionContext) {
			return this.service.delete(id, context);
		}

		restore(id: CrudId<Resource>, context: ExecutionContext) {
			return this.service.restore(id, context);
		}
	}

	Object.defineProperty(GeneratedCrudController, "name", {
		value: getCrudControllerName(resource),
		configurable: true,
	});
	Inject(getCrudServiceToken(resource))(GeneratedCrudController, undefined, 0);
	Controller(normalizeControllerPath(resource.path))(GeneratedCrudController);
	ApiTags(...(resource.tags ?? [resource.name]))(GeneratedCrudController);
	applyEnhancers(GeneratedCrudController, resource.enhancers);

	for (const operation of Object.keys(resource.operations) as CrudOperationName[]) {
		decorateOperation(
			GeneratedCrudController,
			resource,
			operation,
			resource.operations[operation]!,
		);
	}
	return GeneratedCrudController;
}

export function getCrudControllerName(resource: AnyCrudResource): string {
	const normalized = resource.name
		.normalize("NFKD")
		.replaceAll(/[^A-Za-z0-9]+/g, " ")
		.trim()
		.split(/\s+/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");
	return `${normalized || "Anonymous"}CrudController`;
}

function decorateOperation(
	controller: CrudController,
	resource: AnyCrudResource,
	operation: CrudOperationName,
	options: CrudOperationOptions | CrudDeleteOperationOptions,
): void {
	const descriptor = Object.getOwnPropertyDescriptor(controller.prototype, operation);
	if (descriptor === undefined)
		throw new TypeError(`Missing generated CRUD handler "${operation}".`);
	Reflect.defineMetadata(
		PARAMTYPES_METADATA,
		Array.from({ length: parameterCount(resource, operation) }, () => Object),
		controller.prototype,
		operation,
	);
	const path = operationPath(resource, operation);
	const routeDecorator =
		operation === "create"
			? Post(path)
			: operation === "list"
				? Get(path)
				: operation === "read"
					? Get(path)
					: operation === "update"
						? Patch(path)
						: operation === "upsert"
							? Put(path)
							: operation === "delete"
								? Delete(path)
								: Post(path);
	applyMethod(routeDecorator, controller, operation, descriptor);
	applyMethod(HttpCode(OPERATION_STATUS[operation]), controller, operation, descriptor);
	if (resource.version !== undefined) {
		applyMethod(Version(resource.version), controller, operation, descriptor);
	}
	applyMethod(
		ApiOperation({
			operationId: `${resource.name}_${operation}`,
			summary: options.summary ?? defaultSummary(resource.name, operation),
			...(options.description === undefined ? {} : { description: options.description }),
			...(options.deprecated === undefined ? {} : { deprecated: options.deprecated }),
		}),
		controller,
		operation,
		descriptor,
	);

	decorateParameters(controller, resource, operation);
	decorateResponse(controller, resource, operation, options, descriptor);
	decorateSwaggerQueries(controller, resource, operation, descriptor);
	if (operation === "list") {
		applyEnhancers(
			controller.prototype,
			resource.softDelete?.queryDeletedEnhancers,
			operation,
			descriptor,
		);
	}
	applyEnhancers(controller.prototype, options, operation, descriptor);
}

function parameterCount(resource: AnyCrudResource, operation: CrudOperationName): number {
	if ((operation === "create" || operation === "list") && resource.pathParams !== undefined) {
		return 3;
	}
	if (operation === "read" || operation === "update" || operation === "upsert") return 3;
	return 2;
}

function decorateParameters(
	controller: CrudController,
	resource: AnyCrudResource,
	operation: CrudOperationName,
): void {
	const prototype = controller.prototype;
	if (operation === "create") {
		Body({ schema: getCrudSchema(resource.contracts.create) })(prototype, operation, 0);
		if (resource.pathParams === undefined) {
			CrudContext()(prototype, operation, 1);
		} else {
			Param({ schema: getCrudSchema(resource.pathParams.contract) })(prototype, operation, 1);
			CrudContext()(prototype, operation, 2);
		}
		return;
	}
	if (operation === "list") {
		Query()(prototype, operation, 0);
		if (resource.pathParams === undefined) {
			CrudContext()(prototype, operation, 1);
		} else {
			Param({ schema: getCrudSchema(resource.pathParams.contract) })(prototype, operation, 1);
			CrudContext()(prototype, operation, 2);
		}
		return;
	}
	Param({ schema: getCrudSchema(resource.contracts.id) })(prototype, operation, 0);
	if (operation === "read") {
		Query()(prototype, operation, 1);
		CrudContext()(prototype, operation, 2);
		return;
	}
	if (operation === "update" || operation === "upsert") {
		const contract =
			operation === "update" ? resource.contracts.update : resource.contracts.upsert!;
		Body({ schema: getCrudSchema(contract) })(prototype, operation, 1);
		CrudContext()(prototype, operation, 2);
		return;
	}
	CrudContext()(prototype, operation, 1);
}

function decorateResponse(
	controller: CrudController,
	resource: AnyCrudResource,
	operation: CrudOperationName,
	options: CrudOperationOptions | CrudDeleteOperationOptions,
	descriptor: PropertyDescriptor,
): void {
	const responseSchema =
		operation === "list"
			? createCrudPageSchema(
					resource.contracts.response,
					resolveCrudPaginationModes(resource.query?.pagination),
				)
			: getCrudSchema(resource.contracts.response);
	if (operation !== "delete") {
		applyMethod(SerializeOptions({ schema: responseSchema }), controller, operation, descriptor);
		applyMethod(
			ApiResponse({
				status: OPERATION_STATUS[operation],
				description: "Successful response.",
				standardSchema: responseSchema,
			}),
			controller,
			operation,
			descriptor,
		);
	} else {
		applyMethod(
			ApiResponse({ status: HttpStatus.NO_CONTENT, description: "Resource deleted." }),
			controller,
			operation,
			descriptor,
		);
	}
	for (const [status, description] of errorResponses(
		operation,
		Object.keys(resource.relations ?? {}).length > 0,
		operation === "delete" && "missing" in options && options.missing === "ignore",
	)) {
		applyMethod(
			ApiResponse({ status, description, schema: createNestErrorResponseSchema(status) }),
			controller,
			operation,
			descriptor,
		);
	}
}

function decorateSwaggerQueries(
	controller: CrudController,
	resource: AnyCrudResource,
	operation: CrudOperationName,
	descriptor: PropertyDescriptor,
): void {
	if (operation === "read" && Object.keys(resource.relations ?? {}).length > 0) {
		applyMethod(
			ApiQuery({ name: "include", required: false, type: String }),
			controller,
			operation,
			descriptor,
		);
	}
	if (operation !== "list") return;
	const extension = createCrudQueryOpenApiExtension(resource);
	if (extension !== undefined) {
		applyMethod(
			ApiExtension(CRUD_QUERY_OPENAPI_EXTENSION, extension),
			controller,
			operation,
			descriptor,
		);
	}
	const stringNames: string[] = [];
	for (const [field, config] of Object.entries(resource.query?.filters ?? {})) {
		for (const operator of config.operators) stringNames.push(`filter[${field}][${operator}]`);
	}
	if ((resource.query?.sort?.fields.length ?? 0) > 0) stringNames.push("sort");
	if ((resource.query?.search?.fields.length ?? 0) > 0) stringNames.push("search");
	if (Object.keys(resource.relations ?? {}).length > 0) stringNames.push("include");
	const modes = resolveCrudPaginationModes(resource.query?.pagination);
	if (modes.cursor) stringNames.push("after");
	for (const name of stringNames) {
		applyMethod(
			ApiQuery({ name, required: false, type: String }),
			controller,
			operation,
			descriptor,
		);
	}
	if (resource.softDelete?.allowQueryDeleted === true) {
		applyMethod(
			ApiQuery({
				name: "deleted",
				required: false,
				schema: { type: "string", enum: ["include", "only"] },
			}),
			controller,
			operation,
			descriptor,
		);
	}
	const maximum = resource.query?.pagination?.maxLimit;
	if (modes.offset) {
		applyMethod(
			ApiQuery({ name: "page", required: false, schema: { type: "integer", minimum: 1 } }),
			controller,
			operation,
			descriptor,
		);
	}
	if (modes.offset || modes.cursor) {
		applyMethod(
			ApiQuery({
				name: "limit",
				required: false,
				schema: {
					type: "integer",
					minimum: 1,
					...(maximum === undefined ? {} : { maximum }),
				},
			}),
			controller,
			operation,
			descriptor,
		);
	}
}

function applyEnhancers(
	target: CrudController | object,
	enhancers: CrudEnhancers | undefined,
	propertyKey?: string,
	descriptor?: PropertyDescriptor,
): void {
	if (enhancers === undefined) return;
	const apply = (decorator: ClassDecorator | MethodDecorator): void => {
		if (propertyKey === undefined || descriptor === undefined) {
			(decorator as ClassDecorator)(target as CrudController);
		} else {
			(decorator as MethodDecorator)(target, propertyKey, descriptor);
		}
	};
	for (const decorator of enhancers.decorators ?? []) apply(decorator);
	if ((enhancers.guards?.length ?? 0) > 0) apply(UseGuards(...enhancers.guards!));
	if ((enhancers.interceptors?.length ?? 0) > 0) apply(UseInterceptors(...enhancers.interceptors!));
	if ((enhancers.pipes?.length ?? 0) > 0) apply(UsePipes(...enhancers.pipes!));
	if ((enhancers.filters?.length ?? 0) > 0) apply(UseFilters(...enhancers.filters!));
}

function applyMethod(
	decorator: MethodDecorator,
	controller: CrudController,
	operation: string,
	descriptor: PropertyDescriptor,
): void {
	decorator(controller.prototype, operation, descriptor);
}

function operationPath(resource: AnyCrudResource, operation: CrudOperationName): string {
	if (operation === "create" || operation === "list") return "";
	return operation === "restore" ? `${resource.itemPath}/restore` : resource.itemPath;
}

function normalizeControllerPath(path: string): string {
	return path.replace(/^\/+|\/+$/g, "");
}

function defaultSummary(resource: string, operation: CrudOperationName): string {
	const verbs: Readonly<Record<CrudOperationName, string>> = {
		create: "Create",
		list: "List",
		read: "Read",
		update: "Update",
		delete: "Delete",
		restore: "Restore",
		upsert: "Upsert",
	};
	return `${verbs[operation]} ${resource}`;
}

function errorResponses(
	operation: CrudOperationName,
	hasRelations: boolean,
	ignoresMissingDelete: boolean,
): readonly (readonly [CrudSwaggerErrorStatus, string])[] {
	const responses: [CrudSwaggerErrorStatus, string][] = [
		[HttpStatus.BAD_REQUEST, "Invalid request."],
	];
	if (!["create", "list"].includes(operation) && !ignoresMissingDelete) {
		responses.push([HttpStatus.NOT_FOUND, "Resource not found."]);
	}
	if (["create", "update", "delete", "restore", "upsert"].includes(operation)) {
		responses.push([HttpStatus.CONFLICT, "Resource conflict."]);
	}
	if (hasRelations && (operation === "list" || operation === "read")) {
		responses.push([HttpStatus.UNPROCESSABLE_ENTITY, "Included relation exceeds its bound."]);
	}
	responses.push([HttpStatus.INTERNAL_SERVER_ERROR, "Internal persistence or hook failure."]);
	return responses;
}

function collectionArguments<Resource extends AnyCrudResource>(
	resource: Resource,
	pathParamsOrContext: CrudPathParams<Resource> | ExecutionContext,
	executionContext: ExecutionContext | undefined,
): CrudCollectionArgs<Resource> {
	const args =
		resource.pathParams === undefined
			? ([pathParamsOrContext] as const)
			: ([pathParamsOrContext as CrudPathParams<Resource>, executionContext] as const);
	return args as unknown as CrudCollectionArgs<Resource>;
}

function readIncludes<Resource extends AnyCrudResource>(
	resource: Resource,
	query: CrudRawQuery,
): readonly CrudRelationName<Resource>[] {
	let raw: unknown;
	if (query instanceof URLSearchParams) {
		for (const key of query.keys()) {
			if (key !== "include") {
				throw new BadRequestException(`Unknown query parameter "${key}".`);
			}
		}
		const values = query.getAll("include");
		if (values.length > 1) {
			throw new BadRequestException('Query parameter "include" cannot be repeated.');
		}
		raw = values[0];
	} else {
		for (const key of Object.keys(query)) {
			if (key !== "include") {
				throw new BadRequestException(`Unknown query parameter "${key}".`);
			}
		}
		raw = query.include;
	}
	if (raw === undefined || raw === null || raw === "") return [];
	if (typeof raw !== "string")
		throw new BadRequestException("The include query parameter must be a string.");
	const includes = raw.split(",").map((value) => value.trim());
	const allowed = new Set(Object.keys(resource.relations ?? {}));
	if (includes.some((value) => value === "" || !allowed.has(value))) {
		throw new BadRequestException("The include query parameter contains an unknown relation.");
	}
	if (new Set(includes).size !== includes.length) {
		throw new BadRequestException("The include query parameter contains a repeated relation.");
	}
	return includes as unknown as readonly CrudRelationName<Resource>[];
}
