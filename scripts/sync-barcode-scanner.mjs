import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const browserPackage = require.resolve("@zxing/browser/package.json");
const libraryPackage = require.resolve("@zxing/library/package.json");
const libraryRequire = createRequire(libraryPackage);
const output = fileURLToPath(new URL("../src/frontend/vendor/", import.meta.url));
const packages = [
  [browserPackage, "LICENSE"],
  [libraryPackage, "LICENSE"],
  [libraryRequire.resolve("ts-custom-error/package.json"), "LICENSE"],
  [libraryRequire.resolve("@zxing/text-encoding/package.json"), "LICENSE.md"],
];
const notices = [];
for (const [packagePath, licenseName] of packages) {
  const { name, version } = JSON.parse(await readFile(packagePath, "utf8"));
  const license = await readFile(join(dirname(packagePath), licenseName), "utf8");
  notices.push(`${name} ${version}\n${license.replaceAll("\r\n", "\n").trim()}`);
}
const source = await readFile(join(dirname(browserPackage), "umd/zxing-browser.min.js"), "utf8");
await mkdir(output, { recursive: true });
await writeFile(join(output, "zxing-browser.min.js"),
  "/*! ZXing browser bundle. Licenses: ./zxing-LICENSES.txt */\n" + source.replaceAll("\r\n", "\n").replace(/\/\/# sourceMappingURL=.*$/m, "").trimEnd() + "\n");
await writeFile(join(output, "zxing-LICENSES.txt"), notices.join("\n\n----------------------------------------\n\n") + "\n");
console.log("Updated the local barcode scanner bundle and licenses.");
