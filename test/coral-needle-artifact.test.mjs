import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import {
  ensureCoralNeedleBinding,
  resolveCoralNeedleReleaseAsset
} from "../src/daemon/vector-store/artifact.ts";

test("resolves coral-needle release asset for Node platform and arch names", () => {
  const linux = resolveCoralNeedleReleaseAsset("linux", "x64");
  assert.equal(linux.name, "coral-needle-v0.2.0-linux-amd64.tar.gz");
  assert.equal(linux.arch, "amd64");

  const darwin = resolveCoralNeedleReleaseAsset("darwin", "arm64");
  assert.equal(darwin.name, "coral-needle-v0.2.0-darwin-arm64.tar.gz");

  assert.throws(() => resolveCoralNeedleReleaseAsset("freebsd", "x64"), /not available/);
});

test("installs coral-needle binding into managed cache from release archive", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "optsidian-coral-needle-test-"));
  try {
    const binding = Buffer.from("fake native addon bytes");
    const archive = gzipTarSingleFile("coral-needle.node", binding);
    const asset = {
      platform: "linux",
      arch: "amd64",
      archiveType: "tar.gz",
      name: "coral-needle-test-linux-amd64.tar.gz",
      size: archive.length,
      sha256: sha256(archive),
      bindingSize: binding.length,
      bindingSha256: sha256(binding)
    };
    let downloads = 0;
    const installedPath = await ensureCoralNeedleBinding(
      { ...process.env, XDG_CACHE_HOME: tempRoot, OPTSIDIAN_CORAL_NEEDLE_BINDING: "" },
      {
        asset,
        downloadFile: async (_url, targetPath) => {
          downloads += 1;
          fs.writeFileSync(targetPath, archive);
        }
      }
    );

    assert.equal(downloads, 1);
    assert.equal(path.basename(installedPath), "coral-needle.node");
    assert.deepEqual(fs.readFileSync(installedPath), binding);

    const manifestPath = path.join(path.dirname(installedPath), "optsidian-coral-needle.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.package, "coral-needle");
    assert.equal(manifest.version, "v0.2.0");
    assert.equal(manifest.assetSha256, asset.sha256);

    const cachedPath = await ensureCoralNeedleBinding(
      { ...process.env, XDG_CACHE_HOME: tempRoot, OPTSIDIAN_CORAL_NEEDLE_BINDING: "" },
      {
        asset,
        downloadFile: async () => {
          throw new Error("should not download an already installed binding");
        }
      }
    );
    assert.equal(cachedPath, installedPath);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function gzipTarSingleFile(name, data) {
  const header = Buffer.alloc(512);
  writeTarString(header, 0, 100, name);
  writeTarString(header, 100, 8, "0000600");
  writeTarString(header, 108, 8, "0000000");
  writeTarString(header, 116, 8, "0000000");
  writeTarString(header, 124, 12, data.length.toString(8).padStart(11, "0"));
  writeTarString(header, 136, 12, "00000000000");
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeTarString(header, 257, 6, "ustar");
  writeTarString(header, 263, 2, "00");
  const checksum = [...header].reduce((total, byte) => total + byte, 0);
  writeTarString(header, 148, 8, checksum.toString(8).padStart(6, "0"));
  header[154] = 0;
  header[155] = 0x20;

  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return zlib.gzipSync(Buffer.concat([header, data, padding, Buffer.alloc(1024)]));
}

function writeTarString(buffer, offset, length, value) {
  buffer.write(value, offset, Math.min(length, Buffer.byteLength(value)), "ascii");
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}
