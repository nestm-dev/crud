import type { CrudOrder, CrudPredicate } from "../query/query.types.ts";
import { CrudCursorError } from "./cursor.error.ts";

/**
 * Produces `(a > A) OR (a = A AND b > B) ...`, reversing comparisons for
 * descending order, so adapters can compile a portable keyset predicate.
 */
export function buildCrudCursorPredicate<Field extends string>(
	order: readonly CrudOrder<Field>[],
	values: readonly unknown[],
): CrudPredicate<Field> {
	if (order.length === 0 || order.length !== values.length) {
		throw new CrudCursorError("invalid_payload");
	}
	const branches: CrudPredicate<Field>[] = [];
	for (let index = 0; index < order.length; index += 1) {
		const currentOrder = order[index];
		const currentValue = values[index];
		if (currentOrder === undefined || currentValue === null || currentValue === undefined) {
			throw new CrudCursorError("invalid_payload");
		}
		const comparisons: CrudPredicate<Field>[] = [];
		for (let prefixIndex = 0; prefixIndex < index; prefixIndex += 1) {
			const prefixOrder = order[prefixIndex];
			const prefixValue = values[prefixIndex];
			if (prefixOrder === undefined || prefixValue === null || prefixValue === undefined) {
				throw new CrudCursorError("invalid_payload");
			}
			comparisons.push({
				kind: "comparison",
				field: prefixOrder.field,
				operator: "eq",
				value: prefixValue,
			});
		}
		comparisons.push({
			kind: "comparison",
			field: currentOrder.field,
			operator: currentOrder.direction === "asc" ? "gt" : "lt",
			value: currentValue,
		});
		branches.push(
			comparisons.length === 1 ? comparisons[0]! : { kind: "and", predicates: comparisons },
		);
	}
	return branches.length === 1 ? branches[0]! : { kind: "or", predicates: branches };
}
