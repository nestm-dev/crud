import type { CrudSchemaSource } from "../schema/schema.types.ts";
import type { CrudCursorCodec } from "../cursor/cursor.types.ts";

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

export interface CrudSortConfig {
	readonly fields: readonly string[];
	readonly default?: readonly string[];
	readonly cursor?: readonly string[];
}

export interface CrudSearchConfig {
	readonly fields: readonly string[];
	readonly minLength?: number;
	readonly maxLength?: number;
}

export interface CrudPaginationConfig {
	readonly offset?: boolean;
	readonly cursor?: boolean;
	readonly defaultLimit?: number;
	readonly maxLimit?: number;
}

export interface CrudQueryConfig {
	readonly filters?: Readonly<Record<string, CrudFilterFieldConfig>>;
	readonly sort?: CrudSortConfig;
	readonly search?: CrudSearchConfig;
	readonly pagination?: CrudPaginationConfig;
}

export type CrudPredicate =
	| {
			readonly kind: "comparison";
			readonly field: string;
			readonly operator: CrudFilterOperator;
			readonly value: unknown;
	  }
	| { readonly kind: "and"; readonly predicates: readonly CrudPredicate[] }
	| { readonly kind: "or"; readonly predicates: readonly CrudPredicate[] }
	| { readonly kind: "not"; readonly predicate: CrudPredicate };

export interface CrudOrder {
	readonly field: string;
	readonly direction: CrudSortDirection;
}

export interface CrudOffsetQuery {
	readonly mode: "offset";
	readonly page: number;
	readonly limit: number;
	readonly predicate?: CrudPredicate;
	readonly order: readonly CrudOrder[];
	readonly search?: string;
	readonly includes: readonly string[];
	readonly deleted: "exclude" | "include" | "only";
}

export interface CrudCursorQuery {
	readonly mode: "cursor";
	readonly after?: string;
	readonly limit: number;
	readonly predicate?: CrudPredicate;
	readonly order: readonly CrudOrder[];
	readonly search?: string;
	readonly includes: readonly string[];
	readonly deleted: "exclude" | "include" | "only";
}

export type CrudListQuery = CrudOffsetQuery | CrudCursorQuery;

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

export interface CrudQueryParserOptions {
	/** Codec used to verify and decode an `after` cursor. */
	readonly cursorCodec?: CrudCursorCodec;
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
