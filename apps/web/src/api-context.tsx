import { createContext, useContext, type ReactNode } from "react";
import { api, type ApiClient } from "./api.js";

const ApiContext = createContext<ApiClient>(api);

export function ApiProvider({
  client = api,
  children,
}: {
  client?: ApiClient;
  children: ReactNode;
}) {
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

/** Returns the API client scoped to the active Wollipog instance. */
export function useApi(): ApiClient {
  return useContext(ApiContext);
}
