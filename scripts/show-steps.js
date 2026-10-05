/* One-off: print a test case's steps. Usage: node scripts/show-steps.js <testCaseId> */
const path = require("path");
const fs = require("fs");

const envPath = path.join(__dirname, "..", ".env");
for (const line of fs.readFileSync(envPath, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { PrismaClient } = require(path.join(__dirname, "..", "apps", "api", "node_modules", "@prisma", "client"));
const prisma = new PrismaClient();

(async () => {
  const t = await prisma.testCase.findUnique({ where: { id: process.argv[2] }, select: { title: true, version: true, status: true, definition: true } });
  console.log(JSON.stringify(t, null, 1));
  await prisma.$disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
