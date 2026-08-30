import type { CrudSchemaSource } from "../schema/schema.types.ts";
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

export interface CrudSearchConfig<Field extends string = string> {
	readonly fields: readonly Field[];
	readonly minLength?: number;
	readonly maxLength?: number;
}

export interface CrudPaginationConfig {
	readonly offset?: boolean;
	readonly cursor?: boolean;
	readonly defaultLimit?: number;
	readonly maxLimit?: number;
}

type CrudFilterConfigMap<Field extends string> = string extends Field
	? Readonly<Record<string, CrudFilterFieldConfig>>
	: Readonly<Partial<Record<Field, CrudFilterFieldConfig>>>;

export interface CrudQueryConfig<Field extends string = string> {
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

export interface CrudPage<T> {
	readonly data: readonly T[];
	readonly meta: CrudPageMeta;
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
