export function iiiConsoleReleaseAsset(
  os = process.platform,
  arch = process.arch,
): string | null {
  if (os === "darwin" && arch === "arm64")
    return "iii-console-aarch64-apple-darwin.tar.gz";
  if (os === "darwin" && arch === "x64")
    return "iii-console-x86_64-apple-darwin.tar.gz";
  if (os === "linux" && arch === "x64")
    return "iii-console-x86_64-unknown-linux-gnu.tar.gz";
  if (os === "linux" && arch === "arm64")
    return "iii-console-aarch64-unknown-linux-gnu.tar.gz";
  if (os === "linux" && arch === "arm")
    return "iii-console-armv7-unknown-linux-gnueabihf.tar.gz";
  if (os === "win32" && arch === "x64")
    return "iii-console-x86_64-pc-windows-msvc.zip";
  if (os === "win32" && arch === "arm64")
    return "iii-console-aarch64-pc-windows-msvc.zip";
  if (os === "win32" && arch === "ia32")
    return "iii-console-i686-pc-windows-msvc.zip";
  return null;
}

export function iiiConsoleReleaseUrl(
  version: string,
  os = process.platform,
  arch = process.arch,
): string | null {
  const asset = iiiConsoleReleaseAsset(os, arch);
  if (!asset) return null;
  return `https://github.com/iii-hq/iii/releases/download/iii/v${version}/${asset}`;
}

export function iiiConsoleInstallCommand(version: string): string {
  return `curl -fsSL https://install.iii.dev/console/main/install.sh | sh -s -- -v ${version}`;
}

export function iiiConsoleManualInstallHint(
  version: string,
  os = process.platform,
  arch = process.arch,
): string {
  const url = iiiConsoleReleaseUrl(version, os, arch);
  if (os === "win32" && url) {
    return [
      `Download ${url}`,
      "Extract iii-console.exe and place it on PATH (for example %USERPROFILE%\\.local\\bin)",
    ].join("\n  ");
  }
  return url
    ? `${iiiConsoleInstallCommand(version)}\n  Or download ${url}`
    : `Download manually from https://github.com/iii-hq/iii/releases/tag/iii%2Fv${version}`;
}
