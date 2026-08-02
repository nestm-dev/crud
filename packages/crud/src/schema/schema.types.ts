import type { StandardSchemaV1 } from "@standard-schema/spec";

export type CrudStandardSchema = StandardSchemaV1<unknown, unknown>;

export type CrudSchemaSource<Schema extends CrudStandardSchema = CrudStandardSchema> =
	Schema | { readonly schema: Schema };

export type SchemaOf<Source extends CrudSchemaSource> =
	Source extends StandardSchemaV1<unknown, unknown>
		? Source
		: Source extends { readonly schema: infer Schema extends CrudStandardSchema }
			? Schema
			: never;

export type SchemaInput<Source extends CrudSchemaSource> = StandardSchemaV1.InferInput<
	SchemaOf<Source>
>;

export type SchemaOutput<Source extends CrudSchemaSource> = StandardSchemaV1.InferOutput<
	SchemaOf<Source>
>;

export function getCrudSchema<Source extends CrudSchemaSource>(source: Source): SchemaOf<Source> {
	if ("~standard" in source) {
		return source as SchemaOf<Source>;
	}
	return source.schema as SchemaOf<Source>;
}

export async function parseCrudSchema<Source extends CrudSchemaSource>(
	source: Source,
	value: unknown,
): Promise<SchemaOutput<Source>> {
	const result = await getCrudSchema(source)["~standard"].validate(value);
	if ("issues" in result) {
		throw new CrudSchemaValidationError(result.issues ?? []);
	}
	return result.value as SchemaOutput<Source>;
}

export class CrudSchemaValidationError extends Error {
	readonly issues: readonly StandardSchemaV1.Issue[];

	constructor(issues: readonly StandardSchemaV1.Issue[]) {
		super("Standard Schema validation failed.");
		this.name = "CrudSchemaValidationError";
		this.issues = issues;
	}
}
