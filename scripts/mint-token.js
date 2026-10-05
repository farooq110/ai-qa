/* One-off: mint an access token for the org owner so the worker can be driven via API. */
const path = require("path");
const fs = require("fs");
const jwt = require(path.join(__dirname, "..", "node_modules", ".pnpm", "jsonwebtoken@9.0.3", "node_modules", "jsonwebtoken"));

const envPath = path.join(__dirname, "..", ".env");
for (const line of fs.readFileSync(envPath, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { PrismaClient } = require(path.join(__dirname, "..", "apps", "api", "node_modules", "@prisma", "client"));
const prisma = new PrismaClient();

(async () => {
  const projectId = process.argv[2];
  let orgId;
  if (projectId) {
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { organizationId: true } });
    orgId = project?.organizationId;
    if (!orgId) { console.error("project not found"); process.exit(1); }
  }
  const users = await prisma.user.findMany({ where: orgId ? { membership: { organizationId: orgId } } : undefined, take: 5, orderBy: { createdAt: "asc" }, select: { id: true, email: true, isSuperadmin: true, membership: { select: { organizationId: true, role: true } } } });
  console.log(JSON.stringify(users));
  const user = users.find((u) => u.membership) ?? users[0];
  const token = jwt.sign({ userId: user.id, organizationId: user.membership?.organizationId ?? "", role: user.membership?.role ?? "OWNER" }, process.env.JWT_SECRET, { expiresIn: "8h" });
  console.log("TOKEN=" + token);
  await prisma.$disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
