import type {
	CanActivate,
	ExceptionFilter,
	NestInterceptor,
	PipeTransform,
	Type,
} from "@nestjs/common";

export const CRUD_OPERATION_NAMES = [
	"create",
	"list",
	"read",
	"update",
	"delete",
	"restore",
	"upsert",
] as const;

export type CrudOperationName = (typeof CRUD_OPERATION_NAMES)[number];

export interface CrudEnhancers {
	/** Opaque Nest decorators applied to the generated controller or handler. */
	readonly decorators?: readonly (ClassDecorator | MethodDecorator)[];
	readonly guards?: readonly Type<CanActivate>[];
	readonly interceptors?: readonly Type<NestInterceptor>[];
	readonly pipes?: readonly Type<PipeTransform>[];
	readonly filters?: readonly Type<ExceptionFilter>[];
}

export interface CrudOperationOptions extends CrudEnhancers {
	readonly summary?: string;
	readonly description?: string;
	readonly deprecated?: boolean;
}

export type CrudDeleteMissingBehavior = "not-found" | "ignore";

export interface CrudDeleteOperationOptions extends CrudOperationOptions {
	/** Behavior when no visible row matches the requested identity. Defaults to `not-found`. */
	readonly missing?: CrudDeleteMissingBehavior;
}

export type CrudOperationOptionsFor<Operation extends CrudOperationName> =
	Operation extends "delete" ? CrudDeleteOperationOptions : CrudOperationOptions;

export type CrudOperations = {
	[Operation in CrudOperationName]?: CrudOperationOptionsFor<Operation>;
};

function operationMap(names: readonly CrudOperationName[]): CrudOperations {
	return Object.fromEntries(names.map((name) => [name, {}])) as CrudOperations;
}

export const crudOperations = {
	all(options: CrudOperations = {}): CrudOperations {
		return {
			...operationMap(["create", "list", "read", "update", "delete"]),
			...options,
		};
	},
	readOnly(options: CrudOperations = {}): CrudOperations {
		return { ...operationMap(["list", "read"]), ...options };
	},
	only(...names: readonly CrudOperationName[]): CrudOperations {
		return operationMap(names);
	},
} as const;
