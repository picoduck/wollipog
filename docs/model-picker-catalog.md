# Model Picker Catalog

The model picker uses the installed harness's capabilities to determine which models can be picked. The catalog only supplies display groups, release order, and names for known rolling aliases. Newly advertised models receive a direct row until catalog metadata is available. Hidden capabilities stay out of browsing.

The bundled catalog lives in `apps/web/src/model-picker-catalog.json`. For a known release line, add new exact IDs at the start of `releases` and increment `version`. Set `siblings` for collections like Gemini 4, where the order presents recommended choices and every listed model remains current. Only list a provider alias when its behavior is documented and the owning harness already reports that ID.

The build emits the catalog at `/model-picker-catalog.json` as well. A deployment can update that same-origin asset between app releases. Publish the validated file atomically with a larger version. The picker revalidates when opened, at most once per 15 minutes per page, and retains the last valid catalog for that bundle when the asset is unavailable or invalid. A changed bundled catalog starts with its own version. Roll back a bad change by restoring the earlier contents under a new version.


Codex App Server Agent Defaults can also follow a supported GPT family. The control plane resolves that preference against the live installation catalog before validating the new session's configuration. The picker only displays this choice when the server provides it. The running session receives a concrete model ID, and your Agent Defaults keep the family preference for the next launch.
