// Runs in the browser before any application code (Next's instrumentation-client hook).
// The production CSP has no 'unsafe-eval' (§2.8), so zod must never probe `Function("")` for its JIT fast path:
// the probe is caught, but Firefox still reports every blocked eval as a CSP error. Jitless parsing is the same
// validation, only without generated code.
import { z } from "zod"

z.config({ jitless: true })
