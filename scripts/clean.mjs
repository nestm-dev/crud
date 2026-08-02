import { rm } from "node:fs/promises";
import { glob } from "node:fs/promises";

for await (const path of glob(["packages/*/dist", "packages/*/dist-tsc", "coverage"])) {
	await rm(path, { force: true, recursive: true });
}
