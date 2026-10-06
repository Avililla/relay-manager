"use client"

import * as React from "react"

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files")

/**
 * Files dragged from the PC over the whole page: `dragging` while they hover (the page shows a drop overlay).
 * Dropped folders cannot be uploaded (a File for a folder has no contents): they are counted apart.
 */
export function useFileDrop(onDrop: (files: File[], folders: number) => void, enabled: boolean): boolean {
  const [dragging, setDragging] = React.useState(false)
  const depth = React.useRef(0)
  const handler = React.useEffectEvent(onDrop)
  React.useEffect(() => {
    if (!enabled) return
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current++
      setDragging(true)
    }
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"
    }
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setDragging(false)
    }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setDragging(false)
      const dt = e.dataTransfer
      if (!dt) return
      const files: File[] = []
      let folders = 0
      const items = Array.from(dt.items ?? [])
      if (items.length) {
        for (const it of items) {
          if (it.kind !== "file") continue
          const entry = typeof it.webkitGetAsEntry === "function" ? it.webkitGetAsEntry() : null
          if (entry?.isDirectory) {
            folders++
            continue
          }
          const f = it.getAsFile()
          if (f) files.push(f)
        }
      } else {
        files.push(...Array.from(dt.files))
      }
      handler(files, folders)
    }
    const cancel = () => {
      depth.current = 0
      setDragging(false)
    }
    window.addEventListener("dragenter", enter)
    window.addEventListener("dragover", over)
    window.addEventListener("dragleave", leave)
    window.addEventListener("drop", drop)
    window.addEventListener("dragend", cancel)
    return () => {
      window.removeEventListener("dragenter", enter)
      window.removeEventListener("dragover", over)
      window.removeEventListener("dragleave", leave)
      window.removeEventListener("drop", drop)
      window.removeEventListener("dragend", cancel)
    }
  }, [enabled])
  return dragging
}
