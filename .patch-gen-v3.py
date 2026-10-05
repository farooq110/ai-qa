import io
p = r"C:\Users\MuhammadNafees\OneDrive - Royal Cyber Inc\Documents\test\app\apps\api\src\generations\generations.service.ts"
t = io.open(p, encoding="utf-8").read()

# 1. KnowledgeModel interface: new shape
old = "interface KnowledgeModel { framework?: string; language?: string; routes?: string[]; components?: string[]; apiCalls?: string[]; forms?: string[]; capabilities?: string[]; analyzedFiles?: string[]; }"
new = """interface RouteInfo { path: string; page: string; feature: string }
interface DiscoveredPage { url: string; route?: string; title: string; navItems: string[]; buttons: string[]; inputs: string[]; headings: string[] }
interface KnowledgeModel {
  framework?: string;
  language?: string;
  routes?: RouteInfo[];
  components?: string[];
  reachableComponents?: string[];
  discoveredPages?: DiscoveredPage[];
  discoveryError?: string;
  apiCalls?: string[];
  capabilities?: string[];
  analyzedFiles?: string[];
}"""
assert old in t, "KnowledgeModel anchor missing"
t = t.replace(old, new, 1)

# 2. CandidateDraft: keep module/tags, add route already exists. Nothing to change.

# 3. buildTargets: route-first targets carrying discovered page context
start = t.index("  private buildTargets(model: KnowledgeModel) {")
end = t.index("\n  }\n", start) + len("\n  }\n")
new_build = """  private buildTargets(model: KnowledgeModel): Array<{ capability: string; route?: string; page?: DiscoveredPage }> {
    const discovered = model.discoveredPages ?? [];
    const targets: Array<{ capability: string; route?: string; page?: DiscoveredPage }> = [];
    for (const route of model.routes ?? []) {
      if (route.path === "*") continue;
      const page = discovered.find((entry) => entry.route === route.path)
        ?? discovered.find((entry) => entry.route !== undefined && entry.route !== "/" && route.path !== "/" && route.path.startsWith(entry.route));
      targets.push({ capability: route.feature, route: route.path, page });
    }
    for (const name of model.reachableComponents ?? []) {
      if (targets.length >= 24) break;
      if (!this.isFeatureWorthy(name) || targets.some((target) => target.capability === name)) continue;
      targets.push({ capability: name });
    }
    return targets;
  }
"""
t = t[:start] + new_build + t[end:]

# 4. providerCandidates: page-grounded prompt + payload
s = t.index("  private async providerCandidates(")
e = t.index("\n  }\n", s) + len("\n  }\n")
new_provider = """  private async providerCandidates(
    impl: ModelProvider,
    providerName: string,
    providerModel: string,
    targets: Array<{ capability: string; route?: string; page?: DiscoveredPage }>,
    model: KnowledgeModel
  ): Promise<CandidateDraft[]> {
    const systemPrompt = [
      "You are a senior QA engineer writing scenario-based Playwright tests for a React web application.",
      "Return ONLY a JSON object: {\\"candidates\\":[{\\"title\\",\\"capability\\",\\"category\\",\\"priority\\",\\"route\\",\\"confidence\\",\\"preconditions\\":[string],\\"steps\\":[{\\"action\\",\\"target\\",\\"value?\\",\\"condition?\\"}],\\"expectedResult\\",\\"module\\",\\"tags\\":[string]}]}.",
      "actions: navigate|click|fill|select|upload|assert|waitFor. conditions: visible|hidden|equals|contains|urlMatches.",
      "categories: HAPPY_PATH|NEGATIVE|BOUNDARY|VALIDATION|PERMISSION|ERROR|STATE|INTEGRATION. priorities: CRITICAL|HIGH|MEDIUM|LOW. confidence: 0-1.",
      "Each capability may carry a 'route' and a 'discovered' object captured from the LIVE deployed application. When present:",
      "- The FIRST step must be navigate with target = the route path (relative, no domain).",
      "- click/fill targets MUST use the exact discovered button labels and input placeholders/labels — they are verified to exist on the page. Never invent element names that are not in the discovered data.",
      "For EVERY capability write 3 tests with DIFFERENT categories:",
      "1. HAPPY_PATH: a complete user workflow (4-8 steps) exercising the feature end to end the way a real user would.",
      "2. VALIDATION or NEGATIVE: invalid/empty/malformed input and the specific expected behavior.",
      "3. ERROR, BOUNDARY, STATE, PERMISSION, or INTEGRATION — whichever genuinely applies.",
      "Every candidate must include \\"module\\": the business area in short Title Case (e.g. 'Cart and Checkout', 'Authentication', 'Summary'), consistent across candidates. And \\"tags\\": up to 3 lowercase labels from [smoke, critical, regression, forms, navigation, upload, auth, error-handling, e2e].",
      "Titles must describe the scenario ('Create product and verify it appears in catalog'), not the category. At most 8 steps."
    ].join(" ");

    // Batched: small groups keep outputs well-formed and limit blast radius.
    const batchSize = 6;
    const batches: Array<typeof targets> = [];
    for (let index = 0; index < targets.length; index += batchSize) batches.push(targets.slice(index, index + batchSize));

    const all: CandidateDraft[] = [];
    let failedBatches = 0;
    for (const batch of batches) {
      const prompt = JSON.stringify({
        application: { framework: model.framework, language: model.language },
        capabilities: batch.map((target) => ({
          capability: target.capability,
          route: target.route,
          discovered: target.page ? {
            pageTitle: target.page.title,
            navItems: target.page.navItems,
            buttons: target.page.buttons,
            inputs: target.page.inputs,
            headings: target.page.headings
          } : undefined
        }))
      }).slice(0, 14_000);
      try {
        const response = await impl.generateStructured<{ candidates?: CandidateDraft[] }>({
          organizationId: "", projectId: "", jobId: "generation",
          capability: "test-generation",
          systemPrompt,
          prompt,
          schemaName: "CandidateList",
          schema: {}
        });
        all.push(...(Array.isArray(response.output?.candidates) ? response.output.candidates : []));
      } catch (batchError) {
        failedBatches += 1;
        this.logger.warn(`Generation batch failed (${batchError instanceof Error ? batchError.message : batchError}); continuing with ${batches.length - failedBatches} remaining`);
      }
    }
    if (!all.length) throw new Error(`all ${failedBatches} generation batches failed`);
    void providerName;
    void providerModel;
    return all;
  }
"""
t = t[:s] + new_provider + t[e:]

# 5. module seeding from route feature names when AI module missing
old_loop_end = """      const routeFeatures = new Map((model.routes ?? []).map((route) => [route.path, route.feature]));
      for (const draft of fresh) if (!draft.module && draft.route) draft.module = routeFeatures.get(draft.route);
"""
if old_loop_end not in t:
    anchor = "      if (fresh.length) {"
    addition = """      const routeFeatures = new Map((model.routes ?? []).map((route) => [route.path, route.feature]));
      for (const draft of fresh) if (!draft.module && draft.route) draft.module = routeFeatures.get(draft.route);
      if (fresh.length) {"""
    assert anchor in t, "fresh anchor missing"
    t = t.replace(anchor, addition, 1)

io.open(p, "w", encoding="utf-8", newline="\n").write(t)
print("generation grounded in routes + discovered pages")
