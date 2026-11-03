import { randomUUID } from "node:crypto";
import { database } from "../src/database.js";
import { hashPassword } from "../src/password.js";
const { ADMIN_USERNAME: username, ADMIN_PASSWORD: password } = process.env;
if (!username || !password || !/^[a-zA-Z0-9_.-]+$/.test(username)) throw new Error("请设置 ADMIN_USERNAME、ADMIN_PASSWORD；用户名仅允许字母、数字、下划线、点和横线");
const db = database(process.env.DATA_DIR || "data");
try {
  if (db.prepare("SELECT 1 FROM users WHERE admin=1").get()) throw new Error("已有管理员，请通过管理页面操作");
  db.prepare("INSERT INTO users(id,username,displayName,password,admin) VALUES(?,?,?,?,1)").run(randomUUID(), username, username, await hashPassword(password));
  console.log("初始管理员已创建");
} finally { db.close(); }
