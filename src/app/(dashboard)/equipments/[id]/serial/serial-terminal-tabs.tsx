/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

"use client"

import { Fragment } from "react"
import dynamic from "next/dynamic"
import { PanelGroup, Panel, PanelResizeHandle } from "react-resizable-panels"
import { GripVertical } from "lucide-react"

const SerialTerminal = dynamic(
  () => import("@/components/terminal/serial-terminal").then((mod) => mod.SerialTerminal),
  { ssr: false }
)

interface SerialPort {
  id: string
  boardIndex: number
  serialId: string | null
  label: string | null
  baudRate: number
}

interface SerialTerminalTabsProps {
  serialPorts: SerialPort[]
}

export function SerialTerminalTabs({ serialPorts }: SerialTerminalTabsProps) {
  const configuredPorts = serialPorts.filter((port) => port.serialId)

  if (configuredPorts.length === 0) {
    return null
  }

  return (
    <PanelGroup direction="horizontal" className="h-full">
      {configuredPorts.map((port, index) => (
        <Fragment key={port.id}>
          <Panel defaultSize={100 / configuredPorts.length} minSize={15}>
            <SerialTerminal
              serialId={port.serialId!}
              label={port.label || `Placa ${port.boardIndex + 1}`}
              baudRate={port.baudRate}
              className="h-full"
            />
          </Panel>
          {index < configuredPorts.length - 1 && (
            <PanelResizeHandle className="w-2 bg-border hover:bg-primary/20 transition-colors flex items-center justify-center group">
              <GripVertical className="h-4 w-4 text-muted-foreground group-hover:text-primary" />
            </PanelResizeHandle>
          )}
        </Fragment>
      ))}
    </PanelGroup>
  )
}
