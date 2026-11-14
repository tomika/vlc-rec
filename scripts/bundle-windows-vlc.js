const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const https = require("node:https");
const { pipeline } = require("node:stream/promises");
const META = require("../packaging/windows-vlc.json");
const ROOT = path.resolve(__dirname, "..");
async function verifySha256(file, expected) {
  const hash = crypto.createHash("sha256");
  for await (const block of fs.createReadStream(file)) hash.update(block);
  if (hash.digest("hex") !== expected) throw new Error(`SHA-256 mismatch: ${file}. Remove the cached file before retrying.`);
}
function response(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (new URL(url).protocol !== "https:") return reject(new Error("Download must use HTTPS"));
    const request = https.get(url, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (redirects >= 5 || !res.headers.location) return reject(new Error("Too many download redirects"));
        response(new URL(res.headers.location, url).href, redirects + 1).then(resolve, reject);
      } else if (res.statusCode === 200) resolve(res);
      else { res.resume(); reject(new Error(`Download failed: HTTP ${res.statusCode} ${url}`)); }
    });
    request.setTimeout(60000, () => request.destroy(new Error("Download timed out")));
    request.on("error", reject);
  });
}
async function cachedDownload(artifact, cache) {
  fs.mkdirSync(cache, { recursive: true });
  const file = path.join(cache, artifact.file);
  if (fs.existsSync(file)) { await verifySha256(file, artifact.sha256); return file; }
  const partial = `${file}.${crypto.randomUUID()}.part`;
  try {
    console.log(`[windows-vlc] Downloading ${artifact.url}`);
    await pipeline(await response(artifact.url), fs.createWriteStream(partial, { flags: "wx" }));
    await verifySha256(partial, artifact.sha256);
    await fsp.rename(partial, file);
    return file;
  } finally { await fsp.rm(partial, { force: true }); }
}
function assertWindowsRuntime(dir) {
  for (const name of ["libvlc.dll", "libvlccore.dll", "vlc.exe", "COPYING.txt", "COPYING.LIB", "plugins/access/libaccess_srt_plugin.dll", `sources/${META.source.file}`, "bundle.json", "SOURCES.md"]) {
    if (!fs.statSync(path.join(dir, name), { throwIfNoEntry: false })?.isFile()) throw new Error(`Incomplete bundled Windows VLC: ${name}`);
  }
  const info = JSON.parse(fs.readFileSync(path.join(dir, "bundle.json"), "utf8"));
  if (info.version !== META.version || info.binary.sha256 !== META.binary.sha256 || info.source.sha256 !== META.source.sha256) throw new Error("Bundled Windows VLC does not match the pinned version");
}
function extractZip(file, directory, root) {
  const { spawnSync } = require("node:child_process");
  const tool = ["podman", "docker"].find(name => spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0);
  if (!tool) throw new Error("Windows VLC packaging needs podman or docker, like the native player build.");
  const image = "localhost/vlc-rec-player-builder:1";
  for (const args of [
    ["build", "-q", "-t", image, "-f", "native/Containerfile", "native"],
    ["run", "--rm", "--network", "none", "-v", `${path.dirname(file)}:/downloads:ro`, "-v", `${directory}:/extract`, image,
      "unzip", "-q", `/downloads/${path.basename(file)}`, "-d", "/extract"]
  ]) {
    const result = spawnSync(tool, args, { cwd: root, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("VLC archive extraction failed");
  }
}
async function bundleWindowsVlc(root = ROOT, cache = process.env.VLC_REC_DOWNLOAD_CACHE || path.join(os.tmpdir(), "vlc-rec-downloads")) {
  const binary = await cachedDownload(META.binary, cache);
  const source = await cachedDownload(META.source, cache);
  const temporary = fs.mkdtempSync(path.join(cache, "extract-"));
  const destination = path.resolve(root, "vlc");
  if (destination !== path.join(path.resolve(root), "vlc")) throw new Error("Invalid Windows runtime destination");
  try {
    extractZip(binary, temporary, root);
    const original = path.join(temporary, META.folder);
    for (const name of ["libvlc.dll", "libvlccore.dll", "vlc.exe", "COPYING.txt"]) {
      if (!fs.existsSync(path.join(original, name))) throw new Error(`Invalid upstream VLC archive: ${name}`);
    }
    fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(original, destination, { recursive: true });
    fs.mkdirSync(path.join(destination, "sources"));
    fs.copyFileSync(source, path.join(destination, "sources", META.source.file));
    fs.copyFileSync(path.join(root, "packaging/licenses/VLC-COPYING.LIB"), path.join(destination, "COPYING.LIB"));
    fs.writeFileSync(path.join(destination, "bundle.json"), JSON.stringify(META, null, 2) + "\n");
    fs.writeFileSync(path.join(destination, "SOURCES.md"), `# Bundled VLC ${META.version} for Windows x64\n\nThis directory contains the unmodified official portable Windows runtime. Upstream license and copyright notices are retained, including COPYING.txt; COPYING.LIB contains the libVLC LGPL terms. Modules and dependencies can have different licenses; their upstream notices remain applicable. This notice does not change the recorder's license.\n\nBinary: ${META.binary.url}\nSHA-256: ${META.binary.sha256}\n\nVLC source archive (also included in sources/${META.source.file}):\n${META.source.url}\nSHA-256: ${META.source.sha256}\n\nThe matching source archive contains contrib build recipes, dependency versions, upstream source URLs, checksums and patches. Upstream mirrors of dependency sources: ${META.dependencySources}\n\nThe runtime is loaded dynamically from the adjacent vlc directory and can be replaced with a compatible 64-bit VLC 3 runtime. VLC_REC_LIBVLC_DIR explicitly selects an alternative runtime.\n`);
    assertWindowsRuntime(destination);
    console.log(`[windows-vlc] Bundled VLC ${META.version} Windows x64, licenses and matching VLC sources`);
  } finally {
    if (!path.resolve(temporary).startsWith(path.resolve(cache) + path.sep)) throw new Error("Invalid extraction cleanup path");
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
if (require.main === module) bundleWindowsVlc().catch(err => { console.error(err.message); process.exitCode = 1; });
module.exports = { verifySha256, assertWindowsRuntime, bundleWindowsVlc, extractZip };
