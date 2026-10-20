/* One-off: mint an access token for the org owner so the worker can be driven via API. */
const path = require("path");
const fs = require("fs");
const jwt = require(path.join(__dirname, "..", "node_modules", ".pnpm", "jsonwebtoken@9.0.3", "node_modules", "jsonwebtoken"));

const envPath = path.join(__dirname, "..", ".env");
for (const line of fs.readFileSync(envPath, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { PrismaClient } = require(path.join(__dirname, "..", "packages", "database", "node_modules", "@prisma", "client"));
const prisma = new PrismaClient();

(async () => {
  const wantSuperadmin = process.argv.includes("--superadmin");
  const projectId = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  let orgId;
  if (projectId) {
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { organizationId: true } });
    orgId = project?.organizationId;
    if (!orgId) { console.error("project not found"); process.exit(1); }
  }
  let user;
  if (wantSuperadmin) {
    user = await prisma.user.findUnique({ where: { email: "superadmin@proofline.local" }, select: { id: true, email: true, isSuperadmin: true } });
    if (!user?.isSuperadmin) { console.error("superadmin user missing or flag false"); process.exit(1); }
    user = { ...user, membership: null };
  } else {
    const users = await prisma.user.findMany({ where: orgId ? { membership: { organizationId: orgId } } : undefined, take: 5, orderBy: { createdAt: "asc" }, select: { id: true, email: true, isSuperadmin: true, membership: { select: { organizationId: true, role: true } } } });
    user = users.find((u) => u.membership) ?? users[0];
  }
  if (!user) { console.error("no user found"); process.exit(1); }
  const token = jwt.sign({ userId: user.id, organizationId: user.membership?.organizationId ?? "", role: user.membership?.role ?? "ADMIN" }, process.env.JWT_SECRET, { expiresIn: "8h" });
  console.log("TOKEN=" + token);
  await prisma.$disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
