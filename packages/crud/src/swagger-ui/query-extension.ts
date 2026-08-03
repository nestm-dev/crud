import type { CrudFilterOperator } from "../query/query.types.ts";
import type { AnyCrudResource } from "../resource/resource.types.ts";

export const CRUD_QUERY_OPENAPI_EXTENSION = "x-nestm-crud-query" as const;

export type CrudQueryOpenApiValueKind = "scalar" | "csv-list" | "csv-pair" | "boolean";

export interface CrudQueryOpenApiCondition {
	readonly field: string;
	readonly operator: CrudFilterOperator;
	readonly parameter: string;
	readonly valueKind: CrudQueryOpenApiValueKind;
}

/** JSON-only metadata consumed by the optional NestM Swagger UI plugin. */
export interface CrudQueryOpenApiExtension {
	readonly version: 1;
	readonly conjunction: "and";
	readonly conditions: readonly CrudQueryOpenApiCondition[];
}

export function createCrudQueryOpenApiExtension(
	resource: AnyCrudResource,
): CrudQueryOpenApiExtension | undefined {
	const conditions = Object.entries(resource.query?.filters ?? {}).flatMap(([field, config]) =>
		config.operators.map((operator) => ({
			field,
			operator,
			parameter: `filter[${field}][${operator}]`,
			valueKind: valueKind(operator),
		})),
	);
	if (conditions.length === 0) return undefined;
	return {
		version: 1,
		conjunction: "and",
		conditions,
	};
}

function valueKind(operator: CrudFilterOperator): CrudQueryOpenApiValueKind {
	if (operator === "in" || operator === "nin") return "csv-list";
	if (operator === "between") return "csv-pair";
	if (operator === "isnull") return "boolean";
	return "scalar";
}
