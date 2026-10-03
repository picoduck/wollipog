#!/usr/bin/python3
"""WPLBF-HOSTED3: complete SCRATCH candidate; no execution authority here.

Only the exact reviewed hosted inline bootstrap may supply HOSTED_CONTEXT.
Direct invocation refuses before root/child. No experiment was executed in scratch.

No fallback clone, raw-PID signal, tool acquisition, retry, or host writable bind.
The outer controller alone admits persistent slots. Namespace PID1 alone admits
work. An unsupported barrier is a NO-GO before source acquisition.
"""
import argparse
import array
import ctypes as C
import errno
import hashlib
import http.client
import json
import lzma
import os
import pathlib
import platform
import resource
import re
import base64
import select
import signal
import socket
import ssl
import stat
import struct
import sys
import threading
import time

EXPERIMENT_PLAN = json.loads(b'{\n  "artifactRetention": "technical-log-only; VM files disposable",\n  "attempts": 1,\n  "executable": false,\n  "executionAuthority": null,\n  "harnessImplementationRequiredBeforeAttempt": true,\n  "limits": {\n    "acquireSeconds": 30,\n    "closureReserveSeconds": 15,\n    "configureWithinPreparationSeconds": 30,\n    "conservativeTmpfsLogicalBytes": 35184372088832,\n    "exportSeconds": 30,\n    "extractEntries": 49152,\n    "extractMemberBytes": 67108864,\n    "extractPayloadBytes": 1610612736,\n    "extractSeconds": 30,\n    "fileBytes": 536870912,\n    "fixedInputWireBytes": 6291456,\n    "helperCompileSeconds": 30,\n    "metadataBytes": 16777216,\n    "minMemAvailableBytes": 12884901888,\n    "nativeProbeSeconds": 10,\n    "newNodePreparationSeconds": 510,\n    "overallSeconds": 720,\n    "packagingSeconds": 30,\n    "parallelMakeJobs": 4,\n    "processAsHardBytes": 17179869184,\n    "processNofileHard": 256,\n    "realUidNprocHard": 128,\n    "retainedBinaryBytes": 201326592,\n    "retainedEntries": 32,\n    "retainedLogicalBytes": 536870912,\n    "retainedMetadataBytes": 196608,\n    "seaProbeSeconds": 10,\n    "setupSeconds": 25,\n    "stdoutStderrControlBytes": 65536,\n    "terminalBytes": 8192,\n    "tmpfsAllocatedBytes": 8589934592,\n    "tmpfsInodes": 65536,\n    "wireBytes": 83886080,\n    "workCutoffSeconds": 705,\n    "workloadControlBytes": 57344\n  },\n  "noProjectWrites": true,\n  "noRetryFallback": true,\n  "runRoot": "/tmp/2316-linked-build-hosted-run-v3-s_a5b455d9d3fa",\n  "schema": "WPLBF-HOSTED3",\n  "sourceSha256": "86d40d594bbdfcf69009a62fdf43cb19ae72b6cb5822d2bdd8349c5a1b2fa628",\n  "sourceUrl": "https://nodejs.org/dist/v24.18.1/node-v24.18.1.tar.xz",\n  "target": "x86_64-unknown-linux-gnu",\n  "unresolvedBootstrapAndClock": false,\n  "unsupportedContainmentRefusesBeforeSourceAcquire": true\n}\n')
FIXED_TOOLS = json.loads(b'[\n  {\n    "bytes": 1023032,\n    "path": "/usr/bin/x86_64-linux-gnu-gcc-13",\n    "sha256": "1b99826121ae6682a634e5efe09bd3e3df58ce58e0b28f849114ab5b89139c26"\n  },\n  {\n    "bytes": 1027128,\n    "path": "/usr/bin/x86_64-linux-gnu-g++-13",\n    "sha256": "1353e9bdd29a7295c7226bf6c63abccce056d8cac31f112e5cdbecc3f28c2769"\n  },\n  {\n    "bytes": 259808,\n    "path": "/usr/bin/make",\n    "sha256": "d78b8f1d099fbcfb6f2f49ab87223b9b68fb3956642f92d6ec6de812e8afa965"\n  },\n  {\n    "bytes": 8020928,\n    "path": "/usr/bin/python3.12",\n    "sha256": "e50d468e8b0adfb05733f5b87b3cff34829c4a8c1aea50c865aa8bdfe4bb150f"\n  },\n  {\n    "bytes": 44544,\n    "path": "/usr/bin/x86_64-linux-gnu-nm",\n    "sha256": "910ad8a63896f722374fdf22951d2a436c74e3ac9677511cc56378296bdf86cc"\n  }\n]\n')
INPUTS = json.loads(b'{\n  "expectedGypPreimageSha256": "6be40699da2d2211561997eed87313780bd6cd58ffce021d4e83cfa96580450d",\n  "expectedMainPreimageSha256": "c946687691d86754f5d53560b54a70d17cfed62bf23158ac457497b8b912d740",\n  "proposedInputs": [\n    {\n      "bytes": 4496,\n      "name": "node_main.cc",\n      "sha256": "f2fbaad7819251f1f3f5a4c1b747675377152785e87717f957f19072846fff2e"\n    },\n    {\n      "bytes": 52527,\n      "name": "node.gyp",\n      "sha256": "a6ed8cc8705d1eca146f385e5866848650f35e1e1d53999efbeba509913f9168"\n    },\n    {\n      "bytes": 49,\n      "name": "minimal.cjs",\n      "sha256": "44f9550c31c43fb9d7b3b367c1ebb2b460382ebda4c54bb26ceb17b6705a29b9"\n    },\n    {\n      "bytes": 28472,\n      "name": "helper-input.c",\n      "sha256": "c4917ca16a7eb5d94b0862ce74d672c10c720c18c2bcc200fb880f17cacd4b69"\n    },\n    {\n      "bytes": 4840137,\n      "name": "postject-api.js",\n      "sha256": "88931f26b4d3e99e08dc8219a45f576986952fad4d0c78444d27048232b2881b"\n    },\n    {\n      "bytes": 13409,\n      "name": "postject-LICENSE",\n      "sha256": "6546657539feb5b454f400db317e71fa39ff5cd048fa5d78ae0ada2df72f1ea7"\n    }\n  ],\n  "sourceArchive": "https://nodejs.org/dist/v24.18.1/node-v24.18.1.tar.xz",\n  "sourceArchiveSha256": "86d40d594bbdfcf69009a62fdf43cb19ae72b6cb5822d2bdd8349c5a1b2fa628",\n  "unmodifiedSourceCommit": "9623d9ad85d37d2f0610ec4a82b48182cf2c6061"\n}\n')
RUN = EXPERIMENT_PLAN["runRoot"]
UID, GID = os.getuid(), os.getgid()
LIBC = C.PyDLL(None, use_errno=True)  # Keep the GIL across clone3.
LIBC.syscall.restype = C.c_long
LIBC.prctl.restype = C.c_int
LIBC.mount.argtypes = [C.c_char_p, C.c_char_p, C.c_char_p, C.c_ulong, C.c_char_p]
LIBC.mount.restype = C.c_int
ENV = {'PATH': '/usr/bin:/bin', 'HOME': '/work/home', 'TMPDIR': '/work/tmp',
       'LC_ALL': 'C', 'CC': '/usr/bin/gcc', 'CXX': '/usr/bin/g++',
       'PYTHONDONTWRITEBYTECODE': '1'}
O_DIRECTORY = os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


class Refusal(Exception):
    pass


def need(ok, why):
    if not ok:
        raise Refusal(why)


class Clock:
    """BOOT origin zero; supplied bootstrap start never restarts the 720s clock."""
    def __init__(self, start, boot, mono, offset):
        need(offset == 0, 'nonzero/unproved inherited time offset')
        need(0 <= start <= boot < 705 and abs(boot - mono) < 0.01,
             'old boot, suspension or clock origin refusal')
        self.start, self.offset = start, offset
        self.setup = min(705.0, start + 25.0)
        self.initial_gap = boot - mono

    def check(self, boot, mono, end):
        need(abs((boot - mono) - self.initial_gap) < 0.01,
             'suspension/clock disagreement; terminal uncertainty')
        need(boot < min(end, 720), 'absolute deadline refusal')
        return boot

    def phase(self, now, seconds, shared=None):
        return min(705.0, now + seconds, shared if shared is not None else 705.0)

def identity(s):
    return (s.st_dev, s.st_ino, s.st_uid, s.st_gid, s.st_mode, s.st_nlink)

def verified_input(fd, item, pinned_identity, check):
    """Independent child read-only FD validation after every parent writer closes."""
    before = os.fstat(fd)
    need(identity(before) == tuple(pinned_identity) and stat.S_ISREG(before.st_mode)
         and before.st_nlink == 1 and before.st_size == item['bytes'],
         'input inode/owner/link/size refusal')
    h, total = hashlib.sha256(), 0
    while total < item['bytes']:
        check()
        b = os.read(fd, min(65536, item['bytes'] - total))
        need(b, 'short independent input read')
        h.update(b); total += len(b)
    need(not os.read(fd, 1) and os.fstat(fd) == before and
         h.hexdigest() == item['sha256'], 'independent input hash/change refusal')
    return {'name': item['name'], 'bytes': total, 'sha256': h.hexdigest(),
            'dev': before.st_dev, 'ino': before.st_ino}

class Output:
    """Full admitted byte stream. Overflow prevents GO; nothing is tail-selected."""
    def __init__(self, write, external):
        self.write, self.external = write, external
        self.count, self.raw_count, self.overflow = 0, 0, False
        self.hash = hashlib.sha256()
        self.pending, self.delivered = None, 0

    def admit(self, b, end):
        need(isinstance(b, bytes) and self.pending is None, 'output bytes/pending frame refusal')
        frame = b'{"kind":"data","base64":"' + base64.b64encode(b) + b'"}\n'
        if self.count + len(frame) > 57344 or self.raw_count + len(b) > 57344:
            self.overflow = True
            raise Refusal('workload/control exceeds 56KiB; no selective success')
        self.write(frame)
        # Charge admitted bytes ONCE, even if external delivery is interrupted.
        self.hash.update(b); self.count += len(frame); self.raw_count += len(b)
        self.pending = [frame, 0]
        self.resume(end)

    def resume(self, end):
        if self.pending is None:
            return
        def progress(offset):
            need(self.pending[1] < offset <= len(self.pending[0]), 'external progress refused')
            self.delivered += offset - self.pending[1]
            self.pending[1] = offset
        self.external(self.pending[0], end, self.pending[1], progress)
        need(self.pending[1] == len(self.pending[0]), 'external delivery incomplete')
        self.pending = None

    def terminal(self, value, end):
        need(self.pending is None, 'terminal before pending frame closure')
        b = json.dumps(value, sort_keys=True, separators=(',', ':'),
                       ensure_ascii=True, allow_nan=False).encode() + b'\n'
        need(len(b) <= 8192, 'complete terminal fields exceed 8KiB')
        self.write(b)
        self.external(b, end, 0, lambda offset: None)
        return b

def dns_address(data, txid, host):
    """Strict one-response A subset; bounded pointer parser, no DNS fallback."""
    need(12 <= len(data) <= 4096, 'DNS wire cap')
    ident, flags, qd, an, ns, ar = struct.unpack('!6H', data[:12])
    need(ident == txid and flags & 0x8000 and not flags & 0x0200
         and flags & 0x780f == 0 and qd == 1 and 0 < an <= 32
         and ns + ar <= 64, 'DNS response shape/truncation/status refusal')
    def name(pos):
        labels, visited, finish = [], set(), None
        for _ in range(128):
            need(pos < len(data) and pos not in visited, 'DNS name cycle/bounds')
            visited.add(pos)
            size = data[pos]; pos += 1
            if size == 0:
                return b'.'.join(labels).lower().decode('ascii'), finish or pos
            if size & 0xc0 == 0xc0:
                need(pos < len(data), 'DNS pointer bounds')
                target = ((size & 63) << 8) | data[pos]
                if finish is None:
                    finish = pos + 1
                pos = target
                continue
            need(0 < size <= 63 and pos + size <= len(data)
                 and sum(map(len, labels)) + size + len(labels) <= 253,
                 'DNS label bounds')
            labels.append(data[pos:pos + size]); pos += size
        raise Refusal('DNS name steps exhausted')
    question, p = name(12)
    need(question == host and data[p:p + 4] == b'\x00\x01\x00\x01',
         'DNS question mismatch')
    p += 4
    records = []
    for _ in range(an + ns + ar):
        owner, p = name(p)
        need(p + 10 <= len(data), 'DNS record bounds')
        kind, cls, ttl, length = struct.unpack('!HHIH', data[p:p + 10]); p += 10
        need(p + length <= len(data), 'DNS data bounds')
        if len(records) < an:
            target = None
            if kind == 5 and cls == 1:
                target, finish = name(p)
                need(finish == p + length, 'DNS CNAME length mismatch')
            elif kind == 1 and cls == 1:
                need(length == 4, 'DNS A length mismatch')
                target = socket.inet_ntop(socket.AF_INET, data[p:p + length])
            records.append((owner, kind, target))
        p += length
    need(p == len(data), 'DNS trailing bytes refusal')
    owner, seen = host, set()
    for _ in range(32):
        need(owner not in seen, 'DNS alias cycle')
        seen.add(owner)
        addresses = [target for n, k, target in records if n == owner and k == 1]
        aliases = [target for n, k, target in records if n == owner and k == 5]
        need(not (addresses and aliases) and len(aliases) <= 1, 'DNS ambiguous alias')
        if addresses:
            # Exactly the first wire A address; no alternate-address attempt.
            return addresses[0]
        need(len(aliases) == 1, 'DNS unsupported/missing address')
        owner = aliases[0]
    raise Refusal('DNS alias count exhausted')

def wait_socket(sock, writing, end, check):
    while True:
        now = check(end)
        ready = select.select([] if writing else [sock], [sock] if writing else [],
                              [], min(0.025, end - now))
        if ready[1 if writing else 0]:
            return

def resolve_once(host, resolver, end, check):
    need(host == 'raw.githubusercontent.com', 'unapproved fixed-input hostname')
    socket.inet_pton(socket.AF_INET, resolver)  # Numeric address only; no libc NSS.
    txid = int.from_bytes(os.urandom(2), 'big')
    q = b''.join(bytes([len(x)]) + x.encode('ascii') for x in host.split('.')) + b'\0'
    packet = struct.pack('!6H', txid, 0x0100, 1, 0, 0, 0) + q + b'\0\1\0\1'
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.setblocking(False); s.connect((resolver, 53))
        wait_socket(s, True, end, check)
        need(s.send(packet) == len(packet), 'short DNS datagram')
        wait_socket(s, False, end, check)
        data = s.recv(4097)
    check(end)
    return dns_address(data, txid, host)

def headers(data, expected):
    need(len(data) <= 16384 and data.endswith(b'\r\n\r\n'), 'HTTP header cap/shape')
    lines = data[:-4].split(b'\r\n')
    need(0 < len(lines) <= 128 and lines[0] == b'HTTP/1.1 200 OK',
         'HTTP status refusal; no redirect/retry')
    fields = {}
    for line in lines[1:]:
        need(b':' in line and len(line) <= 8192, 'HTTP header line refusal')
        name, value = line.split(b':', 1)
        need(re.fullmatch(rb'[A-Za-z0-9!#$%&\x27*+.^_`|~-]+', name), 'HTTP field name')
        name = name.lower()
        need(name not in fields, 'duplicate HTTP header refusal')
        value = value.strip(b' \t')
        need(all(32 <= x <= 126 for x in value), 'HTTP field value refusal')
        fields[name] = value
    need(fields.get(b'content-length') == str(expected).encode()
         and b'transfer-encoding' not in fields
         and fields.get(b'content-encoding', b'identity') == b'identity',
         'HTTP size/encoding refusal')

def fixed_stream(ip, context, head, item, end, check, write, account):
    """One TCP/TLS/GET; no NSS, redirect, proxy, auth, child or thread."""
    need(re.fullmatch('[0-9a-f]{40}', head), 'invalid exact head')
    need(re.fullmatch('[A-Za-z0-9_.-]{1,64}', item['name']), 'invalid fixed input name')
    path = '/picoduck/wollipog/' + head + '/apps/runner/scripts/probe-linked-base/' + item['name']
    request = ('GET ' + path + ' HTTP/1.1\r\nHost: raw.githubusercontent.com\r\n'
               'Accept-Encoding: identity\r\nConnection: close\r\n\r\n').encode()
    raw = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    raw.setblocking(False)
    s = raw
    try:
        code = raw.connect_ex((ip, 443))
        need(code in (0, 115), 'TCP admission refused; no alternate address')
        if code:
            wait_socket(raw, True, end, check)
            need(raw.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR) == 0, 'TCP connect failed')
        s = context.wrap_socket(raw, server_hostname='raw.githubusercontent.com',
                                do_handshake_on_connect=False)
        def operation(fn):
            while True:
                check(end)
                try:
                    return fn()
                except ssl.SSLWantReadError:
                    wait_socket(s, False, end, check)
                except ssl.SSLWantWriteError:
                    wait_socket(s, True, end, check)
        operation(s.do_handshake)
        pending = request
        while pending:
            n = operation(lambda: s.send(pending))
            need(n > 0, 'short TLS request send'); pending = pending[n:]
        header = bytearray()
        while not header.endswith(b'\r\n\r\n'):
            need(len(header) < 16384, 'HTTP header exhausted BEFORE allocation')
            b = operation(lambda: s.recv(1))
            need(b, 'short HTTP header')
            account(len(b)); header.extend(b)
        headers(bytes(header), item['bytes'])
        total, h = 0, hashlib.sha256()
        while total < item['bytes']:
            b = operation(lambda: s.recv(min(65536, item['bytes'] - total)))
            need(b, 'short fixed-input body')
            account(len(b))
            check(end)
            write(b); h.update(b); total += len(b)
        # Require EOF, not silently ignore excessive payload after declared length.
        extra = operation(lambda: s.recv(1))
        need(not extra, 'excess fixed-input body; refuses BEFORE write')
        need(h.hexdigest() == item['sha256'], 'fixed-input digest mismatch')
        check(end)
        return {'name': item['name'], 'bytes': total, 'sha256': h.hexdigest()}
    finally:
        s.close()
        if s is not raw:
            raw.close()

def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(65536), b''):
            h.update(b)
    return h.hexdigest()


def checked_json(path, sha):
    need(digest(path) == sha, 'pinned manifest changed: ' + path.name)
    return json.loads(path.read_bytes())


def write_all(fd, b):
    while b:
        n = os.write(fd, b)
        need(n > 0, 'short write')
        b = b[n:]


def checked_call(name, *args):
    r = getattr(LIBC, name)(*args)
    if r == -1:
        e = C.get_errno()
        raise OSError(e, name + ': ' + os.strerror(e))
    return r


def syscall(n, *args):
    return LIBC.syscall(C.c_long(n), *args)


def mount(src, dst, kind=None, flags=0, data=None):
    def enc(s):
        return None if s is None else os.fsencode(s)
    checked_call('mount', enc(src), enc(dst), enc(kind), flags, enc(data))


def emit(sock, t0, kind, **fields):
    b = json.dumps({'kind': kind, 'elapsed': round(now()-t0, 6),
                    **fields}, separators=(',', ':')).encode()
    need(len(b) <= 4096, 'control record exceeds 4096 bytes')
    need(sock.send(b) == len(b), 'short control send')


def boundary(sock, t0, kind, end, **fields):
    emit(sock, t0, kind, deadlineElapsed=end-t0, **fields)
    sock.settimeout(max(0.001, end-now()))
    need(sock.recv(32) == b'BOUNDARY', 'phase boundary acknowledgment missing')


def deadline(t0, seconds):
    return min(705.0, now() + seconds)


def until(end):
    need(now() < end, 'phase deadline reached')


def safe_open(rootfd, relative):
    parts = relative.split('/')
    need(parts and all(p not in ('', '.', '..') for p in parts), 'unsafe relative path')
    parent = os.dup(rootfd)
    try:
        for p in parts[:-1]:
            nxt = os.open(p, os.O_RDONLY | O_DIRECTORY, dir_fd=parent)
            os.close(parent)
            parent = nxt
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
                     dir_fd=parent)
        s = os.fstat(fd)
        need(stat.S_ISREG(s.st_mode) and s.st_nlink == 1, 'unproven export file identity')
        return fd, s
    finally:
        os.close(parent)


class CloneArgs(C.Structure):
    _fields_ = [(x, C.c_uint64) for x in ('flags', 'pidfd', 'child_tid', 'parent_tid',
                  'exit_signal', 'stack', 'stack_size', 'tls', 'set_tid',
                  'set_tid_size', 'cgroup')]


def fork_hooks():
    need(sys.implementation.name == 'cpython' and sys.version_info[:2] == (3, 12),
         'unsupported interpreter for fork hooks')
    need(threading.current_thread() is threading.main_thread() and
         len(os.listdir('/proc/self/task')) == 1, 'not single main thread')
    api = C.pythonapi
    for name in ('PyInterpreterState_Get', 'PyInterpreterState_Main'):
        getattr(api, name).restype = C.c_void_p
    need(api.PyInterpreterState_Get() == api.PyInterpreterState_Main(), 'not main interpreter')
    need(api.PyGILState_Check() == 1, 'GIL is not held')
    hooks = [getattr(api, n) for n in ('PyOS_BeforeFork', 'PyOS_AfterFork_Parent',
                                     'PyOS_AfterFork_Child')]
    for h in hooks:
        h.restype = None
        h.argtypes = []
    return hooks


def clone_init(hooks):
    fd = C.c_int(-1)
    a = CloneArgs(flags=0x1000 | 0x10000000 | 0x20000 | 0x20000000 | 0x08000000,
                  pidfd=C.addressof(fd), exit_signal=signal.SIGCHLD)
    hooks[0]()
    pid = syscall(435, C.byref(a), C.c_size_t(C.sizeof(a)))
    saved_errno = C.get_errno()
    if pid == 0:
        hooks[2]()
    else:
        hooks[1]()  # Also required on failed clone.
    if pid == -1:
        raise OSError(saved_errno, 'clone3 atomic namespace admission: ' + os.strerror(saved_errno))
    need(pid == 0 or fd.value >= 0, 'clone3 omitted atomic pidfd')
    return pid, fd.value


def set_limits(file_cap=536870912):
    for which, value in ((resource.RLIMIT_FSIZE, file_cap),
                         (resource.RLIMIT_AS, 17179869184),
                         (resource.RLIMIT_NOFILE, 256), (resource.RLIMIT_CORE, 0),
                         (resource.RLIMIT_NPROC, 128)):
        soft, hard = resource.getrlimit(which)
        need(hard == resource.RLIM_INFINITY or hard >= value, 'existing hard resource limit insufficient')
        resource.setrlimit(which, (value, value))


def drop_caps():
    checked_call('prctl', 47, 4, 0, 0, 0)  # AMBIENT_CLEAR_ALL
    for cap in range(64):
        r = LIBC.prctl(23, cap, 0, 0, 0)  # CAPBSET_READ
        if r == -1 and C.get_errno() == errno.EINVAL:
            break
        need(r >= 0, 'cannot inspect capability bounding set')
        checked_call('prctl', 24, cap, 0, 0, 0)
    class Header(C.Structure):
        _fields_ = [('version', C.c_uint32), ('pid', C.c_int)]
    class Data(C.Structure):
        _fields_ = [('effective', C.c_uint32), ('permitted', C.c_uint32),
                    ('inheritable', C.c_uint32)]
    h, d = Header(0x20080522, 0), (Data * 2)()
    need(syscall(126, C.byref(h), C.byref(d)) == 0, 'capset failed')
    checked_call('prctl', 38, 1, 0, 0, 0)  # NO_NEW_PRIVS


def install_filter(offline=False):
    # Classic BPF, fixed x86_64. Both compat ABI and x32 are killed.
    class Insn(C.Structure):
        _fields_ = [('code', C.c_ushort), ('jt', C.c_ubyte),
                    ('jf', C.c_ubyte), ('k', C.c_uint32)]
    class Prog(C.Structure):
        _fields_ = [('length', C.c_ushort), ('filter', C.POINTER(Insn))]
    b = [(0x20, 0, 0, 4), (0x15, 1, 0, 0xc000003e), (0x06, 0, 0, 0x80000000),
         (0x20, 0, 0, 0), (0x35, 0, 1, 0x40000000), (0x06, 0, 0, 0x80000000)]
    denied = [165, 166, 272, 308, 319, 425, 426, 427, 428, 429, 430, 431, 432, 433, 442,
              29, 30, 31, 64, 65, 66, 67, 68, 69, 70, 71, 86, 265, 133, 259]
    if offline:
        denied += [41, 42, 53]  # socket/connect/socketpair
    for n in denied:
        b += [(0x15, 0, 1, n), (0x06, 0, 0, 0x50000 | errno.EPERM)]
    b += [(0x15, 0, 1, 435), (0x06, 0, 0, 0x50000 | errno.ENOSYS)]
    # clone arg0 low bits: reject every new namespace flag, including NEWTIME.
    b += [(0x15, 0, 3, 56), (0x20, 0, 0, 16),
          (0x45, 0, 1, 0x7e020080), (0x06, 0, 0, 0x50000 | errno.EPERM),
          (0x06, 0, 0, 0x7fff0000)]
    insns = (Insn * len(b))(*(Insn(*i) for i in b))
    p = Prog(len(b), insns)
    need(syscall(317, C.c_uint(1), C.c_uint(0), C.byref(p)) == 0, 'seccomp installation failed')


def cap_status():
    fields = {}
    with open('/proc/self/status') as f:
        for line in f:
            if ':' in line:
                k, v = line.split(':', 1)
                if k in ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb', 'NoNewPrivs', 'Seccomp'):
                    fields[k] = v.strip()
    need(all(int(fields[k], 16) == 0 for k in ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb')),
         'capabilities remain')
    need(fields.get('NoNewPrivs') == '1' and fields.get('Seccomp') == '2', 'barrier status absent')
    return fields


def ro_bind(src, dst):
    if os.path.isdir(src):
        os.makedirs(dst, mode=0o700, exist_ok=True)
    else:
        os.makedirs(os.path.dirname(dst), mode=0o700, exist_ok=True)
        fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(fd)
    mount(src, dst, flags=4096)  # MS_BIND, not recursive.
    mount(None, dst, flags=4096 | 32 | 1 | 2 | 4)  # remount bind RO/nosuid/nodev
    need(os.statvfs(dst).f_flag & os.ST_RDONLY, 'readonly bind flag not established')


def setup_namespace(root, sock, parentfd, spoolfd, t0, fixed, proposed, slots, identities):
    end = min(BOOTSTRAP_START + 25, 705.0)
    need(os.getpid() == 1, 'child is not namespace PID1')
    checked_call('prctl', 1, signal.SIGKILL, 0, 0, 0)
    need(not select.select([parentfd], [], [], 0)[0], 'controller died before PDEATHSIG')
    # Parent admits only after opening private mapping files while child is unreaped.
    sock.settimeout(max(0.001, end-now()))
    need(sock.recv(32) == b'MAPPED', 'mapping handshake failed')
    need(os.getuid() == UID and os.getgid() == GID and UID != 0 and GID != 0,
         'same nonzero identity mapping not established')
    for name, identity in (('uid_map', UID), ('gid_map', GID)):
        need(open('/proc/self/'+name).read().split() == [str(identity), str(identity), '1'],
             'unexpected mapping')
    mount(None, '/', flags=16384 | (1 << 18))  # recursively PRIVATE
    mount('tmpfs', root, 'tmpfs', 2 | 4, 'size=8589934592,nr_inodes=65536,huge=never,mode=0700')
    v = os.statvfs(root)
    need(v.f_blocks*v.f_frsize == 8589934592 and v.f_files == 65536,
         'kernel tmpfs quota/inode values differ')
    # Verify filesystem type without guessing from mount name.
    buf = (C.c_long * 32)()
    checked_call('statfs', C.c_char_p(os.fsencode(root)), C.byref(buf))
    need(buf[0] == 0x01021994, 'not tmpfs')
    rootfd = os.open(root, os.O_RDONLY | O_DIRECTORY)
    sock.sendmsg([b'QUOTA_ROOT'], [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                                  array.array('i', [rootfd]))])
    os.close(rootfd)
    for d in ('work', 'work/tmp', 'work/home', 'inputs', 'proc', 'etc', 'dev'):
        os.mkdir(root+'/'+d, 0o700)
    for host in ('/usr', '/bin', '/lib', '/lib64'):
        ro_bind(host, root+host)
    for host in ('/etc/ssl/certs', '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf'):
        ro_bind(host, root+host)
    for entry in proposed:
        name = entry['name']
        fd = slots[name]
        need(identity(os.fstat(fd)) == tuple(identities[name]) and os.fstat(fd).st_size == 0, 'empty slot changed before bind')
        ro_bind('/proc/self/fd/'+str(fd), root+'/inputs/'+name)
        need(identity(os.stat(root+'/inputs/'+name)) == tuple(identities[name]), 'readonly bind inode mismatch')
    mount('proc', root+'/proc', 'proc', 1 | 2 | 4 | 8)
    os.chroot(root)
    os.chdir('/work')
    # No outside directory descriptors survive chroot. Parent PIDFD/socket/spool are
    # narrowly scoped non-directory descriptors. Compiler exec closes all of them.
    for fd in range(3, 256):
        try:
            s = os.fstat(fd)
        except OSError:
            continue
        need(not stat.S_ISDIR(s.st_mode), 'outside directory descriptor survived')
        if fd not in (sock.fileno(), parentfd, spoolfd):
            os.close(fd)
    need(all(int(x) < 256 for x in os.listdir('/proc/self/fd')), 'unclosed high descriptor')
    os.environ.clear()
    os.environ.update(ENV)
    set_limits()
    drop_caps()
    install_filter()
    status = cap_status()
    until(end)
    guard_canaries(end)
    until(end)
    acquire_end = deadline(t0, 30)
    emit(sock, t0, 'guards-established', deadlineElapsed=acquire_end, statvfsBlocks=v.f_blocks, statvfsFrsize=v.f_frsize,
         statvfsInodes=v.f_files, capabilities=status, noOutsideDirectoryFDs=True, inputWritersClosed=True)
    sock.settimeout(max(0.001, acquire_end-now()))
    need(sock.recv(32) == b'INPUTS-CLOSED', 'input writer closure handshake absent')
    until(acquire_end)
    records = []
    for item in proposed:
        fd = os.open('/inputs/'+item['name'], os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            records.append(verified_input(fd, item, identities[item['name']], lambda: until(acquire_end)))
        finally:
            os.close(fd)
    emit(sock, t0, 'inputs-independently-admitted', records=records, deadlineElapsed=acquire_end)
    sock.settimeout(max(0.001, acquire_end-now()))
    need(sock.recv(32) == b'BOUNDARY', 'independent input admission acknowledgment absent')
    return acquire_end


def reap_tree(end, expected=None):
    statuses = []
    while True:
        until(end)
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            break
        if pid:
            statuses.append((pid, status))
        else:
            time.sleep(0.005)
    if expected is not None:
        need(any(pid == expected and status == 0 for pid, status in statuses),
             'phase leader failed or terminal receipt missing')
    return statuses


def guard_canaries(end):
    # A refused guard must have the specified errno, not merely nonzero output.
    for n, args, allowed_errno in ((319, (C.c_char_p(b'guard'), 0), errno.EPERM),
                                   (272, (0x10000000,), errno.EPERM),
                                   (435, (C.c_void_p(0), 0), errno.ENOSYS),
                                   (29, (0, 4096, 0o600), errno.EPERM)):
        need(syscall(n, *args) == -1 and C.get_errno() == allowed_errno,
             'anonymous/namespace guard not proven')
    need(LIBC.mount(None, b'/work', None, 32, None) == -1 and C.get_errno() == errno.EPERM,
         'remount guard not proven')
    fd = os.open('/work/canary.json', os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_CLOEXEC, 0o600)
    namespace = os.stat('/proc/self/ns/pid').st_ino
    leader = os.fork()
    if leader == 0:
        try:
            descendant = os.fork()
            if descendant == 0:
                os.setsid()
                os.close(0); os.close(1); os.close(2)
                same = os.stat('/proc/self/ns/pid').st_ino == namespace
                cap_status()
                inherited = syscall(319, C.c_char_p(b'child-guard'), 0) == -1 and C.get_errno() == errno.EPERM
                write_all(fd, json.dumps({'sameNamespace': same, 'setsid': True,
                                          'closedStdio': True, 'inheritedBarriers': inherited}).encode())
                time.sleep(0.025)
                os._exit(0 if same else 91)
            os._exit(0)
        except BaseException:
            os._exit(92)
    # Direct child is still unreaped; its PID cannot be recycled before pidfd_open.
    pfd = os.pidfd_open(leader)
    statuses = reap_tree(end, leader)
    need(len(statuses) == 2 and all(status == 0 for _, status in statuses),
         'owned canary descendant terminal proof missing')
    need(select.select([pfd], [], [], 0)[0], 'canary pidfd not terminal')
    os.close(pfd)
    os.lseek(fd, 0, os.SEEK_SET)
    need(json.loads(os.read(fd, 1024)) == {'sameNamespace': True, 'setsid': True,
                                        'closedStdio': True, 'inheritedBarriers': True}, 'canary namespace evidence missing')
    os.close(fd)
    until(end)


def acquire(sock, spoolfd, t0, plan, end):
    until(end)
    conn = http.client.HTTPSConnection('nodejs.org', timeout=max(0.001, end-now()),
                                      context=ssl.create_default_context())
    fd = os.open('/work/source.tar.xz', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    total, h = 0, hashlib.sha256()
    try:
        conn.request('GET', '/dist/v24.18.1/node-v24.18.1.tar.xz',
                     headers={'Accept-Encoding': 'identity', 'Connection': 'close'})
        r = conn.getresponse()
        need(r.status == 200 and r.getheader('Content-Encoding') in (None, 'identity'),
             'source response/encoding refusal; redirects not followed')
        length = r.getheader('Content-Length')
        need(length is not None and length.isdecimal() and 0 < int(length) <= 83886080,
             'source declared wire length not admitted')
        while True:
            until(end)
            if conn.sock is not None:
                conn.sock.settimeout(max(0.001, end-now()))
            b = r.read(65536)
            if not b:
                break
            need(total + len(b) <= 83886080 and total + len(b) <= int(length),
                 'source wire cap exceeded BEFORE write')
            write_all(fd, b); write_all(spoolfd, b)
            total += len(b); h.update(b)
        need(total == int(length) and h.hexdigest() == plan['sourceSha256'],
             'source size or digest mismatch')
        os.fsync(fd); os.fsync(spoolfd)
    finally:
        os.close(fd); os.close(spoolfd); conn.close()
    boundary(sock, t0, 'source-admitted', deadline(t0, 30), bytes=total, sha256=h.hexdigest())
    # Trusted interpreter is now also offline; inherited by all producers.
    install_filter(offline=True)
    need(syscall(41, 2, 1, 0) == -1 and C.get_errno() == errno.EPERM,
         'offline network barrier not established before compilation')


def extract(sock, t0, inputs):
    end = deadline(t0, 30)
    # Deliberately limited USTAR/GNU ordinary regular-file/directory parser. Every
    # link/PAX/sparse/extension shape not proved here refuses rather than follows.
    entries, payload, metadata = 0, 0, 0
    seen, created = set(), set()
    workfd = os.open('/work', os.O_RDONLY | O_DIRECTORY)
    def exact(f, n):
        until(end)
        b = f.read(n)
        need(len(b) == n, 'truncated tar stream')
        return b
    def number(b):
        need(not b or b[0] < 128, 'unsupported tar base-256 number')
        s = b.rstrip(b'\0 ').lstrip(b' ')
        need(not s or all(x in b'01234567' for x in s), 'invalid tar numeric field')
        return int(s or b'0', 8)
    def mkdir_path(parts):
        nonlocal entries
        fd = os.dup(workfd)
        try:
            prefix = []
            for part in parts:
                prefix.append(part)
                key = '/'.join(prefix)
                if key not in created:
                    need(entries + 1 <= 49152, 'extract entry admission exhausted')
                    os.mkdir(part, 0o700, dir_fd=fd)
                    created.add(key); entries += 1
                nxt = os.open(part, os.O_RDONLY | O_DIRECTORY, dir_fd=fd)
                os.close(fd); fd = nxt
            return fd
        except BaseException:
            os.close(fd); raise
    try:
        with lzma.open('/work/source.tar.xz', 'rb') as f:
            while True:
                header = exact(f, 512)
                if header == b'\0'*512:
                    need(exact(f, 512) == b'\0'*512, 'missing tar end marker')
                    # Bound and require only conventional zero record padding.
                    tail = f.read(10241)
                    need(len(tail) <= 10240 and not tail.strip(b'\0') and not f.read(1),
                         'excess/nonzero tar trailer')
                    break
                until(end)
                need(number(header[148:156]) == sum(header[:148])+256+sum(header[156:]),
                     'tar checksum mismatch')
                need(header[257:263] in (b'ustar\0', b'ustar '), 'unsupported tar header')
                raw = header[:100].split(b'\0', 1)[0]
                prefix = header[345:500].split(b'\0', 1)[0]
                raw = (prefix+b'/' if prefix else b'')+raw
                name = raw.decode('utf-8', 'strict').rstrip('/')
                need(len(raw) <= 4096 and '\0' not in name, 'tar name exceeds bound')
                parts = name.split('/')
                need(parts and parts[0] == 'node-v24.18.1' and
                     all(p not in ('', '.', '..') for p in parts), 'tar path outside fixed source')
                need(name not in seen, 'duplicate tar member')
                metadata += len(raw)+512
                need(metadata <= 16777216, 'tar metadata admission exhausted')
                seen.add(name)
                size, kind = number(header[124:136]), header[156:157]
                need(kind in (b'0', b'\0', b'5'), 'unproven tar link/extension/type refuses')
                if kind == b'5':
                    need(size == 0, 'directory tar payload refused')
                    fd = mkdir_path(parts); os.close(fd)
                    continue
                need(size <= 67108864 and payload+size <= 1610612736,
                     'source payload admission exhausted BEFORE creation')
                parent = mkdir_path(parts[:-1])
                try:
                    need(name not in created and entries+1 <= 49152,
                         'source file identity/entry admission refused')
                    fd = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                                 os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
                    created.add(name); entries += 1; payload += size
                    try:
                        remaining = size
                        while remaining:
                            b = exact(f, min(65536, remaining)); write_all(fd, b); remaining -= len(b)
                        os.fchmod(fd, 0o700 if number(header[100:108]) & 0o111 else 0o600)
                    finally:
                        os.close(fd)
                finally:
                    os.close(parent)
                if size % 512:
                    exact(f, 512-size % 512)
        for target, expected, replacement in (
            ('src/node_main.cc', inputs['expectedMainPreimageSha256'], 'node_main.cc'),
            ('node.gyp', inputs['expectedGypPreimageSha256'], 'node.gyp')):
            path = '/work/node-v24.18.1/'+target
            need(digest(path) == expected, 'upstream transformation preimage mismatch')
            data = pathlib.Path('/inputs/'+replacement).read_bytes()
            need(len(data) <= 67108864, 'replacement input cap')
            fd = os.open(path, os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
            try:
                need(os.fstat(fd).st_nlink == 1, 'replacement link identity refusal')
                os.ftruncate(fd, 0); write_all(fd, data)
            finally:
                os.close(fd)
    finally:
        os.close(workfd)
    until(end)
    boundary(sock, t0, 'extraction-complete', deadline(t0, 30), entries=entries, payloadBytes=payload, metadataBytes=metadata)


def run_phase(sock, t0, label, argv, end, cwd='/work', file_cap=None, env=None, expected=None):
    until(end)
    boundary(sock, t0, 'phase-start', end, phase=label)
    leader = os.fork()
    if leader == 0:
        try:
            if file_cap is not None:
                resource.setrlimit(resource.RLIMIT_FSIZE, (file_cap, file_cap))
            os.chdir(cwd)
            # Only stdio crosses exec; phase inputs are fixed readonly paths.
            os.closerange(3, 256)
            os.execve(argv[0], argv, ENV if env is None else env)
        except BaseException:
            os._exit(93)
    pfd = os.pidfd_open(leader)  # unreaped direct child identity, never signaled by PID
    try:
        statuses = reap_tree(end, leader)
        need(select.select([pfd], [], [], 0)[0], 'phase pidfd terminal proof missing')
    finally:
        os.close(pfd)
    until(end)
    v = os.statvfs('/work')
    boundary(sock, t0, 'phase-terminal', end, phase=label, childrenReaped=len(statuses),
         allocatedBytes=(v.f_blocks-v.f_bfree)*v.f_frsize, usedInodes=v.f_files-v.f_ffree)


def bounded_copy(src, dst, maximum, end):
    s = os.stat(src, follow_symlinks=False)
    need(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and 0 < s.st_size <= maximum,
         'binary admission refused BEFORE copy')
    infd = os.open(src, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    outfd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o700)
    try:
        need(os.fstat(infd) == s, 'binary changed before copy')
        total = 0
        while total < s.st_size:
            until(end)
            b = os.read(infd, min(65536, s.st_size-total))
            need(b, 'short binary read'); write_all(outfd, b); total += len(b)
        need(os.fstat(infd) == s, 'binary changed during copy')
    finally:
        os.close(infd); os.close(outfd)


def work(sock, spoolfd, t0, plan, inputs, acquire_end):
    acquire(sock, spoolfd, t0, plan, acquire_end)
    extract(sock, t0, inputs)
    run_phase(sock, t0, 'helper-compile', ['/usr/bin/gcc', '-Os', '-std=c11', '-Wall',
              '-Wextra', '-Werror', '-Dmain=wollipog_lease_native_main', '-c',
              '/inputs/helper-input.c', '-o', '/work/helper.o'], deadline(t0, 30),
              file_cap=2097152)
    end = deadline(t0, 510)
    run_phase(sock, t0, 'node-configure', ['/usr/bin/python3', './configure', '--dest-cpu=x64',
              '--dest-os=linux'], min(end, now()+30), cwd='/work/node-v24.18.1')
    run_phase(sock, t0, 'node-build', ['/usr/bin/make', '-s', '-j4', 'node'], end,
              cwd='/work/node-v24.18.1')
    end = deadline(t0, 30)
    boundary(sock, t0, 'packaging-start', end)
    base = '/work/node-v24.18.1/out/Release/node'
    fd = os.open(base, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        head = os.read(fd, 64); s = os.fstat(fd)
        need(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_size <= 201326592 and
             head[:6] == b'\x7fELF\x02\x01' and struct.unpack('<H', head[18:20])[0] == 62,
             'native x64 ELF/base admission refused')
    finally:
        os.close(fd)
    bounded_copy(base, '/work/linked-sea', 201326592, end)
    fixture = pathlib.Path('/inputs/minimal.cjs').read_bytes()
    for path, b in (('/work/minimal.cjs', fixture), ('/work/sea-config.json',
                    b'{"main":"/work/minimal.cjs","output":"/work/sea-prep.blob","disableExperimentalSEAWarning":true}'),
                    ('/work/inject.cjs', b'const fs=require("node:fs");const {inject}=require("/inputs/postject-api.js");inject("/work/linked-sea","NODE_SEA_BLOB",fs.readFileSync("/work/sea-prep.blob"),{sentinelFuse:"NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"}).catch(()=>process.exit(94));')):
        need(len(b) <= 16384, 'fixed packaging input bound')
        out = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
        try:
            write_all(out, b)
        finally:
            os.close(out)
    run_phase(sock, t0, 'sea-blob', [base, '--experimental-sea-config', '/work/sea-config.json'], end)
    run_phase(sock, t0, 'sea-inject', [base, '/work/inject.cjs'], end)
    for label, path in (('helper-object', '/work/helper.o'),
                        ('node-config', '/work/node-v24.18.1/config.gypi'),
                        ('transformed-main', '/work/node-v24.18.1/src/node_main.cc'),
                        ('transformed-gyp', '/work/node-v24.18.1/node.gyp'),
                        ('base', base), ('sea', '/work/linked-sea')):
        until(end)
        need(os.stat(path, follow_symlinks=False).st_size <= 201326592, 'packaged binary cap')
        emit(sock, t0, 'binary-evidence', role=label, sha256=digest(path), bytes=os.stat(path).st_size)
        until(end)
    # Exact probe-output assertions are performed by the outer controller against
    # its complete admitted output interval, before any GO conclusion.
    env = dict(ENV, NODE_OPTIONS='--require=/work/missing-native-canary.cjs')
    run_phase(sock, t0, 'native-probe', ['/work/linked-sea', '--wollipog-lease-native-io', '--probe'],
              deadline(t0, 10), env=env)
    need(not os.path.lexists('/work/missing-native-canary.cjs'), 'native canary unexpectedly touched')
    run_phase(sock, t0, 'sea-probe', ['/work/linked-sea'], deadline(t0, 10))
    emit(sock, t0, 'work-complete', allPhaseLeadersAndOrphansReaped=True)


class Ledger:
    def __init__(self, root):
        os.mkdir(root, 0o700)  # exclusive; EEXIST is refusal, never reset
        s = os.lstat(root)
        need(stat.S_ISDIR(s.st_mode) and s.st_uid == UID and s.st_mode & 0o777 == 0o700,
             'persistent root identity refusal')
        self.fd = os.open(root, os.O_RDONLY | O_DIRECTORY)
        need(os.fstat(self.fd) == s, 'persistent root substituted during exclusive admission')
        self.bytes, self.entries, self.slots = 0, 1, {}

    def slot(self, name, reserved):
        need('/' not in name and name not in self.slots and self.entries+1 <= 32 and
             self.bytes+reserved <= 536870912, 'persistent admission exhausted')
        fd = os.open(name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                     0o600, dir_fd=self.fd)
        self.bytes += reserved; self.entries += 1; self.slots[name] = (fd, reserved)
        return fd

    def directory(self, name):
        need(self.entries+1 <= 32, 'persistent directory cap')
        os.mkdir(name, 0o700, dir_fd=self.fd); self.entries += 1

    def receipt(self, value):
        b = json.dumps(value, indent=2).encode()+b'\n'
        need(len(b) <= 131072, 'receipt metadata cap')
        fd = self.slot('terminal-receipt.json', 131072)
        write_all(fd, b); os.fsync(fd)
        return hashlib.sha256(b).hexdigest()


def boot():
    return time.clock_gettime(time.CLOCK_BOOTTIME)


def now():
    return CLOCK.check(boot(), time.monotonic(), 720.0)


def validate_inputs(plan):
    need(platform.system() == 'Linux' and platform.machine() == 'x86_64' and UID != 0 and GID != 0,
         'wrong native target/nonzero identity')
    need(plan['runRoot'] == RUN and plan['attempts'] == 1, 'wrong single-attempt plan')
    fixed, inputs = FIXED_TOOLS, INPUTS
    for item in fixed:
        s = os.stat(item['path'], follow_symlinks=False)
        need(stat.S_ISREG(s.st_mode) and s.st_uid == 0 and not s.st_mode & 0o022
             and s.st_size == item['bytes'] and digest(item['path']) == item['sha256'],
             'fixed installed tool preimage/authority refusal')
        until(CLOCK.setup)
    need(os.path.realpath('/usr/bin/gcc') == fixed[0]['path'] and
         os.path.realpath('/usr/bin/g++') == fixed[1]['path'] and
         os.path.realpath('/usr/bin/python3') == fixed[3]['path'], 'tool alias changed')
    need(all(int(x) < 256 for x in os.listdir('/proc/self/fd')), 'inherited high descriptor refuses')
    for fd in range(3, 256):
        try:
            s = os.fstat(fd)
        except OSError:
            continue
        need(not stat.S_ISDIR(s.st_mode), 'inherited outside directory descriptor refuses')
    with open('/proc/meminfo') as f:
        data = f.read(16385)
    need(len(data) <= 16384, 'memory preflight metadata cap')
    values = [line for line in data.splitlines() if line.startswith('MemAvailable:')]
    need(len(values) == 1 and re.fullmatch(r'MemAvailable:\s+[0-9]+ kB',values[0]),
         'unproved available memory')
    available = int(values[0].split()[1])*1024
    need(available >= 12884901888, 'MemAvailable below proposed 12GiB minimum')
    need(len(inputs['proposedInputs']) == 6 and
         sum(x['bytes'] for x in inputs['proposedInputs']) + 6*16384 + 4096 <= 6291456,
         'fixed-input aggregate reservation refused')
    until(CLOCK.setup)
    return fixed, inputs, available


def resolver_config():
    # Trusted image resolver is configuration, never a dynamically adopted tool.
    fd = os.open('/etc/resolv.conf', os.O_RDONLY | os.O_CLOEXEC)
    try:
        s = os.fstat(fd)
        need(stat.S_ISREG(s.st_mode) and s.st_uid == 0 and not s.st_mode & 0o022
             and s.st_size <= 4096, 'resolver image authority/shape refused')
        data = os.read(fd, 4097)
        need(len(data) <= 4096 and os.fstat(fd) == s, 'resolver changed/excess')
    finally:
        os.close(fd)
    servers = []
    for line in data.decode('ascii').splitlines():
        parts = line.split('#',1)[0].split()
        if parts and parts[0] == 'nameserver':
            need(len(parts) == 2, 'invalid resolver field')
            socket.inet_pton(socket.AF_INET, parts[1]); servers.append(parts[1])
    need(len(servers) == 1, 'single numeric IPv4 resolver required; no fallback')
    return servers[0]


def main():
    # The workflow pins decoded bytes externally; no controller self-hash fixed point.
    # Scratch direct invocation is never an authorization path.
    context = globals().get('HOSTED_CONTEXT')
    need(isinstance(context, dict) and set(context) ==
         {'head','bootstrapStart','controllerSha256','clockOffset','runnerBoundary'},
         'exact hosted bootstrap context required; scratch execution refused')
    need(context['runnerBoundary'] == 'existing-public-ubuntu24-actions-vm' and
         re.fullmatch('[0-9a-f]{40}', context['head']) and
         re.fullmatch('[0-9a-f]{64}', context['controllerSha256']), 'hosted context refusal')
    global CLOCK, BOOTSTRAP_START
    BOOTSTRAP_START = context['bootstrapStart']
    CLOCK = Clock(BOOTSTRAP_START, boot(), time.monotonic(), context['clockOffset'])
    t0 = 0.0
    plan = EXPERIMENT_PLAN
    ledger = None
    logfd = spoolfd = receiptfd = quota_fd = parentfd = pfd = readfd = writefd = None
    sockp = sockc = None
    pid = terminal = None
    killed, pipe_eof, control_eof = False, False, False
    output = None
    slots, identities = {}, {}
    receipt = {'schema':'WPLBF-HOSTED3','attempt':1,'head':context['head'],
               'controllerSha256':context['controllerSha256'],'target':'Linux-x64',
               'result':'NO-GO','namespaceCreated':False,'sourceAcquired':False,
               'childrenTerminal':False,'phases':[], 'allSixProductionACIncomplete':True,
               'clockOrigin':'CLOCK_BOOTTIME zero','bootstrapStart':BOOTSTRAP_START,
               'noRetryFallback':True,'binaryRetention':'VM-only; not durable/uploaded',
               'aggregateRssQuota':None,'tmpfsLogicalCeiling':35184372088832}
    active = None
    probe_buffers = {'native-probe':bytearray(), 'sea-probe':bytearray()}
    peak_bytes = peak_inodes = 0
    overall_alarm = False
    closure_end = None
    phase_end = CLOCK.setup
    io_mode = 'work'
    def cancel():
        nonlocal killed
        if pfd is not None and terminal is None and not killed:
            signal.pidfd_send_signal(pfd, signal.SIGKILL)
            killed = True
    def poll_terminal():
        nonlocal terminal
        if pfd is not None and terminal is None:
            info = os.waitid(os.P_PIDFD, pfd, os.WEXITED | os.WNOHANG)
            if info is not None:
                terminal = {'si_code':info.si_code,'si_status':info.si_status,'boot':boot()}
                receipt['terminal'] = terminal
                receipt['childrenTerminal'] = True
    def check_network(end):
        stamp = now()
        need(stamp < min(end,705), 'shared input acquisition deadline')
        poll_terminal()
        need(terminal is None, 'namespace exited during guarded input delivery')
        return stamp
    def check_io(end):
        nonlocal closure_end, io_mode
        # Every readiness/write/read iteration uses the SAME active absolute end.
        # Poll only the retained atomic pidfd, never a raw PID or recycled PGID.
        try:
            stamp = now()
            need(stamp < end, 'active output/drain deadline')
            poll_terminal()
            if io_mode == 'work' and terminal is not None:
                need(terminal['si_code'] == os.CLD_EXITED and terminal['si_status'] == 0,
                     'namespace failed during output/drain')
            return stamp
        except BaseException:
            if closure_end is None:closure_end=min(720.0,boot()+15)
            io_mode='closure'
            cancel()
            raise
    def external(b, end, start=0, progress=lambda offset: None):
        # Nonblocking trusted Actions pipe. A partial frame resumes at its exact
        # offset during the ORIGINAL closure window; no framing/budget restart.
        offset = start
        while offset < len(b):
            stamp = check_io(end)
            _, ready, _ = select.select([], [1], [], min(0.025, end-stamp))
            check_io(end)
            if not ready:
                continue
            try:
                n = os.write(1, b[offset:])
            except BlockingIOError:
                continue
            need(type(n) is int and 0 < n <= len(b)-offset, 'external short/invalid write')
            offset += n
            progress(offset)
            check_io(end)
    def admit(b):
        need(output is not None, 'output ledger missing')
        end = closure_end if io_mode == 'closure' else min(705.0, phase_end)
        output.admit(b, end)
    def drain_pipe(end):
        nonlocal pipe_eof
        while not pipe_eof:
            check_io(end)
            need(output.pending is None, 'drain before pending frame closure refused')
            try:
                b = os.read(readfd, 4096)
            except BlockingIOError:
                return
            # Preserve bytes already removed from the pipe before checking the
            # next iteration; Output records pending external delivery exactly.
            if not b:
                pipe_eof = True; return
            admit(b)
            if active in probe_buffers:
                probe_buffers[active].extend(b)
    def interrupt(_sig,_frame):
        raise Refusal('work/overall cutoff or controller interrupt')
    try:
        # No later total-clock restart; setup includes imports/decoded bootstrap.
        for sig in (signal.SIGINT,signal.SIGTERM,signal.SIGALRM):
            signal.signal(sig,interrupt)
        signal.setitimer(signal.ITIMER_REAL,max(0.001,705-boot()))
        signal.signal(signal.SIGCHLD,signal.SIG_DFL)
        os.set_blocking(1,False)
        fixed, inputs, available = validate_inputs(plan)
        resolver = resolver_config()
        tls = ssl.create_default_context()
        need(tls.check_hostname and tls.verify_mode == ssl.CERT_REQUIRED,
             'TLS hostname/certificate verification missing')
        hooks = fork_hooks()
        until(CLOCK.setup)
        receipt['memAvailableBytes'] = available
        receipt['forkHooksVerified'] = True
        ledger = Ledger(RUN)
        ledger.directory('mount-root')
        logfd = ledger.slot('stdout-stderr-control.log',65536)
        receiptfd = ledger.slot('terminal-receipt.json',131072)
        spoolfd = ledger.slot('source.tar.xz',83886080)
        # Reserve and write small immutable controls BEFORE growth.
        for name,value in (('experiment-plan.json',plan),('fixed-existing-inputs.json',fixed),
                           ('proposed-input-manifest.json',inputs)):
            data = json.dumps(value,sort_keys=True,separators=(',',':')).encode()+b'\n'
            need(len(data) <= 16384, 'control manifest cap BEFORE write')
            fd = ledger.slot(name,16384); write_all(fd,data); os.fsync(fd)
            os.close(fd)
        for item in inputs['proposedInputs']:
            fd = ledger.slot(item['name'],item['bytes'])
            slots[item['name']] = fd
            s = os.fstat(fd)
            need(s.st_size == 0 and s.st_nlink == 1 and s.st_uid == UID,
                 'exclusive empty input inode refusal')
            identities[item['name']] = identity(s)
        need(sum(x['bytes'] for x in inputs['proposedInputs']) <= 6291456,
             'input reservations exhausted')
        output = Output(lambda b:write_all(logfd,b),external)
        admit(json.dumps({'kind':'preflight','head':context['head'],
                         'clockOrigin':'BOOT zero','bootstrapStart':BOOTSTRAP_START,
                         'setupEnd':CLOCK.setup,'inputBytes':sum(x['bytes'] for x in inputs['proposedInputs'])},
                         separators=(',',':')).encode()+b'\n')
        sockp,sockc = socket.socketpair(socket.AF_UNIX,socket.SOCK_SEQPACKET|socket.SOCK_CLOEXEC)
        readfd,writefd = os.pipe2(os.O_CLOEXEC)
        parentfd = os.pidfd_open(os.getpid())
        until(CLOCK.setup)
        pid,pfd = clone_init(hooks)
        if pid == 0:
            try:
                sockp.close(); os.close(readfd); os.close(logfd); os.close(receiptfd); os.close(ledger.fd)
                os.dup2(writefd,1); os.dup2(writefd,2); os.close(writefd)
                eofr,eofw=os.pipe2(os.O_CLOEXEC); os.close(eofw); os.dup2(eofr,0); os.close(eofr)
                acquire_end = setup_namespace(RUN+'/mount-root',sockc,parentfd,spoolfd,t0,
                                              fixed,inputs['proposedInputs'],slots,identities)
                os.close(parentfd)
                work(sockc,spoolfd,t0,plan,inputs,acquire_end)
                os._exit(0)
            except BaseException as e:
                try:
                    message = str(e)
                    if len(message.encode()) > 1024:
                        message = 'complete error diagnostic exceeds bound; failure'
                    emit(sockc,t0,'refusal',exception=type(e).__name__,reason=message)
                finally:
                    os._exit(95)
        receipt['namespaceCreated']=True;receipt['atomicPidfd']=True
        sockc.close();os.close(writefd);writefd=None
        os.close(parentfd);parentfd=None
        os.close(spoolfd);spoolfd=None
        # The retained unreaped DIRECT child prevents PID recycling during mapping.
        procfd=os.open('/proc/'+str(pid),os.O_RDONLY|O_DIRECTORY)
        mapping=[]
        try:
            for name in ('setgroups','uid_map','gid_map'):
                mapping.append(os.open(name,os.O_WRONLY|os.O_CLOEXEC,dir_fd=procfd))
            for fd,value in zip(mapping,('deny',f'{UID} {UID} 1',f'{GID} {GID} 1')):
                until(CLOCK.setup);write_all(fd,value.encode())
        finally:
            for fd in mapping:os.close(fd)
            os.close(procfd)
        sockp.send(b'MAPPED');admit(b'MAPPED\n')
        os.set_blocking(readfd,False);sockp.setblocking(False)
        prep_end=package_end=acquire_end=None
        guards=inputs_admitted=final_work=False
        next_status=now()+5
        while terminal is None or not (pipe_eof and control_eof):
            until(min(705,phase_end))
            ready,_,_=select.select(([readfd] if not pipe_eof else [])+
                ([sockp] if not control_eof else []),[],[],min(0.025,phase_end-now()))
            for obj in ready:
                if obj==readfd:
                    drain_pipe(min(705.0,phase_end));continue
                b,anc,flags,_=sockp.recvmsg(4097,socket.CMSG_SPACE(4))
                need(not flags & (socket.MSG_TRUNC|socket.MSG_CTRUNC), 'truncated control refused')
                if not b:
                    control_eof=True;continue
                need(len(b)<=4096,'control packet size refused')
                if b==b'QUOTA_ROOT':
                    need(quota_fd is None and len(anc)==1 and anc[0][:2]==
                         (socket.SOL_SOCKET,socket.SCM_RIGHTS), 'quota descriptor transfer refused')
                    fds=array.array('i');fds.frombytes(anc[0][2])
                    need(len(fds)==1,'extra quota descriptors refused')
                    quota_fd=fds[0];os.set_inheritable(quota_fd,False)
                    need(stat.S_ISDIR(os.fstat(quota_fd).st_mode),'quota FD not directory')
                    admit(b+b'\n');continue
                need(not anc,'unexpected control descriptors refused')
                event=json.loads(b)
                need(isinstance(event,dict) and len(receipt['phases'])<96,'event count/shape refusal')
                if 'deadlineElapsed' in event:
                    drain_pipe(min(705.0,phase_end))
                    candidate=event['deadlineElapsed']
                    need(type(candidate) in (int,float) and 0<candidate<=705,'invalid phase end')
                receipt['phases'].append(event)
                kind=event['kind']
                if kind=='guards-established':
                    need(not guards and quota_fd is not None and event['inputWritersClosed'],
                         'guard/input closure ordering refused')
                    guards=True;acquire_end=phase_end=candidate
                    need(acquire_end<=now()+30,'input/shared acquisition deadline refused')
                    admit(b+b'\n')
                    # Child is now blocked after all barriers; all six slots EMPTY.
                    wire=4096
                    def account(n):
                        nonlocal wire
                        need(wire+n<=6291456,'fixed-input wire cap BEFORE write')
                        wire+=n
                    ip=resolve_once('raw.githubusercontent.com',resolver,acquire_end,check_network)
                    records=[]
                    for item in inputs['proposedInputs']:
                        fd=slots[item['name']]
                        need(identity(os.fstat(fd))==identities[item['name']] and os.fstat(fd).st_size==0,
                             'parent retained input changed before transfer')
                        total=0
                        def write_chunk(chunk):
                            nonlocal total
                            need(total+len(chunk)<=item['bytes'],'input pre-growth cap')
                            check_network(acquire_end);write_all(fd,chunk);total+=len(chunk)
                        record=fixed_stream(ip,tls,context['head'],item,acquire_end,
                                            check_network,write_chunk,account)
                        need(total==item['bytes'] and identity(os.fstat(fd))==identities[item['name']],
                             'parent input identity/size mismatch')
                        os.fsync(fd);os.close(fd);slots.pop(item['name'])
                        records.append(record)
                        admit(json.dumps({'kind':'fixed-input-admitted',**record},separators=(',',':')).encode()+b'\n')
                    need(not slots,'parent input writers remain')
                    check_network(acquire_end)
                    sockp.send(b'INPUTS-CLOSED');admit(b'INPUTS-CLOSED\n')
                    receipt['fixedInputWireBytesCharged']=wire
                elif kind=='inputs-independently-admitted':
                    need(guards and not inputs_admitted and not slots and candidate==acquire_end
                         and event['records']==[{'name':x['name'],'bytes':x['bytes'],'sha256':x['sha256'],
                              'dev':identities[x['name']][0],'ino':identities[x['name']][1]}
                              for x in inputs['proposedInputs']], 'independent input evidence refused')
                    inputs_admitted=True
                elif kind=='source-admitted':
                    need(inputs_admitted,'source before independent input proof')
                    receipt['sourceAcquired']=True;phase_end=candidate
                    need(phase_end<=now()+30,'extract deadline mismatch')
                elif kind=='extraction-complete':
                    phase_end=candidate;need(phase_end<=now()+30,'helper deadline mismatch')
                elif kind=='packaging-start':
                    package_end=phase_end=candidate;need(phase_end<=now()+30,'package deadline mismatch')
                elif kind=='phase-start':
                    active=event['phase'];phase_end=candidate
                    allowed={'helper-compile':30,'node-configure':30,'node-build':510,
                             'sea-blob':30,'sea-inject':30,'native-probe':10,'sea-probe':10}
                    need(active in allowed and phase_end<=now()+allowed[active],'phase deadline mismatch')
                    if active=='node-configure':prep_end=min(705,now()+510)
                    if active=='node-build':need(prep_end is not None and phase_end<=prep_end,'prep shared budget')
                    if active in ('sea-blob','sea-inject'):
                        need(package_end is not None and phase_end<=package_end,'package shared budget')
                elif kind=='phase-terminal':
                    need(event['phase']==active,'phase association mismatch');active=None
                elif kind=='refusal':
                    admit(b+b'\n')
                    raise Refusal(event['reason'])
                elif kind=='work-complete':
                    need(inputs_admitted and not active,'incomplete work protocol');final_work=True
                else:
                    need(kind=='binary-evidence','unknown control kind refused')
                if kind!='guards-established':
                    admit(b+b'\n')
                if 'deadlineElapsed' in event and kind!='guards-established':
                    sockp.send(b'BOUNDARY');admit(b'BOUNDARY\n')
            poll_terminal()
            if quota_fd is not None:
                v=os.fstatvfs(quota_fd)
                peak_bytes=max(peak_bytes,(v.f_blocks-v.f_bfree)*v.f_frsize)
                peak_inodes=max(peak_inodes,v.f_files-v.f_ffree)
            if now()>=next_status:
                admit(json.dumps({'kind':'heartbeat','boot':round(now(),3)},separators=(',',':')).encode()+b'\n')
                next_status=now()+5
        need(terminal['si_code']==os.CLD_EXITED and terminal['si_status']==0 and
             final_work and not output.overflow,'namespace work failed')
        for phase,expected in (('native-probe',b''),('sea-probe',b'WPLN1-SEA-FEASIBILITY\n')):
            need(bytes(probe_buffers[phase])==expected,'exact probe output mismatch')
        receipt['result']='GO-partial-native-minimalSEA-only'
    except BaseException as e:
        receipt['failureType']=type(e).__name__
        message=str(e)
        receipt['failure']=message if len(message.encode())<=2048 else 'full error exceeds diagnostic cap; NO-GO'
        if isinstance(e,OSError):receipt['errno']=e.errno
        # Disable the work alarm ONLY in favor of the original absolute 720 boundary.
        signal.setitimer(signal.ITIMER_REAL,max(0.001,720-boot()))
        overall_alarm=True
        if closure_end is None:closure_end=min(720.0,boot()+15)
        io_mode='closure'
        if pfd is not None and terminal is None:
            try:
                cancel()
                while boot()<closure_end:
                    poll_terminal()
                    if terminal is not None:break
                    time.sleep(min(0.005,max(0,closure_end-boot())))
                if terminal is None:receipt['closureUncertainty']='no exact PID1 WEXITED within original budget'
            except BaseException as e2:
                receipt['closureUncertainty']='owned closure failure: '+type(e2).__name__
        elif pid is None:
            receipt['childrenTerminal']=True;receipt['terminal']='no namespace child created'
        # Retain the entire admitted failure stream, not only successful phases.
        # The SAME closure end covers terminal wait and draining; it never restarts.
        if output is not None:
            try:
                output.resume(closure_end)
            except BaseException as resume_error:
                receipt['pendingFrameUncertainty']=type(resume_error).__name__
        if terminal is not None and readfd is not None and output is not None:
            try:
                os.set_blocking(readfd,False)
                sockp.setblocking(False)
                while not (pipe_eof and control_eof):
                    check_io(closure_end)
                    ready,_,_=select.select(([readfd] if not pipe_eof else [])+
                        ([sockp] if not control_eof else []),[],[],min(0.025,closure_end-boot()))
                    for channel in ready:
                        check_io(closure_end)
                        if channel==readfd:
                            drain_pipe(closure_end)
                        else:
                            data,anc,flags,_=sockp.recvmsg(4097,socket.CMSG_SPACE(4))
                            need(not flags & (socket.MSG_TRUNC|socket.MSG_CTRUNC),'failure control truncation')
                            for level,kind,blob in anc:
                                need((level,kind)==(socket.SOL_SOCKET,socket.SCM_RIGHTS),'failure extra descriptor')
                                fds=array.array('i');fds.frombytes(blob)
                                for fd in fds:os.close(fd)
                            if not data:control_eof=True
                            else:admit(data+b'\n')
                receipt['failureStreamFullyDrained']=True
            except BaseException as drain_error:
                receipt['failureStreamFullyDrained']=False
                receipt['failureStreamUncertainty']=type(drain_error).__name__
    finally:
        # No exports or further acquisition without exact terminal AND clock proof.
        if not overall_alarm:
            signal.setitimer(signal.ITIMER_REAL,max(0.001,720-boot()))
        for fd in slots.values():
            try:os.close(fd)
            except OSError:pass
        slots.clear()
        receipt['exports']=[];receipt['unexportedKnownSlots']=[]
        try:
            until(705)
            if quota_fd is not None and receipt['childrenTerminal'] and (output is None or output.pending is None):
                export_end=phase_end=min(705.0,now()+30,closure_end if closure_end is not None else 705.0)
                io_mode='export'
                for src,dst in (('work/node-v24.18.1/out/Release/node','linked-base'),('work/linked-sea','linked-sea')):
                    fd=out=None
                    try:
                        until(export_end);fd,s=safe_open(quota_fd,src)
                        need(0<s.st_size<=201326592,'fixed export identity/size cap')
                        out=ledger.slot(dst,s.st_size)
                        total=0;h=hashlib.sha256()
                        while total<s.st_size:
                            until(export_end);b=os.read(fd,min(65536,s.st_size-total))
                            need(b,'short export read');write_all(out,b);total+=len(b);h.update(b)
                        need(os.fstat(fd)==s,'export file changed');os.fsync(out)
                        record={'name':dst,'bytes':total,'sha256':h.hexdigest()}
                        receipt['exports'].append(record)
                        admit(json.dumps({'kind':'export-admitted',**record},separators=(',',':')).encode()+b'\n')
                    except BaseException as e:
                        if closure_end is None:closure_end=min(720.0,boot()+15)
                        io_mode='closure'
                        if output is not None:
                            try:output.resume(closure_end)
                            except BaseException as resume_error:
                                receipt['pendingFrameUncertainty']=type(resume_error).__name__
                        receipt['unexportedKnownSlots'].append({'name':dst,'failure':type(e).__name__})
                        if receipt['result'].startswith('GO'):receipt['result']='NO-GO'
                    finally:
                        for x in (fd,out):
                            if x is not None:
                                try:os.close(x)
                                except OSError:pass
        except BaseException as e:
            receipt['result']='NO-GO';receipt['exportRefusal']=type(e).__name__
        receipt['bootAtTerminal']=boot()
        receipt['sampledPeaksNotExactHighWater']={'allocatedBytes':peak_bytes,'usedInodes':peak_inodes}
        if output:
            receipt['workloadControlBytes']=output.count
            receipt['workloadControlRawBytes']=output.raw_count
            receipt['workloadControlSha256']=output.hash.hexdigest()
            receipt['workloadOverflow']=output.overflow
            receipt['workloadControlDeliveredBytes']=output.delivered
            receipt['pendingExternalBytes']=0 if output.pending is None else len(output.pending[0])-output.pending[1]
            if output.pending is not None:
                receipt['result']='NO-GO'
        if ledger:
            receipt['reservedBytes']=ledger.bytes;receipt['reservedEntries']=ledger.entries
            receipt['inventory']=[]
            for name,(_,reserved) in sorted(ledger.slots.items()):
                s=os.stat(name,dir_fd=ledger.fd,follow_symlinks=False)
                need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==UID and s.st_size<=reserved,
                     'retained artifact identity/size refusal')
                receipt['inventory'].append({'name':name,'bytes':s.st_size,'reserved':reserved,'dev':s.st_dev,'ino':s.st_ino})
        # Phases are already completely emitted once; do not hide/tail-select them.
        public={k:v for k,v in receipt.items() if k!='phases'}
        public['phaseCount']=len(receipt['phases'])
        public['phaseEvidence']='complete workload/control stream referenced by hash'
        terminal_bytes=json.dumps(public,sort_keys=True,separators=(',',':'),ensure_ascii=True,allow_nan=False).encode()+b'\n'
        if len(terminal_bytes)>8192:
            receipt['result']='NO-GO'
            raise Refusal('complete terminal evidence cannot fit 8KiB; no selective success')
        if ledger:
            saved=json.dumps(receipt,sort_keys=True,indent=2,ensure_ascii=True,allow_nan=False).encode()+b'\n'
            need(len(saved)<=131072,'local complete receipt cap')
            write_all(receiptfd,saved);os.fsync(receiptfd)
        if output:
            # The terminal allowance is distinct; workload exhaustion cannot steal it.
            write_all(logfd,terminal_bytes)
        # Failure terminal shares the ORIGINAL closure window, even after export.
        terminal_end=closure_end if closure_end is not None else min(705.0,phase_end)
        need(output is None or output.pending is None, 'terminal delivery before pending frame closure refused')
        external(terminal_bytes,terminal_end)
        if logfd is not None:os.fsync(logfd)
        for fd in (pfd,parentfd,readfd,writefd,spoolfd,logfd,receiptfd,quota_fd):
            if fd is not None:
                try:os.close(fd)
                except OSError:pass
        if sockp:sockp.close()
        if sockc:sockc.close()
        if ledger:os.close(ledger.fd)
        signal.setitimer(signal.ITIMER_REAL,0)
    return 0 if receipt['result'].startswith('GO-') else 1


if __name__ == '__main__':
    raise SystemExit(main())
