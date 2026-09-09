import {
	assertCrudFullTextSearchOptions,
	type CrudFullTextSearchInput,
	type CrudFullTextSearchOptions,
} from "@nestm/crud/adapter";
import type { TypeOrmFieldResolver } from "./typeorm-predicate.ts";

export interface TypeOrmCompiledFullTextSearch {
	readonly sql: string;
	readonly parameters: Readonly<Record<string, string>>;
	/** Prepend these expressions to the caller's deterministic tie-break ordering. */
	readonly order: readonly { readonly sql: string; readonly direction: "ASC" | "DESC" }[];
}

/** Build the same immutable expression for queries and consumer-owned GIN indexes. */
export function compileTypeOrmFullTextVector<Field extends string>(
	fields: readonly Field[],
	options: CrudFullTextSearchOptions<Field>,
	resolveField: TypeOrmFieldResolver<Field>,
): string {
	assertCrudFullTextSearchOptions(fields, options);
	const configuration = `'${options.configuration ?? "simple"}'::regconfig`;
	return fields
		.map(
			(field) =>
				`setweight(to_tsvector(${configuration}, COALESCE(${resolveField(field)}::text, '')), '${options.weights?.[field] ?? "D"}')`,
		)
		.join(" || ");
}

/** PostgreSQL full-text matching/ranking shared by CRUD and custom repository queries. */
export function compileTypeOrmFullTextSearch<Field extends string>(
	input: CrudFullTextSearchInput<Field>,
	resolveField: TypeOrmFieldResolver<Field>,
): TypeOrmCompiledFullTextSearch {
	const vector = `(${compileTypeOrmFullTextVector(input.fields, input, resolveField)})`;
	if (typeof input.query !== "string") throw new TypeError("Full-text query must be a string.");
	const configuration = `'${input.configuration ?? "simple"}'::regconfig`;
	const query =
		input.queryMode === "prefix"
			? `to_tsquery(${configuration}, COALESCE((SELECT string_agg(quote_literal(term) || ':*', ' & ') FROM unnest(tsvector_to_array(to_tsvector(${configuration}, :crud_search_query))) AS tokens(term)), ''))`
			: `${input.queryMode === "websearch" ? "websearch_to_tsquery" : "plainto_tsquery"}(${configuration}, :crud_search_query)`;
	const order: { sql: string; direction: "ASC" | "DESC" }[] = [];
	if (input.primaryField !== undefined) {
		const field = resolveField(input.primaryField);
		order.push({
			sql: `CASE WHEN lower(${field}::text) = lower(:crud_search_query) THEN 0 WHEN strpos(lower(${field}::text), lower(:crud_search_query)) = 1 THEN 1 WHEN to_tsvector(${configuration}, COALESCE(${field}::text, '')) @@ ${query} THEN 2 ELSE 3 END`,
			direction: "ASC",
		});
	}
	order.push({ sql: `ts_rank_cd(${vector}, ${query}, 32)`, direction: "DESC" });
	return { sql: `${vector} @@ ${query}`, parameters: { crud_search_query: input.query }, order };
}
