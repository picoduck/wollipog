export interface ContainerLabelIdentity {
  runner: string;
  template: string;
}

export const CANONICAL_CONTAINER_LABELS: ContainerLabelIdentity = Object.freeze({
  runner: "com.wollipog.runner",
  template: "com.wollipog.template",
});

export const LEGACY_CONTAINER_LABELS: ContainerLabelIdentity = Object.freeze({
  runner: "com.misko-agent-manager.runner",
  template: "com.misko-agent-manager.template",
});

/** Query each generation independently. Docker and Podman combine multiple label filters with AND. */
export const CONTAINER_LABEL_GENERATIONS = Object.freeze([
  CANONICAL_CONTAINER_LABELS,
  LEGACY_CONTAINER_LABELS,
]);

export function containerLabelArgs(runnerKey: string, templateId: string): string[] {
  return CONTAINER_LABEL_GENERATIONS.flatMap((labels) => [
    "--label", `${labels.runner}=${runnerKey}`,
    "--label", `${labels.template}=${templateId}`,
  ]);
}
