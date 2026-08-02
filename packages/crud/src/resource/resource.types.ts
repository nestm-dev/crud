import { VERSION_NEUTRAL, type InjectionToken, type Type } from "@nestjs/common";

import type {
	CrudLifecycleHook,
	CrudOperationContext,
	CrudScope,
} from "../runtime/runtime.types.ts";
import type { CrudQueryConfig } from "../query/query.types.ts";
import type { CrudRelationConfig } from "../relation/relation.types.ts";
import type { CrudSchemaSource, SchemaInput, SchemaOutput } from "../schema/schema.types.ts";
import type { CrudEnhancers, CrudOperations } from "./operations.ts";

export const CRUD_RESOURCE = Symbol.for("@nestm/crud:resource");

export type CrudVersion = string | typeof VERSION_NEUTRAL | Array<string | typeof VERSION_NEUTRAL>;

export interface CrudContracts<
	Id extends CrudSchemaSource = CrudSchemaSource,
	Create extends CrudSchemaSource = CrudSchemaSource,
	Update extends CrudSchemaSource = CrudSchemaSource,
	Response extends CrudSchemaSource = CrudSchemaSource,
> {
	readonly id: Id;
	readonly create: Create;
	readonly update: Update;
	readonly response: Response;
}

export interface CrudSoftDeleteConfig {
	readonly field: string;
	readonly allowQueryDeleted?: boolean;
	readonly queryDeletedEnhancers?: CrudEnhancers;
	readonly deleteValue?: (context: CrudOperationContext) => unknown;
	readonly restoreValue?: (context: CrudOperationContext) => unknown;
}

export interface CrudResourceDefinition<
	Name extends string = string,
	Path extends string = string,
	Id extends CrudSchemaSource = CrudSchemaSource,
	Create extends CrudSchemaSource = CrudSchemaSource,
	Update extends CrudSchemaSource = CrudSchemaSource,
	Response extends CrudSchemaSource = CrudSchemaSource,
	Relations extends Readonly<Record<string, CrudRelationConfig>> = Readonly<
		Record<string, CrudRelationConfig>
	>,
> {
	readonly name: Name;
	readonly path: Path;
	readonly itemPath: string;
	readonly idFields: Readonly<Record<string, string>>;
	readonly contracts: CrudContracts<Id, Create, Update, Response>;
	readonly operations: CrudOperations;
	readonly query?: CrudQueryConfig;
	readonly softDelete?: CrudSoftDeleteConfig;
	readonly relations?: Relations;
	readonly hooks?: readonly InjectionToken<CrudLifecycleHook>[];
	readonly scopes?: readonly InjectionToken<CrudScope>[];
	readonly enhancers?: CrudEnhancers;
	readonly tags?: readonly string[];
	readonly version?: CrudVersion;
}

export interface CrudResource<
	Name extends string = string,
	Path extends string = string,
	Id extends CrudSchemaSource = CrudSchemaSource,
	Create extends CrudSchemaSource = CrudSchemaSource,
	Update extends CrudSchemaSource = CrudSchemaSource,
	Response extends CrudSchemaSource = CrudSchemaSource,
	Relations extends Readonly<Record<string, CrudRelationConfig>> = Readonly<
		Record<string, CrudRelationConfig>
	>,
> extends CrudResourceDefinition<Name, Path, Id, Create, Update, Response, Relations> {
	readonly [CRUD_RESOURCE]: true;
}

/** Exact const-generic resource type returned by `defineCrudResource`. */
export type DefinedCrudResource<Definition extends CrudResourceDefinition> =
	Readonly<Definition> & {
		readonly [CRUD_RESOURCE]: true;
	};

type CrudResourceTypeError<Message extends string> = {
	/** @internal Compile-time diagnostic for an invalid literal resource definition. */
	readonly __crudResourceTypeError: Message;
};

type IsAny<Value> = 0 extends 1 & Value ? true : false;

type OptionalKeys<Value extends object> = {
	[Key in keyof Value]-?: object extends Pick<Value, Key> ? Key : never;
}[keyof Value];

type PathSegmentParameter<Segment extends string> = Segment extends `:${infer Parameter}`
	? Parameter
	: never;

type PathParameters<Path extends string> = string extends Path
	? string
	: Path extends `${infer Segment}/${infer Rest}`
		? PathSegmentParameter<Segment> | PathParameters<Rest>
		: PathSegmentParameter<Path>;

type SameKeys<Left, Right> = [Exclude<Left, Right>, Exclude<Right, Left>] extends [never, never]
	? true
	: false;

type CrudIdObjectConstraint<Definition extends CrudResourceDefinition, Output extends object> = [
	Output,
] extends [readonly unknown[]]
	? CrudResourceTypeError<"contracts.id must output a parameter object, not an array">
	: string extends keyof Output
		? CrudResourceTypeError<"contracts.id must output an object with finite parameter keys">
		: OptionalKeys<Output> extends never
			? SameKeys<keyof Output, keyof Definition["idFields"]> extends true
				? string extends Definition["itemPath"]
					? unknown
					: SameKeys<
								PathParameters<Definition["itemPath"]>,
								keyof Definition["idFields"]
						  > extends true
						? unknown
						: CrudResourceTypeError<"itemPath parameters must match idFields keys">
				: CrudResourceTypeError<"contracts.id output keys must match idFields keys">
			: CrudResourceTypeError<"contracts.id output parameters must all be required">;

/** Compile-time constraints applied to literal definitions by `defineCrudResource`. */
export type CrudResourceDefinitionConstraint<Definition extends CrudResourceDefinition> =
	SchemaOutput<Definition["contracts"]["id"]> extends infer Output
		? IsAny<Output> extends true
			? CrudResourceTypeError<"contracts.id output must be statically known">
			: unknown extends Output
				? string extends Definition["name"]
					? unknown
					: CrudResourceTypeError<"contracts.id output must be statically known">
				: [Output] extends [object]
					? CrudIdObjectConstraint<Definition, Extract<Output, object>>
					: CrudResourceTypeError<"contracts.id must output a parameter object">
		: never;

export type AnyCrudResource = CrudResource<
	string,
	string,
	CrudSchemaSource,
	CrudSchemaSource,
	CrudSchemaSource,
	CrudSchemaSource,
	Readonly<Record<string, CrudRelationConfig>>
>;

export type CrudId<Resource extends AnyCrudResource> = SchemaOutput<Resource["contracts"]["id"]>;
export type CrudCreate<Resource extends AnyCrudResource> = SchemaOutput<
	Resource["contracts"]["create"]
>;
export type CrudUpdate<Resource extends AnyCrudResource> = SchemaOutput<
	Resource["contracts"]["update"]
>;
export type CrudResponseInput<Resource extends AnyCrudResource> = SchemaInput<
	Resource["contracts"]["response"]
>;
export type CrudResponse<Resource extends AnyCrudResource> = SchemaOutput<
	Resource["contracts"]["response"]
>;

export type CrudHookType<Resource extends AnyCrudResource> = Type<CrudLifecycleHook<Resource>>;
export type CrudScopeType<Resource extends AnyCrudResource> = Type<CrudScope<Resource>>;

type TupleValue<Value> = Value extends readonly (infer Item extends string)[] ? Item : never;
type LiteralField<Value> = Value extends string ? (string extends Value ? never : Value) : never;
type RelationLocalFields<Resource extends AnyCrudResource> = Resource extends {
	readonly relations: infer Relations extends Readonly<Record<string, CrudRelationConfig>>;
}
	? {
			[Name in keyof Relations]: TupleValue<Relations[Name]["local"]>;
		}[keyof Relations]
	: never;

/** Logical fields the core itself must be able to read or query. */
export type CrudRequiredField<Resource extends AnyCrudResource> =
	| LiteralField<Extract<Resource["idFields"][keyof Resource["idFields"]], string>>
	| (Resource extends { readonly softDelete: { readonly field: infer Field extends string } }
			? LiteralField<Field>
			: never)
	| (Resource extends {
			readonly query: { readonly filters: infer Filters extends Readonly<Record<string, unknown>> };
	  }
			? LiteralField<Extract<keyof Filters, string>>
			: never)
	| (Resource extends {
			readonly query: { readonly sort: { readonly fields: infer Fields } };
	  }
			? LiteralField<TupleValue<Fields>>
			: never)
	| (Resource extends {
			readonly query: { readonly search: { readonly fields: infer Fields } };
	  }
			? LiteralField<TupleValue<Fields>>
			: never)
	| LiteralField<RelationLocalFields<Resource>>;
