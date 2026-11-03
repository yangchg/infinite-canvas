import { backup } from "node:sqlite";
import { mkdir, cp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { database } from "../src/database.js";
const source = resolve(process.env.DATA_DIR || "data");
const destination = process.argv[2] && resolve(process.argv[2]);
if (!destination || destination === source || destination.startsWith(source + "/") || destination.startsWith(source + "\\")) throw new Error("请指定数据目录之外的全新备份目录");
await mkdir(destination); // Never overwrite an existing backup.
const db = database(source);
try {
  // Files are immutable and never physically removed, so snapshot DB first, then copy its resources.
  await backup(db, join(destination, "canvas.sqlite"));
  await cp(join(source, "files"), join(destination, "files"), { recursive: true });
  console.log("备份完成；请将该目录复制到部署机器之外");
} finally { db.close(); }
