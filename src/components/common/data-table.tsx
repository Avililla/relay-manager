"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon, SearchIcon } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useUnsavedContext } from "@/components/providers/unsaved-changes-provider"
import { common, tables } from "@/lib/i18n/shell"
import { cn } from "@/lib/client/cn"

export interface DataColumn<T> {
  id: string
  header: string
  cell: (row: T) => React.ReactNode
  /** Enables sorting on this column. */
  sortValue?: (row: T) => string | number | null
  /** Text used by the client search. */
  searchValue?: (row: T) => string
  className?: string
  headerClassName?: string
  align?: "left" | "right"
}

type Sort = { id: string; dir: "asc" | "desc" } | null

const fold = (s: string) => s.toLocaleLowerCase("es").normalize("NFD").replace(/\p{M}/gu, "")

/** Pure: filters by the search text across searchable columns, then sorts. Exported for tests and reuse. */
export function tableRows<T>(rows: readonly T[], columns: ReadonlyArray<DataColumn<T>>, query: string, sort: Sort): T[] {
  const q = fold(query.trim())
  let out = q
    ? rows.filter((r) => columns.some((c) => c.searchValue && fold(c.searchValue(r)).includes(q)))
    : [...rows]
  const col = sort ? columns.find((c) => c.id === sort.id && c.sortValue) : undefined
  if (col?.sortValue && sort) {
    const get = col.sortValue
    const collator = new Intl.Collator("es", { numeric: true, sensitivity: "base" })
    out = out.sort((a, b) => {
      const x = get(a)
      const y = get(b)
      if (x === y) return 0
      if (x === null) return 1
      if (y === null) return -1
      const d = typeof x === "number" && typeof y === "number" ? x - y : collator.compare(String(x), String(y))
      return sort.dir === "asc" ? d : -d
    })
  }
  return out
}

/**
 * Table for admin lists (§8.8): one density (36 px rows), sortable headers (`aria-sort`), client search,
 * sticky header (within `maxHeight`), row links. The primary cell should contain an AppLink to the same `rowHref`: the row
 * click is only a mouse convenience.
 */
export function DataTable<T>({ rows, columns, rowKey, rowHref, search = false, searchPlaceholder = common.searchPlaceholder,
  initialSort = null, empty, toolbar, caption, maxHeight, className }: {
  rows: readonly T[]
  columns: ReadonlyArray<DataColumn<T>>
  rowKey: (row: T) => string
  rowHref?: (row: T) => string | null
  search?: boolean
  searchPlaceholder?: string
  initialSort?: Sort
  empty?: React.ReactNode
  toolbar?: React.ReactNode
  caption?: string
  /**
   * Bounds the table height (e.g. "70dvh") so the header sticks while its rows scroll. Unbounded tables grow with the
   * page (one scroll container per page) and scroll sideways inside their frame when too wide for the column.
   */
  maxHeight?: string
  className?: string
}) {
  const router = useRouter()
  const unsaved = useUnsavedContext()
  const [query, setQuery] = React.useState("")
  const [sort, setSort] = React.useState<Sort>(initialSort)
  const visible = React.useMemo(() => tableRows(rows, columns, query, sort), [rows, columns, query, sort])
  const cycle = (id: string) => setSort((s) => (s?.id !== id ? { id, dir: "asc" } : s.dir === "asc" ? { id, dir: "desc" } : null))

  return (
    <div className={cn("flex min-w-0 flex-col gap-3", className)}>
      {search || toolbar ? (
        <div className="flex flex-wrap items-center gap-2">
          {search ? (
            <div className="relative w-full max-w-72">
              <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={searchPlaceholder} aria-label={tables.searchLabel} className="pl-8" />
            </div>
          ) : null}
          {toolbar}
        </div>
      ) : null}
      <Table containerClassName={cn("rounded-lg border bg-card", maxHeight && "overflow-y-auto")} containerStyle={maxHeight ? { maxHeight } : undefined}>
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {columns.map((c) => {
              const active = sort?.id === c.id
              const ariaSort = active ? (sort.dir === "asc" ? "ascending" : "descending") : c.sortValue ? "none" : undefined
              return (
                <TableHead key={c.id} aria-sort={ariaSort} className={cn(c.align === "right" && "text-right", "first:rounded-tl-lg last:rounded-tr-lg", c.headerClassName)}>
                  {c.sortValue ? (
                    <button
                      type="button"
                      onClick={() => cycle(c.id)}
                      className={cn("-mx-1 inline-flex items-center gap-1 rounded-sm px-1 hover:text-foreground", active && "text-foreground", c.align === "right" && "flex-row-reverse")}
                    >
                      {c.header}
                      {active ? (sort.dir === "asc" ? <ArrowUpIcon aria-hidden className="size-3.5" /> : <ArrowDownIcon aria-hidden className="size-3.5" />)
                        : <ArrowUpDownIcon aria-hidden className="size-3.5 text-faint-foreground" />}
                    </button>
                  ) : c.header}
                </TableHead>
              )
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.length ? visible.map((r) => {
            const href = rowHref?.(r) ?? null
            return (
              <TableRow
                key={rowKey(r)}
                className={cn(href && "cursor-pointer")}
                onClick={href ? (e) => {
                  if ((e.target as HTMLElement).closest("a,button,input,select,textarea,[role=checkbox],[role=switch]")) return
                  if (unsaved) unsaved.confirmLeave(() => router.push(href))
                  else router.push(href)
                } : undefined}
              >
                {columns.map((c) => (
                  <TableCell key={c.id} className={cn(c.align === "right" && "text-right tabular-nums", c.className)}>{c.cell(r)}</TableCell>
                ))}
              </TableRow>
            )
          }) : (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={columns.length} className="py-6 text-muted-foreground">
                {query ? common.noResults : (empty ?? tables.empty)}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}
