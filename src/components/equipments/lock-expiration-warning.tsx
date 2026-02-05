/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { AlertTriangle, Clock } from "lucide-react"
import { cn } from "@/lib/utils"

interface LockExpirationWarningProps {
  expiresAt: Date
  warningBeforeMins: number
  onRenew: () => Promise<void>
}

export function LockExpirationWarning({ expiresAt, warningBeforeMins, onRenew }: LockExpirationWarningProps) {
  const [showWarning, setShowWarning] = useState(false)
  const [timeLeft, setTimeLeft] = useState<number>(0)
  const [isRenewing, setIsRenewing] = useState(false)

  useEffect(() => {
    const checkWarning = () => {
      const now = new Date()
      const msLeft = expiresAt.getTime() - now.getTime()
      const minsLeft = msLeft / 1000 / 60

      setTimeLeft(Math.max(0, Math.floor(msLeft / 1000)))

      // Mostrar warning cuando queden menos minutos que warningBeforeMins
      if (minsLeft <= warningBeforeMins && minsLeft > 0) {
        setShowWarning(true)
      } else {
        setShowWarning(false)
      }
    }

    checkWarning()
    const interval = setInterval(checkWarning, 1000)
    return () => clearInterval(interval)
  }, [expiresAt, warningBeforeMins])

  async function handleRenew() {
    setIsRenewing(true)
    try {
      await onRenew()
      setShowWarning(false)
    } finally {
      setIsRenewing(false)
    }
  }

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, "0")}`
  }

  if (!showWarning) return null

  return (
    <div className={cn(
      "p-3 rounded-lg border animate-pulse",
      timeLeft <= 60
        ? "bg-red-500/20 border-red-500/50"
        : "bg-yellow-500/20 border-yellow-500/50"
    )}>
      <div className="flex items-start gap-3">
        <AlertTriangle className={cn(
          "h-5 w-5 shrink-0 mt-0.5",
          timeLeft <= 60 ? "text-red-500" : "text-yellow-500"
        )} />
        <div className="flex-1 space-y-2">
          <div>
            <p className={cn(
              "font-medium text-sm",
              timeLeft <= 60 ? "text-red-600" : "text-yellow-600"
            )}>
              El bloqueo expirara pronto
            </p>
            <div className="flex items-center gap-1.5 mt-1">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">
                Tiempo restante: <span className="font-mono font-bold">{formatTime(timeLeft)}</span>
              </span>
            </div>
          </div>
          <Button
            size="sm"
            variant={timeLeft <= 60 ? "destructive" : "default"}
            onClick={handleRenew}
            disabled={isRenewing}
            className="w-full"
          >
            {isRenewing ? "Renovando..." : "Mantener bloqueo"}
          </Button>
        </div>
      </div>
    </div>
  )
}
