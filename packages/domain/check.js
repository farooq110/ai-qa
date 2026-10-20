// Run after `pnpm --filter @ai-qa/domain build`: node packages/domain/check.js
const assert = require("node:assert");
const d = require("./dist");
assert.deepStrictEqual(d.appRoles, ["ADMIN", "QA", "DEVELOPER"]);
assert.deepStrictEqual(d.defaultRolePermissions.ADMIN, d.allPermissions);
assert(d.defaultRolePermissions.QA.includes("test_cases:approve") && !d.defaultRolePermissions.QA.includes("billing:manage"));
assert(d.defaultRolePermissions.DEVELOPER.every((p) => p.endsWith(":view")) && !d.defaultRolePermissions.DEVELOPER.includes("roles:view"));
for (const role of d.appRoles) for (const p of d.defaultRolePermissions[role]) assert(d.isPermission(p), p);
assert(!d.isPermission("nope:view"));
// The enum and the module/action catalog must describe exactly the same permissions.
const fromCatalog = Object.entries(d.permissionModules).flatMap(([m, acts]) => acts.map((a) => `${m}:${a}`)).sort();
assert.deepStrictEqual(Object.values(d.PERMISSIONS).sort(), fromCatalog);
assert.strictEqual(d.PERMISSIONS.TEST_CASES_APPROVE, "test_cases:approve");
console.log("domain rbac checks ok");
