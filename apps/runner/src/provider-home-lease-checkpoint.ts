/** Negotiated canonical checkpoint limits. Readers and writers use the same fixed limits; an
 * older reader refuses version 4. Limits include interrupted retirement and publication state. */
export const LEASE_CHECKPOINT_LIMITS = Object.freeze({
  compactAfter: 16,
  hardTransitions: 32,
  directoryEntries: 256,
  migrationEntries: 4_096,
  retirementEntries: 8_192,
  checkpointBytes: 2_097_152,
  retainedEntries: 32,
  verificationRecords: 131_072,
  verificationBytes: 268_435_456,
});

export interface LeaseRetirementEntry {
  directory: "root" | "lock";
  name: string;
  hash: string;
  device: string;
  inode: string;
}

export interface LeaseCheckpointProof {
  migration: boolean;
  previousTip: string;
  previousTipHash: string;
  previousAnchorHash: string;
  previousHistoryHash: string;
  guardHash: string;
  guardDevice: string;
  guardInode: string;
  historyHash: string;
  retired: LeaseRetirementEntry[];
}

/** The in-distro counterpart operates exclusively on already opened no-follow directories. */
export const LEASE_CHECKPOINT_PYTHON = String.raw`
CHECKPOINT_LIMITS = ${JSON.stringify(LEASE_CHECKPOINT_LIMITS)}
CHECKPOINT_SLOTS = (".mutable-home.checkpoint.pending", ".mutable-home.checkpoint.pending-2")
FORMAT_GUARD = "protocol-v4.json"
verification_work = None

def with_verification_budget(action, fresh=False):
    global verification_work
    if not fresh and verification_work is not None: return action()
    previous = verification_work
    verification_work = {"records": 0, "bytes": 0}
    try: return action()
    finally: verification_work = previous

def spend_verification_work(records, byte_count):
    if verification_work is None: return
    verification_work["records"] += records
    verification_work["bytes"] += byte_count
    if (verification_work["records"] > CHECKPOINT_LIMITS["verificationRecords"] or
        verification_work["bytes"] > CHECKPOINT_LIMITS["verificationBytes"]):
        fail("provider-home lease verification work limit exceeded; preserve all evidence")

def verification_hash(value):
    raw = value.encode() if isinstance(value, str) else value
    spend_verification_work(0, len(raw))
    return hashlib.sha256(raw).hexdigest()

def bounded_lease_entries(directory):
    entries = []
    with os.scandir(directory) as iterator:
        for entry in iterator:
            if len(entries) == CHECKPOINT_LIMITS["migrationEntries"]: fail("provider-home lease scan limit exceeded")
            entries.append(entry.name)
    return sorted(entries)

def canonical_root_entries(root):
    entries = bounded_lease_entries(root)
    for name in entries:
        if name == "mutable-home.lock": continue
        temporary = PUBLICATION_TEMP.fullmatch(name)
        if not (temporary or name in CHECKPOINT_SLOTS or name in ("mutable-home.recovery.json", ".mutable-home.retired") or re.fullmatch(r"next-([0-9a-f-]+)\.json", name)):
            fail("unexpected canonical lease entries")
        info = os.stat(name, dir_fd=root, follow_symlinks=False)
        if (not stat.S_ISREG(info.st_mode) or info.st_size > (4096 if temporary else CHECKPOINT_LIMITS["checkpointBytes"]) or
            info.st_nlink < 1 or info.st_nlink > 3 or info.st_uid != os.geteuid() or info.st_mode & 0o022):
            fail("unsafe canonical lease entries")
    return entries

def checkpoint_history(proof):
    value = [proof["previousHistoryHash"], proof["previousAnchorHash"], proof["previousTipHash"], proof["guardHash"], proof["guardDevice"], proof["guardInode"], proof["migration"],
        [[entry[key] for key in ("directory", "name", "hash", "device", "inode")] for entry in proof["retired"]]]
    return verification_hash(json.dumps(value, separators=(",", ":"), ensure_ascii=False))

def verify_checkpoint(value):
    proof = value.get("checkpoint")
    if (value.get("version") != 4 or value.get("state") != "active" or value.get("previousLeaseId") is not None or
        value.get("previousRecordHash") is not None or not DIGEST.fullmatch(value.get("recoveredEntriesHash", "")) or
        not isinstance(proof, dict) or not isinstance(proof.get("previousTip"), str) or
        len(proof["previousTip"].encode()) > 4096 or
        any(not isinstance(proof.get(key), str) or not DIGEST.fullmatch(proof[key]) for key in
            ("previousTipHash", "previousAnchorHash", "previousHistoryHash", "historyHash", "guardHash")) or
        not isinstance(proof.get("migration"), bool) or not exact_identity(proof.get("guardDevice"), proof.get("guardInode")) or
        not isinstance(proof.get("retired"), list) or len(proof["retired"]) > CHECKPOINT_LIMITS["retirementEntries"]):
        fail("provider-home checkpoint proof is invalid")
    tip = json.loads(proof["previousTip"])
    if (not isinstance(tip, dict) or tip.get("version") != 2 or tip.get("state") != "active" or
        verification_hash(proof["previousTip"]) != proof["previousTipHash"] or
        any(tip.get(key) != value.get(key) for key in ("leaseId", "ownerHash", "pid", "hostname", "provider", "createdAt"))):
        fail("provider-home checkpoint identity is invalid")
    seen = set()
    for entry in proof["retired"]:
        if not isinstance(entry, dict): fail("provider-home checkpoint manifest is invalid")
        directory, name = entry.get("directory"), entry.get("name")
        valid = isinstance(name, str) and (directory == "root" and (name in (*CHECKPOINT_SLOTS, ".mutable-home.retired") or re.fullmatch(r"next-([0-9a-f-]+)\.json", name)) or
            directory == "lock" and (name == "checkpoint.json" or re.fullmatch(r"(lease|next)-([0-9a-f-]+)\.json", name)))
        key = (directory, name)
        if (not valid or key in seen or not isinstance(entry.get("hash"), str) or not DIGEST.fullmatch(entry["hash"]) or
            directory == "root" and name == "next-%s.json" % value["leaseId"] or
            not exact_identity(entry.get("device"), entry.get("inode"))):
            fail("provider-home checkpoint manifest is invalid")
        seen.add(key)
    if not tip.get("previousLeaseId") or not any(entry["directory"] == "root" and
        entry["name"] == "next-%s.json" % tip["previousLeaseId"] and entry["hash"] == proof["previousTipHash"] for entry in proof["retired"]):
        fail("provider-home checkpoint has no previous tip proof")
    if checkpoint_history(proof) != proof["historyHash"]: fail("provider-home checkpoint commitment changed")
    return proof["retired"]

def verify_retired(root, lock, retired):
    present = set()
    for entry in retired:
        directory = root if entry["directory"] == "root" else lock
        if directory is None: continue
        try: info = os.stat(entry["name"], dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError: continue
        if (not stat.S_ISREG(info.st_mode) or (str(info.st_dev), str(info.st_ino)) != (entry["device"], entry["inode"]) or
            read_lease_record(directory, entry["name"], 3)[1] != entry["hash"]):
            fail("provider-home checkpoint retirement evidence changed")
        after = os.stat(entry["name"], dir_fd=directory, follow_symlinks=False)
        if (str(after.st_dev), str(after.st_ino)) != (entry["device"], entry["inode"]): fail("provider-home retirement identity changed")
        present.add((entry["directory"], entry["name"]))
    return present

def exact_identity(device, inode):
    return (all(isinstance(value, str) and re.fullmatch(r"0|[1-9][0-9]{0,19}", value) and int(value) <= 18446744073709551615 for value in (device, inode)) and inode != "0")

fence_state = None
anchor_override = None

lease_ancestry = {}

def pin_lease_ancestry(root):
    if root in lease_ancestry: return
    path = fd_path(root)
    if not path.startswith("/") or len(path) > 32768: fail("invalid canonical lease ancestry")
    current = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    parents = []
    try:
        for part in path.split("/")[1:]:
            if not part or part in (".","..") or len(parents) >= 1024: fail("lease ancestry depth limit exceeded")
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            info = os.fstat(child)
            parents.append((current,part,(info.st_dev,info.st_ino))); current = child
        info, opened = os.fstat(current), os.fstat(root)
        if (info.st_dev,info.st_ino) != (opened.st_dev,opened.st_ino): fail("lease root ancestry changed")
        lease_ancestry[root] = parents
    except:
        for fd, _, _ in parents: os.close(fd)
        raise
    finally: os.close(current)

def check_lease_ancestry(root, lock=None, alternate=False):
    pin_lease_ancestry(root)
    for parent, name, expected in lease_ancestry[root]:
        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if not stat.S_ISDIR(info.st_mode) or (info.st_dev,info.st_ino) != expected: fail("pinned lease ancestry changed")
    if lock is not None:
        name = os.path.basename(fd_path(lock)) if alternate else "mutable-home.lock"
        if name != "mutable-home.lock" and not COMPACTION.fullmatch(name): fail("unproven alternate lease directory")
        named, opened = os.stat(name, dir_fd=root, follow_symlinks=False), os.fstat(lock)
        if not stat.S_ISDIR(named.st_mode) or (named.st_dev,named.st_ino) != (opened.st_dev,opened.st_ino): fail("pinned lease lock changed")

def release_lease_ancestry(root):
    for fd, _, _ in lease_ancestry.pop(root, []): os.close(fd)

def coherent_lease_filesystem(root):
    with open("/proc/self/fdinfo/%d" % root, "rb") as stream: info = stream.read(4097)
    if len(info) > 4096: fail("lease mount identity limit exceeded")
    mount_id = next((line.split(b":",1)[1].strip() for line in info.splitlines() if line.startswith(b"mnt_id:")), None)
    with open("/proc/self/mountinfo", "rb") as stream: mounts = stream.read(1048577)
    if len(mounts) > 1048576: fail("lease mount inventory limit exceeded")
    for line in mounts.splitlines():
        if line.split(b" ",1)[0] == mount_id:
            kind = line.split(b" - ",1)[1].split(b" ",1)[0]
            if kind not in (b"ext4",b"tmpfs",b"btrfs",b"overlay",b"xfs",b"zfs",b"f2fs"): fail("checkpoint requires a supported coherent local filesystem")
            return
    fail("lease mount identity cannot be verified")

def with_lease_fence(lock, exclusive, action):
    global fence_state
    if lock is None: return action()
    if fence_state is not None:
        if exclusive and not fence_state[1]: fail("lease reader fence cannot be upgraded")
        named = os.stat(FORMAT_GUARD, dir_fd=lock, follow_symlinks=False)
        if (named.st_dev, named.st_ino) != fence_state[2]: fail("permanent lease fence changed")
        return action()
    try: fd = os.open(FORMAT_GUARD, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=lock)
    except FileNotFoundError: return action()
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022 or not 1 <= info.st_nlink <= 3: fail("unsafe permanent lease fence")
        try: fcntl.flock(fd, (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB)
        except BlockingIOError: fail("provider HOME already in use: checkpoint publication is in progress; retry")
        lease_record_cache.clear()
        fence_state = (fd, exclusive, (info.st_dev, info.st_ino))
        return action()
    finally:
        fence_state = None; lease_record_cache.clear(); os.close(fd)

def compact_canonical(root, lock, lease_id, owner):
    try:
        return with_verification_budget(lambda: compact_canonical_bounded(root, lock, lease_id, owner))
    except Exception:
        diagnose("Provider-home lease checkpoint unavailable; preserving the last valid chain. Acquisitions stop at %d transitions, reserving one release slot. Check the permanent reader/writer fence, durable publication, staging evidence and the %d-byte verification budget; quarantine the entire lease directory only after proving this HOME unused." % (CHECKPOINT_LIMITS["hardTransitions"] - 1, CHECKPOINT_LIMITS["verificationBytes"]))
        return False

def compact_canonical_bounded(root, lock, lease_id, owner):
    check_lease_ancestry(root, lock)
    coherent_lease_filesystem(root)
    details = read_owned_lease_chain(root, lock, True, True)
    tip = details[0]
    if (tip.get("state") != "active" or tip["leaseId"] != lease_id or tip["ownerHash"] != owner or
        tip["hostname"] != os.uname().nodename or tip["pid"] != os.getpid()): fail("checkpoint acquired token changed")
    if details[7] < CHECKPOINT_LIMITS["compactAfter"] and not details[6] and not any(name in bounded_lease_entries(root) for name in CHECKPOINT_SLOTS): return True
    if FORMAT_GUARD not in bounded_lease_entries(lock):
        checkpoint_boundary("before-guard")
        guard = dict(tip, version=4, protocol="bounded-canonical-checkpoint", fenceBackend="flock", previousLeaseId=None, previousRecordHash=None)
        publish_lease(root, lock, FORMAT_GUARD, guard); os.fsync(lock); os.fsync(root)
        checkpoint_boundary("guard-durable")
    return with_lease_fence(lock, True, lambda: compact_fenced(root, lock, lease_id, owner))

def compact_fenced(root, lock, lease_id, owner):
    global anchor_override
    def owned():
        details = read_owned_lease_chain(root, lock, True, True)
        tip = details[0]
        if (tip.get("state") != "active" or tip["leaseId"] != lease_id or tip["ownerHash"] != owner or
            tip["hostname"] != os.uname().nodename or tip["pid"] != os.getpid()): fail("checkpoint acquired owner changed")
        return details
    def pin_authority(details):
        info = os.stat("mutable-home.recovery.json", dir_fd=root, follow_symlinks=False)
        guard = os.stat(FORMAT_GUARD, dir_fd=lock, follow_symlinks=False)
        return (info.st_dev, info.st_ino, info.st_ctime_ns, info.st_mtime_ns, info.st_size), (guard.st_dev, guard.st_ino, guard.st_ctime_ns)
    def still_owned(authority):
        check_lease_ancestry(root, lock)
        current = os.stat("mutable-home.recovery.json", dir_fd=root, follow_symlinks=False)
        guard = os.stat(FORMAT_GUARD, dir_fd=lock, follow_symlinks=False)
        if ((current.st_dev, current.st_ino, current.st_ctime_ns, current.st_mtime_ns, current.st_size), (guard.st_dev, guard.st_ino, guard.st_ctime_ns)) != authority: fail("checkpoint authority changed")
        try: os.stat("next-%s.json" % lease_id, dir_fd=root, follow_symlinks=False)
        except FileNotFoundError: return
        fail("checkpoint acquired owner has a successor")
    def retire(details):
        retired = details[6]
        present = verify_retired(root, lock, retired)
        authority = pin_authority(details)
        for entry in retired:
            if (entry["directory"], entry["name"]) not in present: continue
            still_owned(authority); checkpoint_boundary("before-retire"); still_owned(authority)
            lease_record_cache.clear()
            verify_retired(root, lock, [entry])
            directory = root if entry["directory"] == "root" else lock
            os.unlink(entry["name"], dir_fd=directory); os.fsync(directory)
            checkpoint_boundary("after-retire")
    details = owned(); retire(details); details = owned()
    adopted = False
    slots = [name for name in bounded_lease_entries(root) if name in CHECKPOINT_SLOTS]
    for name in reversed(slots):
        if any(entry["directory"] == "root" and entry["name"] == name for entry in details[6]): continue
        candidate, candidate_hash = read_lease_record(root, name, 3)
        retired = verify_checkpoint(candidate)
        proof = candidate["checkpoint"]
        if (proof["previousAnchorHash"] != details[4] or candidate["ownerHash"] != owner or candidate["hostname"] != os.uname().nodename or
            proof["previousTipHash"] not in [entry["hash"] for entry in details[5] if entry["directory"] == "root"]): fail("unproven completed checkpoint candidate")
        verify_retired(root, lock, retired)
        try:
            anchor_override = (candidate, candidate_hash)
            after = owned()
            if after[:2] != details[:2]: fail("completed candidate does not preserve acquired successor")
        finally: anchor_override = None
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=root)
        try: os.fsync(fd)
        finally: os.close(fd)
        os.fsync(root); checkpoint_boundary("before-selection")
        if owned()[1:3] != details[1:3]: fail("completed candidate snapshot changed")
        os.rename(name, "mutable-home.recovery.json", src_dir_fd=root, dst_dir_fd=root)
        checkpoint_boundary("selection-published"); os.fsync(root); checkpoint_boundary("selection-durable")
        details = owned(); retire(details); details = owned(); adopted = True; break
    if details[7] < CHECKPOINT_LIMITS["compactAfter"] and not adopted: return True
    tip, tip_hash, snapshot, anchor, anchor_hash, evidence, previous_retired, transitions = details
    if tip.get("version") != 2: fail("unsupported checkpoint tip")
    retired = []
    for entry in evidence:
        directory = root if entry["directory"] == "root" else lock
        info = os.stat(entry["name"], dir_fd=directory, follow_symlinks=False)
        retired.append(dict(entry, device=str(info.st_dev), inode=str(info.st_ino)))
    if ".mutable-home.retired" in bounded_lease_entries(root):
        info = os.stat(".mutable-home.retired", dir_fd=root, follow_symlinks=False)
        retired.append({"directory":"root","name":".mutable-home.retired","hash":read_lease_record(root,".mutable-home.retired",3)[1],"device":str(info.st_dev),"inode":str(info.st_ino)})
    for entry in list(retired):
        if entry["directory"] == "root" and not any(other["directory"] == "lock" and other["name"] == entry["name"] for other in retired): retired.append(dict(entry, directory="lock"))
    if anchor.get("version") == 2:
        info = os.stat("mutable-home.recovery.json", dir_fd=root, follow_symlinks=False)
        for name in ("checkpoint.json", "lease-%s.json" % anchor["leaseId"]):
            if not any(entry["directory"] == "lock" and entry["name"] == name for entry in retired): retired.append({"directory":"lock","name":name,"hash":anchor_hash,"device":str(info.st_dev),"inode":str(info.st_ino)})
    slots = [name for name in bounded_lease_entries(root) if name in CHECKPOINT_SLOTS]
    pending_name = next((name for name in CHECKPOINT_SLOTS if name not in slots and not any(entry["directory"] == "root" and entry["name"] == name for entry in previous_retired)), None)
    if pending_name is None or len(retired) > CHECKPOINT_LIMITS["retirementEntries"]: fail("checkpoint staging limit reached")
    fd = os.open("next-%s.json" % tip["previousLeaseId"], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=root)
    try: tip_raw = os.read(fd, 4097).decode()
    finally: os.close(fd)
    if verification_hash(tip_raw) != tip_hash: fail("checkpoint tip changed")
    guard = os.stat(FORMAT_GUARD, dir_fd=lock, follow_symlinks=False)
    proof = {"migration":len(bounded_lease_entries(root)) >= CHECKPOINT_LIMITS["directoryEntries"] - 4 or len(bounded_lease_entries(lock)) >= CHECKPOINT_LIMITS["directoryEntries"] - 4,
        "previousTip":tip_raw,"previousTipHash":tip_hash,"previousAnchorHash":anchor_hash,
        "previousHistoryHash":anchor["checkpoint"]["historyHash"] if anchor.get("version") == 4 else anchor_hash,
        "guardHash":read_lease_record(lock, FORMAT_GUARD)[1],"guardDevice":str(guard.st_dev),"guardInode":str(guard.st_ino),"retired":retired}
    proof["historyHash"] = checkpoint_history(proof)
    value = dict(tip, version=4, previousLeaseId=None, previousRecordHash=None, recoveredEntriesHash=anchor["recoveredEntriesHash"], checkpoint=proof)
    raw = lease_bytes(value)
    if len(raw) > CHECKPOINT_LIMITS["checkpointBytes"]: fail("checkpoint byte limit reached")
    verify_checkpoint(value)
    checkpoint_boundary("before-candidate")
    check_lease_ancestry(root, lock)
    fd = os.open(pending_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=root)
    try:
        write_all(fd, raw); checkpoint_boundary("candidate-written"); os.fsync(fd); checkpoint_boundary("candidate-file-durable")
    finally: os.close(fd)
    os.fsync(root); checkpoint_boundary("candidate-durable")
    confirmed = owned()
    if confirmed[1:3] != (tip_hash, snapshot): fail("checkpoint snapshot changed")
    candidate, candidate_hash = read_lease_record(root, pending_name, 3)
    if candidate_hash != verification_hash(raw): fail("checkpoint candidate changed")
    verify_checkpoint(candidate); verify_retired(root, lock, retired); checkpoint_boundary("before-selection")
    if owned()[1:3] != (tip_hash, snapshot): fail("checkpoint snapshot changed")
    os.rename(pending_name, "mutable-home.recovery.json", src_dir_fd=root, dst_dir_fd=root)
    checkpoint_boundary("selection-published"); os.fsync(root); checkpoint_boundary("selection-durable")
    retire(owned()); checkpoint_boundary("retirement-durable")
    return True

def checkpoint_boundary(boundary):
    pass
`;
