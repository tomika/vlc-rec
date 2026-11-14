// This list controls distribution, independently of locally installed plugins.
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const PUBLIC_PLUGINS = fs.readFileSync(path.join(ROOT, "packaging/public-plugins.txt"), "utf8").trim().split(/\r?\n/);
if (!PUBLIC_PLUGINS.length || PUBLIC_PLUGINS.some(id => !/^[a-z0-9_-]+$/.test(id)) || new Set(PUBLIC_PLUGINS).size !== PUBLIC_PLUGINS.length) throw new Error("Invalid public plugin list");
function assertPublicPluginTree(dir) {
  if (!fs.existsSync(dir)) return;
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(`Plugin directory is a symbolic link: ${dir}`);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !PUBLIC_PLUGINS.includes(entry.name)) throw new Error(`Non-public plugin in distribution input: ${path.join(dir, entry.name)}. Build/install private plugins outside player and dist.`);
    const folder = path.join(dir, entry.name);
    const allowed = ["plugin.json", `${entry.name}-linux_x64`, `${entry.name}-win_x64.exe`];
    for (const file of fs.readdirSync(folder, { withFileTypes: true })) {
      if (!file.isFile() || file.isSymbolicLink() || !allowed.includes(file.name)) throw new Error(`Unexpected plugin payload: ${path.join(folder, file.name)}`);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, "plugin.json"), "utf8"));
    if (manifest.id !== entry.name) throw new Error(`Plugin manifest id mismatch: ${folder}`);
  }
}
function assertPublicInputs(root = ROOT) {
  const bundledVlc = path.join(root, "vlc");
  if (fs.existsSync(bundledVlc)) require("./bundle-windows-vlc").assertWindowsRuntime(bundledVlc);
  const runtime = path.join(root, "player");
  if (fs.existsSync(runtime)) for (const entry of fs.readdirSync(runtime, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !["plugins", "vlc-rec-player-linux_x64", "vlc-rec-player-win_x64.exe"].includes(entry.name)) throw new Error(`Unexpected runtime payload: ${path.join(runtime, entry.name)}`);
  }
  assertPublicPluginTree(path.join(runtime, "plugins"));
  const dist = path.join(root, "dist/vlc-rec");
  assertPublicPluginTree(path.join(dist, "player/plugins"));
  if (fs.existsSync(dist)) for (const entry of fs.readdirSync(dist, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith("linux-")) assertPublicPluginTree(path.join(dist, entry.name, "player/plugins"));
  }
  const params = path.join(root, "vlc_rec_params.json");
  if (fs.existsSync(params)) {
    const { camera_plugin } = JSON.parse(fs.readFileSync(params, "utf8"));
    if (camera_plugin && !PUBLIC_PLUGINS.includes(camera_plugin)) throw new Error("The packaged settings select a private plugin. Use the settings folder for private configurations.");
  }
}
module.exports = { PUBLIC_PLUGINS, assertPublicPluginTree, assertPublicInputs };
