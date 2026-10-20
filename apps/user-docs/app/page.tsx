import Link from 'next/link'
import { HomeLayout } from 'fumadocs-ui/layouts/home'
import {
  BookOpen,
  Building2,
  CreditCard,
  FileCode2,
  FolderGit2,
  LayoutDashboard,
  PlayCircle,
  ShieldCheck,
  TestTube2,
  Users,
  Webhook,
} from 'lucide-react'

const chapters = [
  {
    href: '/docs/getting-started/create-an-account',
    icon: BookOpen,
    title: 'Getting Started',
    description: 'Create your organization, sign in, and understand roles.',
  },
  {
    href: '/docs/projects/connecting-a-repository',
    icon: FolderGit2,
    title: 'Projects',
    description: 'Import a repository, including one app from a monorepo.',
  },
  {
    href: '/docs/dashboard/project-control-center',
    icon: LayoutDashboard,
    title: 'Dashboard',
    description: 'Analyze a repository and generate test candidates.',
  },
  {
    href: '/docs/test-cases/reviewing-ai-tests',
    icon: TestTube2,
    title: 'Test Cases',
    description: 'Review AI drafts, write steps, record flows, organize tests.',
  },
  {
    href: '/docs/executions/running-tests',
    icon: PlayCircle,
    title: 'Executions',
    description: 'Start runs, read results and evidence, rerun failures.',
  },
  {
    href: '/docs/ci-cd/how-ci-works',
    icon: Webhook,
    title: 'CI / CD',
    description: 'Run the approved suite on every deploy and report on the commit.',
  },
  {
    href: '/docs/settings/repository-providers',
    icon: Building2,
    title: 'Settings',
    description: 'Repository providers, environments, and your account.',
  },
  {
    href: '/docs/team/managing-members',
    icon: Users,
    title: 'Team',
    description: 'Invite members and tune what each role can do.',
  },
  {
    href: '/docs/billing/plans-and-intervals',
    icon: CreditCard,
    title: 'Billing',
    description: 'Plans, usage, and subscription management.',
  },
]

const reference = [
  {
    href: '/docs/reference/test-steps',
    icon: FileCode2,
    title: 'Test steps reference',
    description: 'Actions, target resolution, waits, timeouts, variables.',
  },
  {
    href: '/docs/reference/ci',
    icon: Webhook,
    title: 'CI reference',
    description: 'Events per provider, idempotency, statuses reported.',
  },
  {
    href: '/docs/security',
    icon: ShieldCheck,
    title: 'Security and data handling',
    description: 'What is read, what is sent to the model, how secrets are stored.',
  },
]

const roles = [
  { href: '/docs/test-cases/reviewing-ai-tests', title: 'I review tests', hint: 'QA' },
  { href: '/docs/ci-cd/setting-up-ci', title: 'I wire up CI', hint: 'Developer' },
  { href: '/docs/settings/repository-providers', title: 'I set up the workspace', hint: 'Admin' },
]

function CardLink({
  href,
  icon: Icon,
  title,
  description,
}: {
  href: string
  icon: typeof BookOpen
  title: string
  description: string
}) {
  return (
    <Link
      href={href}
      className="group rounded-lg border border-fd-border bg-fd-card p-4 transition-colors hover:border-fd-primary"
    >
      <Icon className="size-4 text-fd-primary" />
      <h3 className="mt-3 text-sm font-semibold text-fd-foreground">{title}</h3>
      <p className="mt-1 text-sm text-fd-muted-foreground">{description}</p>
    </Link>
  )
}

export default function HomePage() {
  return (
    <HomeLayout
      nav={{
        title: (
          <span className="inline-flex items-center gap-2 font-semibold">
            <span className="flex size-7 items-center justify-center rounded-md bg-fd-primary text-sm font-bold text-fd-primary-foreground">
              P
            </span>
            ProoflineQA Docs
          </span>
        ),
      }}
      links={[{ text: 'Documentation', url: '/docs' }]}
    >
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 pb-24">
        <section className="flex flex-col items-start gap-5 py-16">
          <p className="font-mono text-xs uppercase tracking-widest text-fd-muted-foreground">
            Documentation
          </p>
          <h1 className="max-w-2xl text-4xl font-semibold tracking-tight text-fd-foreground sm:text-5xl">
            AI drafts the tests. Your team approves them. Only approved tests run.
          </h1>
          <p className="max-w-2xl text-lg text-fd-muted-foreground">
            Connect a repository, review generated tests, and run the approved suite on demand or on
            every deploy.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href="/docs"
              className="rounded-md bg-fd-primary px-4 py-2 text-sm font-semibold text-fd-primary-foreground transition-opacity hover:opacity-90"
            >
              Quickstart
            </Link>
            <Link
              href="/docs/concepts"
              className="rounded-md border border-fd-border px-4 py-2 text-sm font-semibold text-fd-foreground transition-colors hover:bg-fd-muted"
            >
              Concepts
            </Link>
          </div>
        </section>

        <section aria-label="Start here" className="mb-12 grid gap-3 sm:grid-cols-3">
          {roles.map((role) => (
            <Link
              key={role.href}
              href={role.href}
              className="flex items-baseline justify-between rounded-lg border border-fd-border bg-fd-card px-4 py-3 text-sm transition-colors hover:border-fd-primary"
            >
              <span className="font-semibold text-fd-foreground">{role.title}</span>
              <span className="font-mono text-xs text-fd-muted-foreground">{role.hint}</span>
            </Link>
          ))}
        </section>

        <h2 className="mb-3 text-sm font-semibold text-fd-muted-foreground">Guides</h2>
        <section aria-label="Guides" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {chapters.map((chapter) => (
            <CardLink key={chapter.href} {...chapter} />
          ))}
        </section>

        <h2 className="mb-3 mt-12 text-sm font-semibold text-fd-muted-foreground">Reference</h2>
        <section aria-label="Reference" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {reference.map((item) => (
            <CardLink key={item.href} {...item} />
          ))}
        </section>
      </main>
    </HomeLayout>
  )
}
