/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

// Event emitter para cambios de estado de relés y bloqueos
// Los clientes SSE se suscriben aquí para recibir updates

type RelayStateListener = (boardId: string, state: string) => void

interface LockInfo {
  lockedById: string | null
  lockedBy: { id: string; email: string; name: string } | null
  lockExpiresAt: Date | null
}

type LockStateListener = (equipmentId: string, lockInfo: LockInfo) => void

class RelayEventEmitter {
  private relayListeners: Set<RelayStateListener> = new Set()
  private lockListeners: Set<LockStateListener> = new Set()

  // Relay state subscriptions
  subscribeRelay(listener: RelayStateListener): () => void {
    this.relayListeners.add(listener)
    console.log(`[SSE] Relay listener added. Total: ${this.relayListeners.size}`)
    return () => {
      this.relayListeners.delete(listener)
      console.log(`[SSE] Relay listener removed. Total: ${this.relayListeners.size}`)
    }
  }

  emitRelay(boardId: string, state: string): void {
    console.log(`[SSE] Emitting relay event for board ${boardId}. Listeners: ${this.relayListeners.size}`)
    this.relayListeners.forEach((listener) => {
      try {
        listener(boardId, state)
      } catch (error) {
        console.error("[SSE] Error in relay listener:", error)
      }
    })
  }

  // Lock state subscriptions
  subscribeLock(listener: LockStateListener): () => void {
    this.lockListeners.add(listener)
    console.log(`[SSE] Lock listener added. Total: ${this.lockListeners.size}`)
    return () => {
      this.lockListeners.delete(listener)
      console.log(`[SSE] Lock listener removed. Total: ${this.lockListeners.size}`)
    }
  }

  emitLock(equipmentId: string, lockInfo: LockInfo): void {
    console.log(`[SSE] Emitting lock event for equipment ${equipmentId}. Listeners: ${this.lockListeners.size}`)
    this.lockListeners.forEach((listener) => {
      try {
        listener(equipmentId, lockInfo)
      } catch (error) {
        console.error("[SSE] Error in lock listener:", error)
      }
    })
  }

  getListenerCount(): number {
    return this.relayListeners.size + this.lockListeners.size
  }
}

// Usar globalThis para persistir el singleton entre hot reloads en desarrollo
const globalForEvents = globalThis as unknown as {
  relayEvents: RelayEventEmitter | undefined
}

export const relayEvents = globalForEvents.relayEvents ?? new RelayEventEmitter()

if (process.env.NODE_ENV !== "production") {
  globalForEvents.relayEvents = relayEvents
}
