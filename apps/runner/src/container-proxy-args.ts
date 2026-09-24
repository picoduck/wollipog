/** Docker's client config.json injects these proxy pairs into every new container. Explicit
 * empty values override that default; a later trust-gated --env NAME can still opt in. */
export function dockerProxyClearArgs(): string[] {
  return ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "FTP_PROXY", "ftp_proxy",
    "NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy"].flatMap((name) => ["--env", `${name}=`]);
}
