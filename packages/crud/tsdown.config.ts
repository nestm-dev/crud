import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts", "src/adapter/index.ts", "src/testing/index.ts"],
	format: ["esm"],
	platform: "node",
	target: "node22",
	dts: true,
	sourcemap: true,
	clean: true,
	fixedExtension: true,
	deps: {
		neverBundle: [/^@nestjs\//, /^@nestm\//, /^@standard-schema\//, "reflect-metadata", "rxjs"],
	},
});
