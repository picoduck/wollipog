import { createHash } from "node:crypto";

const WORKFLOWS = ["main-rolling-validation.yml", "ci.yml", "settings-rows-win32.yml"];
const SHA = /^[a-f0-9]{40}$/;

/** Batch only immutable workflow blobs inside ONE independent health rebuild.
 * Mutable main refs, run/attempt reads, pagination and final rechecks always pass
 * through. This adapter supplies raw evidence, never a cached health verdict.
 */
export function admissionEvidenceApi(api, repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) throw new Error("Invalid evidence repository");
  const [owner, name] = repository.split("/");
  const prefix = `/repos/${repository}/contents/.github/workflows/`;
  const revisions = new Map();
  const batched = async (path, options) => {
    const suffix = typeof path === "string" && path.startsWith(prefix) ? path.slice(prefix.length) : "";
    const [file, revision, extra] = suffix.split("?ref=");
    if ((options?.method ?? "GET") !== "GET" || options?.body !== undefined || extra !== undefined ||
        !WORKFLOWS.includes(file) || !SHA.test(revision ?? "")) return api(path, options);
    if (!revisions.has(revision)) {
      const response = await api("/graphql", { method: "POST", body: {
        query: "query AdmissionWorkflowEvidence($owner:String!,$name:String!,$revision:GitObjectID!,$file0:String!,$file1:String!,$file2:String!){repository(owner:$owner,name:$name){nameWithOwner revision:object(oid:$revision){__typename oid} file0:object(expression:$file0){...WorkflowBlob} file1:object(expression:$file1){...WorkflowBlob} file2:object(expression:$file2){...WorkflowBlob}}} fragment WorkflowBlob on Blob{__typename oid text isBinary byteSize}",
        variables: { owner, name, revision, ...Object.fromEntries(WORKFLOWS.map((file, i) =>
          [`file${i}`, `${revision}:.github/workflows/${file}`])) },
      } });
      const repo = response?.data?.repository;
      if (response?.errors !== undefined && (!Array.isArray(response.errors) || response.errors.length) ||
          repo?.nameWithOwner?.toLowerCase() !== repository.toLowerCase() ||
          repo?.revision?.__typename !== "Commit" || repo.revision.oid !== revision)
        throw new Error("Workflow evidence identity unavailable");
      const blobs = new Map();
      for (const [i, file] of WORKFLOWS.entries()) {
        const blob = repo[`file${i}`];
        if (blob?.__typename !== "Blob" || !SHA.test(blob.oid ?? "") || blob.isBinary !== false ||
            typeof blob.text !== "string" || !Number.isSafeInteger(blob.byteSize) || blob.byteSize < 0 || blob.byteSize > 1_048_576)
          throw new Error("Workflow evidence incomplete");
        const bytes = Buffer.from(blob.text, "utf8");
        const oid = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
        if (bytes.length !== blob.byteSize || oid !== blob.oid) throw new Error("Workflow evidence bytes unavailable");
        blobs.set(file, { sha: blob.oid, encoding: "base64", content: bytes.toString("base64") });
      }
      // No partial cache on errors, and no state shared across rebuilds.
      revisions.set(revision, blobs);
    }
    return structuredClone(revisions.get(revision).get(file));
  };
  for (const key of ["rateLimit", "graphqlRateLimit"]) Object.defineProperty(batched, key, { get: () => api[key] });
  return batched;
}
