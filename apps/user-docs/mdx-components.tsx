import { Callout } from 'fumadocs-ui/components/callout'
import { Card, Cards } from 'fumadocs-ui/components/card'
import { ImageZoom } from 'fumadocs-ui/components/image-zoom'
import { Step, Steps } from 'fumadocs-ui/components/steps'
import { Tab, Tabs } from 'fumadocs-ui/components/tabs'
import defaultComponents from 'fumadocs-ui/mdx'
import type { MDXComponents } from 'mdx/types'

/**
 * Docs screenshot: serves the full-resolution (2x retina) PNG untouched and
 * scales it to the content column, so text stays sharp on any display.
 */
function Shot({
  src,
  alt,
  width,
  height,
}: {
  src: string
  alt: string
  width: number
  height: number
}) {
  return (
    <ImageZoom
      src={src}
      alt={alt}
      width={width}
      height={height}
      style={{ maxWidth: '100%', height: 'auto', borderRadius: 10 }}
    />
  )
}

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultComponents,
    Callout,
    Card,
    Cards,
    ImageZoom,
    Shot,
    Step,
    Steps,
    Tab,
    Tabs,
    ...components,
  }
}
