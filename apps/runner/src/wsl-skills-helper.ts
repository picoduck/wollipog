/** Fixed in-distro filesystem adapter. JSON carries only validated desired state and store paths;
 * no payload value is evaluated as Python or shell source. */
export const WSL_SKILLS_HELPER = String.raw`#!/usr/bin/env python3
import datetime, hashlib, json, os, re, stat, sys, uuid

NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
DIGEST = re.compile(r"^[0-9a-f]{64}$")
LEASE_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
MAX_ENTRIES = 256
MAX_MD = 65536
DRIVER_DIRS = {"claude-code": ".claude/skills", "codex": ".codex/skills", "codex-app-server": ".codex/skills"}

def fail(message):
    raise RuntimeError(message)

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
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 4096: fail("provider home lease is unsafe")
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

def read_lease_chain(lock):
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
    consumed, seen = {marker}, set()
    while True:
        if value["leaseId"] in seen: fail("provider home lease is incomplete or foreign")
        seen.add(value["leaseId"])
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
    return value, record_hash

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
                return root, lock, value["leaseId"]
            except:
                os.close(lock); raise
    except:
        os.close(root); raise

def release_lease(lease):
    root, lock, lease_id = lease
    try:
        current, current_hash = read_lease_chain(lock)
        if current.get("version") != 2 or current.get("state") != "active" or current["leaseId"] != lease_id:
            fail("provider home lease changed before release")
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

def ensure_link(home_fd, relative, target, store_root, canonical, owned):
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

def unlink_owned(home_fd, relative, store_root, canonical, owned, direct_store=False):
    parent_rel, name = relative.rsplit("/", 1)
    try: parent = walk_dir(home_fd, parent_rel)
    except: return False
    try:
        kind, _ = link_probe(parent, name, store_root, canonical, relative in owned)
        if kind == "store" and (direct_store or relative in owned) or kind == "canonical" and relative in owned:
            os.unlink(name, dir_fd=parent); owned.discard(relative); return True
        return False
    finally: os.close(parent)

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
        for skill in skills:
            name, digest = skill.get("name"), skill.get("versionDigest")
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
            canonical_ok, canonical_status, canonical_detail = ensure_link(home_fd, canonical_rel, base, store_root, None, owned)
            if not canonical_ok: row["error"] = "canonical link: " + canonical_detail
            targeted = set(t.get("agentId") for t in targets)
            linked_dirs = set()
            for rel_dir, plan in plans.items():
                mixed = bool(plan["agent"] and plan["manual"])
                use_manual = bool(plan["manual"] and not plan["agent"])
                relative = rel_dir + "/" + name
                if use_manual:
                    outcome = ensure_link(home_fd, relative, manual, store_root, canonical_dir + "/" + name, owned)
                elif not canonical_ok:
                    removed = unlink_owned(home_fd, relative, store_root, canonical_dir + "/" + name, owned)
                    if removed:
                        harness_keep[rel_dir].discard(name)
                        removals.append({"path": "WSL %s: ~/%s" % (spec["distro"], relative),
                            "reason": "The canonical location it routes through is conflicted."})
                        outcome = (False, "error", "the canonical location is conflicted, so this harness link was removed")
                    else:
                        outcome = (False, canonical_status, "canonical link: " + canonical_detail)
                else:
                    outcome = ensure_link(home_fd, relative, canonical_dir + "/" + name, store_root, canonical_dir + "/" + name, owned)
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
                if remove and unlink_owned(home_fd, relative, store_root, canonical, owned, direct):
                    removals.append({"path": "WSL %s: ~/%s" % (spec["distro"], relative), "reason": "No longer in the desired skill list."})
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
        return {"deployed": deployed, "unmanaged": unmanaged, "removedLinks": removals}
    finally:
        if lease is not None: release_lease(lease)
        os.close(state); os.close(store_fd); os.close(home_fd)

try:
    print(json.dumps(reconcile(bounded_json()), separators=(",", ":")))
except Exception as error:
    print(json.dumps({"error": str(error)}, separators=(",", ":")))
    sys.exit(1)
`;
