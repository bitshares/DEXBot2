const assert = require('assert');
const { getErrorMessage } = require('../modules/utils/errors');

console.log('Running browser abstraction tests');

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockBrowserEnv() {
    const origWindow = (globalThis as any).window;
    (globalThis as any).window = { document: {} };
    return () => { (globalThis as any).window = origWindow; };
}

function toHex(buf: Uint8Array): string {
    return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
    const len = hex.length >> 1;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
}

// Node ecc.ts expects Buffer; browser ecc.browser.ts expects Uint8Array.
// Use this helper to convert binary values that ecc functions receive.
function toNative(buf: any): any {
    if (buf === null || buf === undefined) return buf;
    if (typeof buf === 'string') return buf;
    if (typeof Buffer !== 'undefined' && Buffer.alloc && buf instanceof Uint8Array) return Buffer.from(buf);
    return buf;
}

// ── 1. env.ts ───────────────────────────────────────────────────────────────

async function testEnv() {
    const { isBrowser, hasProcess } = require('../modules/env');

    // On Node, isBrowser is false, hasProcess is true
    assert.strictEqual(isBrowser(), false, 'isBrowser() is false on Node');
    assert.strictEqual(hasProcess(), true, 'hasProcess() is true on Node');

    // Both functions are repeatable
    for (let i = 0; i < 5; i++) {
        assert.strictEqual(isBrowser(), false);
        assert.strictEqual(hasProcess(), true);
    }

    // hasProcess checks process.execPath
    assert.strictEqual(typeof process.execPath, 'string');

    console.log('  ✓ env.ts');
}

// ── 2. PathApi — BrowserPathApi via setPathApi ───────────────────────────────

async function testPathApiSingleton() {
    const { setPathApi, resetPathApi, getPathApi } = require('../modules/path_api');

    const orig = getPathApi();

    // Inject a custom mock
    let customCalled = false;
    const mock: any = {
        join: (...args: string[]) => { customCalled = true; return args.join('/'); },
        resolve: (...args: string[]) => '/mock/resolved',
        dirname: (p: string) => '/mock/dir',
        basename: (p: string) => 'mock.txt',
        extname: (p: string) => '.txt',
        relative: (f: string, t: string) => '../mock',
        parse: (p: string) => ({ root: '/', dir: '/mock', base: 'mock.txt', ext: '.txt', name: 'mock' }),
        format: (pf: any) => '/mock/mock.txt',
        normalize: (p: string) => '/mock/normalized',
        isAbsolute: (p: string) => true,
        sep: '/',
        delimiter: ':',
    };
    setPathApi(mock);
    assert.strictEqual(getPathApi(), mock, 'setPathApi returns injected mock');
    getPathApi().join('a', 'b');
    assert.ok(customCalled, 'injected path.join was called');

    // Reset restores auto-detection
    resetPathApi();
    assert.notStrictEqual(getPathApi(), mock, 'resetPathApi clears instance');

    // getPathApi after reset returns a functioning path
    const fresh = getPathApi();
    assert.strictEqual(typeof fresh.join, 'function');
    assert.strictEqual(typeof fresh.resolve, 'function');
    assert.strictEqual(fresh.sep, '/');

    // Restore the original instance so module-level `path` is consistent
    setPathApi(orig);

    console.log('  ✓ PathApi singleton contract');
}

async function testPathApiNode() {
    const { path } = require('../modules/path_api');

    // join
    assert.strictEqual(path.join('a', 'b', 'c'), 'a/b/c');
    assert.strictEqual(path.join('/a', 'b', 'c'), '/a/b/c');
    assert.strictEqual(path.join('/a', '..', 'b'), '/b');
    assert.strictEqual(path.join('a', '..', '..', 'b'), '../b');

    // resolve
    assert.ok(path.resolve('').endsWith(process.cwd().split('/').pop()!));

    // basename
    assert.strictEqual(path.basename('/foo/bar/baz.txt'), 'baz.txt');
    assert.strictEqual(path.basename('/foo/bar/baz.txt', '.txt'), 'baz');
    const basenameSlash = path.basename('/');
    assert.ok(basenameSlash === '/' || basenameSlash === '', 'path.basename(\'/\') is / or empty');
    assert.strictEqual(path.basename('/foo/bar/'), 'bar');

    // dirname
    assert.strictEqual(path.dirname('/foo/bar/baz.txt'), '/foo/bar');
    assert.strictEqual(path.dirname('/foo/bar'), '/foo');
    assert.strictEqual(path.dirname('/'), '/');
    assert.strictEqual(path.dirname('foo'), '.');

    // extname
    assert.strictEqual(path.extname('/foo/bar/baz.txt'), '.txt');
    assert.strictEqual(path.extname('/foo/bar/baz'), '');
    assert.strictEqual(path.extname('/foo/bar/.hidden'), '');

    // isAbsolute
    assert.strictEqual(path.isAbsolute('/foo'), true);
    assert.strictEqual(path.isAbsolute('foo'), false);
    assert.strictEqual(path.isAbsolute(''), false);

    // relative
    assert.strictEqual(path.relative('/data/orandea/test/aaa', '/data/orandea/impl/bbb'), '../../impl/bbb');
    const relSelf = path.relative('/a/b/c', '/a/b/c');
    assert.ok(relSelf === '.' || relSelf === '', 'path.relative(self) is . or empty');

    // normalize
    assert.strictEqual(path.normalize('/foo/../bar/baz/./qux'), '/bar/baz/qux');
    assert.strictEqual(path.normalize('foo/..'), '.');
    assert.strictEqual(path.normalize('/../../foo'), '/foo');

    // parse
    const parsed = path.parse('/home/user/dir/file.txt');
    assert.strictEqual(parsed.root, '/');
    assert.strictEqual(parsed.dir, '/home/user/dir');
    assert.strictEqual(parsed.base, 'file.txt');
    assert.strictEqual(parsed.ext, '.txt');
    assert.strictEqual(parsed.name, 'file');

    // format
    const formatted = path.format({ root: '/', dir: '/home/user', base: 'file.txt' });
    assert.strictEqual(formatted, '/home/user/file.txt');

    // sep / delimiter
    assert.strictEqual(path.sep, '/');
    assert.strictEqual(path.delimiter, ':');

    console.log('  ✓ PathApi Node impl');
}

// ── 3. Runtime — BrowserRuntime via setRuntime ─────────────────────────────

async function testRuntimeBrowser() {
    const { setRuntime, getRuntime } = require('../modules/runtime');

    const mock: any = {
        exit: (code?: number) => { /* noop */ },
        exitCode: undefined,
        kill: (_pid: number, _signal?: string) => false,
        onSignal: (_signal: string, _handler: any) => {},
        offSignal: (_signal: string, _handler: any) => {},
        pid: 0,
        platform: 'browser',
        stdout: { isTTY: false, write: () => true },
        stderr: { isTTY: false, write: () => true },
        stdin: null,
        argv: [],
        cwd: () => '',
        env: {},
        umask: (_mask?: number) => 0,
        getuid: () => null,
    };

    setRuntime(mock);
    const rt = getRuntime();

    assert.strictEqual(rt.exit, mock.exit);
    assert.strictEqual(rt.kill(1), false);
    assert.strictEqual(rt.pid, 0);
    assert.strictEqual(rt.platform, 'browser');
    assert.strictEqual(rt.stdout.write('test'), true);
    assert.strictEqual(rt.stderr.write('test'), true);
    assert.strictEqual(rt.stdin, null);
    assert.deepStrictEqual(rt.argv, []);
    assert.strictEqual(rt.cwd(), '');
    assert.deepStrictEqual(rt.env, {});
    assert.strictEqual(rt.umask(0o77), 0);
    assert.strictEqual(rt.getuid(), null);
    assert.strictEqual(rt.exitCode, undefined);
    assert.strictEqual(typeof rt.onSignal, 'function');
    assert.strictEqual(typeof rt.offSignal, 'function');

    // onSignal should not throw (mock is no-op)
    rt.onSignal('SIGINT', () => {});
    rt.onSignal('SIGHUP', () => {});
    rt.offSignal('SIGINT', () => {});

    setRuntime(null);

    console.log('  ✓ Runtime Browser contract');
}

async function testRuntimeNode() {
    const { getRuntime, setRuntime } = require('../modules/runtime');

    setRuntime(null);
    const rt = getRuntime();

    assert.strictEqual(typeof rt.exit, 'function');
    assert.strictEqual(typeof rt.kill, 'function');
    assert.strictEqual(typeof rt.onSignal, 'function');
    assert.strictEqual(typeof rt.offSignal, 'function');
    assert.strictEqual(typeof rt.cwd, 'function');
    assert.strictEqual(typeof rt.getuid, 'function');

    assert.strictEqual(typeof rt.pid, 'number');
    assert.ok(rt.pid > 0, 'Node pid > 0');
    assert.strictEqual(typeof rt.platform, 'string');
    assert.strictEqual(typeof rt.env, 'object');
    assert.strictEqual(typeof rt.stdout, 'object');
    assert.strictEqual(typeof rt.stderr, 'object');
    assert.strictEqual(typeof rt.argv, 'object');
    assert.ok(Array.isArray(rt.argv));

    // kill non-existent pid returns false
    assert.strictEqual(rt.kill(999999999, 'SIGINT'), false);

    // umask round-trip
    const prev = rt.umask();
    assert.strictEqual(typeof prev, 'number');
    rt.umask(prev);

    // getuid
    const uid = rt.getuid();
    assert.strictEqual(typeof uid, 'number');

    // exitCode
    assert.strictEqual(rt.exitCode, undefined);
    rt.exitCode = 0;
    assert.strictEqual(rt.exitCode, 0);

    console.log('  ✓ Runtime Node impl');
}

// ── 4. Config ────────────────────────────────────────────────────────────────

async function testConfig() {
    const mod = require('../modules/config');
    const { Config } = mod;

    assert.ok(Config, 'Config object exists');
    assert.ok(Array.isArray(Config.ARGS), 'Config.ARGS is array');
    assert.strictEqual(typeof Config.PLATFORM, 'string');
    assert.strictEqual(typeof Config.CWD, 'string');
    assert.strictEqual(typeof Config.EXEC_PATH, 'string');

    // Feature flag defaults
    assert.strictEqual(Config.DEXBOT_SKIP_PROFILE_VALIDATION, false);
    assert.strictEqual(Config.DEXBOT_DISABLE_SUPERVISOR_SOCKET, false);
    assert.strictEqual(Config.DEXBOT_ISOLATED_CHILD, false);
    assert.strictEqual(Config.DEXBOT_MONOLITHIC_BG, false);

    // Numeric defaults
    assert.strictEqual(Config.CALC_CYCLES, 3);
    assert.strictEqual(Config.CALC_DELAY_MS, 500);

    // AI defaults
    assert.strictEqual(Config.OPENAI_BASE_URL, 'https://api.openai.com/v1');
    assert.strictEqual(Config.OPENAI_CHAT_MODEL, 'gpt-4o');
    assert.strictEqual(Config.OPENAI_EMBED_MODEL, 'text-embedding-3-small');
    assert.strictEqual(Config.MEMU_PYTHON, 'python3');

    // Helper functions
    assert.strictEqual(typeof mod.hasOpenOrdersSyncLoopMsSet, 'function');
    assert.strictEqual(typeof mod.getOpenOrdersSyncLoopMs, 'function');
    assert.strictEqual(typeof mod.setUmask, 'function');

    // setUmask
    const prev = typeof process.umask === 'function' ? process.umask() : 0o22;
    mod.setUmask(prev);
    // Doesn't throw

    console.log('  ✓ Config');
}

// ── 5. BrowserStorageAdapter — thorough ──────────────────────────────────────

async function testBrowserStorage() {
    const { setAdapter } = require('../modules/storage');
    const createBrowserStorageAdapter = require('../modules/storage/browser_adapter').default;

    const adapter = createBrowserStorageAdapter();

    // writeJSON / readJSON round-trip
    const data = { hello: 'world', num: 42, nested: { a: [1, 2, 3] } };
    adapter.writeJSON('/test/foo.json', data);
    const loaded = adapter.readJSON('/test/foo.json');
    assert.deepStrictEqual(loaded, data);

    // readJSON throws ENOENT for missing
    assert.throws(() => adapter.readJSON('/test/nonexist.json'), /ENOENT/);

    // exists
    assert.ok(adapter.exists('/test/foo.json'));
    assert.ok(!adapter.exists('/test/nonexist.json'));

    // writeJSON with flag: 'wx' — succeeds for new, throws EEXIST for existing
    adapter.writeJSON('/test/wx-test.json', { test: true }, { flag: 'wx' });
    assert.throws(() => {
        adapter.writeJSON('/test/wx-test.json', { test: true }, { flag: 'wx' });
    }, /EEXIST/);

    // writeJSON with mode option (no-op in browser, just shouldn't throw)
    adapter.writeJSON('/test/mode-test.json', { mode: true }, { mode: 0o600 });

    // readdir
    adapter.writeJSON('/test/dir/a.json', { x: 1 });
    adapter.writeJSON('/test/dir/sub/b.json', { y: 2 });
    adapter.writeJSON('/test/dir/sub/deep/c.json', { z: 3 });

    let entries = adapter.readdir('/test/dir');
    assert.ok(entries.includes('a.json'));
    assert.ok(entries.includes('sub'));
    assert.strictEqual(entries.length, 2);

    // readdir on root
    const rootEntries = adapter.readdir('/test');
    assert.ok(rootEntries.includes('foo.json'));
    assert.ok(rootEntries.includes('dir'));
    assert.ok(rootEntries.includes('wx-test.json'));

    // readdir on empty dir
    const emptyEntries = adapter.readdir('/empty');
    assert.deepStrictEqual(emptyEntries, []);

    // readdir on nested
    const subEntries = adapter.readdir('/test/dir/sub');
    assert.ok(subEntries.includes('b.json'));
    assert.ok(subEntries.includes('deep'));

    // writeFile / readFile
    adapter.writeFile('/test/hello.txt', 'Hello, World!');
    assert.strictEqual(adapter.readFile('/test/hello.txt'), 'Hello, World!');
    assert.strictEqual(adapter.readFile('/test/hello.txt', 'utf8'), 'Hello, World!');
    assert.throws(() => adapter.readFile('/test/nonexist.txt'), /ENOENT/);

    // unlink
    adapter.unlink('/test/foo.json');
    assert.ok(!adapter.exists('/test/foo.json'));
    adapter.unlink('/test/nonexist.json'); // no-op

    // rename
    adapter.writeJSON('/test/rename-src.json', { src: true });
    adapter.rename('/test/rename-src.json', '/test/rename-dst.json');
    assert.ok(!adapter.exists('/test/rename-src.json'));
    assert.ok(adapter.exists('/test/rename-dst.json'));
    assert.deepStrictEqual(adapter.readJSON('/test/rename-dst.json'), { src: true });

    // ensureDir (no-op in browser, shouldn't throw)
    adapter.ensureDir('/some/deep/path');

    // stat
    const stat = adapter.stat('/test/hello.txt');
    assert.strictEqual(typeof stat.mtimeMs, 'number');
    assert.strictEqual(stat.isFile(), true);
    assert.strictEqual(stat.isDirectory(), false);

    assert.throws(() => adapter.stat('/test/nonexist.txt'), /ENOENT/);

    // lstat
    const lstat = adapter.lstat('/test/hello.txt');
    assert.strictEqual(lstat.isFile(), true);

    // mkdtemp uniqueness
    const t1 = adapter.mkdtemp('/tmp/test-');
    const t2 = adapter.mkdtemp('/tmp/test-');
    assert.notStrictEqual(t1, t2);
    assert.ok(t1.startsWith('/tmp/test-'));
    assert.ok(t2.startsWith('/tmp/test-'));

    // realpath/readlink identity
    assert.strictEqual(adapter.realpath('/foo/bar'), '/foo/bar');
    assert.strictEqual(adapter.readlink('/foo/bar'), '/foo/bar');

    // chmod (no-op, shouldn't throw)
    adapter.chmod('/test/hello.txt', 0o600);

    // access (no-op, shouldn't throw)
    adapter.access('/test/hello.txt');

    // utimes (no-op, shouldn't throw)
    adapter.utimes('/test/hello.txt', Date.now(), Date.now());

    // rmdir (no-op, shouldn't throw)
    adapter.rmdir('/test/empty-dir');

    // rm (no-op, shouldn't throw)
    adapter.rm('/test/some-file');
    adapter.rm('/test/some-dir', { recursive: true, force: true });

    // open/close/write/fsync throw
    assert.throws(() => adapter.open('/test/foo.txt', 'w'), /not supported/);
    assert.throws(() => adapter.close(), /not supported/);
    assert.throws(() => adapter.write(1, 'test'), /not supported/);
    assert.throws(() => adapter.fsync(), /not supported/);

    // appendFile — creates file if missing, appends if exists
    adapter.appendFile('/test/append.txt', 'line1\n');
    assert.strictEqual(adapter.readFile('/test/append.txt'), 'line1\n');
    adapter.appendFile('/test/append.txt', 'line2\n');
    assert.strictEqual(adapter.readFile('/test/append.txt'), 'line1\nline2\n');

    // appendFileAsync
    await adapter.appendFileAsync('/test/append-async.txt', 'a\n');
    assert.strictEqual(adapter.readFile('/test/append-async.txt'), 'a\n');

    // createReadStream / createWriteStream throw in browser
    assert.throws(() => adapter.createReadStream('/test/foo.txt'), /not supported/);
    assert.throws(() => adapter.createWriteStream('/test/bar.txt'), /not supported/);

    // flush exists and is async
    assert.strictEqual(typeof adapter.flush, 'function');
    await adapter.flush(); // should not throw

    setAdapter(null);
    console.log('  ✓ BrowserStorageAdapter');
}

// ── 6. NodeStorageAdapter ────────────────────────────────────────────────────

async function testNodeStorage() {
    const NodeStorageAdapter = require('../modules/storage/node_adapter').default;
    const fs = require('fs');
    const os = require('os');
    const path = require('path');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-test-storage-'));
    const adapter = new NodeStorageAdapter();

    const testFile = path.join(tmpDir, 'test.json');
    const testData = { hello: 'world', num: 42, nested: [1, 2, 3] };

    try {
        // writeJSON / readJSON
        adapter.writeJSON(testFile, testData);
        const loaded = adapter.readJSON(testFile);
        assert.deepStrictEqual(loaded, testData);

        // readJSON throws for missing
        assert.throws(() => adapter.readJSON(path.join(tmpDir, 'nonexist.json')), /ENOENT/);

        // exists
        assert.ok(adapter.exists(testFile));
        assert.ok(!adapter.exists(path.join(tmpDir, 'nonexist.json')));

        // writeJSON with mode
        const modeFile = path.join(tmpDir, 'mode-test.json');
        adapter.writeJSON(modeFile, { mode: true }, { mode: 0o600 });
        const stat1 = fs.statSync(modeFile);
        assert.strictEqual(stat1.mode & 0o777, 0o600);

        // writeJSON with flag: 'wx'
        const wxFile = path.join(tmpDir, 'wx-test.json');
        adapter.writeJSON(wxFile, { test: true }, { flag: 'wx' });
        assert.throws(() => {
            adapter.writeJSON(wxFile, { test: true }, { flag: 'wx' });
        }, /EEXIST/);

        // writeJSON with fsync
        const fsyncFile = path.join(tmpDir, 'fsync-test.json');
        adapter.writeJSON(fsyncFile, { fsync: true }, { fsync: true });
        assert.ok(adapter.exists(fsyncFile));

        // writeFile / readFile
        const textFile = path.join(tmpDir, 'hello.txt');
        adapter.writeFile(textFile, 'Hello, World!');
        assert.strictEqual(adapter.readFile(textFile), 'Hello, World!');
        assert.strictEqual(adapter.readFile(textFile, 'utf8'), 'Hello, World!');
        assert.throws(() => adapter.readFile(path.join(tmpDir, 'nonexist.txt')), /ENOENT/);

        // writeFile with mode
        const modeTextFile = path.join(tmpDir, 'mode-hello.txt');
        adapter.writeFile(modeTextFile, 'Hello', { mode: 0o644 });
        assert.ok(adapter.exists(modeTextFile));

        // unlink
        const unlinkFile = path.join(tmpDir, 'to-unlink.json');
        adapter.writeJSON(unlinkFile, {});
        adapter.unlink(unlinkFile);
        assert.ok(!adapter.exists(unlinkFile));
        adapter.unlink(path.join(tmpDir, 'nonexist.json')); // no-op

        // rename
        const srcFile = path.join(tmpDir, 'rename-src.json');
        const dstFile = path.join(tmpDir, 'rename-dst.json');
        adapter.writeJSON(srcFile, { src: true });
        adapter.rename(srcFile, dstFile);
        assert.ok(!adapter.exists(srcFile));
        assert.ok(adapter.exists(dstFile));

        // ensureDir
        const nestedDir = path.join(tmpDir, 'a', 'b', 'c');
        adapter.ensureDir(nestedDir);
        assert.ok(fs.statSync(nestedDir).isDirectory());

        // ensureDir with mode
        const modeDir = path.join(tmpDir, 'mode-dir');
        adapter.ensureDir(modeDir, { mode: 0o755 });
        assert.ok(fs.statSync(modeDir).isDirectory());

        // stat
        const statResult = adapter.stat(testFile);
        assert.strictEqual(typeof statResult.mtimeMs, 'number');
        assert.ok(statResult.mtimeMs > 0);
        assert.strictEqual(statResult.isFile(), true);
        assert.strictEqual(statResult.isDirectory(), false);
        assert.throws(() => adapter.stat(path.join(tmpDir, 'nonexist')), /ENOENT/);

        // lstat
        const lstatResult = adapter.lstat(testFile);
        assert.strictEqual(lstatResult.isFile(), true);

        // readdir
        const dirEntries = adapter.readdir(tmpDir);
        assert.ok(dirEntries.includes('test.json'));
        assert.ok(dirEntries.includes('a'));

        // readdir on empty dir
        const emptyDir = path.join(tmpDir, 'empty');
        adapter.ensureDir(emptyDir);
        assert.deepStrictEqual(adapter.readdir(emptyDir), []);

        // mkdtemp
        const tempDir = adapter.mkdtemp(path.join(tmpDir, 'my-temp-'));
        assert.ok(fs.statSync(tempDir).isDirectory());
        assert.ok(tempDir.startsWith(path.join(tmpDir, 'my-temp-')));
        fs.rmdirSync(tempDir);

        // open/close/write/fsync fd operations
        const fdFile = path.join(tmpDir, 'fd-test.txt');
        const fd = adapter.open(fdFile, 'wx', 0o600);
        assert.strictEqual(typeof fd, 'number');
        assert.ok(fd > 0);
        adapter.write(fd, 'fd data');
        adapter.fsync(fd);
        adapter.close(fd);
        assert.strictEqual(adapter.readFile(fdFile), 'fd data');

        // realpath
        const real = adapter.realpath(tmpDir);
        assert.strictEqual(real, fs.realpathSync(tmpDir));

        // chmod
        const chmodFile = path.join(tmpDir, 'chmod-test.txt');
        adapter.writeFile(chmodFile, 'test');
        adapter.chmod(chmodFile, 0o644);
        const chmodStat = fs.statSync(chmodFile);
        assert.strictEqual(chmodStat.mode & 0o777, 0o644);

        // access
        adapter.access(tmpDir);

        // utimes
        const utimesFile = path.join(tmpDir, 'utimes-test.txt');
        adapter.writeFile(utimesFile, 'test');
        adapter.utimes(utimesFile, new Date('2020-01-01'), new Date('2020-01-01'));

        // rmdir
        const rmdirDir = path.join(tmpDir, 'to-rmdir');
        adapter.ensureDir(rmdirDir);
        adapter.rmdir(rmdirDir);
        assert.ok(!adapter.exists(rmdirDir));

        // rm
        const rmFile = path.join(tmpDir, 'to-rm.txt');
        adapter.writeFile(rmFile, 'bye');
        adapter.rm(rmFile);
        assert.ok(!adapter.exists(rmFile));

        // rm recursive
        const rmDir = path.join(tmpDir, 'to-rm-recursive');
        adapter.ensureDir(path.join(rmDir, 'sub'));
        adapter.writeFile(path.join(rmDir, 'sub', 'a.txt'), 'a');
        adapter.rm(rmDir, { recursive: true, force: true });
        assert.ok(!adapter.exists(rmDir));

        // readlink
        const linkPath = path.join(tmpDir, 'my-link');
        try { fs.symlinkSync(testFile, linkPath); } catch {}
        if (adapter.exists(linkPath)) {
            const linkTarget = adapter.readlink(linkPath);
            assert.strictEqual(linkTarget, testFile);
        }
        // appendFile
        const appendFile = path.join(tmpDir, 'append.log');
        adapter.appendFile(appendFile, 'line1\n');
        assert.strictEqual(adapter.readFile(appendFile), 'line1\n');
        adapter.appendFile(appendFile, 'line2\n');
        assert.strictEqual(adapter.readFile(appendFile), 'line1\nline2\n');

        // appendFileAsync
        const appendAsyncFile = path.join(tmpDir, 'append-async.log');
        await adapter.appendFileAsync(appendAsyncFile, 'a\n');
        assert.strictEqual(adapter.readFile(appendAsyncFile), 'a\n');

        // createReadStream — read content via stream
        const streamFile = path.join(tmpDir, 'stream-test.txt');
        adapter.writeFile(streamFile, 'hello stream');
        const rsContent = await new Promise<string>((resolve, reject) => {
            const rs = adapter.createReadStream(streamFile);
            let data = '';
            rs.on('data', (chunk: any) => { data += chunk; });
            rs.on('end', () => resolve(data));
            rs.on('error', reject);
        });
        assert.strictEqual(rsContent, 'hello stream');

        // createWriteStream — write content via stream
        const streamOut = path.join(tmpDir, 'stream-out.txt');
        await new Promise<void>((resolve, reject) => {
            const ws = adapter.createWriteStream(streamOut);
            ws.write('written data', 'utf8');
            ws.end(resolve);
            ws.on('error', reject);
        });
        assert.strictEqual(adapter.readFile(streamOut), 'written data');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    console.log('  ✓ NodeStorageAdapter');
}

async function testStorageSingleton() {
    const { getStorage, setAdapter } = require('../modules/storage');

    // Default adapter should be NodeStorageAdapter on Node
    const storage = getStorage();
    assert.ok(storage, 'getStorage returns something');
    assert.strictEqual(typeof storage.readJSON, 'function');
    assert.strictEqual(typeof storage.writeJSON, 'function');
    assert.strictEqual(typeof storage.exists, 'function');
    assert.strictEqual(typeof storage.readdir, 'function');
    assert.strictEqual(typeof storage.ensureDir, 'function');
    assert.strictEqual(typeof storage.unlink, 'function');
    assert.strictEqual(typeof storage.rename, 'function');
    assert.strictEqual(typeof storage.stat, 'function');
    assert.strictEqual(typeof storage.readFile, 'function');
    assert.strictEqual(typeof storage.writeFile, 'function');
    assert.strictEqual(typeof storage.open, 'function');
    assert.strictEqual(typeof storage.close, 'function');
    assert.strictEqual(typeof storage.write, 'function');
    assert.strictEqual(typeof storage.fsync, 'function');
    assert.strictEqual(typeof storage.chmod, 'function');
    assert.strictEqual(typeof storage.realpath, 'function');
    assert.strictEqual(typeof storage.access, 'function');
    assert.strictEqual(typeof storage.utimes, 'function');
    assert.strictEqual(typeof storage.lstat, 'function');
    assert.strictEqual(typeof storage.rmdir, 'function');
    assert.strictEqual(typeof storage.rm, 'function');
    assert.strictEqual(typeof storage.mkdtemp, 'function');
    assert.strictEqual(typeof storage.readlink, 'function');
    assert.strictEqual(typeof storage.appendFile, 'function');
    assert.strictEqual(typeof storage.appendFileAsync, 'function');
    assert.strictEqual(typeof storage.createReadStream, 'function');
    assert.strictEqual(typeof storage.createWriteStream, 'function');

    // setAdapter null resets to auto-detect
    setAdapter(null);
    assert.ok(getStorage(), 'getStorage still works after reset');

    console.log('  ✓ Storage singleton contract');
}

// ── 7. BrowserCryptoProvider — all async methods ────────────────────────────

async function testBrowserCryptoProvider() {
    const { BrowserCryptoProvider } = require('../modules/crypto');
    const crypto = new BrowserCryptoProvider();

    const testData = new TextEncoder().encode('hello world');

    // sha256 known vector
    const hash = await crypto.sha256(testData);
    assert.strictEqual(toHex(hash), 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
    // sha256 of empty
    const emptyHash = await crypto.sha256(new Uint8Array(0));
    assert.strictEqual(toHex(emptyHash), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

    // sha512
    const sha512hash = await crypto.sha512(testData);
    assert.strictEqual(toHex(sha512hash).length, 128);

    // ripemd160
    const ripemd = await crypto.ripemd160(testData);
    assert.strictEqual(toHex(ripemd).length, 40);

    // hmacSha256
    const key = new TextEncoder().encode('my-key');
    const hmac = await crypto.hmacSha256(key, testData);
    assert.strictEqual(toHex(hmac).length, 64);

    // randomBytes
    const rand1 = await crypto.randomBytes(32);
    const rand2 = await crypto.randomBytes(32);
    assert.strictEqual(rand1.length, 32);
    assert.strictEqual(rand2.length, 32);
    assert.notStrictEqual(toHex(rand1), toHex(rand2));

    // privateKeyToPublicKey (secp256k1)
    const privKey = fromHex('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140');
    const pubKey = await crypto.privateKeyToPublicKey(privKey, true);
    assert.strictEqual(pubKey.length, 33);
    assert.ok(pubKey[0] === 0x02 || pubKey[0] === 0x03, 'pubkey prefix is 0x02 or 0x03');

    // Uncompressed
    const pubKeyUncomp = await crypto.privateKeyToPublicKey(privKey, false);
    assert.strictEqual(pubKeyUncomp.length, 65);
    assert.strictEqual(pubKeyUncomp[0], 0x04);

    // timingSafeEqual
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 4]);
    const c = new Uint8Array([1, 2, 3, 5]);
    assert.strictEqual(await crypto.timingSafeEqual(a, b), true);
    assert.strictEqual(await crypto.timingSafeEqual(a, c), false);
    assert.strictEqual(await crypto.timingSafeEqual(a, new Uint8Array([1, 2])), false);

    // hkdf
    const hkdfSalt = new Uint8Array(16);
    const hkdfInfo = new TextEncoder().encode('test-info');
    const hkdfResult = await crypto.hkdf(key, hkdfSalt, hkdfInfo, 32);
    assert.strictEqual(hkdfResult.length, 32);

    // scrypt
    // Use reduced parameters for test speed
    const scryptResult = await crypto.scrypt(
        new TextEncoder().encode('password'),
        new TextEncoder().encode('salt'),
        32,
        { N: 16, r: 1, p: 1 }
    );
    assert.strictEqual(scryptResult.length, 32);

    // aes256Gcm
    const aesKey = await crypto.randomBytes(32);
    const plaintext = new TextEncoder().encode('secret message');
    const encrypted = await crypto.aes256GcmEncrypt(plaintext, aesKey);
    assert.strictEqual(encrypted.ciphertext.length, plaintext.length);
    assert.strictEqual(encrypted.authTag.length, 16);
    assert.strictEqual(encrypted.iv.length, 12);

    const decrypted = await crypto.aes256GcmDecrypt(encrypted.ciphertext, aesKey, encrypted.iv, encrypted.authTag);
    assert.deepStrictEqual(decrypted, plaintext);

    console.log('  ✓ BrowserCryptoProvider');
}

// ── 8. Crypto singleton ──────────────────────────────────────────────────────

async function testCryptoProviderSingleton() {
    const { getCrypto, setCrypto } = require('../modules/crypto');

    const cp = getCrypto();
    assert.ok(cp, 'getCrypto returns something');
    assert.strictEqual(typeof cp.sha256, 'function');
    assert.strictEqual(typeof cp.sha512, 'function');
    assert.strictEqual(typeof cp.ripemd160, 'function');
    assert.strictEqual(typeof cp.hmacSha256, 'function');
    assert.strictEqual(typeof cp.privateKeyToPublicKey, 'function');
    assert.strictEqual(typeof cp.aes256GcmEncrypt, 'function');
    assert.strictEqual(typeof cp.aes256GcmDecrypt, 'function');
    assert.strictEqual(typeof cp.scrypt, 'function');
    assert.strictEqual(typeof cp.hkdf, 'function');
    assert.strictEqual(typeof cp.timingSafeEqual, 'function');
    assert.strictEqual(typeof cp.randomBytes, 'function');

    // setCrypto
    let customUsed = false;
    setCrypto({ sha256: async () => { customUsed = true; return new Uint8Array(0); } } as any);
    await getCrypto().sha256(new Uint8Array(0));
    assert.ok(customUsed);

    setCrypto(null);
    assert.ok(getCrypto(), 'getCrypto still works after reset');

    console.log('  ✓ CryptoProvider singleton');
}

// ── 9. crypto/sync — all exports ────────────────────────────────────────────

async function testCryptoSync() {
    const sync = require('../modules/crypto/sync');

    // All exports exist
    assert.strictEqual(typeof sync.createHash, 'function');
    assert.strictEqual(typeof sync.createHmac, 'function');
    assert.strictEqual(typeof sync.randomBytes, 'function');
    assert.strictEqual(typeof sync.timingSafeEqual, 'function');
    assert.strictEqual(typeof sync.hkdfSync, 'function');
    assert.strictEqual(typeof sync.scryptSync, 'function');
    assert.strictEqual(typeof sync.createCipheriv, 'function');
    assert.strictEqual(typeof sync.createDecipheriv, 'function');
    assert.strictEqual(typeof sync.createECDH, 'function');

    // SHA-256 known vector
    const hash = sync.createHash('sha256');
    hash.update('hello');
    assert.strictEqual(hash.digest('hex'), '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');

    // SHA-1
    const hash1 = sync.createHash('sha1');
    hash1.update('hello');
    assert.strictEqual(hash1.digest('hex'), 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');

    // HMAC
    const hmac = sync.createHmac('sha256', 'key');
    hmac.update('message');
    const hmacDigest = hmac.digest('hex');
    assert.strictEqual(hmacDigest.length, 64);

    // randomBytes uniqueness
    const r1 = sync.randomBytes(16);
    const r2 = sync.randomBytes(16);
    assert.strictEqual(r1.length, 16);
    assert.notStrictEqual(r1.toString('hex'), r2.toString('hex'));

    // timingSafeEqual
    assert.ok(sync.timingSafeEqual(Buffer.from('abc'), Buffer.from('abc')));
    assert.ok(!sync.timingSafeEqual(Buffer.from('abc'), Buffer.from('abd')));

    // createECDH
    const ecdh = sync.createECDH('secp256k1');
    ecdh.generateKeys();
    const ecdhPubDefault = ecdh.getPublicKey();
    assert.ok(ecdhPubDefault.length === 33 || ecdhPubDefault.length === 65, 'ECDH default key is 33 or 65 bytes');
    const ecdhPubComp = ecdh.getPublicKey(null, 'compressed');
    assert.strictEqual(ecdhPubComp.length, 33);

    // createCipheriv / createDecipheriv (AES-256-GCM)
    const cipherKey = sync.randomBytes(32);
    const iv = sync.randomBytes(12);
    const cipher = sync.createCipheriv('aes-256-gcm', cipherKey, iv);
    const enc1 = cipher.update('secret message');
    cipher.final();
    const authTag = cipher.getAuthTag();

    const decipher = sync.createDecipheriv('aes-256-gcm', cipherKey, iv);
    decipher.setAuthTag(authTag);
    const dec1 = decipher.update(enc1);
    const dec2 = decipher.final('utf8');
    assert.strictEqual(dec1.toString() + dec2.toString(), 'secret message');

    // scryptSync
    const scryptBuf = sync.scryptSync('password', 'salt', 32, { N: 16, r: 1, p: 1 });
    assert.strictEqual(scryptBuf.length, 32);

    // hkdfSync
    const hkdfBuf = sync.hkdfSync('sha256', Buffer.from('key'), Buffer.alloc(16), Buffer.from('info'), 32);
    assert.strictEqual(hkdfBuf.byteLength || hkdfBuf.length, 32);

    console.log('  ✓ crypto/sync all exports');
}

// ── 10. pure_ripemd160 ──────────────────────────────────────────────────────

async function testPureRipemd160() {
    const { ripemd160 } = require('../modules/crypto/pure_ripemd160');

    // Known RIPEMD-160 vectors
    const empty = ripemd160(new Uint8Array(0));
    assert.strictEqual(toHex(empty), '9c1185a5c5e9fc54612808977ee8f548b2258d31');

    const hello = ripemd160(new TextEncoder().encode('hello'));
    // RIPEMD-160('hello') — Node reference: crypto.createHash('ripemd160').update('hello').digest('hex')
    assert.strictEqual(toHex(hello), '108f07b8382412612c048d07d13f814118445acd');

    const abc = ripemd160(new TextEncoder().encode('abc'));
    assert.strictEqual(toHex(abc), '8eb208f7e05d987a9b044a8e98c6b087f15a0bfc');

    // 64 bytes (one full block)
    const longData = new Uint8Array(64);
    const longHash = ripemd160(longData);
    assert.strictEqual(toHex(longHash).length, 40);

    console.log('  ✓ pure_ripemd160');
}

// ── 11. pure_scrypt ──────────────────────────────────────────────────────────

async function testPureScrypt() {
    const { scrypt } = require('../modules/crypto/pure_scrypt');

    const result = await scrypt(
        new TextEncoder().encode('password'),
        new TextEncoder().encode('salt'),
        32,
        { N: 16, r: 1, p: 1 }
    );
    assert.strictEqual(result.length, 32);

    // Different params produce different output
    const result2 = await scrypt(
        new TextEncoder().encode('password'),
        new TextEncoder().encode('salt'),
        16,
        { N: 16, r: 1, p: 1 }
    );
    assert.strictEqual(result2.length, 16);

    // Different password
    const result3 = await scrypt(
        new TextEncoder().encode('different'),
        new TextEncoder().encode('salt'),
        32,
        { N: 16, r: 1, p: 1 }
    );
    assert.notStrictEqual(toHex(result), toHex(result3));

    // RFC 7914 section 12 known-answer tests. A previous version reset the
    // ROMix phase-2 state to the input block and derived a different key than
    // native scrypt; these vectors catch that regression.
    const rfcVectors = [
        {
            password: '', salt: '', keyLength: 64, options: { N: 16, r: 1, p: 1 },
            expected: '77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906',
        },
        {
            password: 'password', salt: 'NaCl', keyLength: 64, options: { N: 1024, r: 8, p: 16 },
            expected: 'fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640',
        },
        {
            password: 'pleaseletmein', salt: 'SodiumChloride', keyLength: 64, options: { N: 16384, r: 8, p: 1 },
            expected: '7023bdcb3afd7348461c06cd81fd38ebfda8fbba904f8e3ea9b543f6545da1f2d5432955613f0fcf62d49705242a9af9e61e85dc0d651e40dfcf017b45575887',
        },
    ];
    for (const vector of rfcVectors) {
        const derived = await scrypt(
            new TextEncoder().encode(vector.password),
            new TextEncoder().encode(vector.salt),
            vector.keyLength,
            vector.options,
        );
        assert.strictEqual(toHex(derived), vector.expected, `RFC 7914 KAT N=${vector.options.N} r=${vector.options.r} p=${vector.options.p}`);
    }

    // Cross-check against native scrypt, including a key length that is not a
    // multiple of the SHA-256 output size (exercises multi-block PBKDF2).
    const nativeCrypto = require('crypto');
    const crossChecks = [
        { password: 'password', salt: 'salt', keyLength: 32, options: { N: 16384, r: 8, p: 1 } },
        { password: 'password', salt: 'salt', keyLength: 100, options: { N: 1024, r: 8, p: 2 } },
    ];
    for (const check of crossChecks) {
        const derived = await scrypt(
            new TextEncoder().encode(check.password),
            new TextEncoder().encode(check.salt),
            check.keyLength,
            check.options,
        );
        const native = nativeCrypto.scryptSync(check.password, check.salt, check.keyLength, check.options);
        assert.strictEqual(toHex(derived), native.toString('hex'), `matches native scrypt N=${check.options.N} r=${check.options.r} p=${check.options.p}`);
    }

    console.log('  ✓ pure_scrypt');
}

// ── 12. pure_secp256k1 ──────────────────────────────────────────────────────

async function testPureSecp256k1() {
    const secp = require('../modules/crypto/pure_secp256k1');

    // secp256k1 constants
    assert.ok(secp.secp256k1.n > 0n);
    assert.ok(secp.secp256k1.p > 0n);
    assert.ok(secp.SECP256K1_BASE_POINT);
    assert.strictEqual(secp.SECP256K1_BASE_POINT.x, secp.secp256k1.Gx);

    // bigIntFromBuffer / bufferFromBigInt round-trip
    const orig = fromHex('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
    const bn = secp.bigIntFromBuffer(orig);
    const back = secp.bufferFromBigInt(bn, 32);
    assert.deepStrictEqual([...back], [...orig]);

    // bufferFromBigInt with padding
    const small = secp.bufferFromBigInt(1n, 32);
    assert.strictEqual(small.length, 32);
    assert.strictEqual(small[31], 1);
    assert.strictEqual(small[0], 0);

    // mod
    assert.strictEqual(secp.mod(7n, 5n), 2n);
    assert.strictEqual(secp.mod(-3n, 5n), 2n);

    // modPow
    assert.strictEqual(secp.modPow(2n, 10n, 1000n), 24n);
    assert.strictEqual(secp.modPow(3n, 0n, 100n), 1n);

    // modInverse
    const inv = secp.modInverse(3n, 7n);
    assert.strictEqual((3n * inv) % 7n, 1n);

    // privateKeyToPublicKey
    const priv = fromHex('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140');
    const pubComp = secp.privateKeyToPublicKey(priv, true);
    assert.strictEqual(pubComp.length, 33);
    assert.ok(pubComp[0] === 0x02 || pubComp[0] === 0x03);

    const pubUncomp = secp.privateKeyToPublicKey(priv, false);
    assert.strictEqual(pubUncomp.length, 65);
    assert.strictEqual(pubUncomp[0], 0x04);

    // pointFromPublicKey
    const pt = secp.pointFromPublicKey(pubComp);
    assert.ok(pt.x > 0n);
    assert.ok(pt.y > 0n);

    // publicKeyFromPoint round-trip
    const recompressed = secp.publicKeyFromPoint(pt);
    assert.deepStrictEqual([...recompressed], [...pubComp]);

    // ecPointMul — multiply generator by 1, should return generator
    const gMul1 = secp.ecPointMul(secp.SECP256K1_BASE_POINT, 1n);
    assert.ok(gMul1);
    assert.strictEqual(gMul1.x, secp.secp256k1.Gx);

    // ecPointMul by 0 returns null
    assert.strictEqual(secp.ecPointMul(secp.SECP256K1_BASE_POINT, 0n), null);

    // ecPointDouble
    const doubled = secp.ecPointDouble(secp.SECP256K1_BASE_POINT);
    assert.ok(doubled);
    assert.notStrictEqual(doubled.x, secp.SECP256K1_BASE_POINT.x);

    // ecPointAdd — P + (-P) = null (point at infinity)
    const negG = { x: secp.SECP256K1_BASE_POINT.x, y: secp.secp256k1.p - secp.SECP256K1_BASE_POINT.y };
    const sum = secp.ecPointAdd(secp.SECP256K1_BASE_POINT, negG);
    assert.strictEqual(sum, null);

    // ecPointAdd — null + P = P
    const addNull = secp.ecPointAdd(null, secp.SECP256K1_BASE_POINT);
    assert.strictEqual(addNull, secp.SECP256K1_BASE_POINT);

    console.log('  ✓ pure_secp256k1');
}

// ── 13. ProcessDiscovery ─────────────────────────────────────────────────────

async function testProcessDiscovery() {
    const pd = require('../modules/process_discovery');

    // NullProcessDiscovery
    const { NullProcessDiscovery, getProcessDiscovery, setProcessDiscovery, resetProcessDiscovery } = pd;

    setProcessDiscovery(new NullProcessDiscovery());
    const nullPd = getProcessDiscovery();

    assert.strictEqual(nullPd.isAlive(999), false);
    assert.deepStrictEqual(nullPd.readArgs(999), []);
    assert.strictEqual(nullPd.readCmdline(999), '');
    assert.strictEqual(nullPd.readCwd(999), '');
    assert.strictEqual(nullPd.readRSSBytes(999), -1);
    assert.strictEqual(nullPd.readStat(999), null);
    assert.strictEqual(nullPd.readMemMB(999), '-');
    assert.strictEqual(nullPd.readCpuTime(999), '-');
    assert.strictEqual(await nullPd.readCpuPercent(999), '-');
    assert.strictEqual(nullPd.readUptime(999), '-');
    assert.strictEqual(nullPd.readSystemUptimeSec(), 0);
    assert.strictEqual(nullPd.readSocketInode('/tmp/test.sock'), 0);
    assert.strictEqual(nullPd.findSocketOwnerPid('/tmp/test.sock'), 0);
    assert.deepStrictEqual(nullPd.listAllPids(), []);

    // setProcessDiscovery + resetProcessDiscovery
    resetProcessDiscovery();
    const defaultPd = getProcessDiscovery();
    assert.ok(defaultPd, 'getProcessDiscovery returns something after reset');

    // On Linux it should be LinuxProcessDiscovery, otherwise NullProcessDiscovery
    const platform = require('os').platform();
    const { LinuxProcessDiscovery } = pd;
    if (platform === 'linux') {
        assert.ok(defaultPd instanceof LinuxProcessDiscovery, 'LinuxProcessDiscovery on linux');
    }

    console.log('  ✓ ProcessDiscovery');
}

// ── 14. KeyStore singleton ──────────────────────────────────────────────────

async function testKeyStore() {
    const ks = require('../modules/key_store');

    assert.strictEqual(typeof ks.getKeyStore, 'function');
    assert.strictEqual(typeof ks.setKeyStore, 'function');
    assert.strictEqual(typeof ks.resetKeyStore, 'function');

    // Default instance should be DaemonKeyStore
    const store = ks.getKeyStore();
    assert.ok(store, 'getKeyStore returns something');

    // Interface contract (slim — only non-trivial methods remain)
    assert.strictEqual(typeof store.resolveSigningKey, 'function');
    assert.strictEqual(typeof store.isDaemonSigningKey, 'function');
    assert.strictEqual(typeof store.executeOperations, 'function');

    // setKeyStore / resetKeyStore
    let customCalled = false;
    ks.setKeyStore({ isDaemonSigningKey: () => { customCalled = true; return true; } } as any);
    const custom = ks.getKeyStore();
    custom.isDaemonSigningKey({});
    assert.ok(customCalled);

    ks.resetKeyStore();
    assert.ok(ks.getKeyStore(), 'getKeyStore still works after reset');

    console.log('  ✓ KeyStore');
}

// ── 15. ECC — comprehensive ─────────────────────────────────────────────────

async function testEccComprehensive() {
    const ecc = require('../modules/bitshares-native/crypto/ecc_selector').default();

    // Verify all exports
    const expectedExports = [
        'sha256', 'sha512', 'ripemd160', 'hash160', 'hash256',
        'randomBytes', 'generatePrivateKey', 'isValidPrivateKey',
        'privateKeyToPublicKey', 'sign', 'verify', 'recoverPublicKey',
        'wifEncode', 'wifDecode', 'normalizeBrainKey', 'brainKeyToPrivateKey',
        'publicKeyToString', 'addressFromPublicKey', 'publicKeyFromBuffer',
        'base58Encode', 'base58Decode', 'base58CheckEncode', 'base58CheckDecode',
        'buildSignatureDer', 'buildPublicKeyDer', 'secp256k1',
    ];
    for (const exp of expectedExports) {
        assert.ok(exp in ecc, `ecc has ${exp}`);
    }

    // secp256k1 constants
    assert.ok(ecc.secp256k1.n > 0n);
    assert.ok(ecc.secp256k1.p > 0n);

    // generate private key (already native from ecc)
    let privKey = await ecc.generatePrivateKey();
    privKey = toNative(privKey);
    assert.strictEqual(privKey.length, 32);
    assert.ok(ecc.isValidPrivateKey(privKey));

    // privateKeyToPublicKey
    const pubKey = toNative(await ecc.privateKeyToPublicKey(privKey, true));
    assert.strictEqual(pubKey.length, 33);
    assert.ok(pubKey[0] === 0x02 || pubKey[0] === 0x03);

    const pubKeyUncomp = toNative(await ecc.privateKeyToPublicKey(privKey, false));
    assert.strictEqual(pubKeyUncomp.length, 65);
    assert.strictEqual(pubKeyUncomp[0], 0x04);

    // sign / verify round-trip
    const digest = toNative(await ecc.sha256(new TextEncoder().encode('message to sign')));
    const sig = toNative(await ecc.sign(digest, privKey));
    assert.strictEqual(sig.length, 65);
    assert.ok(sig[0] >= 27 && sig[0] <= 34);

    const verified = await ecc.verify(digest, sig, pubKey);
    assert.strictEqual(verified, true);

    // verify wrong key fails
    const wrongKey = toNative(await ecc.generatePrivateKey());
    const wrongPub = toNative(await ecc.privateKeyToPublicKey(wrongKey, true));
    const verifiedWrong = await ecc.verify(digest, sig, wrongPub);
    assert.strictEqual(verifiedWrong, false);

    // verify wrong digest fails
    const wrongDigest = toNative(await ecc.sha256(new TextEncoder().encode('wrong message')));
    const verifiedWrongDigest = await ecc.verify(wrongDigest, sig, pubKey);
    assert.strictEqual(verifiedWrongDigest, false);

    // recoverPublicKey
    const recoveryId = sig[0] - 27 - 4;
    const r = toNative(sig.slice(1, 33));
    const s = toNative(sig.slice(33, 65));
    const recovered = toNative(ecc.recoverPublicKey(digest, r, s, recoveryId));
    assert.deepStrictEqual([...recovered], [...pubKey]);

    // WIF encode / decode round-trip
    const wif = await ecc.wifEncode(privKey, true);
    assert.strictEqual(typeof wif, 'string');
    assert.ok(wif.length > 50, 'WIF key is reasonable length');

    const decoded = await ecc.wifDecode(wif);
    assert.deepStrictEqual([...decoded.privateKey], [...privKey]);
    assert.strictEqual(decoded.compressed, true);

    // WIF uncompressed
    const wifUncomp = await ecc.wifEncode(privKey, false);
    const decodedUncomp = await ecc.wifDecode(wifUncomp);
    assert.deepStrictEqual([...decodedUncomp.privateKey], [...privKey]);
    assert.strictEqual(decodedUncomp.compressed, false);

    // WIF decode error — invalid base58 string
    try {
        await ecc.wifDecode('invalid');
        assert.fail('should have thrown');
    } catch (e: any) {
        assert.ok(getErrorMessage(e).includes('Invalid base58'), 'base58 error: ' + getErrorMessage(e));
    }

    // base58 encode / decode round-trip
    const payload = toNative(new Uint8Array([0x00, 0x01, 0x02, 0x03]));
    const encoded58 = ecc.base58Encode(payload);
    assert.strictEqual(typeof encoded58, 'string');

    const decoded58 = ecc.base58Decode(encoded58);
    assert.deepStrictEqual([...decoded58], [...Array.from(payload)]);

    // base58Check encode / decode
    const b58checkEncoded = await ecc.base58CheckEncode(payload);
    const b58checkDecoded = await ecc.base58CheckDecode(b58checkEncoded);
    assert.deepStrictEqual([...b58checkDecoded], [...Array.from(payload)]);

    // base58CheckDecode invalid checksum
    try {
        await ecc.base58CheckDecode('1111');
        assert.fail('should have thrown');
    } catch (e: any) {
        assert.ok(getErrorMessage(e).includes('checksum mismatch'), 'checksum error: ' + getErrorMessage(e));
    }

    // normalizeBrainKey / brainKeyToPrivateKey
    const normalized = toNative(await ecc.normalizeBrainKey('a', 'b', 'c'));
    assert.strictEqual(normalized.length, 32);

    const brainPriv = toNative(await ecc.brainKeyToPrivateKey('a b c', 0));
    assert.strictEqual(brainPriv.length, 32);

    // brainKeyToPrivateKey with Buffer/Uint8Array input
    const brainBytes = toNative(new TextEncoder().encode('a b c'));
    const brainPrivBytes = toNative(await ecc.brainKeyToPrivateKey(brainBytes, 0));
    assert.deepStrictEqual([...brainPriv], [...Array.from(brainPrivBytes)]);

    // publicKeyToString / addressFromPublicKey
    const pubKeyStr = await ecc.publicKeyToString(pubKey, 'BTS');
    assert.ok(pubKeyStr.startsWith('BTS'));
    assert.ok(pubKeyStr.length >= 50 && pubKeyStr.length <= 55, 'pubkey string length reasonable');

    const addr = await ecc.addressFromPublicKey(pubKey, 'BTS');
    assert.ok(addr.startsWith('BTS'));
    assert.ok(addr.length >= 30 && addr.length <= 40, 'address length reasonable');

    // publicKeyFromBuffer
    assert.deepStrictEqual([...ecc.publicKeyFromBuffer(pubKey)], [...pubKey]);

    // buildSignatureDer / buildPublicKeyDer
    const derSig = ecc.buildSignatureDer(r, s);
    assert.ok(derSig[0] === 0x30);

    const derPub = ecc.buildPublicKeyDer(pubKey);
    assert.ok(derPub[0] === 0x30);

    // hash160 / hash256
    const h160 = toNative(await ecc.hash160(toNative(new TextEncoder().encode('test'))));
    assert.strictEqual(h160.length, 20);

    const h256 = toNative(await ecc.hash256(toNative(new TextEncoder().encode('test'))));
    assert.strictEqual(h256.length, 32);

    // randomBytes
    const rb = toNative(await ecc.randomBytes(16));
    assert.strictEqual(rb.length, 16);

    // sha512
    const s512 = toNative(await ecc.sha512(toNative(new TextEncoder().encode('test'))));
    assert.strictEqual(s512.length, 64);

    // ripemd160
    const r160 = toNative(await ecc.ripemd160(toNative(new TextEncoder().encode('test'))));
    assert.strictEqual(r160.length, 20);

    console.log('  ✓ ECC comprehensive');
}

// ── 16. claw/index.ts loads cleanly ─────────────────────────────────────────

async function testClawIndexLoad() {
    const claw = require('../claw/index').default;
    assert.ok(claw, 'claw/index loaded successfully');
    assert.ok(claw.broadcastOperationViaCredentialDaemon,
        'claw has broadcastOperationViaCredentialDaemon');
    assert.ok(claw.describeMemuBridge, 'claw has describeMemuBridge');
    console.log('  ✓ claw/index loads cleanly');
}

// ── Main ─────────────────────────────────────────────────────────────────────

(async () => {
    try {
        await testEnv();
        await testPathApiSingleton();
        await testPathApiNode();
        await testRuntimeBrowser();
        await testRuntimeNode();
        await testConfig();
        await testBrowserStorage();
        await testNodeStorage();
        await testStorageSingleton();
        await testBrowserCryptoProvider();
        await testCryptoProviderSingleton();
        await testCryptoSync();
        await testPureRipemd160();
        await testPureScrypt();
        await testPureSecp256k1();
        await testProcessDiscovery();
        await testKeyStore();
        await testEccComprehensive();
        await testClawIndexLoad();
        console.log('\n✓ All browser abstraction tests passed');
    } catch (err: any) {
        console.error(`\n✗ FAILED: ${getErrorMessage(err)}`);
        console.error(err.stack);
        process.exit(1);
    }
})();
