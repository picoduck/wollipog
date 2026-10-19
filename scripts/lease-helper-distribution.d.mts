import type { BigIntStats } from "node:fs";
export interface HelperTuple { readonly schema: "WPLI1"; readonly target: string; readonly protocol: "WPLL4"; readonly sourceSha256: string; readonly imageSha256: string; readonly imageBytes: number; readonly abi: "framework4-il64" | "posix64" }
export interface InstalledHelper { root: string; path: string; bytes: Buffer; tuple: HelperTuple; verify(): Buffer }
export interface HelperAssociation { readonly schema: "WPLR1"; readonly helper: HelperTuple; readonly canonical: string; readonly legacy: string; readonly runnerSha256: string; readonly storage: "embedded" | "external"; readonly installerMode: "--lease-helper-install" }
export const LEASE_HELPER_LIMITS: Readonly<{ positions: number; imageBytes: number; windowsImageBytes: number; contractBytes: number; sourceRecords: number; entries: number; logicalBytes: number; diagnosticBytes: number; ancestry: number; compileMs: number; probeMs: number; producerMs: number }>;
export const LEASE_HELPER_TARGETS: Readonly<Record<string, string>>;
export function helperPositionName(index: number): string;
export function helperSourceRecordName(index: number): string;
export function helperImageName(tuple: HelperTuple): string;
export function helperReleaseAssetName(target: string): string;
export function helperAssociationName(target: string): string;
export function helperDigest(bytes: Uint8Array): string;
export function validateHelperTuple(value: unknown): HelperTuple;
export function helperContractBytes(tuple: HelperTuple): Buffer;
export function parseHelperTuple(bytes: Uint8Array): HelperTuple;
export function sameHelperTuple(a: HelperTuple, b: HelperTuple): boolean;
export function validateHelperAssociation(value: unknown): HelperAssociation;
export function helperAssociationBytes(value: HelperAssociation): Buffer;
export function parseHelperAssociation(bytes: Uint8Array): HelperAssociation;
export function boundedHelperChunks(input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, maximum: number, deadline?: number): AsyncGenerator<Uint8Array>;
export function collectHelperBytes(input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, maximum: number, deadline?: number): Promise<Buffer>;
export function helperAdmissionInventory(parent: string): { physical: string; check(): void };
export function pinHelperParent(parent: string, providerHome?: string): { physical: string; check(): void };
export function readHelperFile(path: string, maximum: number, check?: () => void, readOnly?: boolean): { bytes: Buffer; stat: BigIntStats };
export function findInstalledHelper(parent: string, expected: HelperTuple, providerHome?: string): InstalledHelper;
export function installLeaseHelper(parent: string, expected: HelperTuple, input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, options?: { deadline?: number; beforeWrite?: (offset: number, count: number) => void; onPhase?: (phase: "reserved" | "image-closed" | "contract-closed" | "completed") => void }): Promise<InstalledHelper>;
export function readSourceHelperTuple(parent: string, target: string, sourceSha256: string): HelperTuple;
export function publishSourceHelperTuple(parent: string, expected: HelperTuple): string;
