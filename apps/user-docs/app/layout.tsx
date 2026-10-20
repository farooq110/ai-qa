import { RootProvider } from 'fumadocs-ui/provider/next'
import type { Metadata } from 'next'
import { JetBrains_Mono, Schibsted_Grotesk } from 'next/font/google'
import type { ReactNode } from 'react'
import './globals.css'

const grotesk = Schibsted_Grotesk({ subsets: ['latin'], variable: '--font-grotesk', display: 'swap' })
const jetbrains = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains', display: 'swap' })

export const metadata: Metadata = {
  title: {
    default: 'ProoflineQA Docs',
    template: '%s — ProoflineQA Docs',
  },
  description:
    'The step-by-step user guide for ProoflineQA. Learn how to connect your repositories, review AI-generated tests, and run your approved test suite.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${grotesk.variable} ${jetbrains.variable}`}
      suppressHydrationWarning
    >
      <body className="flex min-h-screen flex-col">
        <RootProvider theme={{ defaultTheme: 'dark' }}>{children}</RootProvider>
      </body>
    </html>
  )
}
