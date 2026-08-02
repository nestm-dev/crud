import type { CrudPredicate } from "./query.types.ts";

/** Combines predicates without producing redundant one-element `and` nodes. */
export function andCrudPredicates(
	...predicates: readonly (CrudPredicate | undefined)[]
): CrudPredicate | undefined {
	const defined = predicates.filter(
		(predicate): predicate is CrudPredicate => predicate !== undefined,
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
export function orCrudPredicates(
	...predicates: readonly (CrudPredicate | undefined)[]
): CrudPredicate | undefined {
	const defined = predicates.filter(
		(predicate): predicate is CrudPredicate => predicate !== undefined,
	);
	if (defined.length === 0) {
		return undefined;
	}
	if (defined.length === 1) {
		return defined[0];
	}
	return { kind: "or", predicates: defined };
}
