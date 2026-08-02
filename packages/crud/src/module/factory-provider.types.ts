import type { InjectionToken } from "@nestjs/common";

/** A Nest injection token, optionally marked as an optional factory dependency. */
export type CrudFactoryDependency<Value = unknown> =
	| InjectionToken<Value>
	| {
			readonly token: InjectionToken<Value>;
			readonly optional: true;
	  };

/** Maps a factory's dependency value tuple to its equally-sized injection-token tuple. */
export type CrudFactoryDependencyTuple<Dependencies extends readonly unknown[]> = {
	readonly [Index in keyof Dependencies]: CrudFactoryDependency<Dependencies[Index]>;
};

/** A factory provider whose injected dependencies and callback parameters share one tuple type. */
export interface CrudFactoryProvider<Result, Dependencies extends readonly unknown[]> {
	readonly inject: CrudFactoryDependencyTuple<Dependencies>;
	readonly useFactory: (...dependencies: Dependencies) => Result | Promise<Result>;
}

/** Preserves dependency-tuple inference for a factory provider before it is passed to a binder. */
export function defineCrudFactoryProvider<Result, const Dependencies extends readonly unknown[]>(
	provider: CrudFactoryProvider<Result, Dependencies>,
): CrudFactoryProvider<Result, Dependencies> {
	return provider;
}
