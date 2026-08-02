import assert from "node:assert/strict";
import "reflect-metadata";

import {
	TypeOrmCrudAdapter,
	bindTypeOrmCrud,
	compileTypeOrmPredicate,
	createTypeOrmCrudAdapter,
} from "@nestm/crud-typeorm";

assert.equal(typeof TypeOrmCrudAdapter, "function");
assert.equal(typeof bindTypeOrmCrud, "function");
assert.equal(typeof compileTypeOrmPredicate, "function");
assert.equal(typeof createTypeOrmCrudAdapter, "function");

process.stdout.write("@nestm/crud-typeorm imported from its isolated packed artifact.\n");
