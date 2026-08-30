import type { CrudPredicate } from "@nestm/crud/adapter";
import {
	and,
	between,
	eq,
	gt,
	gte,
	ilike,
	inArray,
	isNotNull,
	isNull,
	like,
	lt,
	lte,
	ne,
	not,
	notInArray,
	or,
	sql,
	type SQL,
} from "drizzle-orm";
import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";

export type DrizzleCrudTableColumn<Table extends AnyPgTable> =
	Table["_"]["columns"][keyof Table["_"]["columns"]];

export type DrizzleCrudColumns<Table extends AnyPgTable = AnyPgTable> = Readonly<
	Record<string, DrizzleCrudTableColumn<Table>>
>;

function columnFor<Columns extends DrizzleCrudColumns>(
	columns: Columns,
	field: Extract<keyof Columns, string>,
): AnyPgColumn {
	const column = columns[field];
	if (column === undefined) {
		throw new TypeError(`The Drizzle adapter does not map CRUD field '${field}'.`);
	}
	return column;
}

function arrayValue(value: unknown, operator: string): readonly unknown[] {
	if (!Array.isArray(value))
		throw new TypeError(`The ${operator} operator requires an array value.`);
	return value;
}

function escapeLike(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function comparison<Columns extends DrizzleCrudColumns>(
	predicate: Extract<
		CrudPredicate<NoInfer<Extract<keyof Columns, string>>>,
		{ kind: "comparison" }
	>,
	columns: Columns,
): SQL {
	const column = columnFor(columns, predicate.field);
	const value = predicate.value;

	switch (predicate.operator) {
		case "eq":
			return value === null ? isNull(column) : eq(column, value);
		case "ne":
			return value === null ? isNotNull(column) : ne(column, value);
		case "gt":
			return gt(column, value);
		case "gte":
			return gte(column, value);
		case "lt":
			return lt(column, value);
		case "lte":
			return lte(column, value);
		case "in": {
			const values = arrayValue(value, predicate.operator);
			return values.length === 0 ? sql`false` : inArray(column, [...values]);
		}
		case "nin": {
			const values = arrayValue(value, predicate.operator);
			return values.length === 0 ? sql`true` : notInArray(column, [...values]);
		}
		case "contains":
		case "icontains": {
			if (typeof value !== "string") {
				throw new TypeError(`The ${predicate.operator} operator requires a string value.`);
			}
			const pattern = `%${escapeLike(value)}%`;
			// Drizzle binds `pattern`; the explicit escape clause preserves literal wildcard semantics.
			return predicate.operator === "contains"
				? sql`${like(column, pattern)} escape '\\'`
				: sql`${ilike(column, pattern)} escape '\\'`;
		}
		case "isnull":
			if (typeof value !== "boolean") {
				throw new TypeError("The isnull operator requires a boolean value.");
			}
			return value ? isNull(column) : isNotNull(column);
		case "between": {
			const values = arrayValue(value, predicate.operator);
			if (values.length !== 2) {
				throw new TypeError("The between operator requires exactly two values.");
			}
			return between(column, values[0], values[1]);
		}
	}
}

/** Compiles a neutral CRUD predicate into Drizzle's parameterized SQL expression tree. */
export function compileDrizzlePredicate<const Columns extends DrizzleCrudColumns>(
	predicate: CrudPredicate<NoInfer<Extract<keyof Columns, string>>>,
	columns: Columns,
): SQL {
	switch (predicate.kind) {
		case "comparison":
			return comparison(predicate, columns);
		case "and":
			return (
				and(...predicate.predicates.map((item) => compileDrizzlePredicate(item, columns))) ??
				sql`true`
			);
		case "or":
			return (
				or(...predicate.predicates.map((item) => compileDrizzlePredicate(item, columns))) ??
				sql`false`
			);
		case "not":
			return not(compileDrizzlePredicate(predicate.predicate, columns));
	}
}
