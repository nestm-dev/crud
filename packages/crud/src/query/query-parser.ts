import { buildCrudCursorPredicate } from "../cursor/cursor-predicate.ts";
import { decodeCrudCursor } from "../cursor/cursor.ts";
import { CrudCursorError } from "../cursor/cursor.error.ts";
import type { AnyCrudResource } from "../resource/resource.types.ts";
import { parseCrudSchema, type CrudSchemaSource } from "../schema/schema.types.ts";
import { andCrudPredicates } from "./predicate.ts";
import { resolveCrudPaginationModes } from "./pagination.ts";
import { CrudQueryValidationError } from "./query.error.ts";
import {
	CRUD_FILTER_OPERATORS,
	type CrudCursorQuery,
	type CrudFilterOperator,
	type CrudListQuery,
	type CrudOffsetQuery,
	type CrudOrder,
	type CrudPredicate,
	type CrudQueryParserOptions,
	type CrudRawQuery,
} from "./query.types.ts";

const FILTER_PARAMETER_PATTERN = /^filter\[([^\u005B\u005D]+)\]\[([^\u005B\u005D]+)\]$/u;
const ROOT_PARAMETERS = new Set(["sort", "search", "include", "deleted", "page", "limit", "after"]);
const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_LIMIT = 100;

interface FilterInput {
	readonly field: string;
	readonly operator: string;
	readonly values: readonly unknown[];
}

interface NormalizedQuery {
	readonly parameters: ReadonlyMap<string, readonly unknown[]>;
	readonly filters: readonly FilterInput[];
}

/** Parses either nested query-parser output or literal bracketed HTTP query keys. */
export async function parseCrudListQuery<Resource extends AnyCrudResource>(
	resource: Resource,
	rawQuery: CrudRawQuery,
	options: CrudQueryParserOptions = {},
): Promise<CrudListQuery> {
	const normalized = normalizeQuery(rawQuery);
	const pagination = resolvePagination(resource, normalized, options);
	const order = buildCrudOrder(resource, readOptionalString(normalized, "sort"), pagination.mode);
	const filters = await parseFilters(resource, normalized.filters);
	const search = parseSearch(resource, normalized);
	const includes = parseIncludes(resource, normalized);
	const deleted = parseDeleted(resource, normalized);

	if (pagination.mode === "offset") {
		const query: CrudOffsetQuery = {
			mode: "offset",
			page: pagination.page,
			limit: pagination.limit,
			...(filters === undefined ? {} : { predicate: filters }),
			order,
			...(search === undefined ? {} : { search }),
			includes,
			deleted,
		};
		return query;
	}

	let cursorPredicate: CrudPredicate | undefined;
	if (pagination.after !== undefined) {
		if (options.cursorCodec === undefined) {
			throw queryError(
				"cursor_codec_required",
				"Cursor pagination requires a configured cursor codec.",
				"after",
			);
		}
		try {
			const cursor = await decodeCrudCursor(options.cursorCodec, pagination.after, {
				resource: resource.name,
				order,
				...(options.cursorFixedValues === undefined ? {} : { fixed: options.cursorFixedValues }),
			});
			cursorPredicate = buildCrudCursorPredicate(order, cursor.values);
		} catch (cause) {
			if (cause instanceof CrudCursorError) {
				throw new CrudQueryValidationError("invalid_cursor", "Invalid pagination cursor.", {
					parameter: "after",
					cause,
				});
			}
			throw cause;
		}
	}

	const predicate = andCrudPredicates(filters, cursorPredicate);
	const query: CrudCursorQuery = {
		mode: "cursor",
		...(pagination.after === undefined ? {} : { after: pagination.after }),
		limit: pagination.limit,
		...(predicate === undefined ? {} : { predicate }),
		order,
		...(search === undefined ? {} : { search }),
		includes,
		deleted,
	};
	return query;
}

/** Builds deterministic ordering and appends every mapped ID field as a tie-breaker. */
export function buildCrudOrder(
	resource: AnyCrudResource,
	rawSort: string | undefined,
	mode: "offset" | "cursor",
): readonly CrudOrder[] {
	const config = resource.query?.sort;
	if (rawSort !== undefined && config === undefined) {
		throw queryError("unknown_sort_field", "Sorting is not enabled for this resource.", "sort");
	}

	const configuredSort =
		rawSort === undefined
			? mode === "cursor"
				? (config?.default ?? config?.cursor ?? [])
				: (config?.default ?? [])
			: splitCommaParameter(rawSort, "sort");
	const allowedFields = new Set(config?.fields ?? []);
	const cursorFields = new Set(config?.cursor ?? []);
	const idFields = Object.values(resource.idFields);
	const seen = new Set<string>();
	const order: CrudOrder[] = [];

	for (const item of configuredSort) {
		const direction = item.startsWith("-") ? "desc" : "asc";
		const field = item.startsWith("-") ? item.slice(1) : item;
		if (field === "" || !allowedFields.has(field)) {
			throw queryError("unknown_sort_field", `Unknown sort field "${field}".`, "sort");
		}
		if (seen.has(field)) {
			throw queryError("invalid_parameter", `Sort field "${field}" is repeated.`, "sort");
		}
		if (mode === "cursor" && !cursorFields.has(field) && !idFields.includes(field)) {
			throw queryError(
				"unknown_sort_field",
				`Sort field "${field}" is not enabled for cursor pagination.`,
				"sort",
			);
		}
		seen.add(field);
		order.push({ field, direction });
	}

	for (const idField of idFields) {
		if (!seen.has(idField)) {
			seen.add(idField);
			order.push({ field: idField, direction: "asc" });
		}
	}
	return order;
}

async function parseFilters(
	resource: AnyCrudResource,
	inputs: readonly FilterInput[],
): Promise<CrudPredicate | undefined> {
	const predicates: CrudPredicate[] = [];
	for (const input of inputs) {
		const filterConfig = resource.query?.filters;
		const fieldConfig =
			filterConfig !== undefined && Object.hasOwn(filterConfig, input.field)
				? filterConfig[input.field]
				: undefined;
		if (fieldConfig === undefined) {
			throw queryError(
				"unknown_filter_field",
				`Unknown filter field "${input.field}".`,
				filterParameter(input),
			);
		}
		if (!isFilterOperator(input.operator) || !fieldConfig.operators.includes(input.operator)) {
			throw queryError(
				"unknown_filter_operator",
				`Filter operator "${input.operator}" is not enabled for field "${input.field}".`,
				filterParameter(input),
			);
		}
		const parameter = filterParameter(input);
		try {
			const value = await parseFilterValue(
				input.operator,
				input.values,
				fieldConfig.schema,
				parameter,
			);
			predicates.push({
				kind: "comparison",
				field: input.field,
				operator: input.operator,
				value,
			});
		} catch (cause) {
			if (cause instanceof CrudQueryValidationError) {
				throw cause;
			}
			throw new CrudQueryValidationError(
				"invalid_filter_value",
				`Invalid value for filter field "${input.field}".`,
				{ parameter, cause },
			);
		}
	}
	return andCrudPredicates(...predicates);
}

async function parseFilterValue(
	operator: CrudFilterOperator,
	rawValues: readonly unknown[],
	schema: CrudSchemaSource,
	parameter: string,
): Promise<unknown> {
	if (operator === "isnull") {
		const [raw] = requireArity(rawValues, 1, 1, parameter);
		return parseBoolean(raw, parameter);
	}
	if (operator === "in" || operator === "nin") {
		const values = requireArity(expandListValues(rawValues, parameter), 1, undefined, parameter);
		return Promise.all(values.map((value) => parseCrudSchema(schema, value)));
	}
	if (operator === "between") {
		const values = requireArity(expandListValues(rawValues, parameter), 2, 2, parameter);
		return Promise.all(values.map((value) => parseCrudSchema(schema, value)));
	}
	const [raw] = requireArity(rawValues, 1, 1, parameter);
	if (Array.isArray(raw)) {
		throw invalidMultiplicity(parameter);
	}
	return parseCrudSchema(schema, raw);
}

function parseSearch(resource: AnyCrudResource, query: NormalizedQuery): string | undefined {
	const value = readOptionalString(query, "search");
	if (value === undefined) {
		return undefined;
	}
	const config = resource.query?.search;
	if (config === undefined || config.fields.length === 0) {
		throw queryError("invalid_parameter", "Search is not enabled for this resource.", "search");
	}
	const minLength = config.minLength ?? 1;
	const maxLength = config.maxLength ?? 200;
	if (value.length < minLength || value.length > maxLength) {
		throw queryError(
			"invalid_parameter",
			`Search must contain between ${minLength} and ${maxLength} characters.`,
			"search",
		);
	}
	return value;
}

function parseIncludes(resource: AnyCrudResource, query: NormalizedQuery): readonly string[] {
	const value = readOptionalString(query, "include");
	if (value === undefined) {
		return [];
	}
	const includes = splitCommaParameter(value, "include");
	const known = new Set(Object.keys(resource.relations ?? {}));
	const seen = new Set<string>();
	for (const include of includes) {
		if (!known.has(include)) {
			throw queryError("unknown_include", `Unknown relation include "${include}".`, "include");
		}
		if (seen.has(include)) {
			throw queryError(
				"invalid_parameter",
				`Relation include "${include}" is repeated.`,
				"include",
			);
		}
		seen.add(include);
	}
	return includes;
}

function parseDeleted(
	resource: AnyCrudResource,
	query: NormalizedQuery,
): "exclude" | "include" | "only" {
	const value = readOptionalString(query, "deleted");
	if (value === undefined) {
		return "exclude";
	}
	if (
		(value !== "include" && value !== "only") ||
		resource.softDelete === undefined ||
		resource.softDelete.allowQueryDeleted !== true
	) {
		throw queryError(
			"deleted_query_forbidden",
			"Querying deleted records is not enabled for this resource.",
			"deleted",
		);
	}
	return value;
}

function resolvePagination(
	resource: AnyCrudResource,
	query: NormalizedQuery,
	options: CrudQueryParserOptions,
):
	| { readonly mode: "offset"; readonly page: number; readonly limit: number }
	| { readonly mode: "cursor"; readonly after?: string; readonly limit: number } {
	const config = resource.query?.pagination;
	const { offset: offsetEnabled, cursor: cursorEnabled } = resolveCrudPaginationModes(config);
	const hasPage = query.parameters.has("page");
	const hasAfter = query.parameters.has("after");
	if (hasPage && hasAfter) {
		throw queryError(
			"invalid_pagination",
			'Query parameters "page" and "after" cannot be combined.',
			"page",
		);
	}

	const configuredDefault = config?.defaultLimit ?? options.defaultLimit ?? DEFAULT_LIMIT;
	const configuredMaximum = config?.maxLimit ?? options.maxLimit ?? DEFAULT_MAX_LIMIT;
	if (
		!Number.isSafeInteger(configuredDefault) ||
		configuredDefault < 1 ||
		!Number.isSafeInteger(configuredMaximum) ||
		configuredMaximum < configuredDefault
	) {
		throw new TypeError("CRUD pagination limits must be positive safe integers within range.");
	}
	const rawLimit = readOptionalScalar(query, "limit");
	const limit =
		rawLimit === undefined
			? configuredDefault
			: parsePositiveInteger(rawLimit, "limit", configuredMaximum);

	const mode = hasAfter || (!hasPage && cursorEnabled) ? "cursor" : "offset";
	if (mode === "cursor") {
		if (!cursorEnabled) {
			throw queryError("invalid_pagination", "Cursor pagination is not enabled.", "after");
		}
		const after = readOptionalString(query, "after");
		if (after !== undefined && after.length === 0) {
			throw queryError("invalid_cursor", "Invalid pagination cursor.", "after");
		}
		if (limit === Number.MAX_SAFE_INTEGER) {
			throw new TypeError("CRUD cursor pagination limits must leave room for overflow detection.");
		}
		return { mode, ...(after === undefined ? {} : { after }), limit };
	}
	if (!offsetEnabled) {
		throw queryError("invalid_pagination", "Offset pagination is not enabled.", "page");
	}
	const rawPage = readOptionalScalar(query, "page");
	const page = rawPage === undefined ? 1 : parsePositiveInteger(rawPage, "page");
	if (!Number.isSafeInteger((page - 1) * limit)) {
		throw queryError(
			"invalid_pagination",
			'Query parameters "page" and "limit" produce an unsafe offset.',
			"page",
		);
	}
	return { mode, page, limit };
}

function normalizeQuery(rawQuery: CrudRawQuery): NormalizedQuery {
	const parameters = new Map<string, unknown[]>();
	const filterValues = new Map<string, { field: string; operator: string; values: unknown[] }>();
	const entries: readonly (readonly [string, unknown])[] =
		rawQuery instanceof URLSearchParams ? [...rawQuery.entries()] : Object.entries(rawQuery);

	for (const [key, value] of entries) {
		const filterMatch = FILTER_PARAMETER_PATTERN.exec(key);
		if (filterMatch !== null) {
			addFilter(filterValues, filterMatch[1]!, filterMatch[2]!, value);
			continue;
		}
		if (key === "filter") {
			addNestedFilters(filterValues, value);
			continue;
		}
		if (!ROOT_PARAMETERS.has(key)) {
			throw queryError("unknown_parameter", `Unknown query parameter "${key}".`, key);
		}
		addParameter(parameters, key, value);
	}

	return {
		parameters,
		filters: [...filterValues.values()],
	};
}

function addNestedFilters(
	filters: Map<string, { field: string; operator: string; values: unknown[] }>,
	value: unknown,
): void {
	if (!isRecord(value)) {
		throw queryError("invalid_parameter", 'Query parameter "filter" must be an object.', "filter");
	}
	for (const [field, operators] of Object.entries(value)) {
		if (!isRecord(operators)) {
			throw queryError(
				"invalid_parameter",
				`Filter field "${field}" must contain operator keys.`,
				`filter[${field}]`,
			);
		}
		for (const [operator, operand] of Object.entries(operators)) {
			addFilter(filters, field, operator, operand);
		}
	}
}

function addFilter(
	filters: Map<string, { field: string; operator: string; values: unknown[] }>,
	field: string,
	operator: string,
	value: unknown,
): void {
	const key = JSON.stringify([field, operator]);
	const existing = filters.get(key);
	if (existing === undefined) {
		filters.set(key, { field, operator, values: [value] });
	} else {
		existing.values.push(value);
	}
}

function addParameter(parameters: Map<string, unknown[]>, key: string, value: unknown): void {
	const existing = parameters.get(key);
	if (existing === undefined) {
		parameters.set(key, [value]);
	} else {
		existing.push(value);
	}
}

function readOptionalString(query: NormalizedQuery, name: string): string | undefined {
	const value = readOptionalScalar(query, name);
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw queryError("invalid_parameter", `Query parameter "${name}" must be a string.`, name);
	}
	return value;
}

function readOptionalScalar(query: NormalizedQuery, name: string): unknown {
	const values = query.parameters.get(name);
	if (values === undefined) {
		return undefined;
	}
	if (values.length !== 1 || Array.isArray(values[0])) {
		throw queryError(
			"duplicate_parameter",
			`Query parameter "${name}" must occur exactly once.`,
			name,
		);
	}
	return values[0];
}

function parsePositiveInteger(value: unknown, parameter: string, maximum?: number): number {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string" && /^[1-9]\d*$/.test(value)
				? Number(value)
				: Number.NaN;
	if (!Number.isSafeInteger(parsed) || parsed < 1 || (maximum !== undefined && parsed > maximum)) {
		const range = maximum === undefined ? "a positive integer" : `an integer from 1 to ${maximum}`;
		throw queryError(
			"invalid_pagination",
			`Query parameter "${parameter}" must be ${range}.`,
			parameter,
		);
	}
	return parsed;
}

function expandListValues(values: readonly unknown[], parameter: string): readonly unknown[] {
	const expanded: unknown[] = [];
	for (const value of values) {
		const items = Array.isArray(value) ? value : [value];
		for (const item of items) {
			if (typeof item === "string" && item.includes(",")) {
				const parts = item.split(",").map((part) => part.trim());
				if (parts.some((part) => part === "")) {
					throw invalidMultiplicity(parameter);
				}
				expanded.push(...parts);
			} else {
				expanded.push(item);
			}
		}
	}
	return expanded;
}

function requireArity(
	values: readonly unknown[],
	minimum: number,
	maximum: number | undefined,
	parameter: string,
): readonly unknown[] {
	if (values.length < minimum || (maximum !== undefined && values.length > maximum)) {
		throw invalidMultiplicity(parameter);
	}
	return values;
}

function invalidMultiplicity(parameter: string): CrudQueryValidationError {
	return queryError(
		"invalid_filter_value",
		`Query parameter "${parameter}" has invalid value multiplicity.`,
		parameter,
	);
}

function parseBoolean(value: unknown, parameter: string): boolean {
	if (value === true || value === "true" || value === 1 || value === "1") {
		return true;
	}
	if (value === false || value === "false" || value === 0 || value === "0") {
		return false;
	}
	throw queryError(
		"invalid_filter_value",
		`Query parameter "${parameter}" must be a boolean.`,
		parameter,
	);
}

function splitCommaParameter(value: string, parameter: string): readonly string[] {
	const parts = value.split(",").map((part) => part.trim());
	if (parts.length === 0 || parts.some((part) => part === "")) {
		throw queryError(
			"invalid_parameter",
			`Query parameter "${parameter}" contains an empty item.`,
			parameter,
		);
	}
	return parts;
}

function filterParameter(input: Pick<FilterInput, "field" | "operator">): string {
	return `filter[${input.field}][${input.operator}]`;
}

function isFilterOperator(value: string): value is CrudFilterOperator {
	return CRUD_FILTER_OPERATORS.some((operator) => operator === value);
}

function queryError(
	code: ConstructorParameters<typeof CrudQueryValidationError>[0],
	message: string,
	parameter: string,
): CrudQueryValidationError {
	return new CrudQueryValidationError(code, message, { parameter });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
