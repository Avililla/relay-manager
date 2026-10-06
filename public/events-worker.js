/* Relay Manager events worker (§8.11, D32). A SharedWorker that keeps ONE EventSource("/api/events") per browser
 * and relays it to every tab, so N tabs never hit the 6-connection HTTP/1.1 limit. Plain JS, not bundled.
 * Tab → worker: {cmd:"hello"} (re-joins after "bye") | {cmd:"reconnect"} | {cmd:"bye"}.
 * Worker → tab: {kind:"status", status:"connecting"|"open"|"reconnecting"|"closed"} | {kind:"event", data:"<json>"}
 *   | {kind:"event", data:"<cached hello>", replay:true} (to a joining tab: never a server-clock sample, §2.7).
 */
"use strict"

var ports = new Set()
var es = null
var status = "closed"
var lastHello = null
var retryTimer = null
var retryAttempt = 0
var RETRY_MS = [3000, 5000, 10000, 30000]

function post(port, msg) {
  try { port.postMessage(msg) } catch { ports.delete(port) }
}

function broadcast(msg) {
  ports.forEach(function (p) { post(p, msg) })
}

function setStatus(s) {
  if (s === status) return
  status = s
  broadcast({ kind: "status", status: s })
}

function clearRetry() {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
}

function close() {
  clearRetry()
  if (es) { es.onopen = es.onmessage = es.onerror = null; es.close(); es = null }
}

function open() {
  close()
  if (!ports.size) { setStatus("closed"); return }
  setStatus(lastHello ? "reconnecting" : "connecting")
  es = new EventSource("/api/events")
  es.onopen = function () { retryAttempt = 0; setStatus("open") }
  es.onmessage = function (ev) {
    var data = String(ev.data)
    if (data.indexOf("\"type\":\"hello\"") !== -1) lastHello = data
    broadcast({ kind: "event", data: data })
  }
  es.onerror = function () {
    if (!es) return
    if (es.readyState === 2) {
      // CLOSED: the server answered with an error (401, 429, 5xx). Tabs check the session; retry with backoff.
      setStatus("closed")
      es.onopen = es.onmessage = es.onerror = null
      es = null
      var delay = RETRY_MS[Math.min(retryAttempt, RETRY_MS.length - 1)]
      retryAttempt++
      clearRetry()
      retryTimer = setTimeout(open, delay)
    } else {
      setStatus("reconnecting") // CONNECTING: the browser retries on its own (server "retry: 3000").
    }
  }
}

// A port joins on connect, and again on {cmd:"hello"} after a "bye" (a tab restored from the back/forward cache).
// When the stream is idle it is opened first, so the new tab never sees a spurious "closed".
// The cached hello is marked `replay`: its serverNow is as old as the stream, so the tab must not sample it.
function attach(port) {
  ports.add(port)
  if (!es && !retryTimer) open()
  post(port, { kind: "status", status: status })
  if (lastHello) post(port, { kind: "event", data: lastHello, replay: true })
}

self.onconnect = function (e) {
  var port = e.ports[0]
  port.onmessage = function (m) {
    var cmd = m.data && m.data.cmd
    if (cmd === "hello") {
      if (!ports.has(port)) attach(port)
    } else if (cmd === "bye") {
      ports.delete(port)
      if (!ports.size) { close(); lastHello = null; status = "closed" }
    } else if (cmd === "reconnect") {
      retryAttempt = 0
      open()
    }
  }
  port.start()
  attach(port)
}
