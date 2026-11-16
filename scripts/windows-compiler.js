const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Environment keys are case insensitive on Windows. Avoid passing both Path
// and PATH to child processes after loading a Visual Studio developer shell.
function normalizeEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key.toUpperCase(), value]));
}

function parseEnvironment(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0) result[line.slice(0, separator).toUpperCase()] = line.slice(separator + 1);
  }
  return result;
}

function findMsvc({ platform = process.platform, env = process.env, spawn = spawnSync, exists = fs.existsSync,
  readDir = fs.readdirSync } = {}) {
  const preference = env.VLC_REC_WINDOWS_COMPILER || "auto";
  if (!["auto", "msvc", "mingw"].includes(preference)) throw new Error("VLC_REC_WINDOWS_COMPILER must be auto, msvc or mingw.");
  if (preference === "mingw") return null;
  if (platform !== "win32") {
    if (preference === "msvc") throw new Error("MSVC builds require a Windows host.");
    return null;
  }
  let compilerEnv = normalizeEnvironment(env);
  function locateCompiler() {
    const result = spawn("where.exe", ["cl.exe"], { env: compilerEnv, encoding: "utf8", windowsHide: true });
    if (result.error) throw result.error;
    return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : null;
  }
  if (compilerEnv.VSCMD_ARG_TGT_ARCH === "x64" && compilerEnv.INCLUDE && compilerEnv.LIB) {
    const compiler = locateCompiler();
    if (compiler) return { compiler, env: compilerEnv };
  }
  const locator = path.win32.join(compilerEnv["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)",
    "Microsoft Visual Studio", "Installer", "vswhere.exe");
  let installation = compilerEnv.VSINSTALLDIR;
  if (exists(locator)) {
    const result = spawn(locator, ["-latest", "-products", "*", "-requires",
      "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"],
    { encoding: "utf8", windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Visual Studio discovery failed (${result.status}).`);
    if (result.stdout.trim()) installation = result.stdout.trim();
  }
  const candidates = installation ? [installation] : [];
  // Support installations at the usual locations even when vswhere is absent.
  for (const programFiles of new Set([compilerEnv.PROGRAMFILES || "C:\\Program Files",
    compilerEnv["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)"])) {
    const base = path.win32.join(programFiles, "Microsoft Visual Studio");
    if (!exists(base)) continue;
    for (const version of readDir(base).filter(name => /^\d{4}$/.test(name)).sort().reverse()) {
      for (const edition of ["BuildTools", "Community", "Professional", "Enterprise"]) {
        candidates.push(path.win32.join(base, version, edition));
      }
    }
  }
  const vcvars = candidates.map(candidate => path.win32.join(candidate, "VC", "Auxiliary", "Build", "vcvars64.bat"))
    .find(candidate => exists(candidate));
  if (!vcvars || !exists(vcvars)) {
    if (preference === "msvc") throw new Error("MSVC x64 C++ build tools were not found. Install Visual Studio Build Tools with the Windows SDK.");
    return null;
  }
  // vcvars64 sets the SDK, linker and CRT paths as well as PATH. Its path comes
  // from the local VS installation; reject command metacharacters that cannot
  // occur in an ordinary Visual Studio installation path.
  if (/["\r\n%]/.test(vcvars)) throw new Error("Unsupported Visual Studio installation path.");
  const result = spawn(compilerEnv.COMSPEC || "cmd.exe", ["/d", "/s", "/c", `""${vcvars}" >nul && set"`],
    { env: compilerEnv, encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Visual Studio x64 environment initialization failed (${result.status}).`);
  compilerEnv = { ...compilerEnv, ...parseEnvironment(result.stdout) };
  const compiler = locateCompiler();
  if (!compiler || !compilerEnv.INCLUDE || !compilerEnv.LIB) throw new Error("Visual Studio did not provide a usable x64 compiler and Windows SDK.");
  return { compiler, env: compilerEnv };
}

function compileMsvc(toolchain, { sources, output, libraries = [], shared = false }) {
  const destination = path.resolve(output);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporaryPrefix = path.join(os.tmpdir(), "vlc-rec-msvc-");
  const temporary = fs.mkdtempSync(temporaryPrefix);
  try {
    console.log(`[windows-build] MSVC x64: ${destination}`);
    const run = (args) => {
      const result = spawnSync(toolchain.compiler, args, { cwd: temporary, env: toolchain.env, stdio: "inherit", windowsHide: true });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`MSVC failed (${result.status}) building ${path.basename(destination)}. MinGW fallback is not used after a compiler error.`);
    };
    // Separate object names also support sources with identical basenames in
    // different directories (for example a test harness and its implementation).
    const objects = sources.map((source, index) => {
      const object = path.join(temporary, `${index}-${path.basename(source, path.extname(source))}.obj`);
      run(["/nologo", "/std:c11", "/TC", "/c", "/O2", "/MT", "/W3", "/utf-8",
        "/D_CRT_SECURE_NO_WARNINGS", "/D_WINSOCK_DEPRECATED_NO_WARNINGS", ...(shared ? ["/D_WINDLL"] : []),
        `/Fo${object}`, path.resolve(source)]);
      return object;
    });
    run(["/nologo", "/MT", ...(shared ? ["/LD"] : []), `/Fe${destination}`, ...objects,
      "/link", "/INCREMENTAL:NO", ...libraries]);
  } finally {
    if (!path.resolve(temporary).startsWith(path.resolve(temporaryPrefix))) throw new Error("Unsafe MSVC temporary directory.");
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

module.exports = { findMsvc, compileMsvc, parseEnvironment, normalizeEnvironment };
