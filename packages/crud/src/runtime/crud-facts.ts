import { InternalServerErrorException } from "@nestjs/common";

declare const CRUD_FACT_VALUE: unique symbol;
const CRUD_FACT_IDENTITY: unique symbol = Symbol("@nestm/crud:fact");
const CRUD_FACT_ENTRY: unique symbol = Symbol("@nestm/crud:fact-entry");

/** An identity-keyed, typed value produced by a CRUD scope for later mutation phases. */
export interface CrudFact<Value> {
	readonly name: string;
	/** @internal Nominal identity; construct facts with {@link defineCrudFact}. */
	readonly [CRUD_FACT_IDENTITY]: true;
	/** @internal Carries the fact's value type without exposing a mutable property. */
	readonly [CRUD_FACT_VALUE]?: Value;
}

/** Opaque key/value pair constructed by {@link provideCrudFact}. */
export interface CrudFactEntry {
	/** @internal Prevents a fact and value of unrelated types from being paired manually. */
	readonly [CRUD_FACT_ENTRY]: Readonly<{
		readonly fact: CrudFact<unknown>;
		readonly value: unknown;
	}>;
}

/** Read-only transaction-local facts available after all scopes have resolved. */
export interface CrudFacts {
	has<Value>(fact: CrudFact<Value>): boolean;
	get<Value>(fact: CrudFact<Value>): Value | undefined;
	require<Value>(fact: CrudFact<Value>): Value;
}

export function defineCrudFact<Value>(name: string): CrudFact<Value> {
	if (typeof name !== "string" || name.trim() === "") {
		throw new TypeError("A CRUD fact name cannot be empty.");
	}
	return Object.freeze({ name, [CRUD_FACT_IDENTITY]: true as const });
}

export function provideCrudFact<Value>(
	fact: CrudFact<Value>,
	value: NoInfer<Value>,
): CrudFactEntry {
	return Object.freeze({
		[CRUD_FACT_ENTRY]: Object.freeze({ fact, value }),
	});
}

class ResolvedCrudFacts implements CrudFacts {
	readonly #values: ReadonlyMap<CrudFact<unknown>, unknown>;

	constructor(entries: readonly CrudFactEntry[]) {
		const values = new Map<CrudFact<unknown>, unknown>();
		for (const entry of entries) {
			const { fact, value } = entry[CRUD_FACT_ENTRY];
			if (values.has(fact)) {
				throw new InternalServerErrorException(
					`CRUD fact "${fact.name}" was provided more than once.`,
				);
			}
			values.set(fact, value);
		}
		this.#values = values;
	}

	has<Value>(fact: CrudFact<Value>): boolean {
		return this.#values.has(fact as CrudFact<unknown>);
	}

	get<Value>(fact: CrudFact<Value>): Value | undefined {
		return this.#values.get(fact as CrudFact<unknown>) as Value | undefined;
	}

	require<Value>(fact: CrudFact<Value>): Value {
		if (!this.has(fact)) {
			throw new InternalServerErrorException(`CRUD fact "${fact.name}" was not provided.`);
		}
		return this.get(fact) as Value;
	}
}

export function resolveCrudFacts(entries: readonly CrudFactEntry[]): CrudFacts {
	return Object.freeze(new ResolvedCrudFacts(entries));
}

export const EMPTY_CRUD_FACTS: CrudFacts = resolveCrudFacts([]);
