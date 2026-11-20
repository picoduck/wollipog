import type { ReactNode } from "react";
import { useInstances } from "../instances-context.js";
import { instanceViewPath } from "../instance-navigation.js";
import { viewPath, type View } from "../navigation.js";
import { useHasStore, useStoreActions } from "../store.js";

export const ASSISTANT_DEFAULTS_VIEW = { name: "settings", section: "assistant" } as const;

type Props = {
  view: View;
  children: ReactNode;
  className?: string;
};

export function AssistantSettingsLink(props: Props) {
  return useHasStore() ? <StoreLink {...props} /> : <a className={props.className ?? "btn sm"} href={viewPath(props.view)}>{props.children}</a>;
}

function StoreLink({ view, children, className = "btn sm" }: Props) {
  const { navigate } = useStoreActions();
  const { desktopMultiInstance, activeProfile } = useInstances();
  return <a className={className} href={desktopMultiInstance ? instanceViewPath(activeProfile.id, view) : viewPath(view)} onClick={(event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(view);
  }}>{children}</a>;
}
