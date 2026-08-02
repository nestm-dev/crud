import {
	Injectable,
	Optional,
	StandardSchemaSerializerInterceptor,
	StandardSchemaValidationPipe,
	type OnApplicationBootstrap,
} from "@nestjs/common";
import { ApplicationConfig } from "@nestjs/core";

import type { CrudResourceBinding } from "../adapter/binding.types.ts";
import type { AnyCrudResource } from "../resource/resource.types.ts";
import type { CrudOperationName } from "../resource/operations.ts";
import { isCrudResource } from "../resource/define-resource.ts";
import type { CrudService } from "./crud.service.ts";

interface CrudRegistryEntry {
	readonly binding: CrudResourceBinding;
	readonly resource: AnyCrudResource;
	readonly service: CrudService;
}

const ROUTES: Readonly<Record<CrudOperationName, readonly [string, string]>> = {
	create: ["POST", ""],
	list: ["GET", ""],
	read: ["GET", "item"],
	update: ["PATCH", "item"],
	delete: ["DELETE", "item"],
	restore: ["POST", "restore"],
};

@Injectable()
export class CrudRegistry implements OnApplicationBootstrap {
	readonly #entries = new Map<string, CrudRegistryEntry>();
	readonly #routes = new Map<string, string>();
	readonly #controllers = new Map<string, string>();

	constructor(@Optional() private readonly applicationConfig?: ApplicationConfig) {}

	register(binding: CrudResourceBinding, service: CrudService): void {
		const { resource } = binding;
		if (this.#entries.has(resource.name)) {
			throw new TypeError(`Duplicate CRUD resource name "${resource.name}".`);
		}
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
		return this.get(resource.name);
	}

	list(): readonly CrudRegistryEntry[] {
		return [...this.#entries.values()];
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
