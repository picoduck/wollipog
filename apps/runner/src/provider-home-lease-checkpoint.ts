/** Negotiated canonical checkpoint limits. Readers and writers use the same fixed limits; an
 * older reader refuses version 3. Limits include interrupted retirement and publication state. */
export const LEASE_CHECKPOINT_LIMITS = Object.freeze({
  compactAfter: 16,
  hardTransitions: 32,
  directoryEntries: 256,
  retirementEntries: 72,
  checkpointBytes: 65_536,
  retainedEntries: 32,
  verificationRecords: 8_192,
  verificationBytes: 8_388_608,
});

export interface LeaseRetirementEntry {
  directory: "root" | "lock";
  name: string;
  hash: string;
  device: number;
  inode: number;
}

export interface LeaseCheckpointProof {
  previousTip: string;
  previousTipHash: string;
  previousAnchorHash: string;
  previousHistoryHash: string;
  guardHash: string;
  historyHash: string;
  retired: LeaseRetirementEntry[];
}

/** The in-distro counterpart operates exclusively on already opened no-follow directories. */
export const LEASE_CHECKPOINT_PYTHON = String.raw`
CHECKPOINT_LIMITS = ${JSON.stringify(LEASE_CHECKPOINT_LIMITS)}
CHECKPOINT_SLOTS = (".mutable-home.checkpoint.pending", ".mutable-home.checkpoint.pending-2")
FORMAT_GUARD = "protocol-v3.json"
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
            if len(entries) == CHECKPOINT_LIMITS["directoryEntries"]: fail("provider-home lease scan limit exceeded")
            entries.append(entry.name)
    return sorted(entries)

def canonical_root_entries(root):
    entries = bounded_lease_entries(root)
    for name in entries:
        if name == "mutable-home.lock": continue
        temporary = PUBLICATION_TEMP.fullmatch(name)
        if not (temporary or name in CHECKPOINT_SLOTS or name == "mutable-home.recovery.json" or re.fullmatch(r"next-([0-9a-f-]+)\.json", name)):
            fail("unexpected canonical lease entries")
        info = os.stat(name, dir_fd=root, follow_symlinks=False)
        if (not stat.S_ISREG(info.st_mode) or info.st_size > (4096 if temporary else CHECKPOINT_LIMITS["checkpointBytes"]) or
            info.st_nlink < 1 or info.st_nlink > 3 or info.st_uid != os.geteuid() or info.st_mode & 0o022):
            fail("unsafe canonical lease entries")
    return entries

def checkpoint_history(proof):
    value = [proof["previousHistoryHash"], proof["previousAnchorHash"], proof["previousTipHash"], proof["guardHash"],
        [[entry[key] for key in ("directory", "name", "hash", "device", "inode")] for entry in proof["retired"]]]
    return verification_hash(json.dumps(value, separators=(",", ":"), ensure_ascii=False))

def verify_checkpoint(value):
    proof = value.get("checkpoint")
    if (value.get("version") != 3 or value.get("state") != "active" or value.get("previousLeaseId") is not None or
        value.get("previousRecordHash") is not None or not DIGEST.fullmatch(value.get("recoveredEntriesHash", "")) or
        not isinstance(proof, dict) or not isinstance(proof.get("previousTip"), str) or
        len(proof["previousTip"].encode()) > 4096 or
        any(not isinstance(proof.get(key), str) or not DIGEST.fullmatch(proof[key]) for key in
            ("previousTipHash", "previousAnchorHash", "previousHistoryHash", "historyHash", "guardHash")) or
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
        valid = isinstance(name, str) and (directory == "root" and (name in CHECKPOINT_SLOTS or re.fullmatch(r"next-([0-9a-f-]+)\.json", name)) or
            directory == "lock" and (name == "checkpoint.json" or re.fullmatch(r"(lease|next)-([0-9a-f-]+)\.json", name)))
        key = (directory, name)
        if (not valid or key in seen or not isinstance(entry.get("hash"), str) or not DIGEST.fullmatch(entry["hash"]) or
            directory == "root" and name == "next-%s.json" % value["leaseId"] or
            any(not isinstance(entry.get(field), int) or isinstance(entry[field], bool) or entry[field] < (1 if field == "inode" else 0)
                or entry[field] > 9007199254740991 for field in ("device", "inode"))):
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
        if (not stat.S_ISREG(info.st_mode) or (info.st_dev, info.st_ino) != (entry["device"], entry["inode"]) or
            read_lease_record(directory, entry["name"], 3)[1] != entry["hash"]):
            fail("provider-home checkpoint retirement evidence changed")
        after = os.stat(entry["name"], dir_fd=directory, follow_symlinks=False)
        if (after.st_dev, after.st_ino) != (entry["device"], entry["inode"]): fail("provider-home retirement identity changed")
        present.add((entry["directory"], entry["name"]))
    return present

def compact_canonical(root, lock, lease_id, owner):
    return with_verification_budget(lambda: compact_canonical_bounded(root, lock, lease_id, owner), True)

def compact_canonical_bounded(root, lock, lease_id, owner):
    def owned():
        details = read_owned_lease_chain(root, lock, True, True)
        tip = details[0]
        if (tip.get("state") != "active" or tip["leaseId"] != lease_id or tip["ownerHash"] != owner or
            tip["hostname"] != os.uname().nodename or tip["pid"] != os.getpid()):
            fail("provider-home checkpoint owner changed")
        return details
    def retire(details):
        retired = details[6]
        present = verify_retired(root, lock, retired)
        for entry in retired:
            if (entry["directory"], entry["name"]) not in present: continue
            owned(); verify_retired(root, lock, [entry])
            checkpoint_boundary("before-retire")
            owned(); verify_retired(root, lock, [entry])
            directory = root if entry["directory"] == "root" else lock
            os.unlink(entry["name"], dir_fd=directory); os.fsync(directory)
            checkpoint_boundary("after-retire")
    try:
        details = owned()
        retire(details)
        details = owned()
        tip, tip_hash, snapshot, anchor, anchor_hash, evidence, _, transitions = details
        if transitions < CHECKPOINT_LIMITS["compactAfter"]: return
        if tip.get("version") != 2: fail("unsupported checkpoint tip")
        if FORMAT_GUARD not in bounded_lease_entries(lock):
            checkpoint_boundary("before-guard")
            guard = dict(tip, version=3, protocol="bounded-canonical-checkpoint", previousLeaseId=None, previousRecordHash=None)
            publish_lease(root, lock, FORMAT_GUARD, guard)
            os.fsync(lock); os.fsync(root)
            checkpoint_boundary("guard-durable")
            details = owned()
            tip, tip_hash, snapshot, anchor, anchor_hash, evidence, _, transitions = details
        retired = []
        for entry in evidence:
            directory = root if entry["directory"] == "root" else lock
            info = os.stat(entry["name"], dir_fd=directory, follow_symlinks=False)
            retired.append(dict(entry, device=info.st_dev, inode=info.st_ino))
        for entry in list(retired):
            if entry["directory"] == "root" and not any(other["directory"] == "lock" and other["name"] == entry["name"] for other in retired):
                retired.append(dict(entry, directory="lock"))
        if anchor.get("version") == 2:
            info = os.stat("mutable-home.recovery.json", dir_fd=root, follow_symlinks=False)
            for name in ("checkpoint.json", "lease-%s.json" % anchor["leaseId"]):
                if not any(entry["directory"] == "lock" and entry["name"] == name for entry in retired):
                    retired.append({"directory": "lock", "name": name, "hash": anchor_hash, "device": info.st_dev, "inode": info.st_ino})
        slots = [name for name in bounded_lease_entries(root) if name in CHECKPOINT_SLOTS]
        for name in slots:
            pending, pending_hash = read_lease_record(root, name)
            verify_checkpoint(pending)
            if (pending["checkpoint"]["previousTipHash"] not in [tip_hash, anchor_hash] + [entry["hash"] for entry in evidence] or
                pending["ownerHash"] != owner or pending["hostname"] != os.uname().nodename):
                fail("unproven checkpoint candidate")
            info = os.stat(name, dir_fd=root, follow_symlinks=False)
            retired.append({"directory": "root", "name": name, "hash": pending_hash, "device": info.st_dev, "inode": info.st_ino})
        pending_name = next((name for name in CHECKPOINT_SLOTS if name not in slots and
            not any(entry["directory"] == "root" and entry["name"] == name for entry in details[6])), None)
        if pending_name is None or len(retired) > CHECKPOINT_LIMITS["retirementEntries"]: fail("checkpoint staging limit reached")
        # Recover the exact immutable bytes of the current tip, rather than reserializing a
        # native record with a potentially different encoder.
        tip_name = "next-%s.json" % tip["previousLeaseId"]
        fd = os.open(tip_name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=root)
        try: tip_raw = os.read(fd, 4097).decode()
        finally: os.close(fd)
        if hashlib.sha256(tip_raw.encode()).hexdigest() != tip_hash: fail("checkpoint tip changed")
        proof = {"previousTip": tip_raw, "previousTipHash": tip_hash, "previousAnchorHash": anchor_hash,
            "previousHistoryHash": anchor["checkpoint"]["historyHash"] if anchor.get("version") == 3 else anchor_hash,
            "guardHash": read_lease_record(lock, FORMAT_GUARD)[1],
            "retired": retired}
        proof["historyHash"] = checkpoint_history(proof)
        value = dict(tip, version=3, previousLeaseId=None, previousRecordHash=None,
            recoveredEntriesHash=anchor["recoveredEntriesHash"], checkpoint=proof)
        raw = lease_bytes(value)
        if len(raw) > CHECKPOINT_LIMITS["checkpointBytes"]: fail("checkpoint byte limit reached")
        checkpoint_boundary("before-candidate")
        fd = os.open(pending_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=root)
        try:
            write_all(fd, raw)
            checkpoint_boundary("candidate-written")
            os.fsync(fd)
            checkpoint_boundary("candidate-file-durable")
        finally: os.close(fd)
        os.fsync(root)
        checkpoint_boundary("candidate-durable")
        confirmed = owned()
        if confirmed[1:3] != (tip_hash, snapshot): fail("checkpoint snapshot changed")
        candidate, candidate_hash = read_lease_record(root, pending_name)
        if candidate_hash != hashlib.sha256(raw).hexdigest(): fail("checkpoint candidate changed")
        verify_checkpoint(candidate)
        verify_retired(root, lock, retired)
        checkpoint_boundary("before-selection")
        confirmed = owned()
        if confirmed[1:3] != (tip_hash, snapshot): fail("checkpoint snapshot changed")
        os.rename(pending_name, "mutable-home.recovery.json", src_dir_fd=root, dst_dir_fd=root)
        checkpoint_boundary("selection-published")
        os.fsync(root)
        checkpoint_boundary("selection-durable")
        retire(owned())
        checkpoint_boundary("retirement-durable")
    except Exception:
        diagnose("Provider-home lease checkpoint unavailable; preserving the last valid chain. Acquisitions stop at %d transitions, reserving one release slot. Check atomic rename, no-follow descriptors, durable fsync, staging evidence and the %d-byte verification budget; quarantine the entire lease directory only after proving this HOME unused." % (CHECKPOINT_LIMITS["hardTransitions"] - 1, CHECKPOINT_LIMITS["verificationBytes"]))

def checkpoint_boundary(boundary):
    pass
`;
