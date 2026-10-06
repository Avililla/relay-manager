"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useUnsavedContext } from "@/components/providers/unsaved-changes-provider"

type LinkProps = React.ComponentProps<typeof Link>

function hrefToString(href: LinkProps["href"]): string {
  if (typeof href === "string") return href
  const path = href.pathname ?? ""
  const q = href.query
  let search = typeof href.search === "string" ? href.search : ""
  if (!search && q && typeof q === "object") {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(q)) {
      if (Array.isArray(v)) v.forEach((x) => params.append(k, String(x)))
      else if (v !== undefined && v !== null) params.append(k, String(v))
    }
    const s = params.toString()
    search = s ? `?${s}` : ""
  }
  return `${path}${search}${href.hash ? (href.hash.startsWith("#") ? href.hash : `#${href.hash}`) : ""}`
}

/**
 * Every in-app link (§8.8). Wraps next/link; when a registered form is dirty, `onNavigate` cancels the navigation
 * and the confirm dialog asks first. Use `<Button asChild><AppLink/></Button>` for button-looking links.
 */
function AppLink({ onNavigate, href, replace, scroll, ...props }: LinkProps) {
  const router = useRouter()
  const unsaved = useUnsavedContext()
  return (
    <Link
      href={href}
      replace={replace}
      scroll={scroll}
      onNavigate={(e) => {
        onNavigate?.(e)
        if (!unsaved?.isDirty()) return
        e.preventDefault()
        const target = hrefToString(href)
        unsaved.confirmLeave(() => {
          if (replace) router.replace(target, { scroll: scroll !== false })
          else router.push(target, { scroll: scroll !== false })
        })
      }}
      {...props}
    />
  )
}

export { AppLink }
