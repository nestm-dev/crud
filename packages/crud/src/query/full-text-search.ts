import type { CrudFullTextSearchOptions } from "./query.types.ts";

/** Validates policy for both resource definitions and direct adapter consumers. */
export function assertCrudFullTextSearchOptions<Field extends string>(
	fields: readonly Field[],
	options: CrudFullTextSearchOptions<Field>,
): void {
	if (
		fields.length === 0 ||
		fields.some((field) => typeof field !== "string" || field.length === 0) ||
		new Set(fields).size !== fields.length
	) {
		throw new TypeError("Full-text search requires distinct, non-empty fields.");
	}
	if (
		options.configuration !== undefined &&
		!/^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?$/u.test(options.configuration)
	) {
		throw new TypeError("Full-text search configuration must be a PostgreSQL configuration name.");
	}
	if (
		options.queryMode !== undefined &&
		!["plain", "websearch", "prefix"].includes(options.queryMode)
	) {
		throw new TypeError("Unknown full-text search query mode.");
	}
	if (options.primaryField !== undefined && !fields.includes(options.primaryField)) {
		throw new TypeError("Full-text primaryField must be a search field.");
	}
	for (const [field, weight] of Object.entries(options.weights ?? {})) {
		if (
			!fields.some((candidate) => candidate === field) ||
			typeof weight !== "string" ||
			!["A", "B", "C", "D"].includes(weight)
		) {
			throw new TypeError("Full-text weights must map search fields to A, B, C, or D.");
		}
	}
}
