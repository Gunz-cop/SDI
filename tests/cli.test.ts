import { describe, expect, it } from "vitest";
import { HELP_TEXT, VERSION, resolveCliResponse } from "../src/cli.js";

describe("SDI foundation CLI", () => {
  it("shows the product, version, and planned commands with --help", () => {
    const response = resolveCliResponse(["--help"]);

    expect(response).toEqual({ exitCode: 0, output: HELP_TEXT, stream: "stdout" });
    expect(response.output).toContain(`SDI ${VERSION}`);
    expect(response.output).toContain("sdi run");
    expect(response.output).toContain("sdi baseline");
  });

  it("does not expose a functional command during the foundation stage", () => {
    const response = resolveCliResponse(["run"]);

    expect(response.exitCode).toBe(2);
    expect(response.stream).toBe("stderr");
    expect(response.output).toContain("No functional commands are available yet");
  });
});
