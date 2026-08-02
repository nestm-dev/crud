import assert from "node:assert/strict";
import "reflect-metadata";

import type { CrudCreateMappingValues } from "@nestm/crud/adapter";

import {
	DrizzleCrudAdapter,
	bindDrizzleCrud,
	compileDrizzlePredicate,
	createDrizzleCrudAdapter,
	type DrizzleCrudRowPredicateContext,
	type DrizzleCrudTransactionRunnerContext,
} from "@nestm/crud-drizzle";

const inspectTransactionContext = (context: DrizzleCrudTransactionRunnerContext): string =>
	`${context.resource}:${context.accessMode}:${context.isolationLevel}:${String(context.mustOwnCommit)}`;
const inspectRowContext = (context: DrizzleCrudRowPredicateContext<never>): string =>
	context.context.resource;
void inspectTransactionContext;
void inspectRowContext;

type ScopedDocumentInsert = {
	readonly id: string;
	readonly organizationId: string;
	readonly ownerId: string;
	readonly title: string;
};
const scopedCreateValues: CrudCreateMappingValues<
	ScopedDocumentInsert,
	"organizationId" | "ownerId"
> = { id: "document-id", title: "Packed type seam" };
void scopedCreateValues;

assert.equal(typeof DrizzleCrudAdapter, "function");
assert.equal(typeof bindDrizzleCrud, "function");
assert.equal(typeof compileDrizzlePredicate, "function");
assert.equal(typeof createDrizzleCrudAdapter, "function");

process.stdout.write("@nestm/crud-drizzle imported from its isolated packed artifact.\n");
