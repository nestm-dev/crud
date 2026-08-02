import type { CrudPredicate } from "@nestm/crud/adapter";

export interface TypeOrmCompiledPredicate {
	readonly sql: string;
	readonly parameters: Readonly<Record<string, unknown>>;
}

export type TypeOrmFieldResolver = (field: string) => string;

interface CompileState {
	nextParameter: number;
	readonly parameters: Record<string, unknown>;
	readonly resolveField: TypeOrmFieldResolver;
}

function nextParameter(state: CompileState, value: unknown): string {
	const name = `crud_${state.nextParameter++}`;
	state.parameters[name] = value;
	return name;
}

function escapeLike(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function requireArray(value: unknown, operator: string): readonly unknown[] {
	if (!Array.isArray(value)) {
		throw new TypeError(`The ${operator} operator requires an array value.`);
	}
	return value;
}

function compileComparison(
	predicate: Extract<CrudPredicate, { kind: "comparison" }>,
	state: CompileState,
): string {
	const field = state.resolveField(predicate.field);
	const value = predicate.value;

	switch (predicate.operator) {
		case "eq": {
			if (value === null) return `${field} IS NULL`;
			const parameter = nextParameter(state, value);
			return `${field} = :${parameter}`;
		}
		case "ne": {
			if (value === null) return `${field} IS NOT NULL`;
			const parameter = nextParameter(state, value);
			return `${field} <> :${parameter}`;
		}
		case "gt":
		case "gte":
		case "lt":
		case "lte": {
			const operators = { gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;
			const parameter = nextParameter(state, value);
			return `${field} ${operators[predicate.operator]} :${parameter}`;
		}
		case "in":
		case "nin": {
			const values = requireArray(value, predicate.operator);
			if (values.length === 0) return predicate.operator === "in" ? "1 = 0" : "1 = 1";
			const parameter = nextParameter(state, values);
			return `${field} ${predicate.operator === "in" ? "IN" : "NOT IN"} (:...${parameter})`;
		}
		case "contains":
		case "icontains": {
			if (typeof value !== "string") {
				throw new TypeError(`The ${predicate.operator} operator requires a string value.`);
			}
			const parameter = nextParameter(state, `%${escapeLike(value)}%`);
			return `${field} ${predicate.operator === "contains" ? "LIKE" : "ILIKE"} :${parameter} ESCAPE '\\'`;
		}
		case "isnull":
			if (typeof value !== "boolean") {
				throw new TypeError("The isnull operator requires a boolean value.");
			}
			return `${field} IS ${value ? "" : "NOT "}NULL`;
		case "between": {
			const values = requireArray(value, predicate.operator);
			if (values.length !== 2) {
				throw new TypeError("The between operator requires exactly two values.");
			}
			const lower = nextParameter(state, values[0]);
			const upper = nextParameter(state, values[1]);
			return `${field} BETWEEN :${lower} AND :${upper}`;
		}
	}
}

function compileNode(predicate: CrudPredicate, state: CompileState): string {
	switch (predicate.kind) {
		case "comparison":
			return compileComparison(predicate, state);
		case "and":
			if (predicate.predicates.length === 0) return "1 = 1";
			return `(${predicate.predicates.map((item) => compileNode(item, state)).join(" AND ")})`;
		case "or":
			if (predicate.predicates.length === 0) return "1 = 0";
			return `(${predicate.predicates.map((item) => compileNode(item, state)).join(" OR ")})`;
		case "not":
			return `(NOT ${compileNode(predicate.predicate, state)})`;
	}
}

/** Compiles the neutral CRUD predicate to TypeORM QueryBuilder SQL and named parameters. */
export function compileTypeOrmPredicate(
	predicate: CrudPredicate,
	resolveField: TypeOrmFieldResolver,
): TypeOrmCompiledPredicate {
	const state: CompileState = { nextParameter: 0, parameters: {}, resolveField };
	return { sql: compileNode(predicate, state), parameters: state.parameters };
}
