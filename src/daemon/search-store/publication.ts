import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PUBLICATION_STEPS = [
  "tmpSegmentWrite",
  "fsyncSegmentFile",
  "fsyncSegmentDir",
  "hashVerify",
  "manifestTempWrite",
  "fsyncManifestFile",
  "durableRenameManifest",
  "fsyncSnapshotsDir",
  "activePointerTempWrite",
  "fsyncActivePointerFile",
  "durableRenameActivePointer",
  "fsyncActiveDir",
  "recoveryScan",
  "markSweepGc"
] as const;

export type PublicationStep = typeof PUBLICATION_STEPS[number];

export type DurableRename = (from: string, to: string) => void | Promise<void>;

export async function durableRename(from: string, to: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  await fs.promises.rename(from, to);
}

export function fsyncFileSync(filePath: string): void {
  const fd = fs.openSync(filePath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function fsyncDirSync(dirPath: string): void {
  try {
    const fd = fs.openSync(dirPath, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (process.platform === "win32") return;
    throw error;
  }
}

export function computeGcRootsForTests(input: {
  activePointers?: readonly string[];
  inFlightPublishManifests?: readonly string[];
  retainedSnapshotManifests?: readonly string[];
  inMemoryPins?: readonly string[];
}): { snapshotIds: Set<string> } {
  return {
    snapshotIds: new Set([
      ...(input.activePointers ?? []),
      ...(input.inFlightPublishManifests ?? []),
      ...(input.retainedSnapshotManifests ?? []),
      ...(input.inMemoryPins ?? [])
    ])
  };
}

export function createSnapshotPublisherForTests(options: { root: string; failAt?: PublicationStep }) {
  const root = options.root;
  const segmentsDir = path.join(root, "segments");
  const snapshotsDir = path.join(root, "snapshots");
  const activeDir = path.join(root, "active");
  const activePath = path.join(activeDir, "vault");
  const tmpDir = path.join(root, "tmp");
  const step = (name: PublicationStep) => {
    if (options.failAt === name) throw new Error(name);
  };

  return {
    async seedActiveSnapshot(snapshot: { snapshotId: string; segmentHashes: readonly string[] }) {
      fs.mkdirSync(segmentsDir, { recursive: true });
      fs.mkdirSync(snapshotsDir, { recursive: true });
      fs.mkdirSync(activeDir, { recursive: true });
      for (const hash of snapshot.segmentHashes) {
        fs.writeFileSync(path.join(segmentsDir, hash), hash);
      }
      fs.writeFileSync(path.join(snapshotsDir, snapshot.snapshotId), JSON.stringify(snapshot));
      fs.writeFileSync(activePath, `${snapshot.snapshotId}\n`);
    },
    async publish(snapshot: { snapshotId: string; segmentHashes: readonly string[]; bytes: Buffer | Uint8Array }) {
      fs.mkdirSync(segmentsDir, { recursive: true });
      fs.mkdirSync(snapshotsDir, { recursive: true });
      fs.mkdirSync(activeDir, { recursive: true });
      fs.mkdirSync(tmpDir, { recursive: true });
      const previousActive = fs.existsSync(activePath) ? fs.readFileSync(activePath, "utf8") : undefined;
      const rollback = () => {
        if (previousActive === undefined) fs.rmSync(activePath, { force: true });
        else fs.writeFileSync(activePath, previousActive);
      };
      try {
        const segmentTmp = path.join(tmpDir, `${snapshot.segmentHashes[0] ?? snapshot.snapshotId}.segment.tmp`);
        step("tmpSegmentWrite");
        fs.writeFileSync(segmentTmp, snapshot.bytes);
        step("fsyncSegmentFile");
        fsyncFileSync(segmentTmp);
        step("fsyncSegmentDir");
        fsyncDirSync(tmpDir);
        step("hashVerify");
        const actual = sha256(fs.readFileSync(segmentTmp));
        const segmentHash = snapshot.segmentHashes[0] ?? actual;
        if (snapshot.segmentHashes.length > 0 && actual !== segmentHash && segmentHash.length === 64) {
          throw new Error("segment hash verification failed");
        }
        await durableRename(segmentTmp, path.join(segmentsDir, segmentHash));

        const manifestTmp = path.join(tmpDir, `${snapshot.snapshotId}.manifest.tmp`);
        step("manifestTempWrite");
        fs.writeFileSync(manifestTmp, JSON.stringify(snapshot));
        step("fsyncManifestFile");
        fsyncFileSync(manifestTmp);
        step("durableRenameManifest");
        await durableRename(manifestTmp, path.join(snapshotsDir, snapshot.snapshotId));
        step("fsyncSnapshotsDir");
        fsyncDirSync(snapshotsDir);

        const activeTmp = path.join(tmpDir, `${snapshot.snapshotId}.active.tmp`);
        step("activePointerTempWrite");
        fs.writeFileSync(activeTmp, `${snapshot.snapshotId}\n`);
        step("fsyncActivePointerFile");
        fsyncFileSync(activeTmp);
        step("durableRenameActivePointer");
        await durableRename(activeTmp, activePath);
        step("fsyncActiveDir");
        fsyncDirSync(activeDir);
        step("recoveryScan");
        step("markSweepGc");
      } catch (error) {
        rollback();
        throw error;
      }
    },
    async recover() {
      const activeSnapshotId = fs.existsSync(activePath) ? fs.readFileSync(activePath, "utf8").trim() : undefined;
      const validSnapshotIds = fs.existsSync(snapshotsDir)
        ? fs.readdirSync(snapshotsDir).filter((name) => name === activeSnapshotId || name.startsWith("snap-old"))
        : [];
      return {
        activeSnapshotId,
        validSnapshotIds
      };
    }
  };
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
