// Runs the Linux end-to-end tests in a container, from Windows or Linux.
//   node tests/e2e/run-linux.js [stub|x11|sway|all]    default: all
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const repo = path.resolve(__dirname, "..", "..");
const IMAGE = "localhost/vlc-rec-e2e:1";
const which = process.argv[2] || "all";
const tool = spawnSync("podman", ["--version"], { stdio: "ignore" }).error ? "docker" : "podman";

function run(args) {
  return spawnSync(tool, args, { cwd: repo, stdio: "inherit" }).status;
}

if (run(["build", "-q", "-t", IMAGE, "-f", "tests/e2e/linux/Containerfile", "tests/e2e/linux"]) !== 0) process.exit(2);

function inContainer(name, display, mode) {
  const script = [
    "set -e",
    // Work on a copy: nothing in the mounted repository may change except e2e-output.
    "mkdir /tmp/repo",
    "cp -r /repo/src /repo/assets /repo/bin /repo/player /repo/tests /repo/neutralino.config.json /tmp/repo/",
    // The fake camera of the camera scenario.
    "mkdir -p /tmp/repo/tools/camera && cp /repo/tools/camera/fake_osc_camera.py /tmp/repo/tools/camera/",
    `E2E_ONLY=${process.env.E2E_ONLY || ""} E2E_OUT=/out/${name} bash /repo/tests/e2e/linux/session.sh ${display} node /tmp/repo/tests/e2e/run-e2e.js --mode ${mode}`
  ].join(" && ");
  return run([
    "run", "--rm", "--name", `vlc-rec-e2e-${name}`, "--shm-size=256m",
    // E2E_HOST_NETWORK=1 reaches a real camera on the LAN; E2E_PARAMS is merged into the settings file.
    ...(process.env.E2E_HOST_NETWORK ? ["--network", "host"] : []),
    "-e", `E2E_PARAMS=${process.env.E2E_PARAMS || ""}`,
    "-v", `${repo}:/repo:ro`, "-v", `${path.join(repo, "e2e-output")}:/out`,
    IMAGE, "bash", "-c", script
  ]);
}

require("node:fs").mkdirSync(path.join(repo, "e2e-output"), { recursive: true });
const runs = { stub: ["x11", "stub"], x11: ["x11", "real"], sway: ["sway", "real"] };
const names = which === "all" ? Object.keys(runs) : [which];
let failed = 0;
for (const name of names) {
  console.log(`=== Linux e2e: ${name}`);
  if (inContainer(name, ...runs[name]) !== 0) failed += 1;
}
console.log(failed ? `\nLinux e2e: ${failed} run(s) FAILED` : "\nLinux e2e: all runs PASSED");
process.exit(failed ? 1 : 0);
