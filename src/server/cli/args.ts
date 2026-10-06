// Minimal, strict argument parser for the CLI (long options only; Spanish usage errors → exit 2).

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageError"
  }
}

export interface ArgSpec { readonly boolean: readonly string[]; readonly string: readonly string[] }
export interface ParsedArgs { positionals: string[]; flags: Record<string, string | true> }

export function parseArgs(args: readonly string[], spec: ArgSpec): ParsedArgs {
  const positionals: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--") {
      positionals.push(...args.slice(i + 1))
      break
    }
    if (!a.startsWith("-") || a === "-") {
      positionals.push(a)
      continue
    }
    if (!a.startsWith("--")) throw new UsageError(`Opción desconocida: ${a}`)
    const eq = a.indexOf("=")
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq)
    if (Object.hasOwn(flags, name)) throw new UsageError(`La opción --${name} está repetida`)
    if (spec.boolean.includes(name)) {
      if (eq !== -1) throw new UsageError(`La opción --${name} no admite valor`)
      flags[name] = true
    } else if (spec.string.includes(name)) {
      const value = eq === -1 ? args[i + 1] : a.slice(eq + 1)
      if (value === undefined || value === "" || (eq === -1 && value.startsWith("--"))) throw new UsageError(`La opción --${name} necesita un valor`)
      flags[name] = value
      if (eq === -1) i++
    } else {
      throw new UsageError(`Opción desconocida: --${name}`)
    }
  }
  return { positionals, flags }
}

export function flagString(p: ParsedArgs, name: string): string | undefined {
  const v = p.flags[name]
  return typeof v === "string" ? v : undefined
}
export function flagBool(p: ParsedArgs, name: string): boolean {
  return p.flags[name] === true
}
