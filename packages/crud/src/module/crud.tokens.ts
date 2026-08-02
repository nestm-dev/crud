import type { InjectionToken } from "@nestjs/common";

import type { AnyCrudResource } from "../resource/resource.types.ts";
import type { CrudService } from "../runtime/crud.service.ts";

export const CRUD_MODULE_OPTIONS = Symbol.for("@nestm/crud:module-options");
export const CRUD_RESOLVED_OPTIONS = Symbol.for("@nestm/crud:resolved-options");
export const CRUD_CURSOR_CODEC = Symbol.for("@nestm/crud:cursor-codec");

declare const CRUD_SERVICE_TOKEN_RESOURCE: unique symbol;

function tokenPart(resource: AnyCrudResource): string {
	return encodeURIComponent(resource.name);
}

export function getCrudAdapterToken(resource: AnyCrudResource): InjectionToken {
	return Symbol.for(`@nestm/crud:adapter:${tokenPart(resource)}`);
}

export function getCrudBindingToken(resource: AnyCrudResource): InjectionToken {
	return Symbol.for(`@nestm/crud:binding:${tokenPart(resource)}`);
}

export type CrudServiceToken<Resource extends AnyCrudResource> = InjectionToken<
	CrudService<Resource>
> & {
	readonly [CRUD_SERVICE_TOKEN_RESOURCE]: Resource;
};

export function getCrudServiceToken<const Resource extends AnyCrudResource>(
	resource: Resource,
): CrudServiceToken<Resource> {
	// The runtime identity remains Nest's globally stable symbol; the invariant brand only
	// carries the exact resource through TypeScript and has no runtime representation.
	return Symbol.for(`@nestm/crud:service:${tokenPart(resource)}`) as CrudServiceToken<Resource>;
}

export function getCrudRegistrationToken(resource: AnyCrudResource): InjectionToken {
	return Symbol.for(`@nestm/crud:registration:${tokenPart(resource)}`);
}
