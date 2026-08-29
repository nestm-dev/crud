import {
	Injectable,
	Optional,
	StandardSchemaSerializerInterceptor,
	StandardSchemaValidationPipe,
	type ExecutionContext,
	type OnApplicationBootstrap,
} from "@nestjs/common";
import { ApplicationConfig } from "@nestjs/core";

import type { CrudResourceBinding } from "../adapter/binding.types.ts";
import type { AnyCrudResource } from "../resource/resource.types.ts";
import type { CrudOperationName } from "../resource/operations.ts";
import { isCrudResource } from "../resource/define-resource.ts";

interface ErasedRelationReadOptions {
	readonly fields: readonly string[];
	readonly tuples: readonly (readonly unknown[])[];
	readonly executionContext?: ExecutionContext;
	readonly limit: number;
	readonly maxItems: number;
	readonly relationName: string;
	readonly relationType: "hasMany" | "hasOne" | "belongsTo";
}

interface CrudRelationService {
	readonly adapter: { getField(record: unknown, field: string): unknown };
	readForRelation(options: ErasedRelationReadOptions): Promise<{
		readonly records: readonly unknown[];
		readonly responses: readonly unknown[];
	}>;
}

interface CrudRegistryEntry {
	readonly binding: CrudResourceBinding;
	readonly resource: AnyCrudResource;
	readonly service: CrudRelationService;
}

const ROUTES: Readonly<Record<CrudOperationName, readonly [string, string]>> = {
	create: ["POST", ""],
	list: ["GET", ""],
	read: ["GET", "item"],
	update: ["PATCH", "item"],
	delete: ["DELETE", "item"],
	restore: ["POST", "restore"],
	upsert: ["PUT", "item"],
};

@Injectable()
export class CrudRegistry implements OnApplicationBootstrap {
	readonly #entries = new Map<string, CrudRegistryEntry>();
	readonly #routes = new Map<string, string>();
	readonly #controllers = new Map<string, string>();

	constructor(@Optional() private readonly applicationConfig?: ApplicationConfig) {}

	register(
		binding: CrudResourceBinding,
		service: CrudRelationService,
		registerGeneratedController = true,
	): void {
		const { resource } = binding;
		if (this.#entries.has(resource.name)) {
			throw new TypeError(`Duplicate CRUD resource name "${resource.name}".`);
		}
		if (registerGeneratedController) this.#registerGeneratedController(resource);
		this.#entries.set(resource.name, { binding, resource, service });
	}

	onApplicationBootstrap(): void {
		this.#assertStandardSchemaRuntime();
		for (const { binding, resource } of this.#entries.values()) {
			for (const [name, relation] of Object.entries(resource.relations ?? {})) {
				const target = relation.target();
				if (!isCrudResource(target)) {
					throw new TypeError(
						`CRUD relation "${resource.name}.${name}" returned an invalid target resource.`,
					);
				}
				const targetEntry = this.#entries.get(target.name);
				if (targetEntry === undefined) {
					throw new TypeError(
						`CRUD relation "${resource.name}.${name}" targets unregistered resource "${target.name}".`,
					);
				}
				if (targetEntry.resource.pathParams !== undefined) {
					throw new TypeError(
						`CRUD relation "${resource.name}.${name}" cannot target nested resource "${target.name}".`,
					);
				}
				if (targetEntry.resource !== target) {
					throw new TypeError(
						`CRUD relation "${resource.name}.${name}" must return the exact registered resource "${target.name}".`,
					);
				}
				for (const field of relation.local) {
					if (!binding.fields.includes(field)) {
						throw new TypeError(
							`CRUD relation "${resource.name}.${name}" has unmapped local field "${field}".`,
						);
					}
				}
				for (const field of relation.foreign) {
					if (!targetEntry.binding.fields.includes(field)) {
						throw new TypeError(
							`CRUD relation "${resource.name}.${name}" has unmapped target field "${field}".`,
						);
					}
				}
			}
		}
	}

	get(name: string): CrudRegistryEntry {
		const entry = this.#entries.get(name);
		if (entry === undefined) {
			throw new TypeError(`CRUD relation target "${name}" is not registered.`);
		}
		return entry;
	}

	getResource(resource: AnyCrudResource): CrudRegistryEntry {
		const entry = this.get(resource.name);
		if (entry.resource !== resource) {
			throw new TypeError(
				`CRUD resource "${resource.name}" does not match the exact registered resource identity.`,
			);
		}
		return entry;
	}

	list(): readonly CrudRegistryEntry[] {
		return [...this.#entries.values()];
	}

	#registerGeneratedController(resource: AnyCrudResource): void {
		const controller = controllerName(resource.name);
		const controllerOwner = this.#controllers.get(controller);
		if (controllerOwner !== undefined) {
			throw new TypeError(
				`Generated controller name "${controller}" collides for "${controllerOwner}" and "${resource.name}".`,
			);
		}
		const routeSignatures: string[] = [];
		for (const operation of Object.keys(resource.operations) as CrudOperationName[]) {
			const [method, suffix] = ROUTES[operation];
			const item = normalizePath(`${resource.path}/${resource.itemPath}`);
			const path =
				suffix === "" ? normalizePath(resource.path) : suffix === "item" ? item : `${item}/restore`;
			for (const version of versionKeys(resource.version)) {
				const signature = `${version}:${method}:${path}`;
				const owner = this.#routes.get(signature);
				if (owner !== undefined) {
					throw new TypeError(
						`CRUD route ${signature} is registered by both "${owner}" and "${resource.name}".`,
					);
				}
				routeSignatures.push(signature);
			}
		}
		for (const signature of routeSignatures) this.#routes.set(signature, resource.name);
		this.#controllers.set(controller, resource.name);
	}

	#assertStandardSchemaRuntime(): void {
		if (this.#entries.size === 0 || this.applicationConfig === undefined) return;
		const hasValidation = this.applicationConfig
			.getGlobalPipes()
			.some((pipe) => pipe instanceof StandardSchemaValidationPipe);
		const hasSerialization = this.applicationConfig
			.getGlobalInterceptors()
			.some((interceptor) => interceptor instanceof StandardSchemaSerializerInterceptor);
		if (!hasValidation || !hasSerialization) {
			throw new TypeError(
				"CRUD resources require StandardSchemaModule.forRoot() with validation and serialization enabled.",
			);
		}
	}
}

function normalizePath(path: string): string {
	return `/${path}`
		.replaceAll(/\/{2,}/g, "/")
		.replace(/\/$/, "")
		.replaceAll(/:[A-Za-z_][A-Za-z0-9_]*/g, ":parameter");
}

function versionKeys(version: AnyCrudResource["version"]): readonly string[] {
	if (version === undefined) return ["neutral"];
	const versions = Array.isArray(version) ? version : [version];
	return [...new Set(versions.map((item) => (typeof item === "symbol" ? "neutral" : `v${item}`)))];
}

function controllerName(name: string): string {
	const normalized = name
		.normalize("NFKD")
		.replaceAll(/[^A-Za-z0-9]+/g, " ")
		.trim()
		.split(/\s+/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");
	return `${normalized || "Anonymous"}CrudController`;
}
