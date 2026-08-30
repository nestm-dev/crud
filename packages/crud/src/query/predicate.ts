import type { CrudPredicate } from "./query.types.ts";

/** Combines predicates without producing redundant one-element `and` nodes. */
export function andCrudPredicates<Field extends string>(
	...predicates: readonly (CrudPredicate<Field> | undefined)[]
): CrudPredicate<Field> | undefined {
	const defined = predicates.filter(
		(predicate): predicate is CrudPredicate<Field> => predicate !== undefined,
	);
	if (defined.length === 0) {
		return undefined;
	}
	if (defined.length === 1) {
		return defined[0];
	}
	return { kind: "and", predicates: defined };
}

/** Combines predicates without producing redundant one-element `or` nodes. */
export function orCrudPredicates<Field extends string>(
	...predicates: readonly (CrudPredicate<Field> | undefined)[]
): CrudPredicate<Field> | undefined {
	const defined = predicates.filter(
		(predicate): predicate is CrudPredicate<Field> => predicate !== undefined,
	);
	if (defined.length === 0) {
		return undefined;
	}
	if (defined.length === 1) {
		return defined[0];
	}
	return { kind: "or", predicates: defined };
}
