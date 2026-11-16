const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const { findMsvc, parseEnvironment } = require("../scripts/windows-compiler");

const install = "C:\\VS2022";
const compiler = "C:\\VS2022\\VC\\Tools\\MSVC\\14.44\\bin\\Hostx64\\x64\\cl.exe";
const vcvars = path.win32.join(install, "VC", "Auxiliary", "Build", "vcvars64.bat");

function discovery(overrides = {}) {
  const calls = [];
  const files = new Set(overrides.files || []);
  const opts = {
    env: { "PROGRAMFILES(X86)": "C:\\PF86", PROGRAMFILES: "C:\\PF", COMSPEC: "cmd.exe", ...(overrides.env || {}) },
    exists: overrides.exists || (file => files.has(file)),
    readDir: overrides.readDir || (() => []),
    spawn(command, args, options) {
      calls.push({ command, args, options });
      if (overrides.spawn) return overrides.spawn(command, args, options);
      if (command === "C:\\PF86\\Microsoft Visual Studio\\Installer\\vswhere.exe")
        return { status: 0, stdout: `${install}\r\n` };
      if (command === "cmd.exe") return { status: 0, stdout: "PATH=C:\\VS\\bin\r\nINCLUDE=C:\\VS\\include\r\nLIB=C:\\VS\\lib\r\nCUSTOM=a=b\r\n" };
      if (command === "where.exe") return { status: 0, stdout: `${compiler}\r\n` };
      throw new Error(`Unexpected subprocess: ${command}`);
    }
  };
  return { find: () => findMsvc({ platform: "win32", ...opts }), calls };
}

test("parseEnvironment preserves values containing equals signs", () => {
  assert.deepEqual(parseEnvironment("Path=C:\\tool\r\nTOKEN=first=second\r\nEMPTY=\r\n"), {
    PATH: "C:\\tool", TOKEN: "first=second", EMPTY: ""
  });
});

test("discovers MSVC through vswhere and vcvars when PATH is absent", () => {
  const setup = discovery({ files: ["C:\\PF86\\Microsoft Visual Studio\\Installer\\vswhere.exe", vcvars] });
  const result = setup.find();

  assert.equal(result.compiler, compiler);
  assert.equal(result.env.PATH, "C:\\VS\\bin");
  assert.equal(result.env.CUSTOM, "a=b");
  assert.equal(result.env.INCLUDE, "C:\\VS\\include");
  assert.equal(result.env.LIB, "C:\\VS\\lib");
  assert.equal(setup.calls.filter(call => call.command === "cmd.exe").length, 1);
  assert.equal(setup.calls.find(call => call.command === "where.exe").options.env.PATH, "C:\\VS\\bin");
});

test("finds a standard Visual Studio Build Tools install when vswhere is absent", () => {
  const base = "C:\\PF\\Microsoft Visual Studio";
  const standardVcvars = path.win32.join(base, "2022", "BuildTools", "VC", "Auxiliary", "Build", "vcvars64.bat");
  const setup = discovery({
    files: [base, standardVcvars],
    readDir: directory => directory === base ? ["2019", "2022", "Community", "Preview"] : []
  });
  const result = setup.find();

  assert.equal(result.compiler, compiler);
  assert.equal(setup.calls.some(call => call.command.endsWith("vswhere.exe")), false);
  assert.equal(setup.calls.some(call => call.command === "cmd.exe"), true);
});

test("uses an existing x64 Visual Studio developer environment directly", () => {
  const setup = discovery({ env: {
    Path: "C:\\VS\\bin", VSCMD_ARG_TGT_ARCH: "x64", INCLUDE: "C:\\VS\\include", LIB: "C:\\VS\\lib"
  } });
  const result = setup.find();

  assert.equal(result.compiler, compiler);
  assert.equal(result.env.PATH, "C:\\VS\\bin");
  assert.equal("Path" in result.env, false);
  assert.deepEqual(setup.calls.map(call => call.command), ["where.exe"]);
});

test("returns null for automatic MinGW fallback when MSVC is absent", () => {
  const setup = discovery();
  assert.equal(setup.find(), null);
  assert.equal(setup.calls.length, 0);
});

test("explicit MinGW preference skips MSVC discovery", () => {
  const setup = discovery({ env: { VLC_REC_WINDOWS_COMPILER: "mingw" } });
  assert.equal(setup.find(), null);
  assert.equal(setup.calls.length, 0);
});

test("explicit MSVC preference errors when x64 build tools are missing", () => {
  const setup = discovery({ env: { VLC_REC_WINDOWS_COMPILER: "msvc" } });
  assert.throws(setup.find, /MSVC x64 C\+\+ build tools were not found/);
});

test("does not hide vswhere subprocess errors behind fallback discovery", () => {
  const setup = discovery({
    files: ["C:\\PF86\\Microsoft Visual Studio\\Installer\\vswhere.exe", vcvars],
    spawn: command => command.endsWith("vswhere.exe")
      ? { error: new Error("vswhere spawn failed"), status: null, stdout: "" }
      : { status: 0, stdout: "" }
  });
  assert.throws(setup.find, /vswhere spawn failed/);
});

test("does not hide vcvars subprocess errors behind MinGW fallback", () => {
  const setup = discovery({
    files: ["C:\\PF86\\Microsoft Visual Studio\\Installer\\vswhere.exe", vcvars],
    spawn: command => command === "cmd.exe"
      ? { error: new Error("vcvars spawn failed"), status: null, stdout: "" }
      : command.endsWith("vswhere.exe")
        ? { status: 0, stdout: `${install}\r\n` }
        : { status: 0, stdout: `${compiler}\r\n` }
  });
  assert.throws(setup.find, /vcvars spawn failed/);
});

test("does not hide where.exe subprocess errors behind MinGW fallback", () => {
  const setup = discovery({
    env: { VSCMD_ARG_TGT_ARCH: "x64", INCLUDE: "C:\\VS\\include", LIB: "C:\\VS\\lib" },
    spawn: command => ({ error: new Error(`${command} spawn failed`), status: null, stdout: "" })
  });
  assert.throws(setup.find, /where\.exe spawn failed/);
});
