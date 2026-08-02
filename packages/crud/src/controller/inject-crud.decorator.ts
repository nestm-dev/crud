import { Inject } from "@nestjs/common";

import { getCrudServiceToken } from "../module/crud.tokens.ts";
import type { AnyCrudResource } from "../resource/resource.types.ts";

export function InjectCrud(resource: AnyCrudResource): ParameterDecorator & PropertyDecorator {
	return Inject(getCrudServiceToken(resource));
}
