#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDirectory, "../..");
const fixtureDirectory = join(scriptDirectory, "consumer-fixtures");

const packageDefinitions = [
	{ directory: "crud", fixture: "crud.ts", name: "@nestm/crud" },
	{ directory: "crud-memory", fixture: "crud-memory.ts", name: "@nestm/crud-memory" },
	{ directory: "crud-typeorm", fixture: "crud-typeorm.ts", name: "@nestm/crud-typeorm" },
	{ directory: "crud-drizzle", fixture: "crud-drizzle.ts", name: "@nestm/crud-drizzle" },
	{ directory: "crud-prisma", fixture: "crud-prisma.ts", name: "@nestm/crud-prisma" },
];

const temporaryRoot = await mkdtemp(join(tmpdir(), "nestm-crud-consumers-"));
const packsDirectory = join(temporaryRoot, "packs");
let succeeded = false;

try {
	await mkdir(packsDirectory);
	const rootManifest = await readJson(join(workspaceRoot, "package.json"));
	const manifests = new Map();
	const tarballs = new Map();

	for (const definition of packageDefinitions) {
		const packageDirectory = join(workspaceRoot, "packages", definition.directory);
		const manifest = await readJson(join(packageDirectory, "package.json"));
		assertPackageIdentity(definition, manifest);
		manifests.set(definition.name, manifest);

		report(`\nPacking ${definition.name}...`);
		await run("pnpm", ["--dir", packageDirectory, "pack", "--pack-destination", packsDirectory]);
		const tarball = join(packsDirectory, packedFilename(manifest.name, manifest.version));
		await access(tarball);
		tarballs.set(definition.name, tarball);
	}

	for (const definition of packageDefinitions) {
		report(`\nVerifying isolated consumer for ${definition.name}...`);
		await verifyConsumer({
			definition,
			manifests,
			rootManifest,
			tarballs,
		});
	}

	succeeded = true;
	report("\nAll five packed-package consumer checks passed.");
} finally {
	if (succeeded && process.env.KEEP_CONSUMER_TMP !== "1") {
		await rm(temporaryRoot, { force: true, recursive: true });
	} else {
		reportError(`Consumer workspace retained at ${temporaryRoot}`);
	}
}

async function verifyConsumer({ definition, manifests, rootManifest, tarballs }) {
	const consumerDirectory = join(temporaryRoot, `consumer-${definition.directory}`);
	await mkdir(consumerDirectory);

	const coreManifest = requiredMapValue(manifests, "@nestm/crud");
	const targetManifest = requiredMapValue(manifests, definition.name);
	const dependencies = {
		...consumerToolDependencies(rootManifest),
		...peerDependencies(rootManifest, coreManifest, targetManifest),
		"@nestm/crud": `file:${requiredMapValue(tarballs, "@nestm/crud")}`,
		...(definition.name === "@nestm/crud"
			? {}
			: { [definition.name]: `file:${requiredMapValue(tarballs, definition.name)}` }),
	};

	await writeFile(
		join(consumerDirectory, "package.json"),
		`${JSON.stringify(
			{
				name: `consumer-${definition.directory}`,
				private: true,
				type: "module",
				dependencies,
			},
			null,
			2,
		)}\n`,
	);
	await writeFile(
		join(consumerDirectory, "pnpm-workspace.yaml"),
		peerConfiguration(rootManifest, requiredMapValue(tarballs, "@nestm/crud")),
	);
	await copyFile(join(fixtureDirectory, "tsconfig.json"), join(consumerDirectory, "tsconfig.json"));
	await copyFile(
		join(fixtureDirectory, definition.fixture),
		join(consumerDirectory, "consumer.ts"),
	);

	await run(
		"pnpm",
		["install", "--strict-peer-dependencies", "--ignore-scripts", "--no-frozen-lockfile"],
		{ cwd: consumerDirectory },
	);
	await run("pnpm", ["exec", "tsc", "--project", "tsconfig.json"], {
		cwd: consumerDirectory,
	});
	await run(process.execPath, ["dist/consumer.js"], { cwd: consumerDirectory });
}

function consumerToolDependencies(rootManifest) {
	const development = requireObject(rootManifest.devDependencies, "root devDependencies");
	return {
		"@types/node": requireString(development["@types/node"], "@types/node version"),
		typescript: requireString(development.typescript, "TypeScript version"),
	};
}

function peerDependencies(rootManifest, ...manifests) {
	const development = requireObject(rootManifest.devDependencies, "root devDependencies");
	const names = new Set(
		manifests.flatMap((manifest) =>
			Object.keys(requireObject(manifest.peerDependencies ?? {}, "package peerDependencies")),
		),
	);
	return Object.fromEntries(
		[...names].toSorted().map((name) => {
			const version = development[name];
			if (typeof version !== "string") {
				throw new TypeError(
					`The workspace must pin the consumer peer dependency ${JSON.stringify(name)}.`,
				);
			}
			return [name, version];
		}),
	);
}

function peerConfiguration(rootManifest, coreTarball) {
	const development = requireObject(rootManifest.devDependencies, "root devDependencies");
	const common = requireString(development["@nestjs/common"], "@nestjs/common version");
	const core = requireString(development["@nestjs/core"], "@nestjs/core version");
	const swagger = requireString(development["@nestjs/swagger"], "@nestjs/swagger version");
	return [
		"strictPeerDependencies: true",
		"overrides:",
		`  "@nestm/crud": ${JSON.stringify(`file:${coreTarball}`)}`,
		"peerDependencyRules:",
		"  allowedVersions:",
		`    "@nestjs/core@${core}>@nestjs/common": "${common}"`,
		`    "@nestjs/mapped-types>@nestjs/common": "${common}"`,
		`    "@nestjs/swagger@${swagger}>@nestjs/common": "${common}"`,
		`    "@nestjs/swagger@${swagger}>@nestjs/core": "${core}"`,
		"",
	].join("\n");
}

function assertPackageIdentity(definition, manifest) {
	const name = requireString(manifest.name, `${definition.directory} package name`);
	if (name !== definition.name) {
		throw new TypeError(
			`Expected ${definition.directory} to contain ${definition.name}, got ${name}.`,
		);
	}
	requireString(manifest.version, `${definition.name} package version`);
}

function packedFilename(name, version) {
	return `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`;
}

async function readJson(path) {
	return requireObject(JSON.parse(await readFile(path, "utf8")), path);
}

function requiredMapValue(map, key) {
	const value = map.get(key);
	if (value === undefined) throw new TypeError(`Missing required value for ${key}.`);
	return value;
}

function requireObject(value, description) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError(`Expected ${description} to be an object.`);
	}
	return value;
}

function requireString(value, description) {
	if (typeof value !== "string" || value.length === 0) {
		throw new TypeError(`Expected ${description} to be a non-empty string.`);
	}
	return value;
}

function report(message) {
	process.stdout.write(`${message}\n`);
}

function reportError(message) {
	process.stderr.write(`${message}\n`);
}

async function run(command, arguments_, options = {}) {
	await new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(command, arguments_, {
			cwd: options.cwd ?? workspaceRoot,
			env: { ...process.env, CI: "1" },
			stdio: "inherit",
		});
		child.once("error", rejectPromise);
		child.once("exit", (code, signal) => {
			if (code === 0) {
				resolvePromise();
				return;
			}
			rejectPromise(
				new Error(
					`${command} ${arguments_.join(" ")} failed${
						signal === null ? ` with exit code ${String(code)}` : ` from signal ${signal}`
					}.`,
				),
			);
		});
	});
}
