import { cn } from "@/lib/client/cn"

/**
 * The optional banner strip (§8.1) for pages outside the app shell (login, setup) and for the preview in
 * Sistema > General. Same look as the shell's BannerStrip: 24 px, warn tint, centred --foreground text. Below 640 px
 * it may take two lines so a long banner (up to 120 characters) stays readable; the full text is also in the title.
 */
export function PublicBanner({ text, className }: { text: string | null; className?: string }) {
  if (!text) return null
  return (
    <div className={cn("flex min-h-6 shrink-0 items-center justify-center overflow-hidden bg-warn-tint px-4 py-0.5 text-meta text-foreground shadow-[inset_0_-1px_0_var(--border)]", className)}>
      <p title={text} className="truncate text-center max-sm:line-clamp-2 max-sm:whitespace-normal max-sm:text-pretty">{text}</p>
    </div>
  )
}
