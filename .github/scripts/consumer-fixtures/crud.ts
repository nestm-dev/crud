import assert from "node:assert/strict";
import "reflect-metadata";

import * as crud from "@nestm/crud";
import * as adapter from "@nestm/crud/adapter";
import * as testing from "@nestm/crud/testing";

assert.equal(typeof crud.CrudModule, "function");
assert.equal(typeof crud.defineCrudResource, "function");
assert.equal(typeof adapter.defineCrudBinding, "function");
assert.equal(typeof adapter.CrudAdapterError, "function");
assert.equal(typeof adapter.isCrudAdapterError, "function");
assert.equal(typeof testing.runCrudAdapterConformance, "function");
assert.equal(typeof testing.InsecureCrudCursorCodec, "function");

process.stdout.write("@nestm/crud entry points imported from the packed artifact.\n");
