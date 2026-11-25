# Model Picker Catalog

The model picker uses the installed harness's capabilities to determine which models can be picked. The browser catalog supplies display groups and release order. Newly advertised models appear immediately, grouped when Wollipog recognizes their release line and otherwise as direct choices. Hidden capabilities stay out of browsing.

The bundled catalog lives in `apps/web/src/model-picker-catalog.json`. For a known release line, add new exact IDs at the start of `releases` and increment `version`. Set `siblings` for collections like Gemini 4, where the order presents recommended choices and every listed model remains current. Only list a provider alias when its behavior is documented and the owning harness already reports that ID.

The build emits the catalog at `/model-picker-catalog.json` as well. A deployment can update that same-origin asset between app releases. Publish the validated file atomically with a larger version. The picker revalidates when opened, at most once per 15 minutes per page, and retains the last valid catalog for that bundle when the asset is unavailable or invalid. A changed bundled catalog starts with its own version. Roll back a bad change by restoring the earlier contents under a new version.

## Latest Choices

The picker names verified rolling provider aliases when the harness advertises them. These aliases keep their existing provider behavior. Gemini 4 siblings remain separate releases. [Google’s model version patterns](https://aistudio.google.com/docs/models#model-versions) distinguish stable releases from rolling aliases.

Wollipog can also follow a curated family in Agent Defaults and ordinary create-session automations, and in a handoff to a compatible agent. The control plane resolves the family against the destination's live installation catalog before validating the concrete model, effort and other settings. It refuses a missing family instead of selecting another model. A stored preference keeps its family, while the new session and runner command receive a concrete ID. Agent Defaults show which release each machine resolves when those releases differ.

The managed resolver lives in `packages/protocol/src/managed-model-choice.ts`. It covers GPT release lines on Codex App Server and provider-qualified OpenAI, Anthropic, and Z.ai releases discovered by Pi. It excludes previews, hidden models, and other provider namespaces. [Pi’s provider resolver](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/model-resolver.ts) lists its provider IDs. [Anthropic’s model ID documentation](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions) identifies which Claude IDs are pinned.

Cached discovery and unsupported harnesses still expose their advertised specific models. Campaign and other launch inputs with exact-model requirements continue to use their existing validation. The browser catalog never authorizes a launch.
