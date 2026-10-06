"use client"

import * as React from "react"
import { CheckIcon, ChevronsUpDownIcon, XIcon } from "lucide-react"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tag } from "@/components/ui/tag"
import { common } from "@/lib/i18n/shell"
import { cn } from "@/lib/client/cn"

export interface ComboOption { value: string; label: string; description?: string; keywords?: string[]; disabled?: boolean }

const triggerClass = [
  "flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md border border-input bg-muted px-2.5 text-left text-body",
  "hover:border-control-border aria-invalid:border-danger disabled:cursor-not-allowed disabled:opacity-50",
].join(" ")

function OptionList({ options, isSelected, onSelect, searchPlaceholder, emptyText }: {
  options: ComboOption[]
  isSelected: (v: string) => boolean
  onSelect: (v: string) => void
  searchPlaceholder: string
  emptyText: string
}) {
  return (
    <Command
      filter={(value, search, keywords) => {
        const hay = `${value} ${(keywords ?? []).join(" ")}`.toLocaleLowerCase("es").normalize("NFD").replace(/\p{M}/gu, "")
        const needle = search.toLocaleLowerCase("es").normalize("NFD").replace(/\p{M}/gu, "")
        return hay.includes(needle) ? 1 : 0
      }}
    >
      <CommandInput placeholder={searchPlaceholder} />
      <CommandList>
        <CommandEmpty>{emptyText}</CommandEmpty>
        <CommandGroup>
          {options.map((o) => (
            <CommandItem
              key={o.value}
              value={o.value}
              keywords={[o.label, ...(o.description ? [o.description] : []), ...(o.keywords ?? [])]}
              disabled={o.disabled}
              onSelect={() => onSelect(o.value)}
              className="h-auto min-h-8 py-1"
            >
              <CheckIcon aria-hidden className={cn("size-4 text-brand", !isSelected(o.value) && "invisible")} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{o.label}</span>
                {o.description ? <span className="truncate text-meta text-muted-foreground">{o.description}</span> : null}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  )
}

/**
 * Single searchable choice on Popover + cmdk (§8.8): roles, equipment, users (Auditoría filters). Accent-insensitive
 * search. `clearable` adds a "Borrar" button. Pass the FormField props (`id`, `aria-*`) through.
 */
export function Combobox({ options, value, onChange, placeholder = common.selectPlaceholder, searchPlaceholder = common.searchPlaceholder,
  emptyText = common.noResults, clearable = false, disabled, className, ...aria }: {
  options: ComboOption[]
  value: string | null
  onChange: (v: string | null) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  clearable?: boolean
  disabled?: boolean
  className?: string
  id?: string
  "aria-invalid"?: true
  "aria-describedby"?: string
  "aria-label"?: string
}) {
  const [open, setOpen] = React.useState(false)
  const listId = React.useId()
  const selected = options.find((o) => o.value === value) ?? null
  return (
    <div className={cn("relative flex min-w-0", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" role="combobox" aria-expanded={open} aria-controls={listId} aria-haspopup="listbox" disabled={disabled} className={cn(triggerClass, clearable && selected && "pr-14")} {...aria}>
            <span className={cn("min-w-0 flex-1 truncate", !selected && "text-faint-foreground")}>{selected ? selected.label : placeholder}</span>
            <ChevronsUpDownIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent id={listId} align="start" className="w-(--radix-popover-trigger-width) min-w-64 p-0">
          <OptionList
            options={options}
            isSelected={(v) => v === value}
            onSelect={(v) => {
              onChange(v === value ? null : v)
              setOpen(false)
            }}
            searchPlaceholder={searchPlaceholder}
            emptyText={emptyText}
          />
        </PopoverContent>
      </Popover>
      {clearable && selected && !disabled ? (
        <button
          type="button"
          onClick={() => onChange(null)}
          aria-label={`${common.clear}: ${selected.label}`}
          className="absolute top-1/2 right-7 grid size-5 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <XIcon aria-hidden className="size-3.5" />
        </button>
      ) : null}
    </div>
  )
}

/**
 * Multiple searchable choices shown as chips (§8.8): roles, members and equipment. Each chip has its own remove
 * button; the trigger opens the list, where items toggle and the popover stays open.
 */
export function MultiSelect({ options, value, onChange, placeholder = common.selectPlaceholder, searchPlaceholder = common.searchPlaceholder,
  emptyText = common.noResults, disabled, className, ...aria }: {
  options: ComboOption[]
  value: string[]
  onChange: (v: string[]) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  disabled?: boolean
  className?: string
  id?: string
  "aria-invalid"?: true
  "aria-describedby"?: string
  "aria-label"?: string
}) {
  const [open, setOpen] = React.useState(false)
  const listId = React.useId()
  const byValue = new Map(options.map((o) => [o.value, o]))
  const chosen = value.map((v) => byValue.get(v) ?? { value: v, label: v })
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v])
  return (
    <div
      data-invalid={aria["aria-invalid"] || undefined}
      className={cn("flex min-h-8 w-full min-w-0 flex-wrap items-center gap-1 rounded-md border border-input bg-muted p-1 data-[invalid]:border-danger", disabled && "opacity-50", className)}
    >
      {chosen.map((o) => (
        <Tag key={o.value} tone="neutral" className="h-6 gap-0.5 pr-0.5 pl-2 text-meta text-foreground">
          <span className="truncate">{o.label}</span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => toggle(o.value)}
            aria-label={`${common.remove} ${o.label}`}
            className="grid size-5 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <XIcon aria-hidden className="size-3" />
          </button>
        </Tag>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-haspopup="listbox"
            disabled={disabled}
            className="flex h-6 min-w-24 flex-1 items-center justify-between gap-2 rounded-sm px-1.5 text-left text-body text-faint-foreground hover:text-muted-foreground"
            {...aria}
          >
            <span className="truncate">{value.length ? common.selected(value.length) : placeholder}</span>
            <ChevronsUpDownIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent id={listId} align="start" className="w-72 p-0">
          <OptionList options={options} isSelected={(v) => value.includes(v)} onSelect={toggle} searchPlaceholder={searchPlaceholder} emptyText={emptyText} />
        </PopoverContent>
      </Popover>
    </div>
  )
}
