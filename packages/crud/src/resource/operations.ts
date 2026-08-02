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
] as const;

export type CrudOperationName = (typeof CRUD_OPERATION_NAMES)[number];

export interface CrudEnhancers {
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

export type CrudOperations = Partial<Record<CrudOperationName, CrudOperationOptions>>;

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
