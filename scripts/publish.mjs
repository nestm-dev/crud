import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

import { assertFixedGroup, assertFixedVersions } from "./publish-state.mjs";

if (
	process.env.GITHUB_ACTIONS !== "true" ||
	process.env.GITHUB_REF !== "refs/heads/main" ||
	typeof process.env.GITHUB_SHA !== "string"
) {
	throw new Error("Publishing is restricted to GitHub Actions on main.");
}

const clean = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
if (clean.status !== 0 || clean.stdout.trim() !== "") {
	throw new Error("Refusing to publish from a dirty or unreadable worktree.");
}
const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
if (head.status !== 0 || head.stdout.trim() !== process.env.GITHUB_SHA) {
	throw new Error("Git HEAD does not match the GitHub Actions commit.");
}

const root = resolve(import.meta.dirname, "..");
const packages = readdirSync(join(root, "packages"), { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => join(root, "packages", entry.name, "package.json"))
	.filter(existsSync)
	.map((file) => JSON.parse(readFileSync(file, "utf8")))
	.filter((manifest) => manifest.private !== true)
	.map(({ name, version }) => ({ name, version }));
const changesetConfig = JSON.parse(readFileSync(join(root, ".changeset/config.json"), "utf8"));
assertFixedGroup(
	packages.map(({ name }) => name),
	changesetConfig.fixed,
);

const preUrl = new URL("../.changeset/pre.json", import.meta.url);
const hiddenPreUrl = new URL("../.changeset/pre.json.publish", import.meta.url);
const preState = existsSync(preUrl) ? JSON.parse(readFileSync(preUrl, "utf8")) : undefined;
const { tag } = assertFixedVersions(packages, preState);
const require = createRequire(import.meta.url);
const arguments_ = [require.resolve("@changesets/cli/bin.js"), "publish"];
if (tag !== undefined) {
	if (existsSync(hiddenPreUrl)) throw new Error("Hidden Changesets pre-state already exists.");
	arguments_.push("--tag", tag);
	renameSync(preUrl, hiddenPreUrl);
}

let result;
try {
	result = spawnSync(process.execPath, arguments_, { stdio: "inherit" });
} finally {
	if (tag !== undefined && existsSync(hiddenPreUrl)) renameSync(hiddenPreUrl, preUrl);
}
if (result.error) throw result.error;
if (result.signal !== null) throw new Error(`Publish terminated with ${result.signal}.`);
process.exitCode = result.status ?? 1;
