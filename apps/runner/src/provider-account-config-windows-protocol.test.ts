import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeWindowsReply, encodeWindowsRequest, WindowsAccountConfigError } from "./provider-account-config-windows-protocol.js";
test("WACW1 rejects malformed, truncated, trailing and mismatched replies", () => {
  for (const raw of [Buffer.alloc(0), Buffer.alloc(11), Buffer.from("WACW1"), Buffer.concat([Buffer.from([0xff,0xff,0xff,0x7f]), Buffer.from("WACW1")])])
    assert.throws(() => decodeWindowsReply(raw, 1), WindowsAccountConfigError);
  const frame = encodeWindowsRequest({ operation: 1, path: "C:\\synthetic\\runner.json" });
  assert.equal(frame.readInt32LE(0), frame.length - 4);
  assert.throws(() => decodeWindowsReply(frame, 1), WindowsAccountConfigError);
  assert.throws(() => encodeWindowsRequest({ operation: 2, path: "C:\\synthetic\\runner.json", next: Buffer.from("{}") }), WindowsAccountConfigError);
  assert.throws(() => encodeWindowsRequest({ operation: 1, path: "bad\0path" }), WindowsAccountConfigError);
  assert.throws(() => encodeWindowsRequest({ operation: 1, path: "x", next: Buffer.alloc(2 * 1024 * 1024 + 1) }), WindowsAccountConfigError);
});
test("WACW1 valid failure frames retain publication classification", () => {
  function part(s: string) { const b = Buffer.from(s), n = Buffer.alloc(4); n.writeInt32LE(b.length); return Buffer.concat([n,b]); }
  function reply(code: string, state: number, kind = 0, field = "") {
    const payload = Buffer.concat([Buffer.from("WACW1"), Buffer.from([kind,state]),part(code),part(field), ...Array.from({length:10},()=>part(""))]);
    const n=Buffer.alloc(4); n.writeInt32LE(payload.length); return Buffer.concat([n,payload]);
  }
  for (const [state, expected] of [[0,"not_published"],[1,"unknown"],[2,"committed"]] as const) {
    for (const code of ["SOURCE_BUSY","SOURCE_CHANGED","STORE_UNVERIFIABLE","CAPACITY","IO"] as const) {
      for (const tag of [undefined,"ContextFor","Security","Run"] as const) {
        const raw=reply(code+(tag === undefined ? "" : ":"+tag),state);
        assert.throws(() => decodeWindowsReply(raw, 2), (e: unknown) => e instanceof WindowsAccountConfigError && e.verifiedTerminal && e.publication === expected && e.code === code && e.diagnostic === tag);
        assert.throws(() => decodeWindowsReply(Buffer.concat([raw,Buffer.alloc(1)]),2));
      }
    }
  }
  for (const code of ["IO:","IO::Security","IO:UnknownCheck","IO:Security:Run","BAD:Security","IO:C:\\private","IO:"+"x".repeat(65)]) {
    assert.throws(() => decodeWindowsReply(reply(code,2),2), (e: unknown) => e instanceof WindowsAccountConfigError && !e.verifiedTerminal && e.diagnostic === undefined);
  }
  for (const raw of [reply("IO:Security",0,2),reply("IO:Security",0,0,"unexpected")]) {
    assert.throws(() => decodeWindowsReply(raw,2), (e: unknown) => e instanceof WindowsAccountConfigError && !e.verifiedTerminal);
  }
});
