export type Faq = { readonly q: string; readonly a: string };

export const faqs: readonly Faq[] = [
  {
    q: "Can an AI-generated test ever run without approval?",
    a: "No. Only approved test versions can execute, from the dashboard, the API, a schedule, a retry or CI. The check happens when a run is queued and again inside the worker right before execution."
  },
  {
    q: "How many AI tokens does a CI run use?",
    a: "Normally zero. CI executes the approved snapshot of your tests with Playwright. AI is only used when you analyze or regenerate."
  },
  {
    q: "Which applications can ProoflineQA analyze today?",
    a: "The first analyzer targets React and TypeScript applications built with Vite. It combines static analysis of routes, components, forms and API calls with controlled browser discovery."
  },
  {
    q: "What happens to my tests when I regenerate?",
    a: "Manual, approved, edited and historical tests are always kept. Incremental regeneration revisits only what changed between commits; duplicates are linked, and affected tests are marked Needs review instead of being replaced."
  },
  {
    q: "Which repositories and pipelines are supported?",
    a: "Repositories on GitHub and Bitbucket. Pipelines on GitHub Actions, GitLab CI and Bitbucket Pipelines, reporting queued, running, passed, failed, cancelled and blocked states."
  },
  {
    q: "Does ProoflineQA test production automatically?",
    a: "No. You choose the environment for each run, and the deployment URL must match the branch or commit you selected."
  },
  {
    q: "Who can approve and run tests?",
    a: "Organizations have Admin, QA and Developer roles. Admins manage users and billing; review and execution permissions are configurable, and every permission is enforced on the server."
  }
];
