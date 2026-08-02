import assert from "node:assert/strict";
import "reflect-metadata";

import {
	DrizzleCrudAdapter,
	bindDrizzleCrud,
	compileDrizzlePredicate,
	createDrizzleCrudAdapter,
} from "@nestm/crud-drizzle";

assert.equal(typeof DrizzleCrudAdapter, "function");
assert.equal(typeof bindDrizzleCrud, "function");
assert.equal(typeof compileDrizzlePredicate, "function");
assert.equal(typeof createDrizzleCrudAdapter, "function");

process.stdout.write("@nestm/crud-drizzle imported from its isolated packed artifact.\n");
