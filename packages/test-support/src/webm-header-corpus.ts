/** One compatibility corpus for the runner sniffing and control-plane validation boundaries.
 * Expectations are explicit rather than derived from the parser under test. */
export function webmHeaderCorpus(): Array<{ name: string; bytes: Buffer; accepted: boolean }> {
  const signature = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
  const size2 = (size: number) => Buffer.from([0x40 | (size >> 8), size & 0xff]);
  const docType = (value: string) => Buffer.concat([Buffer.from([0x42, 0x82, 0x80 | value.length]), Buffer.from(value)]);
  const header = (...elements: Buffer[]) => {
    const content = Buffer.concat(elements);
    if (content.length >= 127) throw new Error("Use a wider size for large corpus headers");
    return Buffer.concat([signature, Buffer.from([0x80 | content.length]), content]);
  };
  const version = Buffer.from([0x42, 0x86, 0x81, 0x01]);
  const minimal = header(docType("webm"));
  const bounded = Buffer.concat([
    signature, size2(4090), Buffer.from([0xec]), size2(4080), Buffer.alloc(4080), docType("webm"),
  ]);
  const accepted: Array<[string, Buffer]> = [
    ["minimal header", minimal],
    ["DocType after another element", header(version, docType("webm"))],
    ["DocType before another element", header(docType("webm"), version)],
    ["NUL-terminated DocType", header(docType("webm\0"))],
    ["NUL padding", header(docType("webm\0\0\0"))],
    ["arbitrary padding after NUL", header(docType("webm\0x"))],
    ["trailing video data outside header", Buffer.concat([minimal, Buffer.alloc(5000, 0xff)])],
    ["zero-sized other element", header(Buffer.from([0xec, 0x80]), docType("webm"))],
    ["four-byte other element ID", header(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80]), docType("webm"))],
    ["header ends exactly at byte 4096", bounded],
  ];
  const rejected: Array<[string, Buffer]> = [
    ["missing DocType", header(version)],
    ["empty header", Buffer.concat([signature, Buffer.from([0x80])])],
    ["short DocType", header(docType("web"))],
    ["empty DocType", header(docType(""))],
    ["non-null suffix", header(docType("webmx"))],
    ["case-sensitive DocType", header(docType("WebM"))],
    ["Matroska with trailing decoy", Buffer.concat([header(docType("matroska")), Buffer.from("webm")])],
    ["WebM text in another element", header(Buffer.from([0xec, 0x84]), Buffer.from("webm"))],
    ["missing DocType with trailing decoy", Buffer.concat([header(version), Buffer.from("webm")])],
    ["duplicate conflicting DocTypes", header(docType("webm"), docType("matroska"))],
    ["duplicate identical DocTypes", header(docType("webm"), docType("webm"))],
    ["unknown header size", Buffer.concat([signature, Buffer.from([0xff]), docType("webm")])],
    ["unknown two-byte header size", Buffer.concat([signature, Buffer.from([0x7f, 0xff]), docType("webm")])],
    ["unknown eight-byte header size", Buffer.concat([signature, Buffer.from([1, 255, 255, 255, 255, 255, 255, 255]), docType("webm")])],
    ["zero size marker", Buffer.concat([signature, Buffer.from([0]), docType("webm")])],
    ["header claims bytes beyond upload", Buffer.concat([signature, Buffer.from([0x89]), docType("webm")])],
    ["DocType extends past parent", Buffer.concat([signature, Buffer.from([0x87, 0x42, 0x82, 0x85]), Buffer.from("webm")])],
    ["invalid child ID", header(Buffer.from([0]), docType("webm"))],
    ["five-byte child ID", header(Buffer.from([8, 0, 0, 0, 0, 0x80]), docType("webm"))],
    ["truncated child ID after DocType", header(docType("webm"), Buffer.from([0x42]))],
    ["truncated child size after DocType", header(docType("webm"), Buffer.from([0xec, 0x40]))],
    ["unknown child size", header(Buffer.from([0xec, 0xff]), docType("webm"))],
    ["unknown two-byte child size", header(docType("webm"), Buffer.from([0xec, 0x7f, 0xff]))],
    ["invalid child size marker", header(docType("webm"), Buffer.from([0xec, 0]))],
    ["oversized child size", header(docType("webm"), Buffer.from([0xec]), size2(4097))],
    ["otherwise valid header ends at byte 4097", Buffer.concat([
      signature, size2(4091), Buffer.from([0xec]), size2(4081), Buffer.alloc(4081), docType("webm"),
    ])],
    ["header size exceeds 4096", Buffer.concat([signature, size2(4097), Buffer.alloc(4097)])],
  ];
  for (let width = 2; width <= 8; width++) {
    const size = Buffer.alloc(width);
    size[0] = 1 << (8 - width);
    size[width - 1] = 7;
    accepted.push([`${width}-byte header size`, Buffer.concat([signature, size, docType("webm")])]);
    size[width - 1] = 4;
    accepted.push([`${width}-byte DocType size`, header(Buffer.from([0x42, 0x82]), size, Buffer.from("webm"))]);
  }
  for (let length = 0; length < minimal.length; length++) {
    rejected.push([`minimal header truncated at byte ${length}`, minimal.subarray(0, length)]);
  }
  for (let offset = 0; offset < 4; offset++) {
    const bytes = Buffer.from(minimal);
    bytes[offset] = bytes[offset]! ^ 1;
    rejected.push([`wrong signature byte ${offset}`, bytes]);
  }
  for (let offset = 8; offset < 12; offset++) {
    const bytes = Buffer.from(minimal);
    bytes[offset] = bytes[offset]! | 0x80;
    rejected.push([`high-bit DocType byte ${offset}`, Buffer.concat([bytes, Buffer.from("webm")])]);
  }
  return [
    ...accepted.map(([name, bytes]) => ({ name, bytes, accepted: true })),
    ...rejected.map(([name, bytes]) => ({ name, bytes, accepted: false })),
  ];
}
