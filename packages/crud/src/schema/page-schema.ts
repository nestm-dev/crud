import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import type { StandardSchemaConverter } from "@nestjs/swagger";

import type { CrudPage, CrudPageMeta } from "../query/query.types.ts";
import type { CrudPaginationModes } from "../query/pagination.ts";
import {
	getCrudSchema,
	type CrudSchemaSource,
	type SchemaInput,
	type SchemaOf,
	type SchemaOutput,
} from "./schema.types.ts";

const CRUD_PAGE_SCHEMA = Symbol.for("@nestm/crud:page-schema");

interface CrudPageSchemaMarker {
	readonly [CRUD_PAGE_SCHEMA]: {
		readonly source: CrudSchemaSource;
		readonly modes: CrudPaginationModes;
	};
}

export type CrudPageSchema<Source extends CrudSchemaSource> = StandardSchemaV1<
	{ readonly data: readonly SchemaInput<Source>[]; readonly meta: CrudPageMeta },
	CrudPage<SchemaOutput<Source>>
> &
	(SchemaOf<Source> extends StandardJSONSchemaV1
		? StandardJSONSchemaV1<
				{ readonly data: readonly SchemaInput<Source>[]; readonly meta: CrudPageMeta },
				CrudPage<SchemaOutput<Source>>
			>
		: unknown) &
	CrudPageSchemaMarker;

export function createCrudPageSchema<Source extends CrudSchemaSource>(
	source: Source,
	modes: CrudPaginationModes = { offset: true, cursor: true },
): CrudPageSchema<Source> {
	const itemSchema = getCrudSchema(source);
	const itemJsonSchema = getStandardJsonSchemaConverter(itemSchema);
	return {
		[CRUD_PAGE_SCHEMA]: { source, modes },
		"~standard": {
			version: 1,
			vendor: "@nestm/crud",
			...(itemJsonSchema === undefined
				? {}
				: {
						jsonSchema: {
							input: (options: StandardJSONSchemaV1.Options) =>
								pageJsonSchema(itemJsonSchema.input(options), modes),
							output: (options: StandardJSONSchemaV1.Options) =>
								pageJsonSchema(itemJsonSchema.output(options), modes),
						},
					}),
			validate: async (value: unknown) => {
				if (!isPageInput(value) || !modes[value.meta.mode]) {
					return { issues: [{ message: "Expected a CRUD page response." }] };
				}
				const data: unknown[] = [];
				const issues: StandardSchemaV1.Issue[] = [];
				for (const item of value.data) {
					const result = await itemSchema["~standard"].validate(item);
					if ("issues" in result) {
						issues.push(...(result.issues ?? []));
					} else {
						data.push(result.value);
					}
				}
				return issues.length > 0
					? { issues }
					: { value: { data, meta: value.meta } as CrudPage<SchemaOutput<Source>> };
			},
		},
	} as CrudPageSchema<Source>;
}

function getStandardJsonSchemaConverter(
	schema: StandardSchemaV1,
): StandardJSONSchemaV1.Converter | undefined {
	const standard = schema["~standard"] as StandardSchemaV1.Props & {
		readonly jsonSchema?: unknown;
	};
	const converter = standard.jsonSchema;
	if (
		typeof converter !== "object" ||
		converter === null ||
		!("input" in converter) ||
		typeof converter.input !== "function" ||
		!("output" in converter) ||
		typeof converter.output !== "function"
	) {
		return undefined;
	}
	return converter as StandardJSONSchemaV1.Converter;
}

function pageJsonSchema(
	item: Record<string, unknown>,
	modes: CrudPaginationModes,
): Record<string, unknown> {
	const { $schema, $defs, definitions, ...itemSchema } = item;
	return {
		...($schema === undefined ? {} : { $schema }),
		...($defs === undefined ? {} : { $defs }),
		...(definitions === undefined ? {} : { definitions }),
		additionalProperties: false,
		properties: {
			data: { type: "array", items: itemSchema },
			meta: pageMetaJsonSchema(modes),
		},
		required: ["data", "meta"],
		type: "object",
	};
}

export function withCrudStandardSchemaConverter(
	converter: StandardSchemaConverter,
): StandardSchemaConverter {
	return (schema, options) => {
		if (!isCrudPageSchema(schema)) {
			return converter(schema, options);
		}
		const marker = schema[CRUD_PAGE_SCHEMA];
		const item = converter(getCrudSchema(marker.source), options);
		if (item === undefined) {
			return undefined;
		}
		return {
			...item,
			schema: {
				additionalProperties: false,
				properties: {
					data: { type: "array", items: item.schema },
					meta: pageMetaJsonSchema(marker.modes),
				},
				required: ["data", "meta"],
				type: "object",
			},
		};
	};
}

function isCrudPageSchema(value: unknown): value is CrudPageSchemaMarker & StandardSchemaV1 {
	return typeof value === "object" && value !== null && CRUD_PAGE_SCHEMA in value;
}

function isPageInput(
	value: unknown,
): value is { readonly data: readonly unknown[]; readonly meta: CrudPageMeta } {
	return (
		typeof value === "object" &&
		value !== null &&
		"data" in value &&
		Array.isArray(value.data) &&
		"meta" in value &&
		isPageMeta(value.meta)
	);
}

function isPageMeta(value: unknown): value is CrudPageMeta {
	if (typeof value !== "object" || value === null || !("mode" in value)) return false;
	if (value.mode === "offset") {
		return (
			"page" in value &&
			isPositiveInteger(value.page) &&
			"limit" in value &&
			isPositiveInteger(value.limit) &&
			"total" in value &&
			isNonNegativeInteger(value.total) &&
			"totalPages" in value &&
			isNonNegativeInteger(value.totalPages) &&
			"hasNextPage" in value &&
			typeof value.hasNextPage === "boolean" &&
			"hasPreviousPage" in value &&
			typeof value.hasPreviousPage === "boolean"
		);
	}
	return (
		value.mode === "cursor" &&
		"limit" in value &&
		isPositiveInteger(value.limit) &&
		"nextCursor" in value &&
		(value.nextCursor === null || typeof value.nextCursor === "string") &&
		"hasNextPage" in value &&
		typeof value.hasNextPage === "boolean"
	);
}

function isPositiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}

const offsetMetaJsonSchema: Record<string, unknown> = {
	additionalProperties: false,
	properties: {
		mode: { type: "string", enum: ["offset"] },
		page: { type: "integer", minimum: 1 },
		limit: { type: "integer", minimum: 1 },
		total: { type: "integer", minimum: 0 },
		totalPages: { type: "integer", minimum: 0 },
		hasNextPage: { type: "boolean" },
		hasPreviousPage: { type: "boolean" },
	},
	required: ["mode", "page", "limit", "total", "totalPages", "hasNextPage", "hasPreviousPage"],
	type: "object",
};

const cursorMetaJsonSchema: Record<string, unknown> = {
	additionalProperties: false,
	properties: {
		mode: { type: "string", enum: ["cursor"] },
		limit: { type: "integer", minimum: 1 },
		nextCursor: { type: "string", nullable: true },
		hasNextPage: { type: "boolean" },
	},
	required: ["mode", "limit", "nextCursor", "hasNextPage"],
	type: "object",
};

function pageMetaJsonSchema(modes: CrudPaginationModes): Record<string, unknown> {
	if (modes.offset && modes.cursor) {
		return { oneOf: [offsetMetaJsonSchema, cursorMetaJsonSchema] };
	}
	if (modes.cursor) return cursorMetaJsonSchema;
	return offsetMetaJsonSchema;
}
