import { createParamDecorator, type ExecutionContext } from "@nestjs/common";

export const CrudContext = createParamDecorator(
	(_data: unknown, context: ExecutionContext): ExecutionContext => context,
);
