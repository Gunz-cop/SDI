import packageJson from "../package.json" with { type: "json" };

/** SDI's package version, shared by the runner and CLI. */
export const SDI_VERSION = packageJson.version;
