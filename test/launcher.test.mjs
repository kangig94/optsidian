import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

function makeReader({ parents = {}, envs = {}, cmdlines = {}, pids = [] }) {
  return {
    listPids() {
      return pids;
    },
    readCmdline(pid) {
      return cmdlines[pid];
    },
    readEnviron(pid) {
      return envs[pid];
    },
    readParentPid(pid) {
      return parents[pid];
    }
  };
}

test("recoverLinuxGuiEnv prefers the parent chain over process scanning", async () => {
  const { recoverLinuxGuiEnv } = await import(path.resolve("src/native/launcher.ts"));
  const reader = makeReader({
    parents: { 300: 200, 200: 1 },
    envs: {
      200: {
        DISPLAY: ":parent",
        XDG_RUNTIME_DIR: "/run/parent",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/parent/bus"
      },
      100: {
        DISPLAY: ":obsidian",
        XDG_RUNTIME_DIR: "/run/obsidian",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/obsidian/bus"
      }
    },
    cmdlines: {
      100: ["/opt/Obsidian/obsidian"]
    },
    pids: [100]
  });

  const recovered = recoverLinuxGuiEnv(
    { PATH: process.env.PATH },
    {
      currentPid: 300,
      procReader: reader
    }
  );

  assert.deepEqual(recovered, {
    DISPLAY: ":parent",
    XDG_RUNTIME_DIR: "/run/parent",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/parent/bus"
  });
});

test("recoverLinuxGuiEnv falls back to the main Obsidian process when parent env is missing", async () => {
  const { recoverLinuxGuiEnv } = await import(path.resolve("src/native/launcher.ts"));
  const reader = makeReader({
    parents: { 300: 200, 200: 1 },
    envs: {
      101: {
        DISPLAY: ":renderer",
        XDG_RUNTIME_DIR: "/run/renderer"
      },
      102: {
        DISPLAY: ":main",
        XDG_RUNTIME_DIR: "/run/main",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/main/bus",
        XAUTHORITY: "/tmp/main-auth"
      }
    },
    cmdlines: {
      101: ["/opt/Obsidian/obsidian", "--type=renderer"],
      102: ["/opt/Obsidian/obsidian"]
    },
    pids: [101, 102]
  });

  const recovered = recoverLinuxGuiEnv(
    { PATH: process.env.PATH },
    {
      currentPid: 300,
      procReader: reader
    }
  );

  assert.deepEqual(recovered, {
    DISPLAY: ":main",
    XDG_RUNTIME_DIR: "/run/main",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/main/bus",
    XAUTHORITY: "/tmp/main-auth"
  });
});

test("mergeObsidianLaunchEnv preserves explicit values and derives DBUS from XDG runtime", async () => {
  const { mergeObsidianLaunchEnv } = await import(path.resolve("src/native/launcher.ts"));

  const merged = mergeObsidianLaunchEnv(
    {
      DISPLAY: ":explicit",
      XDG_RUNTIME_DIR: "/run/explicit"
    },
    {
      DISPLAY: ":recovered",
      WAYLAND_DISPLAY: "wayland-1"
    }
  );

  assert.equal(merged.DISPLAY, ":explicit");
  assert.equal(merged.WAYLAND_DISPLAY, "wayland-1");
  assert.equal(merged.DBUS_SESSION_BUS_ADDRESS, "unix:path=/run/explicit/bus");
});

test("shouldRefreshObsidianLaunch matches the known recoverable runtime errors", async () => {
  const { shouldRefreshObsidianLaunch } = await import(path.resolve("src/native/launcher.ts"));

  assert.equal(shouldRefreshObsidianLaunch("The CLI is unable to find Obsidian. Please make sure Obsidian is running and try again."), true);
  assert.equal(shouldRefreshObsidianLaunch("Obsidian is not running"), true);
  assert.equal(shouldRefreshObsidianLaunch("native failure"), false);
});
