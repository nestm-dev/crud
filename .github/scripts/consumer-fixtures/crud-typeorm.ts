import assert from "node:assert/strict";
import "reflect-metadata";

import {
	TypeOrmCrudAdapter,
	TypeOrmCrudTransactionIsolationLevel,
	bindTypeOrmCrud,
	compileTypeOrmPredicate,
	createTypeOrmCrudAdapter,
} from "@nestm/crud-typeorm";
import type { IsolationLevel } from "typeorm/driver/types/IsolationLevel.js";

assert.equal(typeof TypeOrmCrudAdapter, "function");
assert.equal(typeof bindTypeOrmCrud, "function");
assert.equal(typeof compileTypeOrmPredicate, "function");
assert.equal(typeof createTypeOrmCrudAdapter, "function");
const isolationLevel: IsolationLevel = TypeOrmCrudTransactionIsolationLevel.RepeatableRead;
const configuredIsolationLevel: TypeOrmCrudTransactionIsolationLevel = "READ COMMITTED";
assert.equal(isolationLevel, "REPEATABLE READ");
assert.equal(configuredIsolationLevel, TypeOrmCrudTransactionIsolationLevel.ReadCommitted);

process.stdout.write("@nestm/crud-typeorm imported from its isolated packed artifact.\n");
