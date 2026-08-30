import type { AnyCrudResource, CrudField, CrudFieldTuple } from "../resource/resource.types.ts";

export type CrudRelationType = "belongsTo" | "hasOne" | "hasMany";

export interface CrudRelationConfig<
	LocalField extends string = string,
	Target extends AnyCrudResource = AnyCrudResource,
> {
	readonly type: CrudRelationType;
	readonly target: () => Target;
	readonly local: CrudFieldTuple<LocalField>;
	readonly foreign: CrudFieldTuple<CrudField<Target>>;
	readonly maxItems?: number;
}

export function defineCrudRelation<
	const Target extends AnyCrudResource,
	const Relation extends CrudRelationConfig<string, Target>,
>(relation: Relation): Relation {
	if (!(["belongsTo", "hasOne", "hasMany"] as const).includes(relation.type)) {
		throw new TypeError("A CRUD relation must declare a supported relation type.");
	}
	if (typeof relation.target !== "function") {
		throw new TypeError("A CRUD relation must declare a target factory.");
	}
	if (relation.local.length === 0 || relation.local.length !== relation.foreign.length) {
		throw new TypeError("A CRUD relation must declare equally-sized, non-empty key tuples.");
	}
	if (
		[...relation.local, ...relation.foreign].some(
			(field) => typeof field !== "string" || field.trim() === "",
		) ||
		new Set(relation.local).size !== relation.local.length ||
		new Set(relation.foreign).size !== relation.foreign.length
	) {
		throw new TypeError("A CRUD relation key tuple must contain unique, non-empty fields.");
	}
	if (relation.type !== "hasMany" && relation.maxItems !== undefined) {
		throw new TypeError("Only a hasMany CRUD relation can declare maxItems.");
	}
	if (
		relation.maxItems !== undefined &&
		(!Number.isSafeInteger(relation.maxItems) ||
			relation.maxItems < 1 ||
			relation.maxItems === Number.MAX_SAFE_INTEGER)
	) {
		throw new TypeError(
			"A hasMany relation maxItems value must be a positive safe integer below Number.MAX_SAFE_INTEGER.",
		);
	}
	return Object.freeze({
		...relation,
		local: Object.freeze([...relation.local]),
		foreign: Object.freeze([...relation.foreign]),
	}) as Relation;
}
