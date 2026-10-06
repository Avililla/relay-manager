import { describe, expect, it } from "vitest"
import { establishedTo } from "./proc-net"

const TCP4 = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0C81 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0000000000000000 100 0 0 10 0
   1: 6101640A:0C81 1401640A:C822 01 00000000:00000000 00:00000000 00000000  1000        0 2 1 0000000000000000 20 4 30 10 -1
   2: 0100007F:0C81 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 3 1 0000000000000000 20 4 30 10 -1
   3: 6101640A:0C82 1401640A:C823 01 00000000:00000000 00:00000000 00000000  1000        0 4 1 0000000000000000 20 4 30 10 -1
   4: 6101640A:0C81 1501640A:C824 06 00000000:00000000 00:00000000 00000000  1000        0 5 1 0000000000000000 20 4 30 10 -1
`
const TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0000000000000000FFFF00006101640A:0C81 0000000000000000FFFF00001601640A:C830 01 00000000:00000000 00:00000000 00000000  1000        0 6 1 0000000000000000 20 4 30 10 -1
`

describe("establishedTo", () => {
  it("lists ESTABLISHED remote peers of a local port (IPv4 and IPv4-mapped IPv6)", () => {
    expect(establishedTo(3201, TCP4, TCP6)).toEqual(["10.100.1.20:51234", "127.0.0.1:54321", "10.100.1.22:51248"])
    expect(establishedTo(3202, TCP4, "")).toEqual(["10.100.1.20:51235"])
    expect(establishedTo(3203, TCP4, TCP6)).toEqual([])
    expect(establishedTo(3201, "basura", "")).toEqual([])
  })
})
