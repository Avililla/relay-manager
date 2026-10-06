/**
 * Relay Manager: single-process entry point.
 *   prod: node app/server.js <cmd>   (esbuild bundle of this file)
 *   dev:  RM_DEV=1 tsx server.ts <cmd>
 * See src/server/boot/main.ts for the command dispatch.
 */
import { main } from "./src/server/boot/main"

void main(process.argv.slice(2))
