import { HELD_SKILL_LINK_DETAIL } from "./skills.js";

/** Fixed in-distro filesystem adapter. JSON carries only validated desired state and store paths;
 * no payload value is evaluated as Python or shell source. */
export const WSL_SKILLS_HELPER = String.raw`#!/usr/bin/env python3
import ctypes, datetime, errno, hashlib, json, os, re, signal, stat, sys, time, uuid

HELD_DETAIL = ${JSON.stringify(HELD_SKILL_LINK_DETAIL)}
NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
DIGEST = re.compile(r"^[0-9a-f]{64}$")
DRIFTED_VERSION = re.compile(r"^[0-9a-f]{64}(-manual)?$")
MAX_COPY_ENTRIES = 1024
MAX_COPY_FILES = 64
MAX_COPY_FILE_BYTES = 512 * 1024
MAX_COPY_BYTES = 2 * 1024 * 1024
LEASE_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
MAX_ENTRIES = 256
MAX_MD = 65536
MAX_LEASE_RECORDS = 16
MAX_COMPACTION_SIBLINGS = 64
MAX_COMPACTION_RECORDS = 4096
MAX_CLEANUP_ALIAS_SCAN_ENTRIES = 4096
MAX_CLEANUP_ALIASES = 128
RENAME_EXCHANGE = 2
DRIVER_DIRS = {"claude-code": ".claude/skills", "codex": ".codex/skills", "codex-app-server": ".codex/skills", "pi": ".pi/agent/skills"}
COMPACTION = re.compile(r"^\.mutable-home\.compact-([0-9a-f-]{36})-([0-9a-f]{64})-([0-9a-f]{32})$")
CLEANUP_PROOF = re.compile(r"^\.mutable-home\.cleanup-([0-9a-f]{32})\.json$")
PUBLICATION_TEMP = re.compile(r"^\.provider-home-lease-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$")
diagnostics = []

def fail(message):
    raise RuntimeError(message)

def diagnose(message):
    value = re.sub(r"[\x00-\x1f\x7f]+", " ", str(message)).strip()[:500]
    if value and value not in diagnostics and len(diagnostics) < 16: diagnostics.append(value)

def open_root(path):
    resolved = os.path.realpath(path)
    return os.open(resolved, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW), resolved

def child_dir(parent, name, create=False, mode=0o755, strict=True):
    if not name or name in (".", "..") or "/" in name or "\\" in name:
        fail("invalid path segment")
    if create:
        try: os.mkdir(name, mode, dir_fd=parent)
        except FileExistsError: pass
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode) or strict and (info.st_uid != os.geteuid() or info.st_mode & 0o022):
        os.close(fd); fail("unsafe directory ownership")
    return fd

def walk_dir(root, relative, create=False):
    fd = os.dup(root)
    try:
        for segment in relative.split("/"):
            next_fd = child_dir(fd, segment, create)
            os.close(fd); fd = next_fd
        return fd
    except:
        os.close(fd); raise

def fd_path(fd):
    return os.path.realpath("/proc/self/fd/%d" % fd)

def bounded_json():
    raw = sys.stdin.buffer.read(4 * 1024 * 1024 + 1)
    if len(raw) > 4 * 1024 * 1024: fail("request too large")
    return json.loads(raw.decode("utf-8"))

def lease_value(owner, state, previous=None):
    return {"version": 2, "state": state, "ownerHash": owner, "leaseId": str(uuid.uuid4()),
        "previousLeaseId": previous[0] if previous else None, "previousRecordHash": previous[1] if previous else None,
        "pid": os.getpid(), "hostname": os.uname().nodename, "provider": "wsl-skills",
        "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}

def lease_bytes(value):
    return json.dumps(value, separators=(",", ":")).encode() + b"\n"

def read_lease_record(lock, name):
    marker = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=lock)
    try:
        info = os.fstat(marker)
        # Native publication briefly gives the immutable record a second hard link while the
        # destination is made durable. More links would permit an unexpected mutable alias.
        if not stat.S_ISREG(info.st_mode) or info.st_nlink not in (1, 2) or info.st_size > 4096: fail("provider home lease is unsafe")
        raw = os.read(marker, info.st_size + 1)
        value = json.loads(raw.decode("utf-8"))
    finally: os.close(marker)
    if not isinstance(value, dict) or not DIGEST.fullmatch(value.get("ownerHash", "")): fail("provider home lease is invalid")
    lease_id = value.get("leaseId", "")
    if (not isinstance(lease_id, str) or not LEASE_ID.fullmatch(lease_id) or
        not isinstance(value.get("pid"), int) or isinstance(value.get("pid"), bool) or value["pid"] <= 0 or value["pid"] > 9007199254740991 or
        not isinstance(value.get("hostname"), str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", value.get("provider", "")) or
        not isinstance(value.get("createdAt"), str)): fail("provider home lease is invalid")
    if value.get("version") == 1:
        pass
    elif value.get("version") == 2 and value.get("state") in ("active", "released"):
        previous_id, previous_hash = value.get("previousLeaseId"), value.get("previousRecordHash")
        if previous_id is not None and (not isinstance(previous_id, str) or not LEASE_ID.fullmatch(previous_id)):
            fail("provider home lease is invalid")
        if previous_hash is not None and not DIGEST.fullmatch(previous_hash): fail("provider home lease is invalid")
    else: fail("provider home lease is invalid")
    return value, hashlib.sha256(raw).hexdigest()

def read_lease_chain(lock, include_records=False):
    entries = sorted(os.listdir(lock))
    if not entries: fail("provider home lease is incomplete")
    if "lease.json" in entries:
        marker = "lease.json"
        value, record_hash = read_lease_record(lock, marker)
        if value.get("version") != 1: fail("provider home lease is incomplete or foreign")
    else:
        genesis = [name for name in entries if re.fullmatch(r"lease-([0-9a-f-]+)\.json", name)]
        if len(genesis) != 1: fail("provider home lease is incomplete or foreign")
        marker = genesis[0]
        value, record_hash = read_lease_record(lock, marker)
        if (value.get("version") != 2 or value.get("state") != "active" or value.get("previousLeaseId") is not None or
            value.get("previousRecordHash") is not None or marker != "lease-%s.json" % value["leaseId"]):
            fail("provider home lease is incomplete or foreign")
    consumed, seen, records = {marker}, set(), {}
    while True:
        if value["leaseId"] in seen: fail("provider home lease is incomplete or foreign")
        seen.add(value["leaseId"])
        records[value["leaseId"]] = (record_hash, value)
        next_marker = "next-%s.json" % value["leaseId"]
        if next_marker not in entries: break
        successor, successor_hash = read_lease_record(lock, next_marker)
        if (successor.get("version") != 2 or successor.get("previousLeaseId") != value["leaseId"] or
            successor.get("previousRecordHash") != record_hash): fail("provider home lease is incomplete or foreign")
        if successor["state"] == "released" and (value.get("version") != 2 or value.get("state") != "active" or
            any(successor[key] != value[key] for key in ("ownerHash", "hostname", "pid", "provider"))):
            fail("provider home lease is incomplete or foreign")
        if successor["state"] == "active" and (value.get("version") == 1 or value.get("state") == "active") and (
            successor["ownerHash"] != value["ownerHash"] or successor["hostname"] != value["hostname"]):
            fail("provider home lease is incomplete or foreign")
        consumed.add(next_marker)
        value, record_hash = successor, successor_hash
    if len(consumed) != len(entries): fail("provider home lease is incomplete or foreign")
    return (value, record_hash, records) if include_records else (value, record_hash)

def write_all(fd, value):
    sent = 0
    while sent < len(value): sent += os.write(fd, value[sent:])

def publish_lease(root, lock, target, value):
    raw = lease_bytes(value)
    temp = ".provider-home-lease-%s.tmp" % uuid.uuid4()
    marker = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=root)
    try:
        write_all(marker, raw); os.fsync(marker)
    finally: os.close(marker)
    try:
        os.link(temp, target, src_dir_fd=root, dst_dir_fd=lock, follow_symlinks=False)
        os.fsync(lock)
    finally:
        try: os.unlink(temp, dir_fd=root)
        except FileNotFoundError: pass
    return hashlib.sha256(raw).hexdigest()

def process_alive(pid):
    try: os.kill(pid, 0); return True
    except ProcessLookupError: return False
    except PermissionError: return True
    except: return True

def discover_cleanup_proof_aliases(root):
    # An incomplete inventory cannot prove that a two-link proof has exactly one strict alias.
    # Return no inventory on mutation or overflow so single-link cleanup can continue safely.
    aliases = {}
    scanned = 0
    retained = 0
    try:
        with os.scandir(root) as entries:
            for entry in entries:
                scanned += 1
                if scanned > MAX_CLEANUP_ALIAS_SCAN_ENTRIES: return None
                if not PUBLICATION_TEMP.fullmatch(entry.name): continue
                retained += 1
                if retained > MAX_CLEANUP_ALIASES: return None
                info = entry.stat(follow_symlinks=False)
                aliases.setdefault((info.st_dev, info.st_ino), []).append(entry.name)
    except: return None
    return aliases

def normalize_cleanup_proof(root, proof_name, proof_identity, proof_raw, aliases_by_identity, retained_fd=None):
    proof_fd = retained_fd if retained_fd is not None else os.open(
        proof_name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=root)
    try:
        info = os.fstat(proof_fd)
        named = os.stat(proof_name, dir_fd=root, follow_symlinks=False)
        os.lseek(proof_fd, 0, os.SEEK_SET)
        if ((info.st_dev, info.st_ino) != proof_identity or
            (named.st_dev, named.st_ino) != proof_identity or
            not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or
            stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink not in (1, 2) or
            info.st_size > 4096 or os.read(proof_fd, info.st_size + 1) != proof_raw):
            fail("compaction cleanup proof changed during recovery")
        if info.st_nlink == 1: return proof_identity
        if aliases_by_identity is None: fail("unverified compaction cleanup proof alias")
        aliases = aliases_by_identity.get(proof_identity, [])
        if len(aliases) != 1: fail("unverified compaction cleanup proof alias")
        alias_name = aliases[0]
        if not PUBLICATION_TEMP.fullmatch(alias_name): fail("unverified compaction cleanup proof alias")
        alias_fd = os.open(alias_name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root)
        try:
            alias_opened = os.fstat(alias_fd)
            named = os.stat(proof_name, dir_fd=root, follow_symlinks=False)
            alias_named = os.stat(alias_name, dir_fd=root, follow_symlinks=False)
            if ((alias_opened.st_dev, alias_opened.st_ino) != proof_identity or
                (named.st_dev, named.st_ino) != proof_identity or named.st_nlink != 2 or
                (alias_named.st_dev, alias_named.st_ino) != proof_identity or alias_named.st_nlink != 2 or
                not stat.S_ISREG(alias_opened.st_mode) or alias_opened.st_uid != os.geteuid() or
                stat.S_IMODE(alias_opened.st_mode) != 0o600 or alias_opened.st_nlink != 2 or
                alias_opened.st_size != info.st_size or
                os.read(alias_fd, alias_opened.st_size + 1) != proof_raw):
                fail("unverified compaction cleanup proof alias")
            os.unlink(alias_name, dir_fd=root)
        finally: os.close(alias_fd)
        os.fsync(root)
        recovered = os.fstat(proof_fd)
        named = os.stat(proof_name, dir_fd=root, follow_symlinks=False)
        if ((recovered.st_dev, recovered.st_ino) != proof_identity or recovered.st_nlink != 1 or
            (named.st_dev, named.st_ino) != proof_identity or named.st_nlink != 1):
            fail("compaction cleanup proof changed during recovery")
        return proof_identity
    finally:
        if retained_fd is None: os.close(proof_fd)

def cleanup_compactions(root, lock):
    try:
        _, _, canonical = read_lease_chain(lock, True)
        names = [name for name in sorted(os.listdir(root)) if COMPACTION.fullmatch(name)]
    except: return
    aliases_by_identity = discover_cleanup_proof_aliases(root)
    for name in names[:MAX_COMPACTION_SIBLINGS]:
        candidate = None
        try:
            match = COMPACTION.fullmatch(name)
            info = os.stat(name, dir_fd=root, follow_symlinks=False)
            if (not match or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or
                stat.S_IMODE(info.st_mode) != 0o700): continue
            candidate = child_dir(root, name)
            opened = os.fstat(candidate)
            named = os.stat(name, dir_fd=root, follow_symlinks=False)
            if (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino):
                fail("compaction journal changed during cleanup")
            entries = sorted(os.listdir(candidate))
            if len(entries) > MAX_COMPACTION_RECORDS: continue
            lease_id, proof_hash, proof_token = match.group(1), match.group(2), match.group(3)
            proof_name = ".mutable-home.cleanup-%s.json" % proof_token
            proof = None
            proof_identity = None
            proof_raw = None
            try:
                proof_fd = os.open(proof_name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=root)
                try:
                    proof_info = os.fstat(proof_fd)
                    if (not stat.S_ISREG(proof_info.st_mode) or proof_info.st_uid != os.geteuid() or
                        stat.S_IMODE(proof_info.st_mode) != 0o600 or proof_info.st_nlink not in (1, 2) or
                        proof_info.st_size > 4096): fail("unverified compaction cleanup proof")
                    proof_raw = os.read(proof_fd, proof_info.st_size + 1)
                    proof = json.loads(proof_raw.decode("utf-8"))
                    proof_identity = (proof_info.st_dev, proof_info.st_ino)
                finally: os.close(proof_fd)
            except FileNotFoundError: pass
            for entry in entries:
                record = os.stat(entry, dir_fd=candidate, follow_symlinks=False)
                if (not stat.S_ISREG(record.st_mode) or record.st_uid != os.geteuid() or
                    stat.S_IMODE(record.st_mode) != 0o600 or record.st_nlink != 1):
                    fail("unverified compaction journal")
            expected_proof = {"version": 1, "name": name, "leaseId": lease_id, "proofHash": proof_hash,
                "device": opened.st_dev, "inode": opened.st_ino}
            if proof is not None:
                if proof != expected_proof: fail("unverified compaction cleanup proof")
                for entry in entries:
                    value, _ = read_lease_record(candidate, entry)
                    if entry == "lease.json":
                        valid_name = value.get("version") == 1
                    elif entry == "lease-%s.json" % value["leaseId"]:
                        valid_name = (value.get("version") == 2 and value.get("state") == "active" and
                            value.get("previousLeaseId") is None and value.get("previousRecordHash") is None)
                    else:
                        valid_name = (value.get("version") == 2 and value.get("previousLeaseId") is not None and
                            entry == "next-%s.json" % value["previousLeaseId"])
                    if not valid_name: fail("unverified compaction journal")
                proof_identity = normalize_cleanup_proof(
                    root, proof_name, proof_identity, proof_raw, aliases_by_identity)
            else:
                if not entries: fail("unverified compaction journal")
                canonical_record = canonical.get(lease_id)
                if canonical_record is None: fail("unverified compaction journal")
                abandoned, abandoned_hash = read_lease_chain(candidate)
                if (abandoned["leaseId"] != lease_id or proof_hash not in
                    (abandoned_hash, canonical_record[0])):
                    fail("unverified compaction journal")
                expected = canonical_record[1]
                if any(abandoned.get(key) != expected.get(key) for key in
                    ("leaseId", "state", "ownerHash", "hostname", "pid", "provider", "createdAt")):
                    fail("unverified compaction journal")
                publish_lease(root, root, proof_name, expected_proof)
                os.fsync(root)
                proof_info = os.stat(proof_name, dir_fd=root, follow_symlinks=False)
                proof_identity = (proof_info.st_dev, proof_info.st_ino)
            named = os.stat(name, dir_fd=root, follow_symlinks=False)
            if (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino):
                fail("compaction journal changed during cleanup")
            for entry in entries: os.unlink(entry, dir_fd=candidate)
            os.fsync(candidate)
            named = os.stat(name, dir_fd=root, follow_symlinks=False)
            if (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino):
                fail("compaction journal changed during cleanup")
            os.close(candidate); candidate = None
            os.rmdir(name, dir_fd=root)
            os.fsync(root)
            proof_info = os.stat(proof_name, dir_fd=root, follow_symlinks=False)
            if proof_identity != (proof_info.st_dev, proof_info.st_ino):
                fail("compaction cleanup proof changed during cleanup")
            os.unlink(proof_name, dir_fd=root)
            os.fsync(root)
        except: pass
        finally:
            if candidate is not None: os.close(candidate)
    try:
        proof_names = [name for name in sorted(os.listdir(root)) if CLEANUP_PROOF.fullmatch(name)]
    except: return
    for proof_name in proof_names[:MAX_COMPACTION_SIBLINGS]:
        proof_fd = None
        try:
            proof_fd = os.open(proof_name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=root)
            info = os.fstat(proof_fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or
                stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink not in (1, 2) or info.st_size > 4096): continue
            proof_raw = os.read(proof_fd, info.st_size + 1)
            proof = json.loads(proof_raw.decode("utf-8"))
            match = CLEANUP_PROOF.fullmatch(proof_name)
            candidate_name = proof.get("name") if isinstance(proof, dict) else None
            candidate_match = COMPACTION.fullmatch(candidate_name) if isinstance(candidate_name, str) else None
            if (not match or not candidate_match or match.group(1) != candidate_match.group(3) or
                proof.get("version") != 1 or proof.get("leaseId") != candidate_match.group(1) or
                proof.get("proofHash") != candidate_match.group(2) or not isinstance(proof.get("device"), int) or
                not isinstance(proof.get("inode"), int)): continue
            try: os.stat(candidate_name, dir_fd=root, follow_symlinks=False)
            except FileNotFoundError:
                proof_identity = normalize_cleanup_proof(
                    root, proof_name, (info.st_dev, info.st_ino), proof_raw, aliases_by_identity, proof_fd)
                verified = os.fstat(proof_fd)
                named = os.stat(proof_name, dir_fd=root, follow_symlinks=False)
                os.lseek(proof_fd, 0, os.SEEK_SET)
                if ((verified.st_dev, verified.st_ino) != proof_identity or
                    (named.st_dev, named.st_ino) != proof_identity or
                    not stat.S_ISREG(verified.st_mode) or verified.st_uid != os.geteuid() or
                    stat.S_IMODE(verified.st_mode) != 0o600 or verified.st_nlink != 1 or
                    verified.st_size > 4096 or os.read(proof_fd, verified.st_size + 1) != proof_raw):
                    fail("compaction cleanup proof changed during cleanup")
                os.unlink(proof_name, dir_fd=root)
                os.fsync(root)
        except: pass
        finally:
            if proof_fd is not None: os.close(proof_fd)

def acquire_lease(home_fd, owner):
    root = walk_dir(home_fd, ".agent-manager/provider-home-leases-v1", True)
    try:
        try:
            os.mkdir("mutable-home.lock", 0o700, dir_fd=root)
            lock = child_dir(root, "mutable-home.lock")
            try:
                value = lease_value(owner, "active")
                publish_lease(root, lock, "lease-%s.json" % value["leaseId"], value)
                os.fsync(root)
                cleanup_compactions(root, lock)
                return root, lock, value["leaseId"]
            except:
                os.close(lock)
                try: os.rmdir("mutable-home.lock", dir_fd=root)
                except: pass
                raise
        except FileExistsError:
            lock = child_dir(root, "mutable-home.lock")
            try:
                existing, existing_hash = read_lease_chain(lock)
                if not (existing.get("version") == 2 and existing.get("state") == "released"):
                    if existing["hostname"] != os.uname().nodename: fail("provider home is leased by another host")
                    if process_alive(existing["pid"]): fail("provider home is already in use")
                    if existing["ownerHash"] != owner: fail("provider home is leased by another runner owner")
                confirmed, confirmed_hash = read_lease_chain(lock)
                if confirmed["leaseId"] != existing["leaseId"] or confirmed_hash != existing_hash:
                    fail("provider home lease changed during recovery")
                value = lease_value(owner, "active", (confirmed["leaseId"], confirmed_hash))
                try: publish_lease(root, lock, "next-%s.json" % confirmed["leaseId"], value)
                except FileExistsError: fail("provider home lease changed during recovery")
                published, _ = read_lease_chain(lock)
                if published.get("state") != "active" or published["leaseId"] != value["leaseId"]:
                    fail("provider home lease changed during recovery")
                cleanup_compactions(root, lock)
                return root, lock, value["leaseId"]
            except:
                os.close(lock); raise
    except:
        os.close(root); raise

def exchange_directories(root, left, right):
    try:
        renameat2 = ctypes.CDLL(None, use_errno=True).renameat2
        renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        renameat2.restype = ctypes.c_int
        return renameat2(root, os.fsencode(left), root, os.fsencode(right), RENAME_EXCHANGE) == 0
    except: return False

def compact_lease(root, lock, current, current_hash):
    if len(os.listdir(lock)) <= MAX_LEASE_RECORDS: return lock
    temporary = ".mutable-home.compact-%s-%s-%s" % (current["leaseId"], current_hash, uuid.uuid4().hex)
    fresh = None
    exchange_attempted = False
    try:
        os.mkdir(temporary, 0o700, dir_fd=root)
        fresh = child_dir(root, temporary)
        genesis = dict(current)
        genesis.update({"previousLeaseId": None, "previousRecordHash": None})
        publish_lease(root, fresh, "lease-%s.json" % genesis["leaseId"], genesis)
        compacted, _ = read_lease_chain(fresh)
        if compacted["leaseId"] != current["leaseId"] or compacted.get("state") != "active":
            fail("provider home lease compaction failed")
        os.fsync(fresh); os.fsync(root)
        exchange_attempted = True
        if not exchange_directories(root, temporary, "mutable-home.lock"):
            fail("provider home lease compaction is unavailable")
    except:
        if fresh is not None:
            try:
                for name in os.listdir(fresh): os.unlink(name, dir_fd=fresh)
            except: pass
            os.close(fresh)
        try: os.rmdir(temporary, dir_fd=root)
        except: pass
        # Compaction is an availability optimization. If this kernel lacks atomic directory
        # exchange, preserve the valid old chain and keep appending. This intentionally favors
        # lease integrity and reconciliation availability over the configured journal bound.
        diagnose("Provider-home lease journal compaction %s; the valid journal remains append-only beyond %d records. Check WSL filesystem support for renameat2(RENAME_EXCHANGE)." %
            ("is unavailable" if exchange_attempted else "failed before exchange", MAX_LEASE_RECORDS))
        return lock
    try: os.fsync(root)
    except: pass
    os.close(lock)
    cleanup_compactions(root, fresh)
    return fresh

def release_lease(lease):
    root, lock, lease_id = lease
    try:
        current, current_hash = read_lease_chain(lock)
        if current.get("version") != 2 or current.get("state") != "active" or current["leaseId"] != lease_id:
            fail("provider home lease changed before release")
        lock = compact_lease(root, lock, current, current_hash)
        current, current_hash = read_lease_chain(lock)
        released = dict(current)
        released.update({"state": "released", "leaseId": str(uuid.uuid4()), "previousLeaseId": current["leaseId"],
            "previousRecordHash": current_hash, "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat()})
        try: publish_lease(root, lock, "next-%s.json" % current["leaseId"], released)
        except FileExistsError: fail("provider home lease changed before release")
    finally:
        os.close(lock); os.close(root)

def load_owned(state_fd):
    try: fd = os.open("links.json", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=state_fd)
    except FileNotFoundError: return set()
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 524288: return set()
        value = json.loads(os.read(fd, info.st_size + 1).decode("utf-8"))
        links = value.get("links") if value.get("version") == 1 else None
        if not isinstance(links, list) or len(links) > 4096 or not all(isinstance(x, str) for x in links): return set()
        return set(links)
    except: return set()
    finally: os.close(fd)

def save_owned(state_fd, owned):
    value = json.dumps({"version": 1, "links": sorted(owned)}, separators=(",", ":")).encode()
    temp = ".links-%s.tmp" % uuid.uuid4().hex
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=state_fd)
    try: write_all(fd, value); os.fsync(fd)
    finally: os.close(fd)
    os.rename(temp, "links.json", src_dir_fd=state_fd, dst_dir_fd=state_fd)
    os.fsync(state_fd)

def owned_shape(relative):
    if not isinstance(relative, str): return None
    parts = relative.split("/")
    if len(parts) != 3 or not NAME.match(parts[2]): return None
    if parts[:2] == [".agents", "skills"]: return (".agents/skills", parts[2])
    if parts[0] in (".claude", ".codex") and parts[1] == "skills": return (parts[0] + "/skills", parts[2])
    return None

def prune_owned(home_fd, owned):
    # A manifest path is removal authority. Drop malformed paths and paths which no longer hold
    # a symlink before a later pass can mistake user-created content for runner-owned state.
    for relative in list(owned):
        shape = owned_shape(relative)
        if shape is None:
            owned.discard(relative); continue
        try:
            parent = walk_dir(home_fd, shape[0])
            try:
                info = os.stat(shape[1], dir_fd=parent, follow_symlinks=False)
                if not stat.S_ISLNK(info.st_mode): owned.discard(relative)
            finally: os.close(parent)
        except: pass

def validated_bindings(value):
    if not isinstance(value, list) or len(value) > 256: fail("invalid WSL skill bindings")
    result = {}
    for item in value:
        if not isinstance(item, dict): fail("invalid WSL skill binding")
        agent_id, driver, relative = item.get("agentId"), item.get("driver"), item.get("relDir")
        if not isinstance(agent_id, str) or not agent_id or len(agent_id) > 256 or any(ord(c) < 32 for c in agent_id):
            fail("invalid WSL skill agent")
        if driver not in DRIVER_DIRS or relative != DRIVER_DIRS[driver] or agent_id in result:
            fail("invalid WSL skill binding")
        result[agent_id] = {"agentId": agent_id, "driver": driver, "relDir": relative}
    return result

def link_probe(parent_fd, name, store_root, canonical=None, owned=False):
    try: info = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError: return ("missing", None)
    if not stat.S_ISLNK(info.st_mode): return ("occupied", None)
    try: target = os.readlink(name, dir_fd=parent_fd)
    except: return ("occupied", None)
    resolved = os.path.normpath(os.path.join(fd_path(parent_fd), target))
    if resolved == store_root or resolved.startswith(store_root + "/"): return ("store", resolved)
    if canonical is not None and resolved == canonical: return (("canonical" if owned else "canonical-unowned"), resolved)
    return ("foreign", resolved)

def ensure_link(home_fd, relative, target, store_root, canonical, owned, gate=None):
    parent_rel, name = relative.rsplit("/", 1)
    parent = None
    try:
        parent = walk_dir(home_fd, parent_rel, True)
        kind, resolved = link_probe(parent, name, store_root, canonical, relative in owned)
        if kind == "occupied": return (False, "conflict", "an unmanaged file or directory already exists at ~/" + relative)
        if kind == "foreign": return (False, "conflict", "an unmanaged symlink already exists at ~/" + relative)
        if kind == "canonical-unowned" and resolved != target:
            return (False, "conflict", "an unmanaged symlink already exists at ~/" + relative)
        if kind in ("store", "canonical", "canonical-unowned") and resolved == target:
            owned.add(relative); return (True, None, None)
        if gate is not None and kind in ("store", "canonical") and not gate(kind, resolved):
            return (False, "conflict", HELD_DETAIL)
        temp = ".%s.tmp-%s" % (name, uuid.uuid4().hex)
        try:
            os.symlink(target, temp, dir_fd=parent)
            os.replace(temp, name, src_dir_fd=parent, dst_dir_fd=parent)
        finally:
            try: os.unlink(temp, dir_fd=parent)
            except FileNotFoundError: pass
        kind, resolved = link_probe(parent, name, store_root, canonical, True)
        if resolved != target or kind not in ("store", "canonical"): fail("link verification failed")
        owned.add(relative); return (True, None, None)
    except Exception as error:
        return (False, "error", "could not create the skill link at ~/%s: %s" % (relative, str(error)))
    finally:
        if parent is not None: os.close(parent)

def unlink_owned(home_fd, relative, store_root, canonical, owned, direct_store=False, gate=None):
    parent_rel, name = relative.rsplit("/", 1)
    try: parent = walk_dir(home_fd, parent_rel)
    except: return False
    try:
        kind, resolved = link_probe(parent, name, store_root, canonical, relative in owned)
        if gate is not None and kind in ("store", "canonical") and not gate(kind, resolved): return False
        if kind == "store" and (direct_store or relative in owned) or kind == "canonical" and relative in owned:
            os.unlink(name, dir_fd=parent); owned.discard(relative); return True
        return False
    finally: os.close(parent)

def generated_artifact(path):
    parts = path.split("/")
    return "__pycache__" in parts or parts[-1] == ".DS_Store"

def copy_digest(store_fd, key):
    # Content digest of one native store copy exactly as the runner's skillVersionDigest computes
    # it (generated artifacts excluded), read through no-follow descriptors. "missing" when the
    # copy is gone; None when it is no longer valid skill content.
    name, version = key.split("/")
    try: name_fd = child_dir(store_fd, name, strict=False)
    except FileNotFoundError: return "missing"
    except Exception: return None
    try:
        try: root = child_dir(name_fd, version, strict=False)
        except FileNotFoundError: return "missing"
        except Exception: return None
    finally: os.close(name_fd)
    files, totals = [], {"entries": 0, "bytes": 0}
    def visit(fd, prefix, depth):
        if depth > 8: raise ValueError("too deep")
        for entry in os.scandir(fd):
            totals["entries"] += 1
            if totals["entries"] > MAX_COPY_ENTRIES: raise ValueError("too many entries")
            path = prefix + entry.name
            info = os.stat(entry.name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode): raise ValueError("symlink")
            if stat.S_ISDIR(info.st_mode):
                child = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try: visit(child, path + "/", depth + 1)
                finally: os.close(child)
                continue
            if not stat.S_ISREG(info.st_mode): raise ValueError("special file")
            if generated_artifact(path): continue
            if len(files) >= MAX_COPY_FILES: raise ValueError("too many files")
            handle = os.open(entry.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            try:
                data = b""
                while len(data) <= MAX_COPY_FILE_BYTES:
                    chunk = os.read(handle, 65536)
                    if not chunk: break
                    data += chunk
            finally: os.close(handle)
            totals["bytes"] += len(data)
            if len(data) > MAX_COPY_FILE_BYTES or totals["bytes"] > MAX_COPY_BYTES: raise ValueError("too large")
            files.append({"path": path, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)})
    try: visit(root, "", 0)
    except Exception: return None
    finally: os.close(root)
    # JavaScript orders strings by UTF-16 code units.
    files.sort(key=lambda item: item["path"].encode("utf-16-be"))
    manifest = json.dumps({"files": files}, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(manifest.encode("utf-8")).hexdigest()

def version_path(store_fd, store_root, name, digest):
    first = child_dir(store_fd, name, strict=False)
    try:
        second = child_dir(first, digest, strict=False)
        try:
            path = fd_path(second)
            if path != store_root + "/" + name + "/" + digest: fail("store version escaped its root")
            return path
        finally: os.close(second)
    finally: os.close(first)

def frontmatter(content, fallback):
    try: text = content.decode("utf-8")
    except: return {"name": fallback}
    lines = text[:MAX_MD].splitlines()
    if not lines or lines[0].strip() != "---": return {"name": fallback}
    result = {"name": fallback}
    for line in lines[1:129]:
        if line.strip() in ("---", "..."): return result
        match = re.match(r"^(name|description)\s*:\s*(.*)$", line)
        if match:
            value = re.sub(r"\s+", " ", match.group(2)).strip().strip("\"'")[:280]
            if match.group(1) == "name":
                if NAME.fullmatch(value): result["name"] = value
            elif value: result["description"] = value
    return {"name": fallback}

def scan_dir(home_fd, relative, store_root, canonical_dir, owned):
    try: directory = walk_dir(home_fd, relative)
    except: return []
    found = []
    try:
        for name in sorted(os.listdir(directory))[:MAX_ENTRIES]:
            kind, _ = link_probe(directory, name, store_root, canonical_dir + "/" + name, relative + "/" + name in owned)
            if kind in ("store", "canonical"): continue
            if kind in ("foreign", "canonical-unowned"):
                if NAME.match(name): found.append({"name": name})
                continue
            if kind != "occupied" or not NAME.match(name): continue
            try:
                skill = child_dir(directory, name)
                try:
                    md = os.open("SKILL.md", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=skill)
                    try:
                        info = os.fstat(md)
                        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1: continue
                        meta = frontmatter(os.read(md, MAX_MD), name)
                    finally: os.close(md)
                finally: os.close(skill)
                found.append(meta)
            except: pass
    finally: os.close(directory)
    return found

def reconcile(spec):
    owner = spec.get("ownerHash", "")
    if not DIGEST.match(owner): fail("invalid owner")
    home_fd, home = open_root(os.environ.get("HOME", ""))
    store_fd, store_root = open_root(spec.get("storeRoot", ""))
    if store_root != spec.get("storeRoot"): fail("store root is not canonical")
    state = walk_dir(home_fd, ".agent-manager/runner-instances/%s/skills" % owner, True)
    lease = None
    try:
        owned = load_owned(state)
        skills = spec.get("skills", [])
        if not isinstance(skills, list) or len(skills) > 4096: fail("invalid WSL skill manifest")
        needs_lease = bool(skills or owned)
        if needs_lease: lease = acquire_lease(home_fd, owner)
        prune_owned(home_fd, owned)
        bindings = validated_bindings(spec.get("bindings", []))
        canonical_dir = home + "/.agents/skills"
        deployed, removals = [], []
        canonical_keep = set()
        harness_keep = {relative: set() for relative in set(DRIVER_DIRS.values())}
        # A link of ours that serves an edited native store copy holds its skill here too; the
        # native pass cannot see links inside this distro.
        drifted = spec.get("drifted", [])
        if not isinstance(drifted, list) or len(drifted) > 4096: fail("invalid WSL drift list")
        drifted_targets = set()
        for item in drifted:
            parts = item.split("/") if isinstance(item, str) else []
            if len(parts) != 2 or not NAME.match(parts[0]) or not DRIFTED_VERSION.match(parts[1]): fail("invalid WSL drift list")
            drifted_targets.add(store_root + "/" + item)
        # Probe each drifted name's link paths directly, recorded or not: ensure_link would replace
        # any direct store link, including one whose ownership record was lost.
        wsl_held = set()
        link_dirs = [".agents/skills"] + sorted(set(DRIVER_DIRS.values()))
        for name in sorted(set(item.split("/")[0] for item in drifted)):
            for rel_dir in link_dirs:
                try: parent = walk_dir(home_fd, rel_dir)
                except: continue
                try:
                    kind, resolved = link_probe(parent, name, store_root)
                    if kind == "store" and resolved in drifted_targets: wsl_held.add(name)
                except: pass
                finally: os.close(parent)
        for name in wsl_held:
            canonical_keep.add(name)
            for keep in harness_keep.values(): keep.add(name)
        # Scan-time digests of copies that were unedited (or captured) when the native pass verified
        # them. A copy edited since then must not lose the links that serve it.
        movable = spec.get("movable")
        if movable is not None and (not isinstance(movable, dict) or len(movable) > 8192): fail("invalid WSL movable list")
        for key, value in (movable or {}).items():
            parts = key.split("/")
            if len(parts) != 2 or not NAME.match(parts[0]) or not DRIFTED_VERSION.match(parts[1]) or \
                    not isinstance(value, str) or not DIGEST.match(value): fail("invalid WSL movable list")
        late_drift = {}
        def served_copy(kind, resolved):
            target = resolved
            if kind == "canonical":
                try: target = os.path.normpath(os.path.join(os.path.dirname(resolved), os.readlink(resolved)))
                except OSError: return None
            if not target.startswith(store_root + "/"): return None
            rest = target[len(store_root) + 1:].split("/")
            if len(rest) != 2 or not NAME.match(rest[0]) or not DRIFTED_VERSION.match(rest[1]): return None
            return rest[0] + "/" + rest[1]
        def may_stop_serving(kind, resolved):
            key = served_copy(kind, resolved)
            # Without scan-time digests (the native store could not be verified) nothing is gated.
            if key is None or movable is None: return True
            current = copy_digest(store_fd, key)
            if current == "missing" or (current is not None and current == movable.get(key)): return True
            late_drift[key] = current
            wsl_held.add(key.split("/")[0])
            canonical_keep.add(key.split("/")[0])
            for keep in harness_keep.values(): keep.add(key.split("/")[0])
            return False
        for skill in skills:
            name, digest = skill.get("name"), skill.get("versionDigest")
            if (skill.get("held") is True or name in wsl_held) and isinstance(name, str) and NAME.match(name):
                # The native store copy was edited: leave every link for this name untouched.
                canonical_keep.add(name)
                for keep in harness_keep.values(): keep.add(name)
                targets = skill.get("targets") if isinstance(skill.get("targets"), list) else []
                if targets and isinstance(digest, str) and DIGEST.match(digest):
                    deployed.append({"name": name, "digest": digest, "links": [
                        {"agentId": str(target.get("agentId")), "status": "conflict", "detail": HELD_DETAIL}
                        if bindings.get(target.get("agentId")) else
                        {"agentId": str(target.get("agentId")), "status": "unsupported", "detail": "this WSL agent is not present on the runner"}
                        for target in targets if isinstance(target, dict)]})
                continue
            row = {"name": str(name), "digest": str(digest), "links": []}
            if not isinstance(name, str) or not NAME.match(name) or not isinstance(digest, str) or not DIGEST.match(digest):
                if isinstance(name, str) and NAME.match(name):
                    canonical_keep.add(name)
                    for keep in harness_keep.values(): keep.add(name)
                row["error"] = "invalid WSL skill manifest"; deployed.append(row); continue
            targets = skill.get("targets")
            if not isinstance(targets, list):
                canonical_keep.add(name)
                for keep in harness_keep.values(): keep.add(name)
                row["error"] = "invalid WSL skill targets"; deployed.append(row); continue
            plans, manual_unsupported = {}, []
            for target in targets:
                agent_id, invocation = target.get("agentId"), target.get("invocation")
                binding = bindings.get(agent_id)
                if not binding:
                    row["links"].append({"agentId": str(agent_id), "status": "unsupported", "detail": "this WSL agent is not present on the runner"}); continue
                if invocation == "manual" and binding["driver"] != "claude-code":
                    manual_unsupported.append((agent_id, binding["relDir"])); continue
                if invocation not in ("agent", "manual"):
                    row["links"].append({"agentId": str(agent_id), "status": "error", "detail": "invalid invocation policy"}); continue
                plan = plans.setdefault(binding["relDir"], {"agent": [], "manual": []})
                plan[invocation].append(agent_id); harness_keep[binding["relDir"]].add(name)
            if not plans:
                for agent_id, _ in manual_unsupported:
                    row["links"].append({"agentId": agent_id, "status": "unsupported", "detail": "Manual-only invocation is not supported for this agent."})
                deployed.append(row); continue
            try:
                base = version_path(store_fd, store_root, name, digest)
                manual = version_path(store_fd, store_root, name, digest + "-manual") if any(p["manual"] for p in plans.values()) else None
            except Exception as error:
                canonical_keep.add(name)
                for keep in harness_keep.values(): keep.add(name)
                row["error"] = "WSL skill store unavailable: " + str(error)
                for target in targets: row["links"].append({"agentId": str(target.get("agentId")), "status": "error", "detail": "the skill version is unavailable inside this WSL distro"})
                deployed.append(row); continue
            canonical_keep.add(name)
            canonical_rel = ".agents/skills/" + name
            canonical_ok, canonical_status, canonical_detail = ensure_link(home_fd, canonical_rel, base, store_root, None, owned, may_stop_serving)
            if not canonical_ok and name in wsl_held:
                for target in targets:
                    row["links"].append({"agentId": str(target.get("agentId")), "status": "conflict", "detail": HELD_DETAIL}
                        if bindings.get(target.get("agentId")) else
                        {"agentId": str(target.get("agentId")), "status": "unsupported", "detail": "this WSL agent is not present on the runner"})
                deployed.append(row); continue
            if not canonical_ok: row["error"] = "canonical link: " + canonical_detail
            targeted = set(t.get("agentId") for t in targets)
            linked_dirs = set()
            for rel_dir, plan in plans.items():
                mixed = bool(plan["agent"] and plan["manual"])
                use_manual = bool(plan["manual"] and not plan["agent"])
                relative = rel_dir + "/" + name
                if use_manual:
                    outcome = ensure_link(home_fd, relative, manual, store_root, canonical_dir + "/" + name, owned, may_stop_serving)
                elif not canonical_ok:
                    removed = unlink_owned(home_fd, relative, store_root, canonical_dir + "/" + name, owned, gate=may_stop_serving)
                    if removed:
                        harness_keep[rel_dir].discard(name)
                        removals.append({"path": "~/%s (WSL %s)" % (relative, spec["distro"]),
                            "reason": "The canonical location it routes through is conflicted."})
                        outcome = (False, "error", "the canonical location is conflicted, so this harness link was removed")
                    else:
                        outcome = (False, canonical_status, "canonical link: " + canonical_detail)
                else:
                    outcome = ensure_link(home_fd, relative, canonical_dir + "/" + name, store_root, canonical_dir + "/" + name, owned, may_stop_serving)
                linked_ids = plan["manual"] if use_manual else plan["agent"] + ([] if mixed else plan["manual"])
                for agent_id in linked_ids:
                    row["links"].append({"agentId": agent_id, "status": "linked"} if outcome[0] else
                        {"agentId": agent_id, "status": outcome[1], "detail": outcome[2]})
                if outcome[0]:
                    linked_dirs.add(rel_dir)
                    for other in bindings.values():
                        if other["relDir"] == rel_dir and other["agentId"] not in targeted:
                            row["links"].append({"agentId": other["agentId"], "status": "linked", "detail": "Shared harness directory; also visible to this agent."})
                if mixed:
                    for agent_id in plan["manual"]:
                        row["links"].append({"agentId": agent_id, "status": "conflict", "detail": "another agent shares this WSL harness directory and requires model invocation for this skill"})
            for agent_id, rel_dir in manual_unsupported:
                row["links"].append({"agentId": agent_id, "status": "conflict", "detail": "Manual-only invocation is not supported for this agent and the skill is still visible through the shared harness directory."} if rel_dir in linked_dirs else
                    {"agentId": agent_id, "status": "unsupported", "detail": "Manual-only invocation is not supported for this agent."})
            deployed.append(row)
        if spec.get("allowRemovals") is True:
            for relative in list(owned):
                parts = relative.split("/")
                remove, canonical, direct = False, None, False
                if len(parts) == 3 and parts[:2] == [".agents", "skills"] and NAME.match(parts[2]):
                    remove, direct = parts[2] not in canonical_keep, True
                elif len(parts) == 3 and parts[0] in (".claude", ".codex") and parts[1] == "skills" and NAME.match(parts[2]):
                    rel_dir = parts[0] + "/skills"
                    remove = rel_dir in harness_keep and parts[2] not in harness_keep[rel_dir]
                    canonical = canonical_dir + "/" + parts[2]
                if remove and unlink_owned(home_fd, relative, store_root, canonical, owned, direct, may_stop_serving):
                    removals.append({"path": "~/%s (WSL %s)" % (relative, spec["distro"]), "reason": "No longer in the desired skill list."})
        if needs_lease: save_owned(state, owned)
        unmanaged = []
        cache = {}
        for binding in bindings.values():
            rel_dir = binding["relDir"]
            if rel_dir not in cache: cache[rel_dir] = scan_dir(home_fd, rel_dir, store_root, canonical_dir, owned)
            found = cache[rel_dir]
            for item in found:
                row = {"agentId": binding["agentId"], "name": item["name"]}
                if item.get("description"): row["description"] = item["description"]
                unmanaged.append(row)
        return {"deployed": deployed, "unmanaged": unmanaged, "removedLinks": removals, "warnings": diagnostics,
            "held": sorted(wsl_held),
            "lateDrift": [dict({"name": key.split("/")[0], "version": key.split("/")[1]},
                **({"observedDigest": value} if value else {})) for key, value in sorted(late_drift.items())]}
    finally:
        if lease is not None: release_lease(lease)
        os.close(state); os.close(store_fd); os.close(home_fd)

# Recoverable adoption. Mirrors the Linux runner transaction in-distro: descriptor-anchored,
# no-follow walks from the pinned HOME, two content passes against the approved digest, a private
# journal, a no-replace rename of the original, and an exclusive managed link. Nothing is unlinked,
# overwritten, or restored automatically; every stop after "journal" leaves recovery evidence.
JOURNAL_PREFIX = ".wollipog-adoption-"
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
IDENTITY = re.compile(r"^[0-9]+:[0-9]+$")
RELATIVE_PATTERN = re.compile(r"^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$")
RENAME_NOREPLACE = 1
MAX_SKILL_FILES = 64
MAX_SKILL_FILE_BYTES = 512 * 1024
MAX_SKILL_TOTAL_BYTES = 2 * 1024 * 1024
MAX_SKILL_ENTRIES = 256
MAX_RECOVERY_RAW = 4096
MAX_RECOVERY_OPERATIONS = 64
MAX_JOURNAL_BYTES = 8192

def valid_relative(value):
    # A fixed harness-relative directory: plain segments, never "." or "..".
    return (isinstance(value, str) and len(value) <= 64 and RELATIVE_PATTERN.fullmatch(value) is not None and
        not any(part in (".", "..") for part in value.split("/")))

def emit(line):
    sys.stdout.write(line + "\n"); sys.stdout.flush()

def checkpoint(stage):
    # Test-only fault injection. Windows does not forward these variables into WSL unless WSLENV
    # names them, and the runner never does.
    if os.environ.get("WOLLIPOG_SKILL_ADOPTION_TEST_CHECKPOINT") != stage: return
    control = os.environ.get("WOLLIPOG_SKILL_ADOPTION_TEST_CONTROL", "")
    if not control: return
    emit("checkpoint")
    deadline = time.time() + 60
    while not os.path.exists(control):
        if time.time() > deadline: fail("checkpoint was not released")
        time.sleep(0.05)
    with open(control) as handle: command = handle.read().strip()
    if command == "k": os.kill(os.getpid(), signal.SIGKILL)
    if command != "c": fail("checkpoint failure")

def identity(fd):
    info = os.fstat(fd)
    return "%d:%d" % (info.st_dev, info.st_ino)

def open_directory(parent, name):
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)

def walk(root, relative, durable=False, strict=False):
    # A strict walk applies reconciliation's ownership rule to harness directories, so adoption
    # never publishes a link where WSL reconciliation would refuse to manage it.
    fd = os.dup(root)
    try:
        for segment in relative.split("/"):
            if not segment or segment in (".", "..") or "\\" in segment: fail("invalid path segment")
            following = open_directory(fd, segment)
            info = os.fstat(following)
            if strict and (info.st_uid != os.geteuid() or info.st_mode & 0o022):
                os.close(following); fail("unsafe directory ownership")
            if durable: os.fsync(fd)
            os.close(fd); fd = following
        return fd
    except:
        os.close(fd); raise

def check_path(root, relative, expected):
    fd = walk(root, relative)
    try:
        if identity(fd) != expected: fail("the recorded path changed")
    finally: os.close(fd)

def entry_kind(parent, name):
    try: info = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError: return "absent"
    return "directory" if stat.S_ISDIR(info.st_mode) else "link" if stat.S_ISLNK(info.st_mode) else "other"

def read_link(parent, name):
    try: return os.readlink(name, dir_fd=parent)
    except OSError: return None

def validate_skill_path(path):
    # Mirrors validSkillFilePath; the exact path participates in the canonical version digest.
    try: units = len(path.encode("utf-16-le")) // 2
    except UnicodeEncodeError: fail("invalid skill file path")
    if (units == 0 or units > 256 or path.startswith("/") or "\\" in path or re.match(r"^[A-Za-z]:", path) or
        any(ord(character) < 0x20 or ord(character) == 0x7f for character in path)): fail("invalid skill file path")
    parts = path.split("/")
    if len(parts) > 8 or any(part in ("", ".", "..") for part in parts): fail("invalid skill file path")

def tree_digest(root, reject_executable, durable):
    # Mirrors skillVersionDigest: SHA-256 over {"files":[{"path","sha256","size"}]} ordered by UTF-16
    # code units, with the same bounds as the runner's no-follow snapshot reader.
    files, budget = [], {"entries": 0, "bytes": 0}
    def visit(directory, prefix, depth):
        if depth > 16: fail("skill tree is too deep")
        for name in os.listdir(directory):
            budget["entries"] += 1
            if budget["entries"] > MAX_SKILL_ENTRIES: fail("skill tree has too many entries")
            path = prefix + name
            validate_skill_path(path)
            info = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                child = open_directory(directory, name)
                try: visit(child, path + "/", depth + 1)
                finally: os.close(child)
                continue
            if not stat.S_ISREG(info.st_mode) or len(files) >= MAX_SKILL_FILES: fail("unsupported skill entry")
            child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            try:
                before = os.fstat(child)
                if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > MAX_SKILL_FILE_BYTES or
                    budget["bytes"] + before.st_size > MAX_SKILL_TOTAL_BYTES): fail("unsupported skill file")
                if reject_executable and before.st_mode & 0o111: fail("executable files are not adopted")
                content, total = hashlib.sha256(), 0
                while True:
                    chunk = os.pread(child, 65536, total)
                    if not chunk: break
                    total += len(chunk)
                    if total > before.st_size: fail("skill file changed")
                    content.update(chunk)
                after = os.fstat(child)
                if total != before.st_size or (after.st_dev, after.st_ino, after.st_size, after.st_nlink, after.st_mtime_ns,
                    after.st_ctime_ns) != (before.st_dev, before.st_ino, before.st_size, before.st_nlink,
                    before.st_mtime_ns, before.st_ctime_ns): fail("skill file changed")
                if durable: os.fsync(child)
            finally: os.close(child)
            budget["bytes"] += before.st_size
            files.append((path, content.hexdigest(), before.st_size))
        if durable: os.fsync(directory)
    visit(root, "", 0)
    if not any(path == "SKILL.md" for path, _, _ in files): fail("SKILL.md is missing")
    files.sort(key=lambda entry: entry[0].encode("utf-16-be"))
    manifest = json.dumps({"files": [{"path": path, "sha256": sha, "size": size} for path, sha, size in files]},
        separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(manifest.encode("utf-8")).hexdigest()

def directory_generation(fd):
    info = os.fstat(fd)
    entries = sorted((name, entry_kind(fd, name)) for name in os.listdir(fd))
    return (info.st_dev, info.st_ino, info.st_mtime_ns, info.st_ctime_ns, tuple(entries))

def check_content(fd, digest, reject_executable):
    before = directory_generation(fd)
    if (tree_digest(fd, reject_executable, True) != digest or tree_digest(fd, reject_executable, True) != digest or
        directory_generation(fd) != before): fail("skill content changed")

def read_record(parent, name):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_JOURNAL_BYTES: fail("unsafe journal record")
        raw = os.read(fd, MAX_JOURNAL_BYTES + 1)
        if len(raw) != info.st_size: fail("journal record changed")
        return raw
    finally: os.close(fd)

def record(parent, name, value, once=False):
    # Exclusive create and flush. A write-once record accepts only identical existing bytes.
    raw = json.dumps(value, separators=(",", ":")).encode()
    try: fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    except FileExistsError:
        if once and read_record(parent, name) == raw: return
        raise
    try: write_all(fd, raw); os.fsync(fd)
    finally: os.close(fd)
    os.fsync(parent)

def rename_noreplace(source_parent, source, target_parent, target):
    try:
        renameat2 = ctypes.CDLL(None, use_errno=True).renameat2
        renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        renameat2.restype = ctypes.c_int
    except AttributeError: renameat2 = None
    if renameat2 is not None:
        if renameat2(source_parent, os.fsencode(source), target_parent, os.fsencode(target), RENAME_NOREPLACE) == 0: return
        code = ctypes.get_errno()
        if code not in (errno.ENOSYS, errno.EINVAL): raise OSError(code, os.strerror(code))
    # Filesystems without RENAME_NOREPLACE keep the Linux runner's semantics inside a private journal.
    if entry_kind(target_parent, target) != "absent": fail("the rename target is occupied")
    os.rename(source, target, src_dir_fd=source_parent, dst_dir_fd=target_parent)

def store_root_text(spec):
    # Recovery names the managed link by text only, so it must work after the store is lost.
    value = spec.get("storeRoot")
    if not isinstance(value, str) or not value.startswith("/") or len(value) > 4096 or any(c in value for c in "\0\r\n"):
        fail("invalid store root")
    return value

def adoption_roots(spec, open_store=True):
    owner = spec.get("ownerHash", "")
    if not isinstance(owner, str) or not DIGEST.fullmatch(owner): fail("invalid owner")
    store_root = store_root_text(spec)
    home_fd, home = open_root(os.environ.get("HOME", ""))
    if not open_store: return owner, home_fd, home, None, store_root
    try: store_fd, resolved = open_root(store_root)
    except:
        os.close(home_fd); raise
    if resolved != store_root:
        os.close(store_fd); os.close(home_fd); fail("store root is not canonical")
    return owner, home_fd, home, store_fd, store_root

def adopt(spec):
    local, source_directory = spec.get("localSourceDirectory"), spec.get("sourceDirectory")
    name, generation, digest, operation = spec.get("name"), spec.get("generation"), spec.get("digest"), spec.get("operationId")
    if (not isinstance(local, str) or not valid_relative(local) or not isinstance(source_directory, str) or
        not valid_relative(source_directory) or not isinstance(name, str) or not NAME.fullmatch(name) or
        not isinstance(generation, str) or not DIGEST.fullmatch(generation) or not isinstance(digest, str) or
        not DIGEST.fullmatch(digest) or not isinstance(operation, str) or not UUID.fullmatch(operation)):
        fail("invalid adoption request")
    owner, home_fd, home, store_fd, store_root = adoption_roots(spec)
    opened, lease = [], None
    def keep(fd):
        opened.append(fd); return fd
    try:
        lease = acquire_lease(home_fd, owner)
        target_relative = name + "/" + digest
        target_path = store_root + "/" + target_relative
        source_path = home + "/" + local + "/" + name
        if target_path == source_path or target_path.startswith(source_path + "/") or source_path.startswith(target_path + "/"):
            fail("source and store overlap")
        parent = keep(walk(home_fd, local, True, True))
        source = keep(open_directory(parent, name))
        target = keep(walk(store_fd, target_relative, True))
        if fd_path(target) != target_path: fail("store version escaped its root")
        parent_id, source_id, target_id = identity(parent), identity(source), identity(target)
        def check_source():
            check_path(home_fd, local, parent_id)
            check_path(home_fd, local + "/" + name, source_id)
            check_content(source, digest, True)
        def check_target():
            check_path(store_fd, target_relative, target_id)
            check_content(target, digest, False)
        check_source()
        check_target()
        backup_name = JOURNAL_PREFIX + operation
        backup_relative = local + "/" + backup_name
        original_relative = backup_relative + "/original"
        emit("journal")
        os.mkdir(backup_name, 0o700, dir_fd=parent)
        backup = keep(open_directory(parent, backup_name))
        backup_id = identity(backup)
        record(backup, "intent.json", {"format": 1, "operationId": operation, "sourceDirectory": source_directory,
            "name": name, "digest": digest, "generation": generation, "sourceIdentity": source_id,
            "parentIdentity": parent_id, "targetIdentity": target_id,
            "targetRelative": "skills/store/" + target_relative})
        os.fsync(parent)
        checkpoint("intent_durable")
        check_source()
        check_path(store_fd, target_relative, target_id)
        # The original may only move into the journal that recovery inspection will find.
        check_path(home_fd, backup_relative, backup_id)
        rename_noreplace(parent, name, backup, "original")
        os.fsync(backup); os.fsync(parent)
        checkpoint("source_preserved")
        preserved = keep(open_directory(backup, "original"))
        if identity(preserved) != source_id: fail("the preserved original changed")
        check_content(preserved, digest, True)
        record(backup, "preserved.json", {"sourceIdentity": source_id, "digest": digest})
        check_path(home_fd, local, parent_id)
        check_path(home_fd, original_relative, source_id)
        check_target()
        # symlink() fails with EEXIST rather than replacing anything created during the rename gap.
        os.symlink(target_path, name, dir_fd=parent)
        os.fsync(parent)
        checkpoint("link_created")
        check_path(home_fd, local, parent_id)
        check_path(home_fd, original_relative, source_id)
        check_target()
        if read_link(parent, name) != target_path: fail("the published link changed")
        record(backup, "linked.json", {"digest": digest})
        emit("adopted")
    finally:
        for fd in reversed(opened):
            try: os.close(fd)
            except OSError: pass
        try:
            if lease is not None: release_lease(lease)
        finally:
            os.close(store_fd); os.close(home_fd)

def inspect_journal(parent, entry, operation, home, local, store_root):
    try: backup = open_directory(parent, entry)
    except OSError: return None
    try:
        try: intent = read_record(backup, "intent.json").decode("utf-8")
        except Exception: return None
        journal = {"OperationId": operation, "Intent": intent, "Name": "", "Digest": "", "OriginalIdentity": "",
            "Kind": 3, "SourceIdentity": "", "Role": 0}
        try:
            original = open_directory(backup, "original")
            try: journal["OriginalIdentity"] = identity(original)
            finally: os.close(original)
        except OSError: pass
        try: parsed = json.loads(intent)
        except Exception: parsed = None
        name = parsed.get("name") if isinstance(parsed, dict) else None
        digest = parsed.get("digest") if isinstance(parsed, dict) else None
        if isinstance(name, str) and NAME.fullmatch(name) and isinstance(digest, str) and DIGEST.fullmatch(digest):
            journal["Name"], journal["Digest"] = name, digest
            kind = entry_kind(parent, name)
            journal["Kind"] = {"absent": 0, "directory": 1, "link": 2, "other": 3}[kind]
            if kind == "directory":
                try:
                    source = open_directory(parent, name)
                    try: journal["SourceIdentity"] = identity(source)
                    finally: os.close(source)
                except OSError: pass
            elif kind == "link":
                target = read_link(parent, name)
                managed = store_root + "/" + name + "/" + digest if store_root else None
                recovery = home + "/" + local + "/" + entry + "/original"
                journal["Role"] = 1 if managed and target == managed else 2 if target == recovery else 3
        return journal
    finally: os.close(backup)

def inspect(spec):
    local, only = spec.get("localSourceDirectory"), spec.get("operationId") or None
    if not isinstance(local, str) or not valid_relative(local) or (only is not None and (not isinstance(only, str) or
        not UUID.fullmatch(only))): fail("invalid inspection")
    result = {"parentIdentity": "", "journals": [], "truncated": False}
    store_root = store_root_text(spec)
    try: home_fd, home = open_root(os.environ.get("HOME", ""))
    except OSError: return result
    try:
        try: parent = walk(home_fd, local)
        except OSError: return result
        try:
            result["parentIdentity"] = identity(parent)
            if only is not None:
                # A targeted lookup opens the named journal directly, like Linux restore.
                journal = inspect_journal(parent, JOURNAL_PREFIX + only, only, home, local, store_root)
                if journal is not None: result["journals"].append(journal)
                return result
            raw = 0
            with os.scandir(parent) as entries:
                for entry in entries:
                    raw += 1
                    if raw > MAX_RECOVERY_RAW:
                        result["truncated"] = True; break
                    if not entry.name.startswith(JOURNAL_PREFIX): continue
                    operation = entry.name[len(JOURNAL_PREFIX):]
                    if not UUID.fullmatch(operation): continue
                    if len(result["journals"]) >= MAX_RECOVERY_OPERATIONS:
                        result["truncated"] = True; break
                    journal = inspect_journal(parent, entry.name, operation, home, local, store_root)
                    if journal is not None: result["journals"].append(journal)
            return result
        finally: os.close(parent)
    finally: os.close(home_fd)

def restore(spec):
    local, operation, name, digest = spec.get("localSourceDirectory"), spec.get("operationId"), spec.get("name"), spec.get("digest")
    parent_expected, source_expected = spec.get("parentIdentity"), spec.get("sourceIdentity")
    if (not isinstance(local, str) or not valid_relative(local) or not isinstance(operation, str) or
        not UUID.fullmatch(operation) or not isinstance(name, str) or not NAME.fullmatch(name) or
        not isinstance(digest, str) or not DIGEST.fullmatch(digest) or not isinstance(parent_expected, str) or
        not IDENTITY.fullmatch(parent_expected) or not isinstance(source_expected, str) or
        not IDENTITY.fullmatch(source_expected)): fail("invalid restore request")
    owner, home_fd, home, _, store_root = adoption_roots(spec, open_store=False)
    opened, lease = [], None
    def keep(fd):
        opened.append(fd); return fd
    try:
        lease = acquire_lease(home_fd, owner)
        emit("leased")
        parent = keep(walk(home_fd, local, True, True))
        if identity(parent) != parent_expected: fail("the source parent identity changed")
        backup_name = JOURNAL_PREFIX + operation
        backup_relative = local + "/" + backup_name
        original_relative = backup_relative + "/original"
        backup = keep(open_directory(parent, backup_name))
        backup_id = identity(backup)
        original = keep(open_directory(backup, "original"))
        if identity(original) != source_expected or tree_digest(original, False, True) != digest:
            fail("the preserved original changed")
        record(backup, "restore-intent.json", {"operationId": operation, "sourceIdentity": source_expected}, True)
        checkpoint("restore_intent_durable")
        managed = store_root + "/" + name + "/" + digest
        recovery = home + "/" + original_relative
        source_kind, preserved_kind = entry_kind(parent, name), entry_kind(backup, "managed-link")
        if source_kind == "link":
            if preserved_kind != "absent" or read_link(parent, name) != managed: fail("the source is not the managed link")
            # Moving the live link is only safe into the journal that recovery inspection will find.
            check_path(home_fd, local, parent_expected)
            check_path(home_fd, backup_relative, backup_id)
            rename_noreplace(parent, name, backup, "managed-link")
            os.fsync(parent); os.fsync(backup)
            source_kind, preserved_kind = "absent", "link"
        if preserved_kind == "link":
            if read_link(backup, "managed-link") != managed: fail("the preserved managed link changed")
            record(backup, "managed-link-preserved.json", {"target": managed}, True)
            checkpoint("managed_link_preserved")
        elif preserved_kind != "absent": fail("the preserved managed link is not a link")
        if source_kind != "absent": fail("the source path is occupied")
        # The link text names the original by path, so its parent and journal must still be where
        # that path leads on both sides of publication.
        check_path(home_fd, local, parent_expected)
        check_path(home_fd, original_relative, source_expected)
        os.symlink(recovery, name, dir_fd=parent)
        os.fsync(parent)
        checkpoint("recovery_link_created")
        check_path(home_fd, local, parent_expected)
        check_path(home_fd, original_relative, source_expected)
        resolved = os.stat(name, dir_fd=parent)
        if (read_link(parent, name) != recovery or "%d:%d" % (resolved.st_dev, resolved.st_ino) != source_expected or
            identity(original) != source_expected or tree_digest(original, False, True) != digest):
            fail("the recovery link changed")
        record(backup, "restored.json", {"sourceIdentity": source_expected, "digest": digest}, True)
        emit("restored")
    finally:
        for fd in reversed(opened):
            try: os.close(fd)
            except OSError: pass
        try:
            if lease is not None: release_lease(lease)
        finally:
            os.close(home_fd)

def main(spec):
    operation = spec.get("operation", "reconcile") if isinstance(spec, dict) else None
    if operation == "reconcile": print(json.dumps(reconcile(spec), separators=(",", ":")))
    elif operation == "adopt": adopt(spec)
    elif operation == "inspect": print(json.dumps(inspect(spec), separators=(",", ":")))
    elif operation == "restore": restore(spec)
    else: fail("invalid helper operation")

try:
    main(bounded_json())
except Exception as error:
    print(json.dumps({"error": str(error)}, separators=(",", ":")))
    sys.exit(1)
`;
