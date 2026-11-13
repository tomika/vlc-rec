const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { assertPublicInputs, assertPublicPluginTree } = require("../scripts/public-plugins");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "public-plugins-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "player/plugins/osc");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ id: "osc" }));
  fs.writeFileSync(path.join(dir, "osc-linux_x64"), "public test binary");
  return { root, dir };
}
test("public packages accept only the listed plugin payload", (t) => {
  const { root, dir } = fixture(t);
  assert.doesNotThrow(() => assertPublicInputs(root));
  fs.writeFileSync(path.join(dir, "extra-file"), "unreviewed");
  assert.throws(() => assertPublicInputs(root), /Unexpected plugin payload/);
});
test("public packages refuse a local extra plugin in player or old distribution folders", (t) => {
  const { root } = fixture(t);
  const extra = path.join(root, "player/plugins/local-only");
  fs.mkdirSync(extra);
  assert.throws(() => assertPublicInputs(root), /Non-public plugin/);
  fs.rmdirSync(extra);
  fs.mkdirSync(path.join(root, "dist/vlc-rec/linux-x64/player/plugins/local-only"), { recursive: true });
  assert.throws(() => assertPublicInputs(root), /Non-public plugin/);
});
test("public packages refuse private plugin settings and unreviewed runtime folders", (t) => {
  const { root } = fixture(t);
  const params = path.join(root, "vlc_rec_params.json");
  fs.writeFileSync(params, JSON.stringify({ camera_plugin: "local-only" }));
  assert.throws(() => assertPublicInputs(root), /private plugin/);
  fs.unlinkSync(params);
  fs.mkdirSync(path.join(root, "player/local-only"));
  assert.throws(() => assertPublicInputs(root), /Unexpected runtime payload/);
});
test("public packages reject a manifest using another id", (t) => {
  const { dir } = fixture(t);
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ id: "other" }));
  assert.throws(() => assertPublicPluginTree(path.dirname(dir)), /id mismatch/);
});
