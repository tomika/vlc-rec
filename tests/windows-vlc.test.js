const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { verifySha256, assertWindowsRuntime } = require("../scripts/bundle-windows-vlc");
const meta = require("../packaging/windows-vlc.json");
test("bundled VLC refuses a corrupt cached download", async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "vlc-hash-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, "archive");
  fs.writeFileSync(file, "original");
  const hash = crypto.createHash("sha256").update("original").digest("hex");
  await verifySha256(file, hash);
  fs.writeFileSync(file, "tampered");
  await assert.rejects(verifySha256(file, hash), /SHA-256 mismatch/);
});
test("Windows runtime validation requires SRT, license notices, sources and pinned metadata", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vlc-layout-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const required = ["libvlc.dll", "libvlccore.dll", "vlc.exe", "COPYING.txt", "COPYING.LIB", "plugins/access/libaccess_srt_plugin.dll", `sources/${meta.source.file}`, "SOURCES.md"];
  for (const file of required) { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), "fixture"); }
  fs.writeFileSync(path.join(dir, "bundle.json"), JSON.stringify(meta));
  assert.doesNotThrow(() => assertWindowsRuntime(dir));
  fs.unlinkSync(path.join(dir, "COPYING.LIB"));
  assert.throws(() => assertWindowsRuntime(dir), /COPYING.LIB/);
  fs.writeFileSync(path.join(dir, "COPYING.LIB"), "fixture");
  fs.writeFileSync(path.join(dir, "bundle.json"), JSON.stringify({ ...meta, version: "0.0.0" }));
  assert.throws(() => assertWindowsRuntime(dir), /pinned version/);
});
