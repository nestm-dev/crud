import assert from "node:assert/strict";
import "reflect-metadata";

import {
	PrismaCrudAdapter,
	bindPrismaCrud,
	compilePrismaPredicate,
	createPrismaCrudAdapter,
} from "@nestm/crud-prisma";

assert.equal(typeof PrismaCrudAdapter, "function");
assert.equal(typeof bindPrismaCrud, "function");
assert.equal(typeof compilePrismaPredicate, "function");
assert.equal(typeof createPrismaCrudAdapter, "function");

process.stdout.write("@nestm/crud-prisma imported from its isolated packed artifact.\n");
