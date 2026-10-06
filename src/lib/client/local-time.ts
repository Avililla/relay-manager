import { formatDateTime } from "@/lib/i18n/format"

/**
 * An absolute date-time for the viewer. Before mount (the server render and hydration) it is a stable UTC text, so
 * the server and the browser render the same markup; React does not patch mismatched text or attributes during
 * hydration, so a server-zone text would otherwise stay. After mount it is the browser's local time.
 */
export function viewerDateTime(iso: string, mounted: boolean): string {
  return mounted ? formatDateTime(iso) : `${formatDateTime(iso, "UTC")} UTC`
}
