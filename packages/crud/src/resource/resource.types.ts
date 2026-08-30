import { VERSION_NEUTRAL, type InjectionToken, type Type } from "@nestjs/common";

import type {
	CrudLifecycleHook,
	CrudMutationValidator,
	CrudOperationContext,
	CrudProjection,
	CrudScope,
} from "../runtime/runtime.types.ts";
import type { CrudQueryConfig } from "../query/query.types.ts";
import type { CrudRelationConfig } from "../relation/relation.types.ts";
import type { CrudSchemaSource, SchemaInput, SchemaOutput } from "../schema/schema.types.ts";
import type { CrudEnhancers, CrudOperations } from "./operations.ts";

export const CRUD_RESOURCE = Symbol.for("@nestm/crud:resource");

export type CrudVersion = string | typeof VERSION_NEUTRAL | Array<string | typeof VERSION_NEUTRAL>;
export type CrudFieldTuple<Field extends string = string> = readonly [Field, ...Field[]];

export interface CrudContracts<
	Id extends CrudSchemaSource = CrudSchemaSource,
	Create extends CrudSchemaSource = CrudSchemaSource,
	Update extends CrudSchemaSource = CrudSchemaSource,
	Response extends CrudSchemaSource = CrudSchemaSource,
	Upsert extends CrudSchemaSource = CrudSchemaSource,
> {
	readonly id: Id;
	readonly create: Create;
	readonly update: Update;
	readonly response: Response;
	readonly upsert?: Upsert;
}

export interface CrudPathParamsConfig<
	Contract extends CrudSchemaSource = CrudSchemaSource,
	Field extends string = string,
	Fields extends Readonly<Record<string, Field>> = Readonly<Record<string, Field>>,
> {
	readonly contract: Contract;
	readonly fields: Fields;
}

export interface CrudSoftDeleteConfig<Field extends string = string> {
	readonly field: Field;
	readonly allowQueryDeleted?: boolean;
	readonly queryDeletedEnhancers?: CrudEnhancers;
	readonly deleteValue?: (context: CrudOperationContext) => unknown;
	readonly restoreValue?: (context: CrudOperationContext) => unknown;
}

type CrudTypedRelations<
	Fields extends CrudFieldTuple,
	Relations extends Readonly<Record<string, CrudRelationConfig>>,
> = {
	readonly [Name in keyof Relations]: Relations[Name] extends {
		readonly target: () => infer Target extends AnyCrudResource;
	}
		? CrudRelationConfig<NoInfer<Fields[number]>, Target>
		: never;
};

export interface CrudResourceDefinition<
	Name extends string = string,
	Path extends string = string,
	Fields extends CrudFieldTuple = CrudFieldTuple,
	Id extends CrudSchemaSource = CrudSchemaSource,
	Create extends CrudSchemaSource = CrudSchemaSource,
	Update extends CrudSchemaSource = CrudSchemaSource,
	Response extends CrudSchemaSource = CrudSchemaSource,
	Relations extends Readonly<Record<string, CrudRelationConfig>> = Readonly<
		Record<string, CrudRelationConfig>
	>,
	PathParams extends CrudPathParamsConfig | undefined = CrudPathParamsConfig | undefined,
	Upsert extends CrudSchemaSource = CrudSchemaSource,
> {
	readonly name: Name;
	readonly path: Path;
	readonly itemPath: string;
	/** Complete logical field vocabulary used by this resource and its adapter binding. */
	readonly fields: Fields;
	readonly idFields: Readonly<Record<string, NoInfer<Fields[number]>>>;
	readonly pathParams?: PathParams & {
		readonly fields: Readonly<Record<string, NoInfer<Fields[number]>>>;
	};
	readonly contracts: CrudContracts<Id, Create, Update, Response, Upsert>;
	readonly operations: CrudOperations;
	readonly query?: CrudQueryConfig<NoInfer<Fields[number]>>;
	readonly softDelete?: CrudSoftDeleteConfig<NoInfer<Fields[number]>>;
	readonly relations?: Relations & CrudTypedRelations<Fields, Relations>;
	readonly hooks?: readonly InjectionToken<CrudLifecycleHook>[];
	/** Transaction-bound mutation validators, executed in declaration order after before hooks. */
	readonly validators?: readonly InjectionToken<CrudMutationValidator>[];
	readonly scopes?: readonly InjectionToken<CrudScope>[];
	/**
	 * Batch resolvers for response fields the adapter cannot select (see {@link CrudProjection}).
	 * Each runs once per page; their results are merged in declaration order, so a later
	 * projection overwrites an earlier one on key collision.
	 */
	readonly projections?: readonly InjectionToken<CrudProjection>[];
	readonly enhancers?: CrudEnhancers;
	readonly tags?: readonly string[];
	readonly version?: CrudVersion;
}

export interface CrudResource<
	Name extends string = string,
	Path extends string = string,
	Fields extends CrudFieldTuple = CrudFieldTuple,
	Id extends CrudSchemaSource = CrudSchemaSource,
	Create extends CrudSchemaSource = CrudSchemaSource,
	Update extends CrudSchemaSource = CrudSchemaSource,
	Response extends CrudSchemaSource = CrudSchemaSource,
	Relations extends Readonly<Record<string, CrudRelationConfig>> = Readonly<
		Record<string, CrudRelationConfig>
	>,
	PathParams extends CrudPathParamsConfig | undefined = CrudPathParamsConfig | undefined,
	Upsert extends CrudSchemaSource = CrudSchemaSource,
> extends CrudResourceDefinition<
	Name,
	Path,
	Fields,
	Id,
	Create,
	Update,
	Response,
	Relations,
	PathParams,
	Upsert
> {
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

type SameValue<Left, Right> = [Left, Right] extends [Right, Left] ? true : false;

type SameType<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
		? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
			? true
			: false
		: false;

type IdentifierStart =
	| "_"
	| "A"
	| "B"
	| "C"
	| "D"
	| "E"
	| "F"
	| "G"
	| "H"
	| "I"
	| "J"
	| "K"
	| "L"
	| "M"
	| "N"
	| "O"
	| "P"
	| "Q"
	| "R"
	| "S"
	| "T"
	| "U"
	| "V"
	| "W"
	| "X"
	| "Y"
	| "Z"
	| "a"
	| "b"
	| "c"
	| "d"
	| "e"
	| "f"
	| "g"
	| "h"
	| "i"
	| "j"
	| "k"
	| "l"
	| "m"
	| "n"
	| "o"
	| "p"
	| "q"
	| "r"
	| "s"
	| "t"
	| "u"
	| "v"
	| "w"
	| "x"
	| "y"
	| "z";

type IdentifierCharacter =
	IdentifierStart | "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

type IsIdentifierRest<Value extends string> = Value extends ""
	? true
	: Value extends `${infer Character}${infer Rest}`
		? Character extends IdentifierCharacter
			? IsIdentifierRest<Rest>
			: false
		: false;

type IsIdentifier<Value extends string> = Value extends `${infer First}${infer Rest}`
	? First extends IdentifierStart
		? IsIdentifierRest<Rest>
		: false
	: false;

type IsCanonicalPathSegment<Segment extends string> = Segment extends `:${infer Parameter}`
	? IsIdentifier<Parameter>
	: Segment extends `${string}:${string}` | `${string}*${string}`
		? false
		: true;

type IsCanonicalPath<Path extends string> = string extends Path
	? true
	: Path extends `${infer Segment}/${infer Rest}`
		? IsCanonicalPathSegment<Segment> extends true
			? IsCanonicalPath<Rest>
			: false
		: IsCanonicalPathSegment<Path>;

type PathParameterTuple<Path extends string> = string extends Path
	? readonly string[]
	: Path extends `${infer Segment}/${infer Rest}`
		? Segment extends `:${infer Parameter}`
			? readonly [Parameter, ...PathParameterTuple<Rest>]
			: PathParameterTuple<Rest>
		: Path extends `:${infer Parameter}`
			? readonly [Parameter]
			: readonly [];

type HasDuplicateValues<Values extends readonly unknown[], Seen = never> = Values extends readonly [
	infer Value,
	...infer Rest,
]
	? Value extends Seen
		? true
		: HasDuplicateValues<Rest, Seen | Value>
	: false;

type CrudFieldVocabularyConstraint<Definition extends CrudResourceDefinition> =
	HasDuplicateValues<Definition["fields"]> extends true
		? CrudResourceTypeError<"fields must contain unique logical field names">
		: unknown;

type CrudRelationTupleConstraint<Definition extends CrudResourceDefinition> = Definition extends {
	readonly relations: infer Relations extends Readonly<Record<string, CrudRelationConfig>>;
}
	? false extends {
			[
				Name in keyof Relations
			]: Relations[Name]["local"]["length"] extends Relations[Name]["foreign"]["length"]
				? Relations[Name]["foreign"]["length"] extends Relations[Name]["local"]["length"]
					? true
					: false
				: false;
		}[keyof Relations]
		? CrudResourceTypeError<"relation local and foreign tuples must have the same length">
		: unknown
	: unknown;

type MappedFieldTuple<
	Parameters extends readonly string[],
	Fields extends Readonly<Record<string, string>>,
> = Parameters extends readonly [infer Parameter extends string, ...infer Rest extends string[]]
	? readonly [Fields[Parameter & keyof Fields], ...MappedFieldTuple<Rest, Fields>]
	: readonly [];

type CrudIdObjectConstraint<Definition extends CrudResourceDefinition, Output extends object> = [
	Output,
] extends [readonly unknown[]]
	? CrudResourceTypeError<"contracts.id must output a parameter object, not an array">
	: string extends keyof Output
		? CrudResourceTypeError<"contracts.id must output an object with finite parameter keys">
		: OptionalKeys<Output> extends never
			? SameKeys<keyof Output, keyof Definition["idFields"]> extends true
				? unknown
				: CrudResourceTypeError<"contracts.id output keys must match idFields keys">
			: CrudResourceTypeError<"contracts.id output parameters must all be required">;

type CrudIdContractConstraint<Definition extends CrudResourceDefinition> =
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

type CrudRouteSyntaxConstraint<Definition extends CrudResourceDefinition> =
	IsCanonicalPath<Definition["path"]> extends true
		? IsCanonicalPath<Definition["itemPath"]> extends true
			? string extends Definition["path"]
				? unknown
				: HasDuplicateValues<PathParameterTuple<Definition["path"]>> extends true
					? CrudResourceTypeError<"path route parameters must be unique">
					: string extends Definition["itemPath"]
						? unknown
						: HasDuplicateValues<PathParameterTuple<Definition["itemPath"]>> extends true
							? CrudResourceTypeError<"itemPath route parameters must be unique">
							: Extract<
										PathParameters<Definition["path"]>,
										PathParameters<Definition["itemPath"]>
								  > extends never
								? SameKeys<
										PathParameters<Definition["path"]> | PathParameters<Definition["itemPath"]>,
										keyof Definition["idFields"]
									> extends true
									? unknown
									: CrudResourceTypeError<"full route parameters must match idFields keys">
								: CrudResourceTypeError<"path and itemPath parameters must be disjoint">
			: CrudResourceTypeError<"itemPath parameters must use canonical :identifier segments">
		: CrudResourceTypeError<"path parameters must use canonical :identifier segments">;

type CrudPathParamPresenceConstraint<Definition extends CrudResourceDefinition> =
	string extends Definition["path"]
		? unknown
		: PathParameters<Definition["path"]> extends never
			? Definition extends { readonly pathParams: CrudPathParamsConfig }
				? CrudResourceTypeError<"pathParams cannot be declared when path has no parameters">
				: unknown
			: Definition extends { readonly pathParams: CrudPathParamsConfig }
				? unknown
				: CrudResourceTypeError<"pathParams is required when path has parameters">;

type CrudPathParamTypesConstraint<
	Definition extends CrudResourceDefinition,
	Config extends CrudPathParamsConfig,
	Output extends object,
> =
	SchemaOutput<Definition["contracts"]["id"]> extends infer IdOutput
		? IsAny<IdOutput> extends true
			? unknown
			: unknown extends IdOutput
				? unknown
				: [IdOutput] extends [object]
					? false extends {
							[Parameter in keyof Config["fields"]]: Parameter extends keyof Output
								? Parameter extends keyof Extract<IdOutput, object>
									? SameType<Pick<Output, Parameter>, Pick<Extract<IdOutput, object>, Parameter>>
									: false
								: false;
						}[keyof Config["fields"]]
						? CrudResourceTypeError<"pathParams.contract output property types must match contracts.id">
						: unknown
					: unknown
		: never;

type CrudPathParamsObjectConstraint<
	Definition,
	Config extends CrudPathParamsConfig,
	Output extends object,
> = Definition extends CrudResourceDefinition
	? [Output] extends [readonly unknown[]]
		? CrudResourceTypeError<"pathParams.contract must output a parameter object, not an array">
		: string extends keyof Output
			? CrudResourceTypeError<"pathParams.contract must output an object with finite parameter keys">
			: OptionalKeys<Output> extends never
				? SameKeys<keyof Output, keyof Config["fields"]> extends true
					? string extends Definition["path"]
						? unknown
						: SameKeys<PathParameters<Definition["path"]>, keyof Config["fields"]> extends true
							? HasDuplicateValues<
									MappedFieldTuple<PathParameterTuple<Definition["path"]>, Config["fields"]>
								> extends true
								? CrudResourceTypeError<"pathParams.fields must map to unique fields">
								: false extends {
											[
												Parameter in keyof Config["fields"]
											]: Parameter extends keyof Definition["idFields"]
												? SameValue<Config["fields"][Parameter], Definition["idFields"][Parameter]>
												: false;
									  }[keyof Config["fields"]]
									? CrudResourceTypeError<"pathParams.fields must match parent idFields mappings">
									: CrudPathParamTypesConstraint<Definition, Config, Output>
							: CrudResourceTypeError<"path parameters must match pathParams.fields keys">
					: CrudResourceTypeError<"pathParams.contract output keys must match pathParams.fields keys">
				: CrudResourceTypeError<"pathParams.contract output parameters must all be required">
	: never;

type CrudPathParamsContractConstraint<Definition extends CrudResourceDefinition> =
	Definition extends { readonly pathParams: infer Config extends CrudPathParamsConfig }
		? SchemaOutput<Config["contract"]> extends infer Output
			? IsAny<Output> extends true
				? CrudResourceTypeError<"pathParams.contract output must be statically known">
				: unknown extends Output
					? string extends Definition["name"]
						? unknown
						: CrudResourceTypeError<"pathParams.contract output must be statically known">
					: [Output] extends [object]
						? CrudPathParamsObjectConstraint<Definition, Config, Extract<Output, object>>
						: CrudResourceTypeError<"pathParams.contract must output a parameter object">
			: never
		: unknown;

type CrudRelationFieldConstraint<Definition extends CrudResourceDefinition> = Definition extends {
	readonly relations: infer Relations extends Readonly<Record<string, CrudRelationConfig>>;
}
	? false extends {
			[Name in keyof Relations]: Relations[Name] extends {
				readonly local: readonly string[];
				readonly foreign: readonly string[];
				readonly target: () => infer Target extends AnyCrudResource;
			}
				? Exclude<Relations[Name]["local"][number], Definition["fields"][number]> extends never
					? [Target] extends [never]
						? true
						: Exclude<Relations[Name]["foreign"][number], Target["fields"][number]> extends never
							? true
							: false
					: false
				: false;
		}[keyof Relations]
		? CrudResourceTypeError<"relation keys must use fields declared by their source and target resources">
		: unknown
	: unknown;

type CrudSortExpressionField<Value> = Value extends `-${infer Field}` ? Field : Value;

type CrudSortSelectionConstraint<Definition extends CrudResourceDefinition> = Definition extends {
	readonly query: {
		readonly sort: infer Sort extends {
			readonly fields: readonly string[];
			readonly default?: readonly string[];
			readonly cursor?: readonly string[];
		};
	};
}
	? Exclude<
			| (Sort extends { readonly default: readonly (infer Item)[] }
					? CrudSortExpressionField<Item>
					: never)
			| (Sort extends { readonly cursor: readonly (infer Item)[] } ? Item : never),
			Sort["fields"][number]
		> extends never
		? unknown
		: CrudResourceTypeError<"sort.default and sort.cursor must use fields enabled by sort.fields">
	: unknown;

type CrudUpsertContractConstraint<Definition extends CrudResourceDefinition> =
	Definition["operations"] extends { readonly upsert: unknown }
		? Definition["contracts"] extends { readonly upsert: CrudSchemaSource }
			? unknown
			: CrudResourceTypeError<"operations.upsert requires contracts.upsert">
		: unknown;

/** Compile-time constraints applied to literal definitions by `defineCrudResource`. */
export type CrudResourceDefinitionConstraint<Definition extends CrudResourceDefinition> =
	CrudFieldVocabularyConstraint<Definition> &
		CrudIdContractConstraint<Definition> &
		CrudRouteSyntaxConstraint<Definition> &
		CrudPathParamPresenceConstraint<Definition> &
		CrudPathParamsContractConstraint<Definition> &
		CrudRelationFieldConstraint<Definition> &
		CrudRelationTupleConstraint<Definition> &
		CrudSortSelectionConstraint<Definition> &
		CrudUpsertContractConstraint<Definition>;

export type AnyCrudResource = CrudResource<
	string,
	string,
	CrudFieldTuple,
	CrudSchemaSource,
	CrudSchemaSource,
	CrudSchemaSource,
	CrudSchemaSource,
	Readonly<Record<string, CrudRelationConfig>>,
	CrudPathParamsConfig | undefined
>;

/** Complete logical field vocabulary declared by a concrete resource. */
export type CrudField<Resource extends AnyCrudResource> = Resource["fields"][number];
/** Logical values keyed only by fields declared on a concrete resource. */
export type CrudFieldValues<Resource extends AnyCrudResource> = Readonly<
	Partial<Record<CrudField<Resource>, unknown>>
>;

export type CrudId<Resource extends AnyCrudResource> = SchemaOutput<Resource["contracts"]["id"]>;
export type CrudPathParams<Resource extends AnyCrudResource> = [Resource] extends [
	{
		readonly path: infer Path extends string;
	},
]
	? string extends Path
		? Readonly<Record<string, unknown>>
		: PathParameters<Path> extends never
			? never
			: [Resource] extends [
						{
							readonly pathParams: {
								readonly contract: infer Contract extends CrudSchemaSource;
							};
						},
				  ]
				? SchemaOutput<Contract>
				: Readonly<Record<string, unknown>>
	: Readonly<Record<string, unknown>>;
export type CrudCreate<Resource extends AnyCrudResource> = SchemaOutput<
	Resource["contracts"]["create"]
>;
export type CrudUpdate<Resource extends AnyCrudResource> = SchemaOutput<
	Resource["contracts"]["update"]
>;
type HasPossibleCrudUpsert<Resource extends AnyCrudResource> = Resource extends Resource
	? "upsert" extends keyof Resource["contracts"]
		? true
		: false
	: never;
export type CrudUpsert<Resource extends AnyCrudResource> = [Resource] extends [
	{ readonly contracts: { readonly upsert: infer Upsert extends CrudSchemaSource } },
]
	? SchemaOutput<Upsert>
	: string extends Resource["name"]
		? never
		: true extends HasPossibleCrudUpsert<Resource>
			? unknown
			: never;
export type CrudResponseInput<Resource extends AnyCrudResource> = SchemaInput<
	Resource["contracts"]["response"]
>;
export type CrudResponse<Resource extends AnyCrudResource> = SchemaOutput<
	Resource["contracts"]["response"]
>;

export type CrudHookType<Resource extends AnyCrudResource> = Type<CrudLifecycleHook<Resource>>;
export type CrudValidatorType<Resource extends AnyCrudResource> = Type<
	CrudMutationValidator<Resource>
>;
export type CrudScopeType<Resource extends AnyCrudResource> = Type<CrudScope<Resource>>;

/** Complete logical fields accepted by the core for this resource. */
export type CrudRequiredField<Resource extends AnyCrudResource> = CrudField<Resource>;

/** Relation names accepted by `include` for a concrete resource. */
export type CrudRelationName<Resource extends AnyCrudResource> = Resource extends {
	readonly relations: infer Relations extends Readonly<Record<string, CrudRelationConfig>>;
}
	? string extends keyof Relations
		? string
		: Extract<keyof Relations, string>
	: never;
