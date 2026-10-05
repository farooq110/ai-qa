# AI QA Platform MVP Plan

## Product Principle

Connect a repository, understand the application, generate structured test candidates, require human approval, and execute only approved tests.

AI-generated tests must never execute until approved by a human.

## Platform Architecture

Build a multi-tenant SaaS as a TypeScript modular monolith for the control plane, with isolated asynchronous workers for untrusted repository analysis, AI generation, and Playwright execution.

- Customer dashboard: organization users, projects, tests, executions, billing, and settings.
- Superadmin dashboard: platform operations, plans, quotas, provider keys, models, workers, jobs, audits.
- Shared API: Node.js, TypeScript, NestJS, Fastify.
- Relational database: PostgreSQL with Prisma.
- Queue: Redis and BullMQ.
- Artifact storage: S3-compatible object storage.
- Workers: ephemeral, resource-limited containers.
- Browser automation: Playwright.
- Billing: Stripe Billing, Checkout, Customer Portal, and webhooks.
- AI: provider-independent `ModelProvider` abstraction.

## Repository Layout

Use a `pnpm` workspace and Turborepo monorepo.

```text
ai-qa-platform/
├── apps/
│   ├── web/                 # Customer dashboard, e.g. app.example.com
│   ├── admin/               # Superadmin dashboard, e.g. admin.example.com
│   ├── api/                 # NestJS + Fastify control plane, e.g. api.example.com
│   └── workers/             # Isolated background runners
├── packages/
│   ├── database/            # Prisma schema, migrations, client
│   ├── contracts/           # API DTOs and job payloads
│   ├── domain/              # Domain models and policies
│   ├── authorization/       # RBAC and permissions
│   ├── ui/                  # Shared UI components
│   ├── config/              # Shared lint/TypeScript configuration
│   ├── repository-providers/# GitHub and Bitbucket adapters
│   ├── ci-providers/        # GitHub, GitLab, Bitbucket CI adapters
│   ├── model-provider/      # AI provider abstraction/adapters
│   ├── test-dsl/            # Machine-readable test schema
│   └── observability/       # Logging, metrics, tracing
├── infrastructure/
│   ├── docker/
│   ├── compose/
│   ├── terraform/
│   └── kubernetes/
├── docs/
│   ├── architecture/
│   ├── api/
│   ├── ci-integrations/
│   ├── security/
│   └── runbooks/
├── pnpm-workspace.yaml
├── turbo.json
└── package.json
```

The separate customer and superadmin applications reduce UI exposure, but the backend is always the authorization boundary. Superadmin endpoints require backend authorization, MFA, a separate cookie/session scope, and audit logging.

## Organizations, Accounts, and Roles

An organization is the tenant, billing, and data-isolation boundary.

- One user account belongs to exactly one organization in the MVP.
- A user cannot switch between or belong to multiple organizations in the MVP.
- One organization can have multiple users and multiple projects.
- Every project, repository, analysis job, test, artifact, subscription, usage record, and execution belongs to exactly one organization.
- Signup creates one user and one organization; that user becomes the initial organization admin.
- Signup collects user name, work email, password or identity-provider login, organization name, business type/industry, organization size, country/region, and optional billing contact details.

Organization roles:

- Admin
- QA
- Developer

Only Admins can create users, manage roles, view billing, change plans, update payment methods, cancel subscriptions, or reactivate billing. QA and Developer permissions are centralized and configurable later. All API endpoints and workers must authorize server-side; hiding a UI control is not authorization.

Initial permission matrix:

| Capability | Admin | QA | Developer |
|---|---:|---:|---:|
| Manage organization users | Yes | No | No |
| View/manage billing | Yes | No | No |
| Connect repositories | Yes | Configurable | Configurable |
| Review/approve tests | Yes | Configurable | Configurable |
| Execute approved tests | Yes | Configurable | Configurable |
| View results | Yes | Configurable | Configurable |

## Stripe Billing and Access Enforcement

Stripe is the billing source of truth. Store a local synchronized subscription snapshot for fast authorization and UI display. Never store raw card details.

Plans have Monthly, Quarterly, and Yearly billing intervals. Plan configuration includes AI quotas, execution-concurrency limits, storage/retention policies, and other product limits.

Subscription state:

```text
TRIALING / ACTIVE
       ↓
PAYMENT_WARNING
       ↓
PAST_DUE
       ├── ACTIVE after successful payment
       └── BILLING_LOCKED after unpaid due date
       ↓
CANCELED / EXPIRED
```

Requirements:

- Admins receive warnings before renewal/due date when payment is missing, expiring, or failing.
- Stripe webhooks update the subscription idempotently with signature validation and reconciliation.
- Admins alone can see plan, invoices, renewal date, payment status, and usage.
- Before the due date, access remains available while warnings are shown.
- After an unpaid due date, the organization becomes `BILLING_LOCKED`.
- A billing lock blocks analysis, generation, regeneration, test create/edit/approve actions, and test execution.
- Execution must be blocked from dashboard, API, schedule, retry, webhook, CI, or manual rerun.
- Existing data can remain read-only according to role policy.
- Jobs must re-check billing immediately before work begins.
- Successful Stripe webhook processing, not a browser redirect alone, removes the lock.
- Cancellation at period end preserves access through the paid period.

## AI Quotas and Model Management

AI usage is pooled across all projects in an organization. It is not allocated separately per project unless a later policy adds sub-limits.

Track input tokens, output tokens, cached tokens, model calls, estimated/actual cost, provider, model, project, job, organization, and billing period.

- Pricing plans define token quotas, warning thresholds, hard limits, and optional future overage policy.
- Reserve estimated usage before a generation job starts, then reconcile actual provider usage.
- Enforce quotas in the API and again in workers.
- Reject generation before calling a provider if remaining quota cannot cover the estimated job.
- Partial work must record consumed usage and remain resumable.

Platform superadmin responsibilities:

- Manage providers, models, routing policies, plan quotas, and pricing metadata.
- Store provider API keys only server-side through encrypted secrets/KMS storage.
- Rotate/revoke keys, perform health checks, and receive provider-failure alerts.
- Keep superadmin actions in a separate audit trail.
- Never expose provider keys to customers, browser clients, generated tests, or untrusted repository code.

### ModelProvider

All AI operations use a single server-side provider interface. Application code must not call a vendor SDK directly.

```text
ModelProvider
  ├── estimateUsage(request)
  ├── generateStructured(request)
  ├── getUsage(response)
  ├── healthCheck()
  └── supports(model, capability)
```

It handles routing, encrypted credentials, schema-constrained output, usage/cost reporting, retries, timeouts, rate limits, fallback providers, correlation IDs, and log redaction.

Use one primary model and one fallback model/provider initially. Build the abstraction now, but defer complex automatic routing until quality, latency, and cost data exists. Later, use inexpensive models for extraction/classification/deduplication and stronger models for hard reasoning.

## Repository Analysis and Test Generation

Repository connectors support GitHub and Bitbucket. CI integration supports GitHub Actions, GitLab CI, and Bitbucket Pipelines.

Initial analyzer target: React + TypeScript + Vite. Inspect dependencies, routes, components, forms/controls, APIs, state transitions, authentication, and business-logic signals. Combine static AST/dependency analysis with controlled browser discovery.

Never send a complete repository repeatedly to an LLM. Instead:

```text
Pinned repository commit
  → static analysis + browser discovery
  → versioned application knowledge model
  → relevant-context retrieval
  → schema-constrained AI test candidates
  → deterministic validation and deduplication
```

Generate capability-oriented categories: happy path, negative, boundary, validation, permissions, error handling, state changes, and integration.

Each candidate contains human-readable content and machine-readable test steps. Attach source evidence/provenance, capability/route/file relationships, confidence, and coverage information.

2,500 is a coverage target, not an exact requirement. Generation stops when coverage, quality, deduplication, and budget rules are satisfied.

### Test Organization and Discovery

AI-generated tests should be organized primarily by discovered business capability or user-facing functionality, not only by source-code folders. For example:

```text
Authentication
  - Login validation
  - Password reset
Product Management
  - Browse products
  - Product details
  - Product search and filters
Cart and Checkout
  - Add to cart
  - Update quantity
  - Payment validation
```

Each test case can have multiple system-derived classifications:

- Capability/functionality
- Feature area
- Route or page
- Source component/API evidence
- Test category, such as happy path, negative, boundary, validation, permission, error handling, state change, or integration
- Priority and risk

Organization users must also be able to create and maintain their own modules and tags. A user can create a module such as **Product Module**, select relevant tests, and add them to that module. User-managed organization does not replace or overwrite AI-derived classifications.

Requirements:

- A test can belong to multiple user-created modules and have multiple tags.
- Modules can be hierarchical if needed, for example `Product Module > Search and Filters`.
- Tags are lightweight labels for cross-cutting concerns, such as `smoke`, `regression`, `checkout`, `critical`, or `release-1`.
- Users can create, rename, reorder, archive, and delete their own modules/tags according to the configurable permission policy.
- Bulk assignment supports moving or adding selected tests to a module and adding/removing tags.
- “Move” should mean replacing the primary user-managed module assignment only when the user explicitly chooses it; a test may otherwise remain in multiple modules.
- Deleting or archiving a module or tag must not delete its test cases, versions, approvals, or execution history.
- AI regeneration preserves user-managed modules and tags. Newly generated candidates receive AI classifications but are not automatically placed in a user-owned module unless an explicit matching rule exists.
- The test list supports search and filters for module, tag, capability, route, status, source, category, priority, branch, last result, and owner.
- Module/tag changes are auditable and are separate from test-case content/version changes.

## Test Ownership, Lifecycle, and Regeneration

Test sources are AI-generated, manually created, or imported. Preserve all manually authored, approved, edited, and historical/executed tests.

```text
Generated → Pending Review
              ├── Approved → Ready → Running → Passed/Failed
              ├── Edited → new version → Pending Review
              └── Rejected/Deleted/Archived
```

A test edit creates a new version. Existing execution history remains immutable.

### Regeneration

Regeneration must never silently delete all tests.

The dashboard exposes a primary **Regenerate** button and separate down-arrow menu:

1. **Incremental regeneration (Recommended)**
2. **Full regeneration**

Clicking the primary button starts incremental regeneration. Each menu option has an information icon and tooltip. Full regeneration requires confirmation because it can consume more quota. The system records generation mode in the job and audit log and prevents duplicate submissions.

- Incremental: compare the last analyzed commit with the selected target commit; analyze only changed and affected capabilities; create only new/affected AI candidates.
- Full: reanalyze the complete selected repository revision and produce fresh AI candidates for comparison.

Both modes preserve manual, approved, edited, and historical tests. Duplicates are linked/discarded; affected existing tests can be marked `Needs Review`; pending AI tests can be superseded or archived.

Store commit-based snapshots:

```text
GenerationRun
- repository and branch
- baseCommit and targetCommit
- previous/new knowledge model versions
- changed files and affected capabilities
- generated candidates
- token usage and mode
```

Tests store generated-from commit, last-validated commit, source files/capabilities, source type, status, and version history. Use `git diff baseCommit...targetCommit`, AST/import dependency graphs, API/route/component relations, and test-to-source mapping to determine impact. For pull requests use merge-base comparison with the feature branch head.

## Dashboard Execution

Only approved test versions can execute.

Dashboard actions:

- Run one approved test
- Run selected approved tests
- Run all approved tests in a suite or project
- Rerun selected failed tests

Before queueing and before worker execution, validate membership, permission, billing, environment access, approval, and policy limits. Each action creates an immutable execution plan recording selected test versions, code revision, environment, browser profile, and settings.

Each project has a default test branch, initially from the connected repository default branch. Authorized users can select another repository branch or exact commit SHA for an individual run. This does not change the default branch. Changing the default is a separate audited project-management action.

The selected deployment/application URL must match the selected branch or commit. Block or require explicit confirmation when no matching environment is configured. Warn when selected code differs materially from the generation revision; regeneration remains separate.

## CI/CD Execution

CI runs execute approved tests only and normally consume zero AI tokens.

```text
Push to branch
  → GitHub Actions / GitLab CI / Bitbucket Pipelines
  → provider sends repository, branch, commit SHA, pipeline identity
  → validate organization, billing, project, and permission
  → pin exact commit
  → execute approved test snapshot with Playwright
  → return status/artifacts to platform and pipeline
```

For a feature branch, execute against the exact feature-branch commit. The commit SHA is authoritative; a branch name is historical metadata and must never silently resolve to the default branch.

By default, all approved tests run. Future policies may select an explicit approved subset. Pending, rejected, deleted, or unapproved tests never run.

Every CI execution records provider, repository, branch, commit SHA, pipeline run ID, pull request when available, test snapshot, environment, browser profile, and Playwright version.

Branch result tracking supports separate history for `development`, `qa`, `production`, feature branches, and PRs. The same test can pass on development, fail on QA, and pass on production without overwriting history. Test details show branch/commit history, failure message, logs, screenshots, videos, and traces; users can compare branches or commits. Distinguish test failures from environment/deployment failures.

Use a `CiProvider` interface with provider-specific adapters. Validate signatures, prevent replay, use project-scoped least-privilege tokens, avoid secrets in logs, report queued/running/passed/failed/cancelled/blocked states, and store retries as separate attempts.

## Large-Suite Performance

For 3,000 tests, use Playwright sharding and a bounded worker pool. Do not launch 3,000 browser processes at once.

```text
Approved tests → execution planner → balanced shard queue → controlled workers → results/artifacts
```

The planner uses historical duration to balance shards, isolates browser contexts and test data, retries only failed/timed-out tests, prevents duplicate execution, and streams live progress.

Limits apply at platform, organization, plan, project, and environment level. Effective concurrency is the minimum of these limits.

Plans sell a maximum number of concurrent test slots, not permanently running worker servers. Workers autoscale up to applicable limits and scale down while idle.

Example plan entitlements:

| Tier | Concurrent test slots |
|---|---:|
| Starter | 5 |
| Team | 25 |
| Business | 100 |
| Enterprise | Configurable |

The superadmin configures global capacity, plan limits, resource profiles, max queue time, artifact retention, and fairness. Organization admins can choose a lower project limit but cannot exceed plan limits.

Each worker has CPU, memory, disk, browser-session, and execution-time limits. Configure environment concurrency to avoid overloading customer application/database/session capacity. Tests with shared mutation must use isolated accounts/namespaces/seeded data or run serially.

Approximation:

```text
wall-clock time ≈ total test duration / effective workers + startup and queue overhead
```

For 3,000 one-minute tests: serial execution is about 50 hours; 50 workers about 60 minutes plus overhead; 100 workers about 30 minutes; 200 workers about 15 minutes. Actual time varies with retries, startup, artifacts, uneven workloads, serial tests, and environment throttling.

Measure queue wait, startup, test/shard/retry duration, peak concurrency, resource usage, artifact volume, and environment errors.

## Three.js/WebGL MVP Scope

Support instrumented smoke checks, not pixel-perfect visual testing.

Applications expose observables such as canvas rendered, model loaded, object selected, camera changed, decoration applied, scene state changed, and key controls responding. Defer broad visual regression, GPU compatibility, and performance testing.

## Core Entities

- Organization, User, OrganizationMembership, Role, PermissionPolicy
- Subscription, BillingEvent, BillingAlert, PricingPlan, PlanQuotaPolicy, PlanExecutionPolicy
- AIProvider, AIModel, EncryptedProviderCredential, ModelRoutingPolicy, AIUsageReservation, AIUsageRecord, AIUsagePeriod
- Project, RepositoryConnection, RepositoryRevision, AnalysisJob
- ApplicationModelVersion, ApplicationEntity, ApplicationRelation, EvidenceArtifact
- TestSuite, TestCase, TestCaseVersion, TestStep, TestReview
- TestModule, TestModuleMembership, TestTag, TestTagAssignment
- EnvironmentProfile, ExecutionPlan, TestExecution, StepExecution, Artifact
- CiProviderConnection, CiExecutionRequest, AuditEvent

Version application knowledge models, test-case versions, repository revisions, and execution plans immutably. Soft-delete/archiving retains audit history.

## Implementation Phases

1. Foundation: signup, organization roles, tenant isolation, billing, Stripe webhooks, pricing plans, quotas, superadmin controls, secrets, projects, environments, revisions, jobs.
2. Repository and analysis: provider adapters, pinned commits, React/TypeScript/Vite analyzer, knowledge models.
3. Generation and review: test DSL, `ModelProvider`, evidence, deduplication, review dashboard, approve/edit/delete.
4. Execution: Playwright compiler/workers, approved-only gate, shards, concurrency/autoscaling, artifacts, branch-aware CI adapters/statuses.
5. Hardening: billing reconciliation, authorization, tenant isolation, secret redaction, quota races, provider-key rotation, 3,000-case load tests, data isolation, backpressure, fairness, security scanning.
6. Post-MVP: richer incremental impact analysis, optional AI failure analysis, visual/performance capabilities.

## MVP Exclusions

- Autonomous test approval
- Exact 2,500-test guarantee
- Automatic production testing
- Broad visual regression testing
- Performance testing
- Automatic Git commits
- AI-dependent execution on every push
- Custom enterprise billing contracts and usage-based pricing
