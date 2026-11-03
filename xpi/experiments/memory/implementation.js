/* Experiment: access to SKAI_ Memory (/var/lib/skai/SKAI_ Memory) for the add-on.
 *
 * Reading is plain file reading (IOUtils); writing runs the root-owned helper
 * /usr/lib/skai/skai-memory-write through "sudo -n ... --skai" (sudo lets the group 'skai' run exactly that,
 * and the helper itself only lets an app change its own notes). Nothing else on disk is reachable from here. */
"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");

const VAULT = "/var/lib/skai/SKAI_ Memory";
const HELPER = "/usr/lib/skai/skai-memory-write";
const SUDO = "/usr/bin/sudo";
const OPS = ["register", "write", "append", "delete"];

function insideVault(path) {
  return typeof path === "string" && !path.includes("\0") && !path.split("/").includes("..") &&
    (path === VAULT || path.startsWith(VAULT + "/"));
}

this.skaiMemory = class extends ExtensionCommon.ExtensionAPI {
  getAPI() {
    return {
      skaiMemory: {
        async available() {
          return IOUtils.exists(VAULT);
        },

        async list(dir) {
          if (!insideVault(dir)) {
            throw new Error("outside the memory vault");
          }
          const out = [];
          for (const p of await IOUtils.getChildren(dir)) {
            out.push({ name: p.split("/").pop(), isDir: (await IOUtils.stat(p)).type === "directory" });
          }
          return out;
        },

        async read(path) {
          if (!insideVault(path) || !path.endsWith(".md")) {
            throw new Error("not a note of the memory vault");
          }
          return IOUtils.readUTF8(path);
        },

        async write(op, path, text, caller) {
          if (!OPS.includes(op)) {
            throw new Error("unknown operation");
          }
          const proc = await Subprocess.call({ command: SUDO, arguments: ["-n", HELPER, "--skai"], stderr: "pipe" });
          await proc.stdin.write(JSON.stringify({ op, path, text, caller }));
          await proc.stdin.close();
          const err = await proc.stderr.readString();
          const { exitCode } = await proc.wait();
          if (exitCode !== 0) {
            throw new Error(err.trim() || "write refused");
          }
        },
      },
    };
  }
};
