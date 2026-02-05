/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Wifi, WifiOff, Users, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"
import "@xterm/xterm/css/xterm.css"

interface SerialTerminalProps {
  serialId: string
  label?: string
  baudRate?: number
  className?: string
}

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error"

export function SerialTerminal({
  serialId,
  label,
  baudRate = 115200,
  className,
}: SerialTerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null)
  const terminalInstanceRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>("disconnected")
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const isMountedRef = useRef(true)

  const connectRef = useRef<() => void>(() => {})

  const scheduleReconnect = useCallback(() => {
    // No reconectar si el componente está desmontado
    if (!isMountedRef.current) return

    // Limpiar timeout anterior si existe
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
    }
    // Programar reconexión en 3 segundos
    reconnectTimeoutRef.current = setTimeout(() => {
      if (!isMountedRef.current) return
      console.log("[Terminal] Auto-reconnecting...")
      terminalInstanceRef.current?.writeln("\r\n[Reconnecting...]\r\n")
      connectRef.current()
    }, 3000)
  }, [])

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return
    }

    // Limpiar timeout de reconexión si existe
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }

    setStatus("connecting")
    setErrorMessage(null)

    // Usar variable de entorno o fallback a window.location
    const wsHost = process.env.NEXT_PUBLIC_WS_HOST || window.location.hostname
    const wsPort = process.env.NEXT_PUBLIC_WS_PORT || "3001"
    const wsProtocol = process.env.NEXT_PUBLIC_WS_PROTOCOL || (window.location.protocol === "https:" ? "wss:" : "ws:")
    const wsUrl = `${wsProtocol}//${wsHost}:${wsPort}?id=${encodeURIComponent(serialId)}&baudRate=${baudRate}`

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      console.log("[Terminal] WebSocket connected")
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)

        switch (data.type) {
          case "connected":
            setStatus("connected")
            terminalInstanceRef.current?.writeln(`\r\n[Connected to ${data.serialId}]\r\n`)
            break

          case "disconnected":
            setStatus("disconnected")
            terminalInstanceRef.current?.writeln("\r\n[Disconnected]\r\n")
            scheduleReconnect()
            break

          case "data":
            terminalInstanceRef.current?.write(data.data)
            break

          case "history":
            terminalInstanceRef.current?.write(data.data)
            break

          case "error":
            setStatus("error")
            setErrorMessage(data.error)
            terminalInstanceRef.current?.writeln(`\r\n[Error: ${data.error}]\r\n`)
            scheduleReconnect()
            break
        }
      } catch {
        // Datos raw, escribir directamente
        terminalInstanceRef.current?.write(event.data)
      }
    }

    ws.onerror = () => {
      setStatus("error")
      setErrorMessage("WebSocket connection error")
    }

    ws.onclose = () => {
      setStatus("disconnected")
      scheduleReconnect()
    }
  }, [serialId, baudRate, scheduleReconnect])

  // Mantener connectRef actualizado
  connectRef.current = connect

  const disconnect = useCallback(() => {
    // Limpiar timeout de reconexión
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    setStatus("disconnected")
  }, [])

  const reconnect = useCallback(() => {
    disconnect()
    setTimeout(connect, 100)
  }, [disconnect, connect])

  // Inicializar terminal
  useEffect(() => {
    if (!terminalRef.current) return

    isMountedRef.current = true

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      theme: {
        background: "#1a1b26",
        foreground: "#c0caf5",
        cursor: "#c0caf5",
        cursorAccent: "#1a1b26",
        selectionBackground: "#33467c",
        black: "#15161e",
        red: "#f7768e",
        green: "#9ece6a",
        yellow: "#e0af68",
        blue: "#7aa2f7",
        magenta: "#bb9af7",
        cyan: "#7dcfff",
        white: "#a9b1d6",
        brightBlack: "#414868",
        brightRed: "#f7768e",
        brightGreen: "#9ece6a",
        brightYellow: "#e0af68",
        brightBlue: "#7aa2f7",
        brightMagenta: "#bb9af7",
        brightCyan: "#7dcfff",
        brightWhite: "#c0caf5",
      },
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)

    terminal.open(terminalRef.current)

    terminalInstanceRef.current = terminal
    fitAddonRef.current = fitAddon

    // Fit después de que el elemento tenga dimensiones
    requestAnimationFrame(() => {
      try {
        fitAddon.fit()
      } catch {
        // Ignorar error si el terminal aún no tiene dimensiones
      }
    })

    // Manejar input del usuario
    terminal.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "input", data }))
      }
    })

    // Resize handler
    const handleResize = () => {
      try {
        fitAddon.fit()
      } catch {
        // Ignorar error si el terminal no tiene dimensiones
      }
    }
    window.addEventListener("resize", handleResize)

    // Conectar automáticamente
    connect()

    return () => {
      isMountedRef.current = false
      window.removeEventListener("resize", handleResize)
      terminal.dispose()
      disconnect()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Reconectar cuando cambia el serialId
  useEffect(() => {
    if (terminalInstanceRef.current) {
      terminalInstanceRef.current.clear()
      reconnect()
    }
  }, [serialId, baudRate]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Card className={cn("flex flex-col", className)}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <CardTitle className="text-lg">{label || "Terminal Serial"}</CardTitle>
            <Badge variant="outline" className="font-mono text-xs">
              {baudRate} baud
            </Badge>
          </div>
          <div className="flex items-center gap-3">
            {status === "connected" ? (
              <div className="flex items-center gap-1.5 text-green-500">
                <Wifi className="h-4 w-4" />
                <span className="text-xs font-medium">Conectado</span>
              </div>
            ) : status === "connecting" ? (
              <div className="flex items-center gap-1.5 text-yellow-500">
                <RefreshCw className="h-4 w-4 animate-spin" />
                <span className="text-xs font-medium">Conectando...</span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 text-red-500">
                <WifiOff className="h-4 w-4" />
                <span className="text-xs font-medium">Desconectado</span>
              </div>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={reconnect}
              disabled={status === "connecting"}
            >
              <RefreshCw className={cn("h-4 w-4", status === "connecting" && "animate-spin")} />
            </Button>
          </div>
        </div>
        {errorMessage && (
          <p className="text-xs text-destructive mt-2">{errorMessage}</p>
        )}
      </CardHeader>
      <CardContent className="flex-1 p-0 min-h-0">
        <div
          ref={terminalRef}
          className="h-full w-full rounded-b-lg overflow-hidden"
        />
      </CardContent>
    </Card>
  )
}
