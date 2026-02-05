/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

import { createServer, IncomingMessage } from "http"
import next from "next"
import { WebSocketServer, WebSocket } from "ws"
import { serialManager } from "./src/lib/serial-manager"
import { startPeriodicSync, stopPeriodicSync } from "./src/lib/relay-service"

const dev = process.env.NODE_ENV !== "production"
const hostname = process.env.HOSTNAME || "localhost"
const port = parseInt(process.env.PORT || "3000", 10)
const wsPort = parseInt(process.env.WS_PORT || "3001", 10)

const app = next({ dev, hostname, port })
const handle = app.getRequestHandler()

app.prepare().then(() => {
  // HTTP server para Next.js
  const server = createServer((req, res) => {
    handle(req, res)
  })

  // WebSocket server en puerto separado
  const wss = new WebSocketServer({ port: wsPort })

  wss.on("listening", () => {
    console.log(`> WebSocket server on ws://${hostname}:${wsPort}`)
  })

  // Manejar conexiones WebSocket
  wss.on("connection", async (ws: WebSocket, request: IncomingMessage) => {
    const url = new URL(request.url!, `http://${request.headers.host}`)
    const serialId = url.searchParams.get("id")
    const baudRate = parseInt(url.searchParams.get("baudRate") || "115200", 10)

    if (!serialId) {
      ws.send(JSON.stringify({ type: "error", error: "Missing serialId parameter" }))
      ws.close()
      return
    }

    console.log(`[WebSocket] New connection for serial: ${serialId}`)

    try {
      // Obtener o crear conexión serial
      const connection = await serialManager.getOrCreateConnection(serialId, baudRate)

      // Añadir cliente
      serialManager.addClient(serialId, ws, connection)

      // Manejar mensajes del cliente (input del terminal)
      ws.on("message", (message: Buffer) => {
        try {
          const data = JSON.parse(message.toString())

          if (data.type === "input") {
            // Escribir al puerto serial
            serialManager.write(serialId, data.data)
          }
        } catch {
          // Si no es JSON, asumir que es texto directo
          serialManager.write(serialId, message.toString())
        }
      })

      // Manejar cierre de conexión
      ws.on("close", () => {
        console.log(`[WebSocket] Connection closed for serial: ${serialId}`)
        serialManager.removeClient(serialId, ws)
      })

      ws.on("error", (err) => {
        console.error(`[WebSocket] Error for serial ${serialId}:`, err.message)
        serialManager.removeClient(serialId, ws)
      })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error"
      console.error(`[WebSocket] Failed to connect to serial ${serialId}:`, errorMessage)
      ws.send(JSON.stringify({ type: "error", error: `Failed to open serial port: ${errorMessage}` }))
      ws.close()
    }
  })

  // Manejar shutdown graceful
  const shutdown = () => {
    console.log("\n[Server] Shutting down...")
    stopPeriodicSync()
    serialManager.closeAll()
    wss.close()
    server.close(() => {
      console.log("[Server] Closed")
      process.exit(0)
    })
  }

  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)

  server.listen(port, () => {
    console.log(`> Ready on http://${hostname}:${port}`)

    // Iniciar sincronización periódica de placas de relés
    startPeriodicSync()
  })
})
