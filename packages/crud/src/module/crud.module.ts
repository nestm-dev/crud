import {
	Module,
	type DynamicModule,
	type InjectionToken,
	type ModuleMetadata,
	type Provider,
} from "@nestjs/common";

import type { CrudAdapter } from "../adapter/adapter.types.ts";
import { isCrudBinding, type CrudResourceBinding } from "../adapter/binding.types.ts";
import { createCrudController, getCrudControllerName } from "../controller/controller.factory.ts";
import { HmacSha256CrudCursorCodec } from "../cursor/hmac-sha256-cursor-codec.ts";
import type { CrudCursorCodec } from "../cursor/cursor.types.ts";
import { CrudRegistry } from "../runtime/crud-registry.ts";
import { CrudService } from "../runtime/crud.service.ts";
import type { CrudLifecycleHook, CrudScope } from "../runtime/runtime.types.ts";
import {
	resolveCrudModuleOptions,
	type CrudModuleOptions,
	type ResolvedCrudModuleOptions,
} from "./crud-module.options.ts";
import {
	CRUD_CURSOR_CODEC,
	CRUD_MODULE_OPTIONS,
	CRUD_RESOLVED_OPTIONS,
	getCrudAdapterToken,
	getCrudBindingToken,
	getCrudRegistrationToken,
	getCrudServiceToken,
} from "./crud.tokens.ts";
import type { CrudFactoryDependencyTuple } from "./factory-provider.types.ts";

type CrudModuleAsyncInjection<Dependencies extends readonly unknown[]> =
	Dependencies extends readonly []
		? { readonly inject?: CrudFactoryDependencyTuple<Dependencies> }
		: { readonly inject: CrudFactoryDependencyTuple<Dependencies> };

export type CrudModuleAsyncOptions<Dependencies extends readonly unknown[] = readonly []> = Pick<
	ModuleMetadata,
	"imports"
> &
	CrudModuleAsyncInjection<Dependencies> & {
		readonly useFactory: (
			...dependencies: Dependencies
		) => CrudModuleOptions | Promise<CrudModuleOptions>;
	};

export interface CrudFeatureOptions<
	Resources extends readonly CrudResourceBinding[] = readonly CrudResourceBinding[],
> {
	readonly imports?: ModuleMetadata["imports"];
	readonly resources: Resources;
}

@Module({})
export class CrudModule {
	static forRoot(options: CrudModuleOptions = {}): DynamicModule {
		return rootModule({ provide: CRUD_MODULE_OPTIONS, useValue: options });
	}

	static forRootAsync<const Dependencies extends readonly unknown[]>(
		options: CrudModuleAsyncOptions<Dependencies>,
	): DynamicModule {
		return rootModule(
			{
				provide: CRUD_MODULE_OPTIONS,
				inject: [...(options.inject ?? [])],
				useFactory: options.useFactory,
			},
			options.imports,
		);
	}

	static forFeature<const Resources extends readonly CrudResourceBinding[]>(
		options: CrudFeatureOptions<Resources>,
	): DynamicModule {
		assertFeatureBindings(options.resources);
		const imports = [
			...(options.imports ?? []),
			...options.resources.flatMap((binding) => binding.imports ?? []),
		];
		const controllers = options.resources.map(({ resource }) => createCrudController(resource));
		const providers = options.resources.flatMap(featureProviders);
		return {
			module: CrudModule,
			imports,
			controllers,
			providers,
			exports: options.resources.map(({ resource }) => getCrudServiceToken(resource)),
		};
	}
}

function rootModule(
	optionsProvider: Provider,
	imports: ModuleMetadata["imports"] = [],
): DynamicModule {
	const providers: Provider[] = [
		optionsProvider,
		{
			provide: CRUD_RESOLVED_OPTIONS,
			inject: [CRUD_MODULE_OPTIONS],
			useFactory: (options: CrudModuleOptions): ResolvedCrudModuleOptions =>
				resolveCrudModuleOptions(options),
		},
		{
			provide: CRUD_CURSOR_CODEC,
			inject: [CRUD_RESOLVED_OPTIONS],
			useFactory: (options: ResolvedCrudModuleOptions): CrudCursorCodec | undefined =>
				options.cursor === undefined
					? undefined
					: new HmacSha256CrudCursorCodec(options.cursor.secret),
		},
		CrudRegistry,
	];
	return {
		module: CrudModule,
		global: true,
		imports,
		providers,
		exports: [CRUD_RESOLVED_OPTIONS, CRUD_CURSOR_CODEC, CrudRegistry],
	};
}

function featureProviders(binding: CrudResourceBinding): readonly Provider[] {
	const { resource } = binding;
	const adapterToken = getCrudAdapterToken(resource);
	const bindingToken = getCrudBindingToken(resource);
	const serviceToken = getCrudServiceToken(resource);
	const hookTokens = resource.hooks ?? [];
	const scopeTokens = resource.scopes ?? [];
	return [
		{ provide: bindingToken, useValue: binding },
		adapterProvider(adapterToken, binding),
		{
			provide: serviceToken,
			inject: [
				adapterToken,
				CRUD_RESOLVED_OPTIONS,
				CRUD_CURSOR_CODEC,
				CrudRegistry,
				...hookTokens,
				...scopeTokens,
			],
			useFactory: (...dependencies: readonly unknown[]): CrudService => {
				const adapter = dependencies[0] as CrudAdapter;
				const resolved = dependencies[1] as ResolvedCrudModuleOptions;
				const cursor = dependencies[2] as CrudCursorCodec | undefined;
				const registry = dependencies[3] as CrudRegistry;
				const hookOffset = 4;
				const hooks = dependencies.slice(
					hookOffset,
					hookOffset + hookTokens.length,
				) as readonly CrudLifecycleHook[];
				const scopes = dependencies.slice(hookOffset + hookTokens.length) as readonly CrudScope[];
				return new CrudService(
					resource,
					binding,
					adapter,
					hooks,
					scopes,
					registry,
					resolved,
					cursor,
				);
			},
		},
		{
			provide: getCrudRegistrationToken(resource),
			inject: [CrudRegistry, bindingToken, serviceToken],
			useFactory: (
				registry: CrudRegistry,
				registeredBinding: CrudResourceBinding,
				service: CrudService,
			): true => {
				registry.register(registeredBinding, service);
				return true;
			},
		},
	];
}

function adapterProvider(token: InjectionToken, binding: CrudResourceBinding): Provider {
	const provider = binding.adapter;
	if ("useValue" in provider) return { provide: token, useValue: provider.useValue };
	if ("useClass" in provider) return { provide: token, useClass: provider.useClass };
	if ("useExisting" in provider) return { provide: token, useExisting: provider.useExisting };
	return {
		provide: token,
		inject: [...(provider.inject ?? [])],
		useFactory: provider.useFactory,
	};
}

function assertFeatureBindings(
	bindings: readonly unknown[],
): asserts bindings is readonly CrudResourceBinding[] {
	const names = new Set<string>();
	const controllers = new Set<string>();
	for (const binding of bindings) {
		if (!isCrudBinding(binding)) {
			throw new TypeError("CrudModule.forFeature() resources must be CRUD adapter bindings.");
		}
		if (names.has(binding.resource.name)) {
			throw new TypeError(`Duplicate CRUD resource name "${binding.resource.name}".`);
		}
		names.add(binding.resource.name);
		const controllerName = getCrudControllerName(binding.resource);
		if (controllers.has(controllerName)) {
			throw new TypeError(`Duplicate generated CRUD controller name "${controllerName}".`);
		}
		controllers.add(controllerName);
	}
}
