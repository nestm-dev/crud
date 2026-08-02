const prereleasePattern = /^[0-9]+\.[0-9]+\.[0-9]+-([0-9A-Za-z-]+)(?:[.+]|$)/;

export function resolvePrereleaseTag(version, preState) {
	if (typeof version !== "string") throw new TypeError("Package version must be a string.");
	const identifier = prereleasePattern.exec(version)?.[1];
	if (preState?.mode === "pre") {
		if (typeof preState.tag !== "string" || preState.tag.length === 0) {
			throw new Error("Changesets prerelease mode requires a tag.");
		}
		if (identifier !== preState.tag) {
			throw new Error(
				`Version prerelease ${identifier ?? "missing"} does not match ${preState.tag}.`,
			);
		}
		return preState.tag;
	}
	if (identifier !== undefined) {
		throw new Error(`Prerelease version ${version} requires Changesets pre mode.`);
	}
	return undefined;
}

export function assertFixedVersions(packages, preState) {
	if (!Array.isArray(packages) || packages.length === 0) {
		throw new TypeError("At least one publishable package is required.");
	}
	const versions = new Set(packages.map(({ version }) => version));
	if (versions.size !== 1) {
		throw new Error(
			`Refusing to publish diverged fixed-group versions: ${[...versions].join(", ")}.`,
		);
	}
	const version = packages[0].version;
	return { version, tag: resolvePrereleaseTag(version, preState) };
}

export function assertFixedGroup(packageNames, fixedGroups) {
	if (!Array.isArray(fixedGroups) || fixedGroups.length !== 1) {
		throw new Error("Changesets must declare exactly one fixed package group.");
	}
	const byName = (left, right) => left.localeCompare(right);
	const actual = [...packageNames].sort(byName);
	const declared = [...fixedGroups[0]].sort(byName);
	if (actual.length !== declared.length || actual.some((name, index) => name !== declared[index])) {
		throw new Error("Changesets fixed group does not match publishable workspace packages.");
	}
	return declared;
}
