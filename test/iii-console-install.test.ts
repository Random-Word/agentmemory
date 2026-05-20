import { describe, expect, it } from "vitest";

import {
  iiiConsoleInstallCommand,
  iiiConsoleManualInstallHint,
  iiiConsoleReleaseAsset,
  iiiConsoleReleaseUrl,
} from "../src/cli/iii-console-install.js";

describe("iii console install helpers", () => {
  it("maps Windows x64 to the zip asset", () => {
    expect(iiiConsoleReleaseAsset("win32", "x64")).toBe(
      "iii-console-x86_64-pc-windows-msvc.zip",
    );
  });

  it("builds a pinned release URL for Windows", () => {
    expect(iiiConsoleReleaseUrl("0.11.2", "win32", "x64")).toBe(
      "https://github.com/iii-hq/iii/releases/download/iii/v0.11.2/iii-console-x86_64-pc-windows-msvc.zip",
    );
  });

  it("uses the pinned shell installer on Unix", () => {
    expect(iiiConsoleInstallCommand("0.11.2")).toBe(
      "curl -fsSL https://install.iii.dev/console/main/install.sh | sh -s -- -v 0.11.2",
    );
  });

  it("gives Windows users zip extraction guidance instead of curl pipe guidance", () => {
    const hint = iiiConsoleManualInstallHint("0.11.2", "win32", "x64");
    expect(hint).toContain("iii-console-x86_64-pc-windows-msvc.zip");
    expect(hint).toContain("Extract iii-console.exe");
    expect(hint).not.toContain("curl -fsSL");
  });
});
