'use strict';

import * as CC from './chain_constants.js';
import { BufferWriter } from './serializer.js';
import { Buffer } from './lazy_buffer.js';
import { OBJECT_TYPE } from './chain_constants.js';

interface BufWriter {
    buf: Buffer;
    length: number;
    toBuffer(): Buffer;
    write(array: Buffer | Uint8Array | number[]): this;
    writeUint8(v: number): this;
    writeUint16(v: number): this;
    writeUint32(v: number): this;
    writeInt16(v: number): this;
    writeInt32(v: number): this;
    writeInt64(v: number | bigint | string): this;
    writeUint64(v: number | bigint | string): this;
    writeVarint32(v: number): this;
    writeVarint64(v: number | bigint | string): this;
    flip(): this;
    append(src: BufWriter | Buffer | Uint8Array): this;
}

interface BufReader {
    buffer: Buffer;
    offset: number;
    length: number;
    isEnd(): boolean;
    read(length: number): Buffer;
    skip(length: number): void;
    readUint8(): number;
    readUint16(): number;
    readUint32(): number;
    readInt32(): number;
    readInt64(): number | string;
    readUint64(): number | string;
    readVarint32(): number;
    readVarint64(): bigint;
    copy(offset: number, end?: number): Buffer;
    toString(encoding?: BufferEncoding): string;
}

const { RESERVED_SPACES } = CC;

interface SerDebug {
    use_default?: boolean;
    annotate?: boolean;
    [key: string]: unknown;
}

interface FieldDef {
    name: string;
    type: SerType;
}

export interface SerType {
    fromByteBuffer(b: BufReader): unknown;
    appendByteBuffer(b: BufWriter, v: unknown): void;
    fromObject(v: unknown): unknown;
    toObject(v: unknown, debug?: SerDebug): unknown;
    compare?: (a: unknown, b: unknown) => number;
    nosort?: boolean;
    st_operations?: SerType[];
    validate?: (arr: unknown[]) => unknown[];
}

const isDigits = (v: unknown): boolean => /^-?\d+$/.test(String(v));
const toNumber = (v: unknown): number => {
    if (typeof v === 'number') return v;
    return isDigits(v) ? Number(v) : NaN;
};
const int64ToSafeValue = (n: bigint): number | string => (
    n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(n)
        : n.toString()
);
const $required = (obj: unknown, name?: string): void => { if (obj == null) throw new Error(`${name || 'value'} required`); };
const requireRange = (min: number, max: number, v: number | string, name?: string): void => {
    const num = Number(v);
    if (num < min || num > max) throw new Error(`${name || 'value'} out of range [${min}, ${max}]: ${v}`);
};

const strCmp = (a: unknown, b: unknown): number => (a as never) > (b as never) ? 1 : (a as never) < (b as never) ? -1 : 0;
const firstEl = (el: unknown): unknown => Array.isArray(el) ? el[0] : el;

function sortOperation(array: unknown[], st_operation?: SerType): unknown[] {
    if (!st_operation) return array;
    if (st_operation.compare) {
        const cmp = st_operation.compare;
        return array.sort((a, b) => cmp(firstEl(a), firstEl(b)));
    }
    if (st_operation.nosort) return array;
    return array.sort((a, b) => {
        const fa = firstEl(a);
        const fb = firstEl(b);
        if (typeof fa === 'number' && typeof fb === 'number') return fa - fb;
        if (Buffer.isBuffer(fa) && Buffer.isBuffer(fb)) return strCmp(fa.toString('hex'), fb.toString('hex'));
        return strCmp(String(fa), String(fb));
    });
}

/**
 * Build a SerType for a bounded integer. `read`/`write` are the codec hooks;
 * `min`/`max` drive requireRange in every direction. Shared by the
 * uint8/uint16/uint32/varint32 definitions, which differ only by codec+range.
 */
function makeIntType(
    name: string,
    min: number,
    max: number,
    read: (b: BufReader) => number,
    write: (b: BufWriter, v: number) => void,
): SerType {
    return {
        fromByteBuffer(b: BufReader): number { return read(b); },
        appendByteBuffer(b: BufWriter, v: number): void { requireRange(min, max, v, name); write(b, v); },
        fromObject(v: number): number { requireRange(min, max, v, name); return v; },
        toObject(v: number, debug?: SerDebug): number {
            if (debug && debug.use_default && v === undefined) return 0;
            requireRange(min, max, v, name);
            return parseInt(String(v), 10);
        },
    };
}

const void_type: SerType = {
    fromByteBuffer(): undefined { return undefined; },
    appendByteBuffer(): void { /* void serializes to zero bytes */ },
    fromObject(): undefined { return undefined; },
    toObject(object: unknown, debug?: SerDebug): undefined {
        if (debug && debug.use_default && object === undefined) return undefined;
        return undefined;
    },
};

const uint8 = makeIntType('uint8', 0, 0xFF, (b) => b.readUint8(), (b, v) => b.writeUint8(v));
const uint16 = makeIntType('uint16', 0, 0xFFFF, (b) => b.readUint16(), (b, v) => b.writeUint16(v));
const uint32 = makeIntType('uint32', 0, 0xFFFFFFFF, (b) => b.readUint32(), (b, v) => b.writeUint32(v));
const varint32 = makeIntType('varint32', -2147483648, 2147483647, (b) => b.readVarint32(), (b, v) => b.writeVarint32(v));

const int64: SerType = {
    fromByteBuffer(b: BufReader): number | string { return b.readInt64(); },
    appendByteBuffer(b: BufWriter, v: number | bigint | string): void {
        $required(v, 'int64');
        const n = BigInt(String(v));
        if (n < -0x8000000000000000n || n > 0x7FFFFFFFFFFFFFFFn) {
            throw new Error(`int64 out of range [-9223372036854775808, 9223372036854775807]: ${v}`);
        }
        b.writeInt64(n);
    },
    fromObject(v: number | bigint | string): number | string {
        $required(v, 'int64');
        const n = BigInt(String(v));
        if (n < -0x8000000000000000n || n > 0x7FFFFFFFFFFFFFFFn) {
            throw new Error(`int64 out of range [-9223372036854775808, 9223372036854775807]: ${v}`);
        }
        return int64ToSafeValue(n);
    },
    toObject(v: number | bigint | string, debug?: SerDebug): string {
        if (debug && debug.use_default && v === undefined) return '0';
        $required(v, 'int64');
        return String(v);
    },
};

const uint64: SerType = {
    fromByteBuffer(b: BufReader): number | string { return b.readUint64(); },
    appendByteBuffer(b: BufWriter, v: number | bigint | string): void {
        $required(v, 'uint64');
        const n = BigInt(String(v));
        if (n < 0n || n > 0xFFFFFFFFFFFFFFFFn) {
            throw new Error(`uint64 out of range [0, 18446744073709551615]: ${v}`);
        }
        const buf = Buffer.allocUnsafe(8);
        buf.writeBigUInt64LE(n, 0);
        b.write(buf);
    },
    fromObject(v: number | bigint | string): number | string {
        $required(v, 'uint64');
        const n = BigInt(String(v));
        if (n < 0n || n > 0xFFFFFFFFFFFFFFFFn) {
            throw new Error(`uint64 out of range [0, 18446744073709551615]: ${v}`);
        }
        return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n.toString();
    },
    toObject(v: number | bigint | string, debug?: SerDebug): string {
        if (debug && debug.use_default && v === undefined) return '0';
        $required(v, 'uint64');
        const n = BigInt(String(v));
        if (n < 0n || n > 0xFFFFFFFFFFFFFFFFn) {
            throw new Error(`uint64 out of range [0, 18446744073709551615]: ${v}`);
        }
        return String(n);
    },
};

const string_type: SerType = {
    fromByteBuffer(b: BufReader): string {
        const len = b.readVarint32();
        const data = b.read(len);
        return Buffer.from(data).toString('utf8');
    },
    appendByteBuffer(b: BufWriter, v: unknown): void {
        $required(v, 'string');
        const buf = Buffer.from(String(v), 'utf8');
        b.writeVarint32(buf.length);
        b.write(buf);
    },
    fromObject(v: unknown): Buffer { $required(v, 'string'); return Buffer.from(String(v), 'utf8'); },
    toObject(v: unknown, debug?: SerDebug): string {
        if (debug && debug.use_default && v === undefined) return '';
        return String(v);
    },
};

function bytesType(size?: number): SerType {
    return {
        fromByteBuffer(b: BufReader): Buffer {
            if (size === undefined) {
                const len = b.readVarint32();
                return b.read(len);
            }
            return b.read(size);
        },
        appendByteBuffer(b: BufWriter, v: unknown): void {
            $required(v, 'bytes');
            const buf = Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'hex');
            if (size === undefined) b.writeVarint32(buf.length);
            b.write(buf);
        },
        fromObject(v: unknown): Buffer {
            $required(v, 'bytes');
            if (Buffer.isBuffer(v)) return v;
            return Buffer.from(String(v), 'hex');
        },
        toObject(v: unknown, debug?: SerDebug): string {
            if (debug && debug.use_default && v === undefined) {
                if (size) return '00'.repeat(size);
                return '';
            }
            $required(v, 'bytes');
            if (Buffer.isBuffer(v)) return v.toString('hex');
            return String(v);
        },
    };
}

const bool_type: SerType = {
    fromByteBuffer(b: BufReader): boolean { return b.readUint8() === 1; },
    appendByteBuffer(b: BufWriter, v: unknown): void { b.writeUint8(v ? 1 : 0); },
    fromObject(v: unknown): boolean { return !!v; },
    toObject(v: unknown, debug?: SerDebug): boolean {
        if (debug && debug.use_default && v === undefined) return false;
        return !!v;
    },
};

function arrayType(st_operation: SerType): SerType {
    return {
        fromByteBuffer(b: BufReader): unknown[] {
            const size = b.readVarint32();
            const result: unknown[] = [];
            for (let i = 0; i < size; i++) {
                result.push(st_operation.fromByteBuffer(b));
            }
            return result;
        },
        appendByteBuffer(b: BufWriter, v: unknown): void {
            $required(v, 'array');
            const arr = v as unknown[];
            b.writeVarint32(arr.length);
            for (const item of arr) {
                st_operation.appendByteBuffer(b, item);
            }
        },
        fromObject(v: unknown): unknown[] {
            $required(v, 'array');
            return (v as unknown[]).map((item) => st_operation.fromObject(item));
        },
        toObject(v: unknown, debug?: SerDebug): unknown[] {
            if (debug && debug.use_default && v === undefined) {
                return [st_operation.toObject(undefined, debug)];
            }
            $required(v, 'array');
            return (v as unknown[]).map((item) => st_operation.toObject(item, debug));
        },
    };
}

const time_point_sec: SerType = {
    fromByteBuffer(b: BufReader): number { return b.readUint32(); },
    appendByteBuffer(b: BufWriter, v: unknown): void {
        const n = typeof v === 'number' ? v : (time_point_sec.fromObject(v) as number);
        b.writeUint32(n);
    },
    fromObject(v: unknown): number {
        $required(v, 'time_point_sec');
        if (typeof v === 'number') return v;
        if (v instanceof Date) return Math.floor(v.getTime() / 1000);
        if (typeof v !== 'string') throw new Error('Unknown date type: ' + v);
        if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}$/.test(v)) v += 'Z';
        return Math.floor(new Date(v).getTime() / 1000);
    },
    toObject(v: unknown, debug?: SerDebug): string {
        if (debug && debug.use_default && v === undefined) {
            return new Date(0).toISOString().split('.')[0];
        }
        $required(v, 'time_point_sec');
        if (typeof v === 'string') return v;
        if (v instanceof Date) return v.toISOString().split('.')[0];
        const int = parseInt(String(v), 10);
        requireRange(0, 0xFFFFFFFF, int, 'uint32');
        return new Date(int * 1000).toISOString().split('.')[0];
    },
};

function setType(st_operation: SerType): SerType & { validate: (arr: unknown[]) => unknown[] } {
    function validate(arr: unknown[]): unknown[] {
        const dup: Record<string | number, boolean> = {};
        for (const item of arr) {
            const key = (typeof item === 'number' || typeof item === 'string') ? item : undefined;
            if (key !== undefined && dup[key] !== undefined) {
                throw new Error('duplicate (set)');
            }
            if (key !== undefined) dup[key] = true;
        }
        return sortOperation(arr, st_operation);
    }

    return {
        validate,
        fromByteBuffer(b: BufReader): unknown[] {
            const size = b.readVarint32();
            const result: unknown[] = [];
            for (let i = 0; i < size; i++) {
                result.push(st_operation.fromByteBuffer(b));
            }
            return validate(result);
        },
        appendByteBuffer(b: BufWriter, v: unknown): void {
            const sorted = validate((v || []) as unknown[]);
            b.writeVarint32(sorted.length);
            for (const item of sorted) {
                st_operation.appendByteBuffer(b, item);
            }
        },
        fromObject(v: unknown): unknown[] {
            const arr = (v || []) as unknown[];
            return validate(arr.map((item) => st_operation.fromObject(item)));
        },
        toObject(v: unknown, debug?: SerDebug): unknown[] {
            if (debug && debug.use_default && v === undefined) {
                return [st_operation.toObject(undefined, debug)];
            }
            const arr = (v || []) as unknown[];
            return validate(arr.map((item) => st_operation.toObject(item, debug)));
        },
    };
}

function idType(reserved_spaces: number, object_type: string): SerType & { compare?: (a: unknown, b: unknown) => number } {
    const objectTypeId = (OBJECT_TYPE as Record<string, number>)[object_type] != null ? (OBJECT_TYPE as Record<string, number>)[object_type] : object_type;
    return {
        fromByteBuffer(b: BufReader): number { return b.readVarint32(); },
        appendByteBuffer(b: BufWriter, v: unknown): void {
            $required(v, 'id_type');
            const id = /^\d+\.\d+\.\d+$/.test(String(v)) ? getInstance(reserved_spaces, object_type, v) : v;
            b.writeVarint32(toNumber(id));
        },
        fromObject(v: unknown): number {
            $required(v, 'id_type');
            if (isDigits(v)) return toNumber(v);
            return getInstance(reserved_spaces, object_type, v);
        },
        toObject(v: unknown, debug?: SerDebug): string {
            if (debug && debug.use_default && v === undefined) {
                return `${reserved_spaces}.${objectTypeId}.0`;
            }
            $required(v, 'id_type');
            const id = /^\d+\.\d+\.\d+$/.test(String(v)) ? getInstance(reserved_spaces, object_type, v) : v;
            return `${reserved_spaces}.${objectTypeId}.${id}`;
        },
    };
}

function getInstance(_reserved_spaces: number, _object_type: string, object: unknown): number {
    const parts = String(object).split('.');
    if (parts.length !== 3) throw new Error(`Invalid object ID: ${object}`);
    return parseInt(parts[2], 10);
}

function protocolIdType(name: string): SerType & { compare?: (a: unknown, b: unknown) => number } {
    return idType(RESERVED_SPACES.protocol_ids, name);
}

const object_id_type: SerType & { compare?: (a: unknown, b: unknown) => number } = {
    compare(a: unknown, b: unknown): number {
        const oa = a as ObjectId;
        const ob = b as ObjectId;
        if (oa.space !== ob.space) return oa.space - ob.space;
        if (oa.type !== ob.type) return oa.type - ob.type;
        const ai = typeof oa.instance === 'bigint' ? oa.instance : BigInt(oa.instance);
        const bi = typeof ob.instance === 'bigint' ? ob.instance : BigInt(ob.instance);
        return ai < bi ? -1 : ai > bi ? 1 : 0;
    },
    fromByteBuffer(b: BufReader): ObjectId {
        const long = b.readUint64();
        return ObjectId.fromLong(long);
    },
    appendByteBuffer(b: BufWriter, v: unknown): void {
        $required(v, 'object_id_type');
        const obj = ObjectId.fromString(String(v));
        obj.appendByteBuffer(b);
    },
    fromObject(v: unknown): ObjectId {
        $required(v, 'object_id_type');
        return ObjectId.fromString(String(v));
    },
    toObject(v: unknown, debug?: SerDebug): string {
        if (debug && debug.use_default && v === undefined) return '0.0.0';
        $required(v, 'object_id_type');
        let obj: unknown = v;
        if (obj instanceof ObjectId) return obj.toString();
        try {
            obj = ObjectId.fromString(String(v));
        } catch (_) {
            if (typeof v === 'number') {
                obj = ObjectId.fromLong(v);
            } else {
                throw new Error(`Invalid object_id: ${v}`);
            }
        }
        return obj instanceof ObjectId ? obj.toString() : (obj as ObjectId).toString();
    },
};

class ObjectId {
    space: number;
    type: number;
    instance: bigint;

    constructor(space: number | string, type: number | string, instance: number | bigint | string) {
        this.space = Number(space);
        this.type = Number(type);
        this.instance = BigInt(String(instance));
        if (!isDigits(String(instance))) throw new Error('ObjectId instance must be digits');
    }

    static fromString(value: unknown): ObjectId {
        if (typeof value !== 'string' || value.split('.').length !== 3) {
            throw new Error(`Invalid ObjectId: ${value}`);
        }
        const [space, type, instance] = value.split('.');
        return new ObjectId(space, type, instance);
    }

    static fromLong(long: number | bigint | string): ObjectId {
        long = BigInt(long);
        const space = Number((long >> 56n) & 0xFFn);
        const type = Number((long >> 48n) & 0xFFn);
        const instance = long & 0xFFFFFFFFFFFFn;
        return new ObjectId(space, type, instance);
    }

    toString(): string {
        return `${this.space}.${this.type}.${this.instance}`;
    }

    toLong(): bigint {
        const space = BigInt(this.space) & 0xFFn;
        const type = BigInt(this.type) & 0xFFn;
        const instance = BigInt(this.instance) & 0xFFFFFFFFFFFFn;
        return (space << 56n) | (type << 48n) | instance;
    }

    appendByteBuffer(b: BufWriter): void {
        const long = this.toLong();
        const buf = Buffer.allocUnsafe(8);
        buf.writeBigUInt64LE(long, 0);
        b.write(buf);
    }

    toBuffer(): Buffer {
        const w = new BufferWriter();
        this.appendByteBuffer(w);
        return w.toBuffer();
    }
}

function optionalType(st_operation: SerType): SerType {
    return {
        fromByteBuffer(b: BufReader): unknown {
            if (b.readUint8() !== 1) return undefined;
            return st_operation.fromByteBuffer(b);
        },
        appendByteBuffer(b: BufWriter, v: unknown): void {
            if (v !== null && v !== undefined) {
                b.writeUint8(1);
                st_operation.appendByteBuffer(b, v);
            } else {
                b.writeUint8(0);
            }
        },
        fromObject(v: unknown): unknown {
            if (v === undefined || v === null) return undefined;
            return st_operation.fromObject(v);
        },
        toObject(v: unknown, debug?: SerDebug): unknown {
            if (!debug || !debug.use_default) {
                if (v === undefined || v === null) return undefined;
            }
            const result = st_operation.toObject(v, debug);
            if (debug && debug.annotate) {
                if (typeof result === 'object' && result !== null) {
                    (result as Record<string, unknown>).__optional = 'parent is optional';
                } else {
                    return { __optional: result };
                }
            }
            return result;
        },
    };
}

function extensionType(fields_def: FieldDef[]): SerType {
    return {
        fromByteBuffer(b: BufReader): Record<string, unknown> | undefined {
            const count = b.readVarint32();
            if (count === 0) return undefined;

            const o: Record<string, unknown> = {};
            for (let i = 0; i < count; i++) {
                const index = b.readVarint32();
                if (index >= fields_def.length) throw new Error('extension index out of range: ' + index);
                const field = fields_def[index];
                o[field.name] = field.type.fromByteBuffer(b);
            }
            return o;
        },
        appendByteBuffer(b: BufWriter, v: unknown): void {
            const temp = new BufferWriter();
            let count = 0;

            if (v) {
                const rec = v as Record<string, unknown>;
                fields_def.forEach((f, i) => {
                    if (rec[f.name] !== undefined && rec[f.name] !== null) {
                        temp.writeVarint32(i);
                        f.type.appendByteBuffer(temp, rec[f.name]);
                        count++;
                    }
                });
            }

            b.writeVarint32(count);
            b.append(temp);
        },
        fromObject(v: unknown): Record<string, unknown> | undefined {
            if (v === undefined) return undefined;
            const result: Record<string, unknown> = {};
            const rec = v as Record<string, unknown>;
            fields_def.forEach((f) => {
                if (rec[f.name] !== undefined && rec[f.name] !== null) {
                    result[f.name] = f.type.fromObject(rec[f.name]);
                }
            });
            return result;
        },
        toObject(v: unknown, debug?: SerDebug): Record<string, unknown> | undefined {
            if (v === undefined) return undefined;
            const result: Record<string, unknown> = {};
            const rec = v as Record<string, unknown>;
            fields_def.forEach((f) => {
                if (rec[f.name] !== undefined && rec[f.name] !== null) {
                    result[f.name] = f.type.toObject(rec[f.name], debug);
                }
            });
            return result;
        },
    };
}

function staticVariantType(st_operations: SerType[]): SerType & { st_operations: SerType[] } {
    return {
        nosort: true,
        st_operations,
        compare(a: unknown, b: unknown): number {
            return Number(a) - Number(b);
        },
        fromByteBuffer(b: BufReader): unknown[] {
            const type_id = b.readVarint32();
            const st_operation = this.st_operations[type_id];
            if (!st_operation) throw new Error(`Unknown static_variant type: ${type_id}`);
            return [type_id, st_operation.fromByteBuffer(b)];
        },
        appendByteBuffer(b: BufWriter, v: unknown): void {
            $required(v, 'static_variant');
            const pair = v as unknown[];
            const type_id = pair[0] as number;
            const st_operation = this.st_operations[type_id];
            if (!st_operation) throw new Error(`Unknown static_variant type: ${type_id}`);
            b.writeVarint32(type_id);
            st_operation.appendByteBuffer(b, pair[1]);
        },
        fromObject(v: unknown): unknown[] {
            $required(v, 'static_variant');
            const pair = v as unknown[];
            const type_id = pair[0] as number;
            const st_operation = this.st_operations[type_id];
            if (!st_operation) throw new Error(`Unknown static_variant type: ${type_id}`);
            return [type_id, st_operation.fromObject(pair[1])];
        },
        toObject(v: unknown, debug?: SerDebug): unknown[] {
            if (debug && debug.use_default && v === undefined) {
                const sto = this.st_operations[0];
                if (!sto) throw new Error('Unknown static_variant type: 0');
                return [0, sto.toObject(undefined, debug)];
            }
            $required(v, 'static_variant');
            const pair = v as unknown[];
            const type_id = pair[0] as number;
            const st_operation = this.st_operations[type_id];
            if (!st_operation) throw new Error(`Unknown static_variant type: ${type_id}`);
            return [type_id, st_operation.toObject(pair[1], debug)];
        },
    };
}

const public_key_type: SerType & { _toPublic(): void } = {
    _toPublic(): void {
        throw new Error('public_key type requires ecc module - import from index');
    },
    fromByteBuffer(b: BufReader): Buffer {
        return b.read(33);
    },
    appendByteBuffer(b: BufWriter, v: unknown): void {
        $required(v, 'public_key');
        const buf = Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'hex');
        b.write(buf);
    },
    fromObject(v: unknown): Buffer {
        $required(v, 'public_key');
        if (Buffer.isBuffer(v)) return v;
        return Buffer.from(String(v), 'hex');
    },
    toObject(v: unknown, debug?: SerDebug): string {
        if (debug && debug.use_default && v === undefined) return '';
        $required(v, 'public_key');
        if (Buffer.isBuffer(v)) return v.toString('hex');
        return String(v);
    },
};

export { uint8, uint16, uint32, varint32, int64, uint64, string_type as string, bytesType as bytes, bool_type as bool, arrayType as array, time_point_sec, setType as set, protocolIdType as protocol_id_type, object_id_type, optionalType as optional, extensionType as extension, staticVariantType as static_variant, public_key_type as public_key, void_type, void_type as future_extensions }

