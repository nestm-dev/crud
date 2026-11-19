import type { CrudSchemaSource, SchemaInput } from "../schema/schema.types.ts";
import type { CrudCursorCodec, CrudCursorFixedValue } from "../cursor/cursor.types.ts";

export const CRUD_FILTER_OPERATORS = [
	"eq",
	"ne",
	"gt",
	"gte",
	"lt",
	"lte",
	"in",
	"nin",
	"contains",
	"icontains",
	"isnull",
	"between",
] as const;

export type CrudFilterOperator = (typeof CRUD_FILTER_OPERATORS)[number];

export type CrudSortDirection = "asc" | "desc";

export interface CrudFilterFieldConfig<Source extends CrudSchemaSource = CrudSchemaSource> {
	readonly schema: Source;
	readonly operators: readonly CrudFilterOperator[];
}

export type CrudSortExpression<Field extends string = string> = Field | `-${Field}`;

export interface CrudSortConfig<Field extends string = string> {
	readonly fields: readonly Field[];
	readonly default?: readonly CrudSortExpression<Field>[];
	readonly cursor?: readonly Field[];
}

export type CrudFullTextWeight = "A" | "B" | "C" | "D";

/** Server-owned full-text policy; clients supply only the search text. */
export interface CrudFullTextSearchOptions<Field extends string = string> {
	readonly configuration?: string;
	readonly weights?: Readonly<Partial<Record<Field, CrudFullTextWeight>>>;
	readonly queryMode?: "plain" | "websearch" | "prefix";
	/** Rank this field's matches before matches confined to other fields. */
	readonly primaryField?: Field;
}

export interface CrudFullTextSearchInput<
	Field extends string = string,
> extends CrudFullTextSearchOptions<Field> {
	readonly fields: readonly Field[];
	readonly query: string;
}

export interface CrudSearchConfig<Field extends string = string> {
	readonly fields: readonly Field[];
	readonly fullText?: CrudFullTextSearchOptions<Field>;
	readonly minLength?: number;
	readonly maxLength?: number;
}

/**
 * Public names of the bracket grammar's pagination query parameters.
 * Only the bracket grammar reads them; a `query.schema` contract names its own parameters.
 */
export interface CrudPaginationParameterNames {
	/** Offset page number. @default "page" */
	readonly page?: string;
	/** Page size for both pagination modes. @default "limit" */
	readonly limit?: string;
	/** Opaque keyset cursor. @default "after" */
	readonly after?: string;
}

/**
 * Replaces the canonical page `meta` object with an application-defined shape.
 *
 * `format` maps the canonical meta to the public one; `schema` describes the public one. The
 * page response schema validates and documents `meta` with `schema`, so OpenAPI and the
 * serializer always agree with what `format` returns.
 */
export interface CrudPageMetaFormatter<
	Canonical extends CrudPageMeta = CrudPageMeta,
	Source extends CrudSchemaSource = CrudSchemaSource,
> {
	readonly schema: Source;
	readonly format: (meta: Canonical) => SchemaInput<Source>;
}

export interface CrudPageMetaFormatters {
	readonly offset?: CrudPageMetaFormatter<CrudOffsetMeta>;
	readonly cursor?: CrudPageMetaFormatter<CrudCursorMeta>;
}

export interface CrudPaginationConfig {
	readonly offset?: boolean;
	readonly cursor?: boolean;
	readonly defaultLimit?: number;
	readonly maxLimit?: number;
	/** Renames the bracket grammar's `page`, `limit`, and `after` query parameters. */
	readonly parameters?: CrudPaginationParameterNames;
	/** Per-mode formatters replacing the canonical page `meta` object. */
	readonly meta?: CrudPageMetaFormatters;
}

type CrudFilterConfigMap<Field extends string> = string extends Field
	? Readonly<Record<string, CrudFilterFieldConfig>>
	: Readonly<Partial<Record<Field, CrudFilterFieldConfig>>>;

export interface CrudQueryConfig<Field extends string = string> {
	/**
	 * Standard Schema for the complete list query object. Supplying it replaces the bracket
	 * grammar (`filter[field][op]=value`, `sort`, `page`/`limit`/`after`) for this resource:
	 * generated controllers bind it with `@Query({ schema })`, so Nest validates the query and
	 * Swagger documents each property, and `toListQuery` turns the parsed value into the AST.
	 * Without it the resource keeps the bracket grammar.
	 */
	readonly schema?: CrudSchemaSource;
	/**
	 * Maps the parsed `schema` output to a list request. Required with `schema`.
	 * Annotate `parsed` with the schema's output type.
	 */
	readonly toListQuery?: (parsed: never) => CrudListRequest<Field>;
	/** Bracket grammar only: filterable fields and operators. */
	readonly filters?: CrudFilterConfigMap<Field>;
	readonly sort?: CrudSortConfig<Field>;
	readonly search?: CrudSearchConfig<Field>;
	readonly pagination?: CrudPaginationConfig;
}

export type CrudPredicate<Field extends string = string> =
	| {
			readonly kind: "comparison";
			readonly field: Field;
			readonly operator: CrudFilterOperator;
			readonly value: unknown;
	  }
	| { readonly kind: "and"; readonly predicates: readonly CrudPredicate<Field>[] }
	| { readonly kind: "or"; readonly predicates: readonly CrudPredicate<Field>[] }
	| { readonly kind: "not"; readonly predicate: CrudPredicate<Field> };

export interface CrudOrder<Field extends string = string> {
	readonly field: Field;
	readonly direction: CrudSortDirection;
}

export interface CrudOffsetQuery<Field extends string = string, Include extends string = string> {
	readonly mode: "offset";
	readonly page: number;
	readonly limit: number;
	readonly predicate?: CrudPredicate<Field>;
	readonly order: readonly CrudOrder<Field>[];
	readonly search?: string;
	readonly includes: readonly Include[];
	readonly deleted: "exclude" | "include" | "only";
}

export interface CrudCursorQuery<Field extends string = string, Include extends string = string> {
	readonly mode: "cursor";
	readonly after?: string;
	readonly limit: number;
	readonly predicate?: CrudPredicate<Field>;
	readonly order: readonly CrudOrder<Field>[];
	readonly search?: string;
	readonly includes: readonly Include[];
	readonly deleted: "exclude" | "include" | "only";
}

export type CrudListQuery<Field extends string = string, Include extends string = string> =
	CrudOffsetQuery<Field, Include> | CrudCursorQuery<Field, Include>;

// Optional members accept `undefined` so mappers can pass `andCrudPredicates(...)` and
// optional schema output straight through under `exactOptionalPropertyTypes`.
interface CrudListRequestBase<Field extends string, Include extends string> {
	/** Filter AST. CRUD ANDs it with path, scope, and soft-delete predicates. */
	readonly predicate?: CrudPredicate<Field> | undefined;
	/**
	 * Requested ordering. CRUD appends every ID field as a tie-breaker. Defaults to
	 * `query.sort.default` (and `query.sort.cursor` in cursor mode).
	 */
	readonly order?: readonly CrudOrder<Field>[] | undefined;
	/** Text search over `query.search.fields`, using the resource's search policy. */
	readonly search?: string | undefined;
	readonly includes?: readonly Include[] | undefined;
	readonly deleted?: "exclude" | "include" | "only" | undefined;
}

/** Offset page of a parser-independent list request. */
export interface CrudOffsetListRequest<
	Field extends string = string,
	Include extends string = string,
> extends CrudListRequestBase<Field, Include> {
	readonly mode: "offset";
	/** One-based page number. */
	readonly page: number;
	/** Page size; defaults to `query.pagination.defaultLimit`. Bounded by `maxLimit`. */
	readonly limit?: number | undefined;
}

/** Keyset page of a parser-independent list request. */
export interface CrudCursorListRequest<
	Field extends string = string,
	Include extends string = string,
> extends CrudListRequestBase<Field, Include> {
	readonly mode: "cursor";
	/** Opaque cursor returned as `nextCursor` by the previous page; absent for the first page. */
	readonly after?: string | null | undefined;
	/** Page size; defaults to `query.pagination.defaultLimit`. Bounded by `maxLimit`. */
	readonly limit?: number | undefined;
}

/**
 * Parser-independent list request accepted by `CrudService.listQuery()` and returned by a
 * resource's `query.toListQuery`. CRUD validates it against the resource policy (declared
 * fields, sort whitelist, pagination bounds, includes, soft-delete visibility) before it runs.
 */
export type CrudListRequest<Field extends string = string, Include extends string = string> =
	CrudOffsetListRequest<Field, Include> | CrudCursorListRequest<Field, Include>;

export interface CrudOffsetMeta {
	readonly mode: "offset";
	readonly page: number;
	readonly limit: number;
	readonly total: number;
	readonly totalPages: number;
	readonly hasNextPage: boolean;
	readonly hasPreviousPage: boolean;
}

export interface CrudCursorMeta {
	readonly mode: "cursor";
	readonly limit: number;
	readonly nextCursor: string | null;
	readonly hasNextPage: boolean;
}

export type CrudPageMeta = CrudOffsetMeta | CrudCursorMeta;

export interface CrudPage<T, Meta = CrudPageMeta> {
	readonly data: readonly T[];
	readonly meta: Meta;
}

export type CrudRawQuery = URLSearchParams | Readonly<Record<string, unknown>>;

export interface CrudQueryParserOptions<Field extends string = string> {
	/** Codec used to verify and decode an `after` cursor. */
	readonly cursorCodec?: CrudCursorCodec;
	/** Route-owned values that bind a cursor to one nested collection. */
	readonly cursorFixedValues?: readonly CrudCursorFixedValue<Field>[];
	/** Used when a resource does not configure a default limit. */
	readonly defaultLimit?: number;
	/** Used when a resource does not configure a maximum limit. */
	readonly maxLimit?: number;
}

export const CRUD_QUERY_ERROR_CODES = [
	"unknown_parameter",
	"invalid_parameter",
	"duplicate_parameter",
	"unknown_filter_field",
	"unknown_filter_operator",
	"invalid_filter_value",
	"unknown_sort_field",
	"invalid_pagination",
	"unknown_include",
	"deleted_query_forbidden",
	"cursor_codec_required",
	"invalid_cursor",
] as const;

export type CrudQueryErrorCode = (typeof CRUD_QUERY_ERROR_CODES)[number];
