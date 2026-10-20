import { DocsLayout } from 'fumadocs-ui/layouts/docs'
import type { ReactNode } from 'react'
import { source } from '@/lib/source'

export default function RootDocsLayout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.pageTree}
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
    >
      {children}
    </DocsLayout>
  )
}
