import fs from "node:fs";
import path from "node:path";

export function atomicWriteFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.optsidian-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  try {
    fs.writeFileSync(tmp, contents, "utf8");
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // Best-effort cleanup only.
    }
    throw error;
  }
}
