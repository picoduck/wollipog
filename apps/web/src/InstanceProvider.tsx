import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { CONTROL_PLANE_HTTP, CONTROL_PLANE_WS } from "./config.js";
import {
  addRemoteInstance,
  editRemoteInstance,
  readInstanceRegistry,
  removeRemoteInstance,
  repairRemoteInstance,
  setActiveInstance,
  type DesktopInstanceRuntime,
  type InstanceProfile,
  type InstanceRegistrySnapshot,
} from "./desktop-instances.js";
import { DEVICE_TOKEN_CHANGED_EVENT, deviceToken } from "./device-token.js";
import {
  DesktopInstanceNavigation,
  instanceRouteFromPath,
  instanceViewPath,
  isInstanceScopedPath,
  loadLastInstanceView,
  saveLastInstanceView,
} from "./instance-navigation.js";
import { createBrowserInstanceRuntime, createNativeInstanceRuntime, type InstanceRuntime } from "./instance-runtime.js";
import type { NativeInvokeRuntime } from "./native-api-transport.js";
import type { NativeUiRuntime } from "./native-ui-transport.js";
import {
  InstancesContextProvider,
  type InstanceAvailability,
  type InstanceManager,
  type InstanceStatus,
} from "./instances-context.js";
import { viewFromPath, type View } from "./navigation.js";
import { browserRandomUUID } from "./browser-crypto.js";

const LOCAL_PROFILE: InstanceProfile = {
  id: "local",
  serverInstanceId: "local",
  kind: "local",
  label: "This Machine",
  origin: CONTROL_PLANE_HTTP,
  createdAt: "",
};

const EMPTY_REGISTRY: InstanceRegistrySnapshot = {
  profiles: [LOCAL_PROFILE],
  activeInstanceId: "local",
};

type ProviderDesktopRuntime = DesktopInstanceRuntime & NativeInvokeRuntime & NativeUiRuntime;

const nativeDesktop: ProviderDesktopRuntime = {
  isTauri,
  invoke<T>(command: string, args?: Record<string, unknown> | Uint8Array): Promise<T> {
    return invoke<T>(command, args);
  },
  channel<T>() { return new Channel<T>(); },
};

function localRuntime(): InstanceRuntime {
  return createBrowserInstanceRuntime({
    instanceId: "local",
    runtimeKey: `local:${browserRandomUUID()}`,
    httpOrigin: CONTROL_PLANE_HTTP,
    websocketOrigin: CONTROL_PLANE_WS,
    token: deviceToken,
    onCredentialChange(listener) {
      window.addEventListener(DEVICE_TOKEN_CHANGED_EVENT, listener);
      return () => window.removeEventListener(DEVICE_TOKEN_CHANGED_EVENT, listener);
    },
  });
}

function nativeRemoteRuntime(profileId: string, desktop: ProviderDesktopRuntime): Promise<InstanceRuntime> {
  return createNativeInstanceRuntime({ profileId, desktop });
}

function errorDetails(error: unknown): { message: string; code?: string } {
  if (error && typeof error === "object") {
    const value = error as { message?: unknown; code?: unknown };
    if (typeof value.message === "string") {
      return { message: value.message, ...(typeof value.code === "string" ? { code: value.code } : {}) };
    }
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

function isMissingProfileError(error: unknown): boolean {
  const { message, code } = errorDetails(error);
  return code === "missing-profile" || message.toLowerCase().includes("instance no longer exists");
}

export function remoteOpenFailureStatus(error: unknown): InstanceStatus {
  const { message, code } = errorDetails(error);
  const lower = message.toLowerCase();
  let availability: InstanceAvailability = "offline";
  if (code === "authentication-required" || lower.includes("pairing token was rejected")) {
    availability = "authentication-required";
  } else if (code === "missing-credential" || lower.includes("credential is missing")) {
    availability = "missing-credential";
  } else if (
    code === "incompatible"
    || code === "identity-changed"
    || lower.includes("unsupported api version")
    || lower.includes("does not support remote instances")
    || lower.includes("different wollipog instance")
  ) {
    availability = "incompatible";
  }
  return { availability, message };
}

interface ProviderState {
  registry: InstanceRegistrySnapshot;
  activeProfile: InstanceProfile;
  runtime: InstanceRuntime | null;
  phase: InstanceManager["phase"];
  error: string | null;
  statuses: Record<string, InstanceStatus>;
  missingInstanceId?: string;
}

export interface InstanceProviderProps {
  children: ReactNode;
  desktop?: ProviderDesktopRuntime;
  createLocalRuntime?: () => InstanceRuntime;
  createRemoteRuntime?: (profileId: string, desktop: ProviderDesktopRuntime) => Promise<InstanceRuntime>;
}

export function InstanceProvider({
  children,
  desktop = nativeDesktop,
  createLocalRuntime = localRuntime,
  createRemoteRuntime = nativeRemoteRuntime,
}: InstanceProviderProps) {
  const [state, setState] = useState<ProviderState>({
    registry: EMPTY_REGISTRY,
    activeProfile: LOCAL_PROFILE,
    runtime: null,
    phase: "loading",
    error: null,
    statuses: { local: { availability: "saved" } },
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const runtimeRef = useRef<InstanceRuntime | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(false);
  const registryMutationRef = useRef<Promise<void>>(Promise.resolve());
  const retryInFlightRef = useRef<{
    profileId: string;
    generation: number;
    operation: Promise<void>;
  } | null>(null);

  const enqueueRegistryMutation = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const result = registryMutationRef.current.then(operation, operation);
    registryMutationRef.current = result.then(() => {}, () => {});
    return result;
  }, []);

  const closeRuntime = useCallback(() => {
    const runtime = runtimeRef.current;
    runtimeRef.current = null;
    runtime?.close();
  }, []);

  const openProfile = useCallback(async (
    profile: InstanceProfile,
    registry: InstanceRegistrySnapshot,
    generation: number,
  ) => {
    try {
      const runtime = profile.kind === "local"
        ? createLocalRuntime()
        : await createRemoteRuntime(profile.id, desktop);
      const refreshedRegistry = profile.kind === "remote"
        ? await readInstanceRegistry(desktop).catch(() => registry) ?? registry
        : registry;
      if (!mountedRef.current || generation !== generationRef.current) {
        runtime.close();
        return;
      }
      const refreshedProfile = refreshedRegistry.profiles.find((candidate) => candidate.id === profile.id) ?? profile;
      runtimeRef.current = runtime;
      setState((current) => ({
        ...current,
        registry: refreshedRegistry,
        activeProfile: refreshedProfile,
        runtime,
        phase: "ready",
        error: null,
        statuses: { ...current.statuses, [profile.id]: { availability: "online" } },
        missingInstanceId: undefined,
      }));
    } catch (error) {
      if (!mountedRef.current || generation !== generationRef.current) return;
      if (isMissingProfileError(error)) {
        const refreshed = await readInstanceRegistry(desktop).catch(() => null);
        if (!mountedRef.current || generation !== generationRef.current) return;
        setState((value) => ({
          ...value,
          ...(refreshed ? { registry: refreshed } : {}),
          runtime: null,
          phase: "missing",
          error: null,
          missingInstanceId: profile.id,
        }));
        return;
      }
      const status = remoteOpenFailureStatus(error);
      setState((current) => ({
        ...current,
        registry,
        activeProfile: profile,
        runtime: null,
        phase: "failed",
        error: status.message ?? "The remote instance could not be opened.",
        statuses: { ...current.statuses, [profile.id]: status },
        missingInstanceId: undefined,
      }));
    }
  }, [createLocalRuntime, createRemoteRuntime, desktop]);

  const beginOpen = useCallback((profile: InstanceProfile, registry: InstanceRegistrySnapshot): number => {
    const generation = ++generationRef.current;
    closeRuntime();
    setState((current) => ({
      ...current,
      registry,
      activeProfile: profile,
      runtime: null,
      phase: "opening",
      error: null,
      statuses: { ...current.statuses, [profile.id]: { availability: "connecting" } },
      missingInstanceId: undefined,
    }));
    return generation;
  }, [closeRuntime]);

  const switchTo = useCallback(async (profileId: string, route?: View, replace = false) => {
    const current = stateRef.current;
    const profile = current.registry.profiles.find((candidate) => candidate.id === profileId);
    if (!profile) {
      const generation = ++generationRef.current;
      void generation;
      closeRuntime();
      setState((value) => ({ ...value, runtime: null, phase: "missing", error: null, missingInstanceId: profileId }));
      return;
    }
    const optimistic = { ...current.registry, activeInstanceId: profile.id };
    const generation = beginOpen(profile, optimistic);
    try {
      const registry = await enqueueRegistryMutation(() => setActiveInstance(profile.id, desktop));
      if (!mountedRef.current || generation !== generationRef.current) return;
      const destination = route ?? loadLastInstanceView(profile.id);
      const path = instanceViewPath(profile.id, destination);
      if (replace) window.history.replaceState(window.history.state, "", path);
      else if (`${window.location.pathname}${window.location.search}` !== path) {
        window.history.pushState(window.history.state, "", path);
      }
      await openProfile(profile, registry, generation);
    } catch (error) {
      if (!mountedRef.current || generation !== generationRef.current) return;
      if (isMissingProfileError(error)) {
        const refreshed = await readInstanceRegistry(desktop).catch(() => null);
        if (!mountedRef.current || generation !== generationRef.current) return;
        setState((value) => ({
          ...value,
          ...(refreshed ? { registry: refreshed } : {}),
          runtime: null,
          phase: "missing",
          error: null,
          missingInstanceId: profile.id,
        }));
        return;
      }
      const status = remoteOpenFailureStatus(error);
      setState((value) => ({
        ...value,
        runtime: null,
        phase: "failed",
        error: status.message ?? "The instance selection could not be saved.",
        statuses: { ...value.statuses, [profile.id]: status },
      }));
    }
  }, [beginOpen, closeRuntime, desktop, enqueueRegistryMutation, openProfile]);

  useEffect(() => {
    mountedRef.current = true;
    const generation = ++generationRef.current;
    void readInstanceRegistry(desktop).then(async (registry) => {
      if (!mountedRef.current || generation !== generationRef.current) return;
      if (!registry) throw new Error("Remote instances are available only in the Wollipog desktop app.");
      const scoped = instanceRouteFromPath(window.location.pathname, window.location.search);
      if (isInstanceScopedPath(window.location.pathname) && !scoped) {
        setState((current) => ({ ...current, registry, runtime: null, phase: "missing", error: null }));
        return;
      }
      const profileId = scoped?.instanceId ?? registry.activeInstanceId;
      const profile = registry.profiles.find((candidate) => candidate.id === profileId);
      if (!profile) {
        setState((current) => ({
          ...current,
          registry,
          runtime: null,
          phase: "missing",
          error: null,
          missingInstanceId: profileId,
        }));
        return;
      }
      let selectedRegistry = registry;
      if (registry.activeInstanceId !== profile.id) {
        setState((current) => ({
          ...current,
          registry: { ...registry, activeInstanceId: profile.id },
          activeProfile: profile,
          runtime: null,
          phase: "opening",
          error: null,
          statuses: { ...current.statuses, [profile.id]: { availability: "connecting" } },
          missingInstanceId: undefined,
        }));
        selectedRegistry = await enqueueRegistryMutation(() => setActiveInstance(profile.id, desktop));
      }
      if (!mountedRef.current || generation !== generationRef.current) return;
      const legacy = scoped?.view
        ?? viewFromPath(window.location.pathname, window.location.search)
        ?? loadLastInstanceView(profile.id);
      const canonical = instanceViewPath(profile.id, legacy);
      if (`${window.location.pathname}${window.location.search}` !== canonical || window.location.hash) {
        window.history.replaceState(window.history.state, "", canonical);
      }
      setState((current) => ({
        ...current,
        registry: selectedRegistry,
        activeProfile: profile,
        runtime: null,
        phase: "opening",
        error: null,
        statuses: { ...current.statuses, [profile.id]: { availability: "connecting" } },
      }));
      await openProfile(profile, selectedRegistry, generation);
    }).catch((error) => {
      if (!mountedRef.current || generation !== generationRef.current) return;
      const details = errorDetails(error);
      setState((current) => ({ ...current, runtime: null, phase: "failed", error: details.message }));
    });
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      closeRuntime();
    };
  }, [closeRuntime, desktop, enqueueRegistryMutation, openProfile]);

  useEffect(() => {
    const onPopState = () => {
      const route = instanceRouteFromPath(window.location.pathname, window.location.search);
      if (!route) {
        if (isInstanceScopedPath(window.location.pathname)) {
          generationRef.current += 1;
          closeRuntime();
          setState((current) => ({ ...current, runtime: null, phase: "missing", error: null }));
        }
        return;
      }
      if (route.instanceId !== stateRef.current.activeProfile.id) {
        void switchTo(route.instanceId, route.view, true);
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [closeRuntime, switchTo]);

  const retryActive = useCallback((): Promise<void> => {
    const { activeProfile } = stateRef.current;
    if (
      retryInFlightRef.current?.profileId === activeProfile.id
      && retryInFlightRef.current.generation === generationRef.current
    ) {
      return retryInFlightRef.current.operation;
    }
    const route = instanceRouteFromPath(window.location.pathname, window.location.search);
    const operation = switchTo(
      activeProfile.id,
      route?.instanceId === activeProfile.id ? route.view : undefined,
      true,
    );
    const retry = {
      profileId: activeProfile.id,
      generation: generationRef.current,
      operation,
    };
    retryInFlightRef.current = retry;
    const clear = () => {
      if (retryInFlightRef.current === retry) retryInFlightRef.current = null;
    };
    void operation.then(clear, clear);
    return operation;
  }, [switchTo]);

  const addAndSwitch = useCallback(async (input: { label: string; origin: string; token: string }) => {
    const registry = await enqueueRegistryMutation(() => addRemoteInstance(input, desktop));
    const profile = registry.profiles.find((candidate) => candidate.kind === "remote" && candidate.origin === input.origin);
    if (!profile) throw new Error("The saved remote instance could not be found.");
    setState((current) => ({ ...current, registry }));
    stateRef.current = { ...stateRef.current, registry };
    await switchTo(profile.id);
  }, [desktop, enqueueRegistryMutation, switchTo]);

  const editInstance = useCallback(async (input: { profileId: string; label: string; origin: string; token?: string }) => {
    const registry = await enqueueRegistryMutation(() => editRemoteInstance(input, desktop));
    const profile = registry.profiles.find((candidate) => candidate.id === input.profileId);
    if (!profile) throw new Error("The edited remote instance could not be found.");
    setState((current) => ({ ...current, registry, ...(current.activeProfile.id === profile.id ? { activeProfile: profile } : {}) }));
    stateRef.current = { ...stateRef.current, registry };
    if (stateRef.current.activeProfile.id === profile.id) {
      const generation = beginOpen(profile, registry);
      await openProfile(profile, registry, generation);
    }
  }, [beginOpen, desktop, enqueueRegistryMutation, openProfile]);

  const repairInstance = useCallback(async (profileId: string, token: string) => {
    const registry = await enqueueRegistryMutation(() => repairRemoteInstance(profileId, token, desktop));
    setState((current) => ({ ...current, registry }));
    stateRef.current = { ...stateRef.current, registry };
    if (stateRef.current.activeProfile.id === profileId) await retryActive();
  }, [desktop, enqueueRegistryMutation, retryActive]);

  const removeInstance = useCallback(async (profileId: string) => {
    const wasActive = stateRef.current.activeProfile.id === profileId;
    if (wasActive) {
      generationRef.current += 1;
      closeRuntime();
      setState((current) => ({ ...current, runtime: null, phase: "opening", error: null }));
    }
    const operationGeneration = generationRef.current;
    let registry: InstanceRegistrySnapshot;
    try {
      registry = await enqueueRegistryMutation(() => removeRemoteInstance(profileId, desktop));
    } catch (error) {
      if (mountedRef.current && generationRef.current === operationGeneration && wasActive) {
        const refreshed = await readInstanceRegistry(desktop).catch(() => null);
        if (mountedRef.current && generationRef.current === operationGeneration) {
          const restoredRegistry = refreshed ?? stateRef.current.registry;
          const restoredProfile = restoredRegistry.profiles.find((profile) => profile.id === profileId);
          const details = errorDetails(error);
          setState((current) => ({
            ...current,
            registry: restoredRegistry,
            ...(restoredProfile ? { activeProfile: restoredProfile } : {}),
            runtime: null,
            phase: restoredProfile ? "failed" : "missing",
            error: restoredProfile ? `Could not remove ${restoredProfile.label}: ${details.message}` : null,
            missingInstanceId: restoredProfile ? undefined : profileId,
            ...(restoredProfile
              ? { statuses: { ...current.statuses, [profileId]: { availability: "offline", message: details.message } } }
              : {}),
          }));
        }
      }
      throw error;
    }
    if (!mountedRef.current) return;
    if (generationRef.current !== operationGeneration) {
      setState((current) => ({ ...current, registry }));
      stateRef.current = { ...stateRef.current, registry };
      return;
    }
    const selected = registry.profiles.find((profile) => profile.id === registry.activeInstanceId)
      ?? registry.profiles.find((profile) => profile.id === "local")
      ?? LOCAL_PROFILE;
    if (wasActive || stateRef.current.activeProfile.id !== selected.id) {
      const generation = beginOpen(selected, registry);
      window.history.replaceState(
        window.history.state,
        "",
        instanceViewPath(selected.id, loadLastInstanceView(selected.id)),
      );
      await openProfile(selected, registry, generation);
    } else {
      setState((current) => ({ ...current, registry }));
      stateRef.current = { ...stateRef.current, registry };
    }
  }, [beginOpen, closeRuntime, desktop, enqueueRegistryMutation, openProfile]);

  const activateProfileRoute = useCallback((profileId: string, view: View) => {
    const current = stateRef.current;
    if (current.activeProfile.id !== profileId || current.phase !== "ready") {
      void switchTo(profileId, view);
      return;
    }
    const path = instanceViewPath(profileId, view);
    saveLastInstanceView(profileId, view);
    if (`${window.location.pathname}${window.location.search}` !== path) {
      window.history.pushState(window.history.state, "", path);
    }
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, [switchTo]);

  const navigation = useMemo(
    () => new DesktopInstanceNavigation(
      state.activeProfile.id,
      window,
      activateProfileRoute,
    ),
    [activateProfileRoute, state.activeProfile.id],
  );

  const reportActiveStatus = useCallback((status: InstanceStatus) => {
    const profileId = stateRef.current.activeProfile.id;
    setState((current) => {
      const previous = current.statuses[profileId];
      if (previous?.availability === status.availability && previous.message === status.message) return current;
      return { ...current, statuses: { ...current.statuses, [profileId]: status } };
    });
  }, []);

  const value = useMemo<InstanceManager>(() => ({
    desktopMultiInstance: true,
    registry: state.registry,
    activeProfile: state.activeProfile,
    runtime: state.runtime,
    navigation,
    phase: state.phase,
    error: state.error,
    statusByProfile: state.statuses,
    switchInstance: (profileId) => switchTo(profileId),
    retryActive,
    addAndSwitch,
    editInstance,
    repairInstance,
    removeInstance,
    manageInstances() {
      navigation.activate?.({ name: "runners", section: "instances" });
    },
    goToThisMachine: () => switchTo("local"),
    reportActiveStatus,
  }), [
    addAndSwitch,
    editInstance,
    navigation,
    removeInstance,
    reportActiveStatus,
    repairInstance,
    retryActive,
    state,
    switchTo,
  ]);

  return <InstancesContextProvider value={value}>{children}</InstancesContextProvider>;
}

export function desktopMultiInstanceAvailable(): boolean {
  return isTauri();
}
