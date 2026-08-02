import type { CrudOrder, CrudPredicate } from "@nestm/crud/adapter";

export type PrismaCrudWhere = Readonly<Record<string, unknown>>;
export type PrismaCrudOrderBy = Readonly<Record<string, "asc" | "desc">>;
export type PrismaCrudFields = Readonly<Record<string, string>>;

function fieldFor(fields: PrismaCrudFields, field: string): string {
	const persistenceField = fields[field] ?? field;
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(persistenceField)) {
		throw new TypeError(
			`Invalid Prisma field mapping '${persistenceField}' for CRUD field '${field}'.`,
		);
	}
	return persistenceField;
}

function arrayValue(value: unknown, operator: string): readonly unknown[] {
	if (!Array.isArray(value))
		throw new TypeError(`The ${operator} operator requires an array value.`);
	return value;
}

function comparison(
	predicate: Extract<CrudPredicate, { kind: "comparison" }>,
	fields: PrismaCrudFields,
	nonNullableFields: ReadonlySet<string>,
): PrismaCrudWhere {
	const field = fieldFor(fields, predicate.field);
	const value = predicate.value;

	switch (predicate.operator) {
		case "eq":
			return { [field]: value };
		case "ne":
			return { [field]: { not: value } };
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			return { [field]: { [predicate.operator]: value } };
		case "in":
			return { [field]: { in: arrayValue(value, predicate.operator) } };
		case "nin":
			return { [field]: { notIn: arrayValue(value, predicate.operator) } };
		case "contains":
		case "icontains":
			if (typeof value !== "string") {
				throw new TypeError(`The ${predicate.operator} operator requires a string value.`);
			}
			return {
				[field]:
					predicate.operator === "icontains"
						? { contains: value, mode: "insensitive" }
						: { contains: value },
			};
		case "isnull":
			if (typeof value !== "boolean") {
				throw new TypeError("The isnull operator requires a boolean value.");
			}
			if (nonNullableFields.has(predicate.field)) {
				return value ? { OR: [] } : { AND: [] };
			}
			return { [field]: value ? null : { not: null } };
		case "between": {
			const values = arrayValue(value, predicate.operator);
			if (values.length !== 2) {
				throw new TypeError("The between operator requires exactly two values.");
			}
			return { [field]: { gte: values[0], lte: values[1] } };
		}
	}
}

/** Compiles a neutral CRUD predicate to Prisma's parameterized `where` object. */
export function compilePrismaPredicate(
	predicate: CrudPredicate,
	fields: PrismaCrudFields = {},
	nonNullableFields: ReadonlySet<string> = new Set(),
): PrismaCrudWhere {
	switch (predicate.kind) {
		case "comparison":
			return comparison(predicate, fields, nonNullableFields);
		case "and":
			return {
				AND: predicate.predicates.map((item) =>
					compilePrismaPredicate(item, fields, nonNullableFields),
				),
			};
		case "or":
			return {
				OR: predicate.predicates.map((item) =>
					compilePrismaPredicate(item, fields, nonNullableFields),
				),
			};
		case "not":
			return { NOT: compilePrismaPredicate(predicate.predicate, fields, nonNullableFields) };
	}
}

export function compilePrismaOrder(
	order: readonly CrudOrder[],
	fields: PrismaCrudFields = {},
): readonly PrismaCrudOrderBy[] {
	return order.map((item) => ({ [fieldFor(fields, item.field)]: item.direction }));
}
