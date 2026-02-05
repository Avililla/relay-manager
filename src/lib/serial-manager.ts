/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

import { SerialPort } from "serialport"
import { WebSocket } from "ws"

interface SerialConnection {
  port: SerialPort
  clients: Set<WebSocket>
  buffer: string // Buffer para mantener historial reciente
}

const MAX_BUFFER_SIZE = 50000 // ~50KB de historial

class SerialManager {
  private connections: Map<string, SerialConnection> = new Map()

  // Obtener o crear conexión serial
  async getOrCreateConnection(serialId: string, baudRate: number = 115200): Promise<SerialConnection> {
    const existing = this.connections.get(serialId)
    if (existing && existing.port.isOpen) {
      return existing
    }

    // Limpiar conexión anterior si existe
    if (existing) {
      this.closeConnection(serialId)
    }

    // Crear nueva conexión
    const port = new SerialPort({
      path: serialId,
      baudRate,
      autoOpen: false,
    })

    const connection: SerialConnection = {
      port,
      clients: new Set(),
      buffer: "",
    }

    // Manejar datos entrantes
    port.on("data", (data: Buffer) => {
      const text = data.toString()

      // Añadir al buffer
      connection.buffer += text
      if (connection.buffer.length > MAX_BUFFER_SIZE) {
        connection.buffer = connection.buffer.slice(-MAX_BUFFER_SIZE)
      }

      // Broadcast a todos los clientes
      const message = JSON.stringify({ type: "data", data: text })
      connection.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message)
        }
      })
    })

    port.on("error", (err) => {
      console.error(`[Serial] Error on ${serialId}:`, err.message)
      const message = JSON.stringify({ type: "error", error: err.message })
      connection.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message)
        }
      })
    })

    port.on("close", () => {
      console.log(`[Serial] Port ${serialId} closed`)
      const message = JSON.stringify({ type: "disconnected" })
      connection.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message)
        }
      })
      this.connections.delete(serialId)
    })

    // Abrir puerto
    await new Promise<void>((resolve, reject) => {
      port.open((err) => {
        if (err) {
          reject(err)
        } else {
          console.log(`[Serial] Port ${serialId} opened at ${baudRate} baud`)
          resolve()
        }
      })
    })

    this.connections.set(serialId, connection)
    return connection
  }

  // Añadir cliente WebSocket a una conexión
  addClient(serialId: string, client: WebSocket, connection: SerialConnection): void {
    connection.clients.add(client)
    console.log(`[Serial] Client added to ${serialId}. Total clients: ${connection.clients.size}`)

    // Enviar historial al nuevo cliente
    if (connection.buffer.length > 0) {
      client.send(JSON.stringify({ type: "history", data: connection.buffer }))
    }

    // Enviar estado de conexión
    client.send(JSON.stringify({ type: "connected", serialId }))
  }

  // Remover cliente WebSocket
  removeClient(serialId: string, client: WebSocket): void {
    const connection = this.connections.get(serialId)
    if (connection) {
      connection.clients.delete(client)
      console.log(`[Serial] Client removed from ${serialId}. Total clients: ${connection.clients.size}`)

      // Si no hay más clientes, cerrar el puerto después de un delay
      if (connection.clients.size === 0) {
        setTimeout(() => {
          const conn = this.connections.get(serialId)
          if (conn && conn.clients.size === 0) {
            this.closeConnection(serialId)
          }
        }, 5000) // Esperar 5 segundos antes de cerrar
      }
    }
  }

  // Escribir datos al puerto serial
  write(serialId: string, data: string): boolean {
    const connection = this.connections.get(serialId)
    if (connection && connection.port.isOpen) {
      connection.port.write(data)
      return true
    }
    return false
  }

  // Cerrar conexión
  closeConnection(serialId: string): void {
    const connection = this.connections.get(serialId)
    if (connection) {
      if (connection.port.isOpen) {
        connection.port.close()
      }
      connection.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: "disconnected" }))
        }
      })
      this.connections.delete(serialId)
      console.log(`[Serial] Connection ${serialId} closed`)
    }
  }

  // Obtener lista de puertos disponibles
  async listPorts(): Promise<Array<{ path: string; manufacturer?: string; serialNumber?: string }>> {
    const { SerialPort } = await import("serialport")
    const ports = await SerialPort.list()
    return ports.map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer,
      serialNumber: p.serialNumber,
    }))
  }

  // Verificar si un puerto está conectado
  isConnected(serialId: string): boolean {
    const connection = this.connections.get(serialId)
    return connection?.port.isOpen ?? false
  }

  // Obtener número de clientes conectados a un puerto
  getClientCount(serialId: string): number {
    return this.connections.get(serialId)?.clients.size ?? 0
  }

  // Cerrar todas las conexiones (para shutdown)
  closeAll(): void {
    this.connections.forEach((_, serialId) => {
      this.closeConnection(serialId)
    })
  }
}

// Singleton con globalThis para hot reload
const globalForSerial = globalThis as unknown as {
  serialManager: SerialManager | undefined
}

export const serialManager = globalForSerial.serialManager ?? new SerialManager()

if (process.env.NODE_ENV !== "production") {
  globalForSerial.serialManager = serialManager
}
