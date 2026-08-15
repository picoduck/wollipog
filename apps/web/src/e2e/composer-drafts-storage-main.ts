import {
  deleteComposerDraft,
  deleteComposerDraftIfMatches,
  loadComposerDraft,
  markComposerDraftAccepted,
  reserveComposerDraftSnapshot,
  saveComposerDraft,
} from "../composer-drafts.js";

declare global {
  interface Window {
    __WOLLIPOG_COMPOSER_DRAFTS_E2E__: {
      load(sessionId: string, instanceScope?: string): ReturnType<typeof loadComposerDraft>;
      save(sessionId: string, text: string, instanceScope?: string): ReturnType<typeof saveComposerDraft>;
      reserve(sessionId: string, text: string, instanceScope?: string): ReturnType<typeof reserveComposerDraftSnapshot>;
      delete(sessionId: string, instanceScope?: string): ReturnType<typeof deleteComposerDraft>;
      deleteIfMatches(
        sessionId: string,
        text: string,
        revision?: string,
        instanceScope?: string,
        supersededRevision?: string,
      ): ReturnType<typeof deleteComposerDraftIfMatches>;
      markAccepted(
        sessionId: string,
        text: string,
        revision?: string,
        instanceScope?: string,
        supersededRevision?: string,
      ): ReturnType<typeof markComposerDraftAccepted>;
    };
  }
}

window.__WOLLIPOG_COMPOSER_DRAFTS_E2E__ = {
  load: (sessionId, instanceScope) => loadComposerDraft(sessionId, instanceScope),
  save: (sessionId, text, instanceScope) => saveComposerDraft(sessionId, text, [], instanceScope),
  reserve: (sessionId, text, instanceScope) =>
    reserveComposerDraftSnapshot(sessionId, text, [], instanceScope),
  delete: (sessionId, instanceScope) => deleteComposerDraft(sessionId, instanceScope),
  deleteIfMatches: (sessionId, text, revision, instanceScope, supersededRevision) =>
    deleteComposerDraftIfMatches(sessionId, text, [], instanceScope, revision, supersededRevision),
  markAccepted: (sessionId, text, revision, instanceScope, supersededRevision) =>
    markComposerDraftAccepted(sessionId, text, [], instanceScope, revision, supersededRevision),
};

document.documentElement.dataset.ready = "1";
