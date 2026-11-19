import { buildCrudCursorPredicate } from "../cursor/cursor-predicate.ts";
import { decodeCrudCursor } from "../cursor/cursor.ts";
import { CrudCursorError } from "../cursor/cursor.error.ts";
import type {
	AnyCrudResource,
	CrudField,
	CrudRelationName,
	CrudRequiredField,
} from "../resource/resource.types.ts";
import { CrudSchemaValidationError, parseCrudSchema } from "../schema/schema.types.ts";
import { resolveCrudPaginationModes } from "./pagination.ts";
import { andCrudPredicates } from "./predicate.ts";
import { CrudQueryValidationError } from "./query.error.ts";
import {
	CRUD_FILTER_OPERATORS,
	type CrudListQuery,
	type CrudListRequest,
	type CrudOrder,
	type CrudPredicate,
	type CrudQueryErrorCode,
	type CrudQueryParserOptions,
	type CrudRawQuery,
} from "./query.types.ts";

const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_LIMIT = 100;
const DEFAULT_SEARCH_MAX_LENGTH = 200;

/**
 * Validates a raw query object with the resource's `query.schema`.
 *
 * Use it only for a query that Nest has not validated yet; generated controllers bind the
 * schema with `@Query({ schema })` and hand the parsed value straight to `toCrudListRequest`.
 * Repeated `URLSearchParams` keys become arrays, matching Express and Fastify query parsing.
 */
export async function parseCrudListSchema(
	resource: AnyCrudResource,
	rawQuery: CrudRawQuery,
): Promise<unknown> {
	const schema = resource.query?.schema;
	if (schema === undefined) {
		throw new TypeError(`CRUD resource "${resource.name}" does not declare query.schema.`);
	}
	try {
		return await parseCrudSchema(
			schema,
			rawQuery instanceof URLSearchParams ? searchParamsObject(rawQuery) : rawQuery,
		);
	} catch (cause) {
		if (!(cause instanceof CrudSchemaValidationError)) throw cause;
		const message = cause.issues
			.map((issue) => {
				const path = (issue.path ?? [])
					.map((segment) => String(typeof segment === "object" ? segment.key : segment))
					.join(".");
				return path === "" ? issue.message : `${path}: ${issue.message}`;
			})
			.join("; ");
		throw new CrudQueryValidationError("invalid_parameter", message || "Invalid list query.", {
			cause,
		});
	}
}

/** Maps a value validated by the resource's `query.schema` with its `query.toListQuery`. */
export function toCrudListRequest<Resource extends AnyCrudResource>(
	resource: Resource,
	parsed: unknown,
): CrudListRequest<CrudField<Resource>, CrudRelationName<Resource>> {
	const toListQuery = resource.query?.toListQuery;
	if (toListQuery === undefined) {
		throw new TypeError(`CRUD resource "${resource.name}" does not declare query.toListQuery.`);
	}
	// `toListQuery` is declared with a `never` parameter so any annotated mapper is assignable;
	// `defineCrudResource` checks at compile time that it accepts the schema's output.
	return (
		toListQuery as (
			parsed: unknown,
		) => CrudListRequest<CrudField<Resource>, CrudRelationName<Resource>>
	)(parsed);
}

/**
 * Validates a parser-independent list request against the resource policy and resolves it to
 * the executable query AST: ID tie-breakers are appended, the cursor is verified and turned
 * into a keyset predicate, and defaults are filled in.
 *
 * Requests normally come from `query.toListQuery`, so every violation is a 400 query error.
 */
export async function resolveCrudListRequest<Resource extends AnyCrudResource>(
	resource: Resource,
	request: CrudListRequest<CrudField<Resource>, CrudRelationName<Resource>>,
	options: CrudQueryParserOptions<CrudField<Resource>> = {},
): Promise<CrudListQuery<CrudRequiredField<Resource>, CrudRelationName<Resource>>> {
	if (typeof request !== "object" || request === null) {
		throw new TypeError(`CRUD list request for "${resource.name}" must be an object.`);
	}
	const modes = resolveCrudPaginationModes(resource.query?.pagination);
	if (request.mode !== "offset" && request.mode !== "cursor") {
		throw queryError("invalid_pagination", 'List requests must use mode "offset" or "cursor".');
	}
	if (!modes[request.mode]) {
		throw queryError(
			"invalid_pagination",
			`${request.mode === "offset" ? "Offset" : "Cursor"} pagination is not enabled.`,
		);
	}
	const maxLimit = resource.query?.pagination?.maxLimit ?? options.maxLimit ?? DEFAULT_MAX_LIMIT;
	const limit =
		request.limit ??
		resource.query?.pagination?.defaultLimit ??
		options.defaultLimit ??
		DEFAULT_LIMIT;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit) {
		throw queryError("invalid_pagination", `Page size must be an integer from 1 to ${maxLimit}.`);
	}

	const order = normalizeCrudOrder(resource, request.order, request.mode);
	const predicate =
		request.predicate === undefined ? undefined : assertPredicate(resource, request.predicate);
	const search = assertSearch(resource, request.search);
	if (
		search !== undefined &&
		resource.query?.search?.fullText !== undefined &&
		request.mode === "cursor"
	) {
		throw queryError(
			"invalid_pagination",
			"Full-text relevance search requires offset pagination.",
		);
	}
	const includes = assertIncludes(resource, request.includes ?? []);
	const deleted = assertDeleted(resource, request.deleted ?? "exclude");

	if (request.mode === "offset") {
		const page = request.page;
		if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger((page - 1) * limit)) {
			throw queryError("invalid_pagination", "Page must be a positive integer within range.");
		}
		return {
			mode: "offset",
			page,
			limit,
			...(predicate === undefined ? {} : { predicate }),
			order,
			...(search === undefined ? {} : { search }),
			includes,
			deleted,
		} as CrudListQuery as CrudListQuery<CrudRequiredField<Resource>, CrudRelationName<Resource>>;
	}

	if (limit === Number.MAX_SAFE_INTEGER) {
		throw new TypeError("CRUD cursor pagination limits must leave room for overflow detection.");
	}
	const after = request.after ?? undefined;
	let cursorPredicate: CrudPredicate | undefined;
	if (after !== undefined) {
		if (typeof after !== "string" || after.length === 0) {
			throw queryError("invalid_cursor", "Invalid pagination cursor.");
		}
		if (options.cursorCodec === undefined) {
			throw queryError(
				"cursor_codec_required",
				"Cursor pagination requires a configured cursor codec.",
			);
		}
		try {
			const cursor = await decodeCrudCursor(options.cursorCodec, after, {
				resource: resource.name,
				order,
				...(options.cursorFixedValues === undefined ? {} : { fixed: options.cursorFixedValues }),
			});
			cursorPredicate = buildCrudCursorPredicate(order, cursor.values);
		} catch (cause) {
			if (cause instanceof CrudCursorError) {
				throw new CrudQueryValidationError("invalid_cursor", "Invalid pagination cursor.", {
					cause,
				});
			}
			throw cause;
		}
	}
	const combined = andCrudPredicates(predicate, cursorPredicate);
	return {
		mode: "cursor",
		...(after === undefined ? {} : { after }),
		limit,
		...(combined === undefined ? {} : { predicate: combined }),
		order,
		...(search === undefined ? {} : { search }),
		includes,
		deleted,
	} as CrudListQuery as CrudListQuery<CrudRequiredField<Resource>, CrudRelationName<Resource>>;
}

/**
 * Validates explicit ordering and appends every ID field as a tie-breaker.
 *
 * Fields must be declared by the resource and, when `query.sort.fields` is configured, listed
 * there. Cursor pagination additionally requires every non-ID field to appear in
 * `query.sort.cursor`, the resource's declaration of non-nullable keyset columns.
 */
export function normalizeCrudOrder<Resource extends AnyCrudResource>(
	resource: Resource,
	requested: readonly CrudOrder<CrudField<Resource>>[] | undefined,
	mode: "offset" | "cursor",
): readonly CrudOrder<CrudRequiredField<Resource>>[] {
	const config = resource.query?.sort;
	const items: readonly CrudOrder[] =
		requested ??
		((mode === "cursor" ? (config?.default ?? config?.cursor) : config?.default) ?? []).map(
			(item) =>
				item.startsWith("-")
					? { field: item.slice(1), direction: "desc" as const }
					: { field: item, direction: "asc" as const },
		);
	const declared = new Set<string>(resource.fields);
	const allowed = config === undefined ? declared : new Set<string>(config.fields);
	const cursorFields = new Set<string>(config?.cursor ?? []);
	const idFields: readonly string[] = Object.values(resource.idFields);
	const seen = new Set<string>();
	const order: CrudOrder[] = [];
	for (const item of items) {
		if (
			typeof item !== "object" ||
			item === null ||
			(item.direction !== "asc" && item.direction !== "desc")
		) {
			throw queryError("unknown_sort_field", "Sort items must have a field and a direction.");
		}
		const field: string = item.field;
		if (!declared.has(field) || (!allowed.has(field) && !idFields.includes(field))) {
			throw queryError("unknown_sort_field", `Unknown sort field "${field}".`);
		}
		if (seen.has(field)) {
			throw queryError("invalid_parameter", `Sort field "${field}" is repeated.`);
		}
		if (mode === "cursor" && !cursorFields.has(field) && !idFields.includes(field)) {
			throw queryError(
				"unknown_sort_field",
				`Sort field "${field}" is not enabled for cursor pagination.`,
			);
		}
		seen.add(field);
		order.push({ field, direction: item.direction });
	}
	for (const idField of idFields) {
		if (!seen.has(idField)) {
			seen.add(idField);
			order.push({ field: idField, direction: "asc" });
		}
	}
	return order as readonly CrudOrder<CrudRequiredField<Resource>>[];
}

function assertPredicate<Resource extends AnyCrudResource>(
	resource: Resource,
	predicate: CrudPredicate,
): CrudPredicate {
	const declared = new Set<string>(resource.fields);
	const visit = (node: CrudPredicate): void => {
		if (typeof node !== "object" || node === null) {
			throw queryError("invalid_parameter", "List predicates must be predicate objects.");
		}
		switch (node.kind) {
			case "comparison":
				if (!declared.has(node.field)) {
					throw queryError("unknown_filter_field", `Unknown filter field "${node.field}".`);
				}
				if (!CRUD_FILTER_OPERATORS.includes(node.operator)) {
					throw queryError(
						"unknown_filter_operator",
						`Unknown filter operator "${String(node.operator)}".`,
					);
				}
				return;
			case "and":
			case "or":
				if (!Array.isArray(node.predicates)) {
					throw queryError("invalid_parameter", `A "${node.kind}" predicate needs a list.`);
				}
				for (const child of node.predicates) visit(child);
				return;
			case "not":
				visit(node.predicate);
				return;
			default:
				throw queryError("invalid_parameter", "List predicates must be predicate objects.");
		}
	};
	visit(predicate);
	return predicate;
}

function assertSearch(resource: AnyCrudResource, search: string | undefined): string | undefined {
	if (search === undefined) return undefined;
	const config = resource.query?.search;
	if (config === undefined || config.fields.length === 0) {
		throw queryError("invalid_parameter", "Search is not enabled for this resource.");
	}
	const minLength = config.minLength ?? 1;
	const maxLength = config.maxLength ?? DEFAULT_SEARCH_MAX_LENGTH;
	if (typeof search !== "string" || search.length < minLength || search.length > maxLength) {
		throw queryError(
			"invalid_parameter",
			`Search must contain between ${minLength} and ${maxLength} characters.`,
		);
	}
	return search;
}

function assertIncludes<Include extends string>(
	resource: AnyCrudResource,
	includes: readonly Include[],
): readonly Include[] {
	const known = new Set(Object.keys(resource.relations ?? {}));
	const seen = new Set<string>();
	for (const include of includes) {
		if (!known.has(include)) {
			throw queryError("unknown_include", `Unknown relation include "${include}".`);
		}
		if (seen.has(include)) {
			throw queryError("invalid_parameter", `Relation include "${include}" is repeated.`);
		}
		seen.add(include);
	}
	return includes;
}

function assertDeleted(
	resource: AnyCrudResource,
	deleted: "exclude" | "include" | "only",
): "exclude" | "include" | "only" {
	if (deleted === "exclude") return deleted;
	if (
		(deleted !== "include" && deleted !== "only") ||
		resource.softDelete === undefined ||
		resource.softDelete.allowQueryDeleted !== true
	) {
		throw queryError(
			"deleted_query_forbidden",
			"Querying deleted records is not enabled for this resource.",
		);
	}
	return deleted;
}

function queryError(code: CrudQueryErrorCode, message: string): CrudQueryValidationError {
	return new CrudQueryValidationError(code, message);
}

function searchParamsObject(parameters: URLSearchParams): Readonly<Record<string, unknown>> {
	// A Map plus fromEntries defines own properties, so a "__proto__" key stays data.
	const values = new Map<string, string | string[]>();
	for (const [key, value] of parameters) {
		const existing = values.get(key);
		values.set(
			key,
			existing === undefined
				? value
				: Array.isArray(existing)
					? [...existing, value]
					: [existing, value],
		);
	}
	return Object.fromEntries(values);
}
