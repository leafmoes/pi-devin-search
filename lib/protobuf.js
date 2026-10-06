"use strict";

// Ported from dsh-devin-search src/protobuf.ts (MIT). Strict variant: partial
// fields, unsupported wire types and unsafe integers fail closed.
const { fail } = require("./core");

class Writer {
  constructor() {
    this.chunks = [];
  }
  int(field, value) {
    this.chunks.push(varint(field * 8), varint(value));
    return this;
  }
  bytes(field, value) {
    this.chunks.push(varint(field * 8 + 2), varint(value.length), value);
    return this;
  }
  string(field, value) {
    return this.bytes(field, Buffer.from(value));
  }
  build() {
    return Buffer.concat(this.chunks);
  }
}

function varint(value) {
  if (!Number.isSafeInteger(value) || value < 0) return fail("protocol", "Invalid protobuf integer.");
  const bytes = [];
  do {
    const next = value % 128;
    value = Math.floor(value / 128);
    bytes.push(next | (value ? 128 : 0));
  } while (value);
  return Buffer.from(bytes);
}

function decode(buffer) {
  let offset = 0;
  const fields = [];
  const read = () => {
    let n = 0;
    for (let i = 0; i < 10; i++) {
      const b = buffer[offset++];
      if (b === undefined) return fail("protocol", "Partial protobuf field.");
      n += (b & 127) * 2 ** (i * 7);
      if (!Number.isSafeInteger(n)) return fail("protocol", "Unsafe protobuf integer.");
      if (!(b & 128)) return n;
    }
    return fail("protocol", "Malformed protobuf varint.");
  };
  while (offset < buffer.length) {
    const tag = read();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (!field) return fail("protocol", "Invalid protobuf tag.");
    if (wire === 0) fields.push({ field, value: read() });
    else if (wire === 2) {
      const length = read();
      const end = offset + length;
      if (end > buffer.length) return fail("protocol", "Partial protobuf payload.");
      fields.push({ field, value: buffer.subarray(offset, end) });
      offset = end;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > buffer.length) return fail("protocol", "Partial protobuf fixed field.");
    } else return fail("protocol", "Unsupported protobuf wire type.");
    if (fields.length > 16384) return fail("bounds", "Too many protobuf fields.");
  }
  return fields;
}

function stringField(fields, field) {
  const value = fields.find((f) => f.field === field)?.value;
  return Buffer.isBuffer(value) ? value.toString("utf8") : undefined;
}

module.exports = { Writer, decode, stringField };
