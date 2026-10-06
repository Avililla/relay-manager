// Global Vitest setup (W0). Keep it side-effect free apart from quiet defaults.
process.env.RM_LOG_LEVEL ??= "error"
process.env.NEXT_TELEMETRY_DISABLED = "1"
