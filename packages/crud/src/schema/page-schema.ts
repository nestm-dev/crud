import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import type { StandardSchemaConverter } from "@nestjs/swagger";

import type { CrudPaginationModes } from "../query/pagination.ts";
import type { CrudPage, CrudPageMeta, CrudPageMetaFormatters } from "../query/query.types.ts";
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
		readonly meta: CrudPageMetaFormatters | undefined;
	};
}

export interface CrudPageSchemaOptions {
	/** Per-mode meta formatters whose schemas replace the canonical `meta` object. */
	readonly meta?: CrudPageMetaFormatters | undefined;
}

export type CrudPageSchema<Source extends CrudSchemaSource, Meta = CrudPageMeta> = StandardSchemaV1<
	{ readonly data: readonly SchemaInput<Source>[]; readonly meta: Meta },
	CrudPage<SchemaOutput<Source>, Meta>
> &
	(SchemaOf<Source> extends StandardJSONSchemaV1
		? StandardJSONSchemaV1<
				{ readonly data: readonly SchemaInput<Source>[]; readonly meta: Meta },
				CrudPage<SchemaOutput<Source>, Meta>
			>
		: unknown) &
	CrudPageSchemaMarker;

type MetaMode = keyof CrudPaginationModes;

export function createCrudPageSchema<Source extends CrudSchemaSource, Meta = CrudPageMeta>(
	source: Source,
	modes: CrudPaginationModes = { offset: true, cursor: true },
	options: CrudPageSchemaOptions = {},
): CrudPageSchema<Source, Meta> {
	const itemSchema = getCrudSchema(source);
	const itemJsonSchema = getStandardJsonSchemaConverter(itemSchema);
	const enabled = enabledModes(modes);
	const metaJsonSchemas = new Map<MetaMode, StandardJSONSchemaV1.Converter>();
	let metaJsonAvailable = true;
	for (const mode of enabled) {
		const formatter = options.meta?.[mode];
		if (formatter === undefined) continue;
		const converter = getStandardJsonSchemaConverter(getCrudSchema(formatter.schema));
		if (converter === undefined) metaJsonAvailable = false;
		else metaJsonSchemas.set(mode, converter);
	}
	const metaJson = (
		direction: "input" | "output",
		jsonOptions: StandardJSONSchemaV1.Options,
	): MetaJsonSchemas =>
		new Map(
			enabled.map((mode) => {
				const converter = metaJsonSchemas.get(mode);
				return [
					mode,
					converter === undefined ? undefined : converter[direction](jsonOptions),
				] as const;
			}),
		);
	return {
		[CRUD_PAGE_SCHEMA]: { source, modes, meta: options.meta },
		"~standard": {
			version: 1,
			vendor: "@nestm/crud",
			...(itemJsonSchema === undefined || !metaJsonAvailable
				? {}
				: {
						jsonSchema: {
							input: (jsonOptions: StandardJSONSchemaV1.Options) =>
								pageJsonSchema(
									itemJsonSchema.input(jsonOptions),
									modes,
									metaJson("input", jsonOptions),
								),
							output: (jsonOptions: StandardJSONSchemaV1.Options) =>
								pageJsonSchema(
									itemJsonSchema.output(jsonOptions),
									modes,
									metaJson("output", jsonOptions),
								),
						},
					}),
			validate: async (value: unknown) => {
				if (!isPageShape(value)) {
					return { issues: [{ message: "Expected a CRUD page response." }] };
				}
				const meta = await validatePageMeta(value.meta, enabled, options.meta);
				if (meta === undefined) {
					return { issues: [{ message: "Expected a CRUD page response.", path: ["meta"] }] };
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
					: { value: { data, meta: meta.value } as CrudPage<SchemaOutput<Source>, Meta> };
			},
		},
	} as CrudPageSchema<Source, Meta>;
}

/** Converter results per enabled mode; `undefined` means the canonical meta for that mode. */
type MetaJsonSchemas = ReadonlyMap<MetaMode, Record<string, unknown> | undefined>;

async function validatePageMeta(
	meta: unknown,
	enabled: readonly MetaMode[],
	formatters: CrudPageMetaFormatters | undefined,
): Promise<{ readonly value: unknown } | undefined> {
	for (const mode of enabled) {
		const formatter = formatters?.[mode];
		if (formatter === undefined) {
			if (isCanonicalPageMeta(meta, mode)) return { value: meta };
			continue;
		}
		const result = await getCrudSchema(formatter.schema)["~standard"].validate(meta);
		if (!("issues" in result) || result.issues === undefined) return { value: result.value };
	}
	return undefined;
}

function enabledModes(modes: CrudPaginationModes): readonly MetaMode[] {
	return (["offset", "cursor"] as const).filter((mode) => modes[mode]);
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
	metas: MetaJsonSchemas,
): Record<string, unknown> {
	const { $schema, $defs, definitions, ...itemSchema } = item;
	const mergedDefs: Record<string, unknown> = { ...asRecord($defs) };
	const mergedDefinitions: Record<string, unknown> = { ...asRecord(definitions) };
	const metaSchemas = new Map<MetaMode, Record<string, unknown>>();
	for (const [mode, meta] of metas) {
		if (meta === undefined) continue;
		const {
			$schema: _metaSchema,
			$defs: metaDefs,
			definitions: metaDefinitions,
			...metaSchema
		} = meta;
		Object.assign(mergedDefs, asRecord(metaDefs));
		Object.assign(mergedDefinitions, asRecord(metaDefinitions));
		metaSchemas.set(mode, metaSchema);
	}
	return {
		...($schema === undefined ? {} : { $schema }),
		...(Object.keys(mergedDefs).length === 0 ? {} : { $defs: mergedDefs }),
		...(Object.keys(mergedDefinitions).length === 0 ? {} : { definitions: mergedDefinitions }),
		additionalProperties: false,
		properties: {
			data: { type: "array", items: itemSchema },
			meta: pageMetaJsonSchema(modes, metaSchemas),
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
		const components: Record<string, unknown> = { ...item.components };
		const metaSchemas = new Map<MetaMode, Record<string, unknown>>();
		for (const mode of enabledModes(marker.modes)) {
			const formatter = marker.meta?.[mode];
			if (formatter === undefined) continue;
			const metaSchema = getCrudSchema(formatter.schema);
			const converted = converter(metaSchema, options);
			if (converted !== undefined) {
				Object.assign(components, converted.components);
				metaSchemas.set(mode, converted.schema as Record<string, unknown>);
				continue;
			}
			const native = getStandardJsonSchemaConverter(metaSchema)?.[options.schemaType]({
				target: "openapi-3.0",
			});
			const {
				$schema: _schema,
				$defs: _defs,
				definitions: _definitions,
				...inline
			} = native ?? {
				type: "object",
			};
			metaSchemas.set(mode, inline);
		}
		return {
			...item,
			...(Object.keys(components).length === 0 ? {} : { components }),
			schema: {
				additionalProperties: false,
				properties: {
					data: { type: "array", items: item.schema },
					meta: pageMetaJsonSchema(marker.modes, metaSchemas),
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

function isPageShape(
	value: unknown,
): value is { readonly data: readonly unknown[]; readonly meta: unknown } {
	return (
		typeof value === "object" &&
		value !== null &&
		"data" in value &&
		Array.isArray(value.data) &&
		"meta" in value
	);
}

function isCanonicalPageMeta(value: unknown, mode: MetaMode): value is CrudPageMeta {
	if (typeof value !== "object" || value === null || !("mode" in value) || value.mode !== mode) {
		return false;
	}
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

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
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

function pageMetaJsonSchema(
	modes: CrudPaginationModes,
	custom: ReadonlyMap<MetaMode, Record<string, unknown>> = new Map(),
): Record<string, unknown> {
	const offset = custom.get("offset") ?? offsetMetaJsonSchema;
	const cursor = custom.get("cursor") ?? cursorMetaJsonSchema;
	if (modes.offset && modes.cursor) {
		return { oneOf: [offset, cursor] };
	}
	if (modes.cursor) return cursor;
	return offset;
}
