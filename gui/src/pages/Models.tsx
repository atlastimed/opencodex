import { CodexStaleBanner } from "../components/codex-stale-banner";
import ModelPickerOrderEditor from "../components/ModelPickerOrderEditor";
import ModelDisplayNameDialog from "../components/ModelDisplayNameDialog";
import ModelPriceDialog from "../components/ModelPriceDialog";
import { fetchCodexAppServerState } from "../codex-app-server-state";
import type { AppServerStateOutcome } from "../codex-app-server-state";
import { useCodexRestart } from "../use-codex-restart";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Switch, Notice, EmptyState, Select, Tooltip } from "../ui";
import { IconChevron, IconBoxes, IconInfo, IconCheck, IconAlert, IconRefresh, IconPencil } from "../icons";
import { useT } from "../i18n/shared";
import type { TFn, TKey } from "../i18n/shared";
import { modelLabel } from "../model-display";
import { formatProviderDisplayName, providerDisplaySlug } from "../provider-icons";
import { readJsonIfOk, readJsonOrThrow } from "../fetch-json";
import { describeIntegrationRefusalParts } from "./integrations/refusal-copy";
import { readSessionListCache, writeSessionListCache } from "../session-list-cache";
import { setClientResourceData } from "../client-resource";
import { createBoundedFetch, type BoundedFetch } from "../bounded-fetch";
import {
  isModelPickerUsage, isPickerOrderSaved, isPickerOrderSettings, modelPickerOrder, modelPickerOrderMode,
  type ModelPickerOrderMode, type PickerOrderSettings, type PickerOrderSaved, type ModelPickerUsage,
} from "../model-picker-order";
import { startVisibilityPoll } from "../visibility-poll";
import { useDataSurface } from "../data-surface";
import { DataSurfaceSkeleton } from "../components/data-surface";
import ErrorBoundary from "../components/ErrorBoundary";
import Combos from "./Combos";
import RoutingProfiles from "./RoutingProfiles";
import CompatibilityMatrix from "./CompatibilityMatrix";
import { ModelsTabStrip } from "./models-tab-strip";
import {
  modelsPanelDomId,
  modelsTabDomId,
  readModelsTab,
  selectModelsTab,
  type ModelsTab,
} from "./models-tab";
import {
  buildProviderModelGroups,
  type ConfiguredProviderSummary,
  type ProviderModelGroup,
} from "../models-groups";
import {
  fetchSelectedModels,
  modelVisible,
  putModelVisibility,
  clientCatalogRefreshFailures,
  type ClientCatalogRefreshFailure,
  shouldApplyLoadGeneration,
  type ProviderModelMap,
  type ModelVisibilityScope,
  type ModelVisibilityTarget,
} from "../model-visibility";
import {
  activeModelOptions,
  CAP_OPTION_SET,
  CAP_OPTIONS,
  collectDisabledNamespaced,
  CUSTOM_OPTION,
  fmtK,
  NATIVE_CAP_OPTIONS,
  NATIVE_CAP_OPTION_SET,
  PAGE,
  readCollapsedProviders,
  THREAD_OPTION_SET,
  THREAD_OPTIONS,
  writeCollapsedProviders,
  discoveryFailureLabel,
  REASONING_EFFORT_LEVELS,
  type ModelRow,
  type ProviderContextCapsResponse,
  type ShadowCallData,
  type V2Status,
} from "./models-shared";
import { DiscoveryFailedHint, EmptyProviderHint } from "./models-provider-hints";
import { shadowCallModelOptions } from "./dashboard-shared";
import { shadowSourceModelBadge, shadowSourceModelLabel } from "./shadow-call-source";

type CachedModelsPage = {
  models: ModelRow[];
  providers: ConfiguredProviderSummary[];
  selectedModels: ProviderModelMap;
  disabled: string[];
  contextCaps: Record<string, number>;
  contextCapValues?: Record<string, number>;
  contextCapValue: number;
};

/** One subtitle per tab: only one panel is visible, so only one description applies. */
const SUBTITLE_TKEY: Record<ModelsTab, TKey> = {
  catalog: "models.subtitle",
  combos: "models.subtitle.combos",
  routing: "models.subtitle.routing",
  compatibility: "models.subtitle.compatibility",
};

/**
 * Parse a context-window field: a number, `null` for "unset", or `undefined` when the text is
 * not usable. Separators are cosmetic, so "64,000" and "64_000" and "64000" are one value.
 *
 * Safe-integer rather than integer: `Number.isInteger(1e100)` is true, the server rejects it,
 * and accepting it here would turn a typo into a round-trip error instead of inline feedback.
 *
 * Module scope because it closes over nothing — rebuilding it every render is wasted work.
 */
function parseContextWindowDraft(raw: string): number | null | undefined {
  const normalized = raw.replace(/[_,\s]/g, "");
  if (!normalized) return null;
  const value = Number(normalized);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}


/** #2465 per-provider model-preset view, as `GET /api/model-presets` returns it. */
interface ModelPresetView {
  mode: "preset" | "all" | "custom";
  appliedVersion?: number;
  availableVersion: number;
  presetIds: string[];
  presetCount: number;
  totalCount: number;
  fallback?: string;
}
interface ModelDiscoveryView {
  policy: "on" | "off";
  providers: Record<string, "on" | "off" | "inherit">;
  recentArrivals: Record<string, Array<{ id: string; at: string; state: string }>>;
}

interface AliasView {
  providers: Record<string, string>;
  models: Record<string, Record<string, { alias: string; source: "user" | "builtin"; stale?: boolean }>>;
  defaults: { global: boolean; providers: Record<string, boolean> };
}

export default function Models({ apiBase, restartEpoch = 0 }: { apiBase: string; restartEpoch?: number }) {
  // Codex app-server staleness (devlog/_fin/260815_gui_codex_restart). Named
  // appServerState, not catalogState: this file already binds that name to the
  // model-catalog resource state, which is an unrelated concept. (Spelling the
  // catalog route here would register a phantom endpoint with the CLI parity
  // sweep, which reads GUI sources for api paths.)
  const [appServerState, setAppServerState] = useState<AppServerStateOutcome["state"]>(null);
  // A restart request outlives a navigation away from this page, so its completion
  // callback must not set state after unmount.
  const appServerMounted = useRef(true);
  useEffect(() => {
    appServerMounted.current = true;
    return () => { appServerMounted.current = false; };
  }, []);

  const appServerRead = useRef<BoundedFetch | null>(null);
  const appServerReadGeneration = useRef(0);
  const appServerReadBase = useRef(apiBase);
  const cancelAppServerRead = useCallback(() => {
    appServerReadGeneration.current++;
    appServerRead.current?.controller.abort();
    appServerRead.current?.clear();
    appServerRead.current = null;
  }, []);
  const reloadAppServerState = useCallback(async () => {
    // An old restart callback must not start an A read after the page moved to B.
    if (!appServerMounted.current || appServerReadBase.current !== apiBase) return;
    cancelAppServerRead();
    const generation = appServerReadGeneration.current;
    const bounded = createBoundedFetch(15_000);
    appServerRead.current = bounded;
    try {
      const outcome = await fetchCodexAppServerState(apiBase, { signal: bounded.signal });
      if (bounded.signal.aborted || !appServerMounted.current
        || appServerReadBase.current !== apiBase || generation !== appServerReadGeneration.current
        || appServerRead.current !== bounded) return;
      setAppServerState(outcome.state);
    } finally {
      // The observation owns its deadline until settlement, independently of PUT.
      bounded.clear();
      if (appServerRead.current === bounded) appServerRead.current = null;
    }
  }, [apiBase, cancelAppServerRead]);

  // onSettled, not a per-button callback: the sidebar control knows nothing about
  // this page, and a restart succeeding there must still clear the banner here.
  const { restarting: codexRestarting, restart: handleCodexRestart } = useCodexRestart(apiBase, {
    onSettled: () => { void reloadAppServerState(); },
  });

  useEffect(() => {
    // Once on mount/base change or restart completion, never on a timer.
    appServerReadBase.current = apiBase;
    setAppServerState(null);
    void reloadAppServerState();
    return cancelAppServerRead;
  }, [apiBase, cancelAppServerRead, reloadAppServerState, restartEpoch]);



  /*
   * Tab state. The hash is the source of truth, so refresh, bookmark, and
   * Back/Forward keep the choice — same contract as `#logs` / `#logs/debug`.
   *
   * Panels mount lazily and then STAY mounted, hidden, so a half-typed combo draft
   * survives a tab hop. The mounted set accumulates in the handler rather than an
   * effect: an effect would cost a second render pass on every switch for a value both
   * callers already know.
   */
  const [tab, setTab] = useState<ModelsTab>(readModelsTab);
  const [mounted, setMounted] = useState<ReadonlySet<ModelsTab>>(() => new Set([readModelsTab()]));

  const activateTab = useCallback((next: ModelsTab) => {
    setTab(next);
    setMounted(current => (current.has(next) ? current : new Set([...current, next])));
  }, []);

  useEffect(() => {
    const syncFromHash = () => activateTab(readModelsTab());
    window.addEventListener("hashchange", syncFromHash);
    window.addEventListener("popstate", syncFromHash);
    return () => {
      window.removeEventListener("hashchange", syncFromHash);
      window.removeEventListener("popstate", syncFromHash);
    };
  }, [activateTab]);

  const selectTab = useCallback((next: ModelsTab) => {
    // Deliberate navigation: push a history entry so Back/Forward restore the tab.
    selectModelsTab(next);
    activateTab(next);
  }, [activateTab]);

  const catalogActive = tab === "catalog";

  /** Counts reported up by the panels that own the underlying lists. */
  const [comboCount, setComboCount] = useState<number | null>(null);
  const [routingCount, setRoutingCount] = useState<number | null>(null);
  const [compatibilityCount, setCompatibilityCount] = useState<number | null>(null);

  const t: TFn = useT();
  const cacheKey = `ocx.models.catalog.v1:${apiBase}`;
  const cached = useMemo(() => readSessionListCache<CachedModelsPage>(cacheKey), [cacheKey]);
  const [models, setModels] = useState<ModelRow[]>(() => cached?.models ?? []);
  const [providers, setProviders] = useState<ConfiguredProviderSummary[]>(() => cached?.providers ?? []);
  const [disabled, setDisabled] = useState<Set<string>>(() => new Set(cached?.disabled ?? []));
  const [selectedModels, setSelectedModels] = useState<ProviderModelMap | null>(() => cached?.selectedModels ?? null);
  const [search, setSearch] = useState<Record<string, string>>({});
  const [limit, setLimit] = useState<Record<string, number>>({});
  const [contextCaps, setContextCaps] = useState<Record<string, number>>(() => cached?.contextCaps ?? {});
  const [contextCapValues, setContextCapValues] = useState<Record<string, number>>(() => cached?.contextCapValues ?? {});
  const [contextCapValue, setContextCapValue] = useState(() => cached?.contextCapValue ?? 350_000);
  const pickerCacheKey = `${cacheKey}:picker-order`;
  const cachedPicker = useMemo(() => {
    const value = readSessionListCache<unknown>(pickerCacheKey);
    return isPickerOrderSettings(value) ? value : undefined;
  }, [pickerCacheKey]);
  const [pickerDraft, setPickerDraft] = useState<ModelPickerOrderMode | null>(null);
  const [pickerBusy, setPickerBusy] = useState(false);
  const pickerFlight = useRef<BoundedFetch | null>(null);
  const pickerGeneration = useRef(0);
  const pickerResource = useDataSurface<PickerOrderSettings>(
    pickerCacheKey, [apiBase],
    useCallback(async (signal: AbortSignal) => {
      const response = await fetch(`${apiBase}/api/subagent-models`, { signal });
      const data = await readJsonOrThrow<unknown>(response);
      if (!isPickerOrderSettings(data)) throw new Error("picker settings payload missing");
      if (signal.aborted) throw new Error("picker settings request aborted");
      writeSessionListCache(pickerCacheKey, data);
      return data;
    }, [apiBase, pickerCacheKey]),
    { isEmpty: () => false, enabled: catalogActive, deadlineMs: 15_000, initialData: cachedPicker },
  );
  const pickerSettings = pickerResource.state.data;
  const pickerMode = pickerDraft ?? modelPickerOrderMode(
    pickerSettings?.pickerAvailable ?? [], pickerSettings?.pickerOrder ?? [], pickerSettings?.pickerOrderMode,
  );
  useLayoutEffect(() => {
    pickerGeneration.current++;
    setPickerDraft(null);
    setPickerBusy(false);
    return () => {
      pickerGeneration.current++;
      pickerFlight.current?.controller.abort();
      pickerFlight.current?.clear();
      pickerFlight.current = null;
      cancelAppServerRead();
    };
  }, [apiBase, catalogActive, cancelAppServerRead]);
  useLayoutEffect(() => {
    // Pin inferred Custom before any late GET can switch mode and unmount its draft.
    if (catalogActive && pickerDraft === null && pickerMode === "custom") setPickerDraft("custom");
  }, [catalogActive, pickerDraft, pickerMode]);
  const [customCap, setCustomCap] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [providerCapCustomOpen, setProviderCapCustomOpen] = useState<Record<string, boolean>>({});
  const [providerCapCustomDraft, setProviderCapCustomDraft] = useState<Record<string, string>>({});
  const initialCollapsed = readCollapsedProviders();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => initialCollapsed ?? new Set());
  const needsDefaultCollapseRef = useRef(initialCollapsed === null);
  const [status, setStatus] = useState("");
  const [integrationFailures, setIntegrationFailures] = useState<ClientCatalogRefreshFailure[]>([]);
  const [ok, setOk] = useState(false);
  // Feedback generation: a repeated identical message (same success string, same validation
  // error) must still re-arm the toast timer. Clearing `status` alone is not enough — a
  // second identical value bails out of React's state diff, so the old timer would dismiss
  // the new toast early. Every publish bumps the generation.
  const [feedbackGen, setFeedbackGen] = useState(0);
  const publishFeedback = useCallback((nextOk: boolean, message: string) => {
    setOk(nextOk);
    setStatus(message);
    setFeedbackGen(g => g + 1);
  }, []);
  // Transient action feedback as a fixed toast: appearing or auto-clearing it never shifts
  // the workspace below (the old inline Notice pushed the whole model grid down by its
  // height on every apply). The timer itself just clears the status again.
  useEffect(() => {
    if (!status) return;
    const holdMs = ok ? 6000 : 8000;
    const timer = setTimeout(() => setStatus(""), holdMs);
    return () => clearTimeout(timer);
  }, [status, ok, feedbackGen]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const catalogMutationRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const loadPendingRef = useRef(false);
  // multi_agent_v2 / ultra gate. null = endpoint unavailable (older proxy build) -> section hidden.
  const [v2, setV2] = useState<V2Status | null>(null);
  // #2465: per-provider model-preset state. Keyed by provider so one card's busy state cannot
  // freeze the others.
  const [presets, setPresets] = useState<Record<string, ModelPresetView>>({});
  const [modelDiscovery, setModelDiscovery] = useState<ModelDiscoveryView | null>(null);
  const [aliases, setAliases] = useState<AliasView>({ providers: {}, models: {}, defaults: { global: false, providers: {} } });
  const [showAliases, setShowAliases] = useState(false);
  const [presetBusy, setPresetBusy] = useState<string | null>(null);
  const [v2Loading, setV2Loading] = useState(true);
  const [v2Busy, setV2Busy] = useState(false);
  const [v2Note, setV2Note] = useState("");
  const v2BusyRef = useRef(false);
  const [threadsCustom, setThreadsCustom] = useState("");
  const [showThreadsCustom, setShowThreadsCustom] = useState(false);
  const [v2HelpOpen, setV2HelpOpen] = useState(false);
  const [customModalOpen, setCustomModalOpen] = useState(false);
  const [displayNameModel, setDisplayNameModel] = useState<ModelRow | null>(null);
  const [priceModel, setPriceModel] = useState<ModelRow | null>(null);
  const priceTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [displayNameSaving, setDisplayNameSaving] = useState(false);
  const [displayNameRequestError, setDisplayNameRequestError] = useState<string | null>(null);
  const [displayNameRecovery, setDisplayNameRecovery] = useState<{
    value: string | null | undefined;
    confirmed: boolean;
  } | null>(null);
  const [displayNameCurrentPending, setDisplayNameCurrentPending] = useState(false);
  const displayNameRequestRef = useRef<BoundedFetch | null>(null);
  const displayNameSavingRef = useRef(false);
  useEffect(() => () => {
    displayNameRequestRef.current?.controller.abort();
    displayNameRequestRef.current?.clear();
    displayNameRequestRef.current = null;
  }, []);
  const displayNameTriggerRef = useRef<HTMLButtonElement | null>(null);

  const reloadAliases = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`${apiBase}/api/aliases`, { signal });
    const data = await readJsonIfOk<AliasView>(response);
    if (data && !signal?.aborted) setAliases(data);
  }, [apiBase]);
  useEffect(() => {
    const controller = new AbortController();
    void reloadAliases(controller.signal);
    return () => controller.abort();
  }, [reloadAliases]);

  const saveProviderAlias = async (provider: string) => {
    const entered = window.prompt(t("models.aliasPrompt"), aliases.providers[provider] ?? "");
    if (entered === null) return;
    const response = await fetch(`${apiBase}/api/providers/${encodeURIComponent(provider)}/alias`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ alias: entered.trim() || null }),
    });
    if (!response.ok) { publishFeedback(false, t("models.aliasConflict")); return; }
    await reloadAliases();
    publishFeedback(true, t("models.aliasSaved"));
  };

  const saveModelAlias = async (provider: string, model: string) => {
    const current = aliases.models[provider]?.[model]?.alias ?? "";
    const entered = window.prompt(t("models.modelAliasPrompt"), current);
    if (entered === null) return;
    const body = entered.trim() ? { set: { [model]: entered.trim() } } : { remove: [model] };
    const response = await fetch(`${apiBase}/api/providers/${encodeURIComponent(provider)}/model-aliases`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    if (!response.ok) { publishFeedback(false, t("models.aliasConflict")); return; }
    await reloadAliases();
    publishFeedback(true, t("models.aliasSaved"));
  };

  const setDefaultAliases = async (enabled: boolean, provider?: string) => {
    const response = await fetch(`${apiBase}/api/default-aliases`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled, ...(provider ? { provider } : {}) }),
    });
    if (response.ok) await reloadAliases();
  };
  const [customModalMode, setCustomModalMode] = useState<"add" | "edit">("add");
  const [customModalProvider, setCustomModalProvider] = useState("");
  const [customModalId, setCustomModalId] = useState("");
  const [customFormModelId, setCustomFormModelId] = useState("");
  const [customFormDisplayName, setCustomFormDisplayName] = useState("");
  const [customFormContextWindow, setCustomFormContextWindow] = useState("");
  const [customFormShowCustomCtx, setCustomFormShowCustomCtx] = useState(false);
  const [customFormModalities, setCustomFormModalities] = useState<string[]>(["text"]);
  const [customFormReasoning, setCustomFormReasoning] = useState(false);
  const [customFormReasoningEfforts, setCustomFormReasoningEfforts] = useState<string[]>([]);
  // Whether the ladder has been seeded at least once. `[]` is a MEANINGFUL explicit
  // no-reasoning override, so initialization is tracked separately from the array contents:
  // once seeded (an edit's stored ladder — including an explicit empty one — or a new form's
  // first enable), re-enabling the override preserves the current array even when empty.
  const customFormReasoningInitializedRef = useRef(false);
  const [customSaving, setCustomSaving] = useState(false);
  const [customError, setCustomError] = useState("");
  const [contextModalProvider, setContextModalProvider] = useState<string | null>(null);
  const [contextModalModels, setContextModalModels] = useState<string[]>([]);
  const [contextModelId, setContextModelId] = useState("");
  const [contextDefaultDraft, setContextDefaultDraft] = useState("");
  const [contextModelDrafts, setContextModelDrafts] = useState<Record<string, string>>({});
  // What the modal showed when it opened. Every payload decision compares against THIS, not
  // against the live `groups`, because the 10s poll can refresh a value mid-modal: diffing
  // against current state would mark an untouched field dirty and revert someone else's change.
  const [contextSnapshot, setContextSnapshot] = useState<{
    contextWindow: number | null;
    modelContextWindows: Record<string, number | null>;
  }>({ contextWindow: null, modelContextWindows: {} });
  // Which fields the USER typed into. Touch alone is not enough to send — a value typed and
  // then restored is not a change — but it is what makes an untouched field ineligible.
  const [contextTouchedModels, setContextTouchedModels] = useState<Set<string>>(new Set());
  const [contextDefaultTouched, setContextDefaultTouched] = useState(false);
  const [contextSaving, setContextSaving] = useState(false);
  const [contextError, setContextError] = useState("");
  const [hoveredModel, setHoveredModel] = useState<{ namespaced: string; rect: DOMRect } | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [shadowCall, setShadowCall] = useState<ShadowCallData | null>(null);
  const [shadowCallSaving, setShadowCallSaving] = useState(false);

  // App owns the in-session view mode; fallback to persisted mode for isolated renders/tests.
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);

  useEffect(() => () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  }, []);

  const shadowModelOptions = useMemo(
    () => activeModelOptions(models, disabled, selectedModels ?? {}, t),
    [models, disabled, selectedModels, t],
  );
  const shadowCallOptions = useMemo(() => {
    const activeNamespaced = new Set(shadowModelOptions.map(option => option.value));
    return shadowCallModelOptions(
      models.filter(model => activeNamespaced.has(model.namespaced)),
      shadowCall?.model,
      shadowCall?.sourceModels,
    );
  }, [models, shadowCall?.model, shadowCall?.sourceModels, shadowModelOptions]);

  const loadShadowCall = useCallback(async () => {
    const bounded = createBoundedFetch(15_000);
    try {
      const r = await fetch(`${apiBase}/api/shadow-call-settings`, { signal: bounded.signal });
      const data = await readJsonIfOk<ShadowCallData>(r);
      if (data) setShadowCall(data);
    } catch { /* old server / network: keep the section disabled */ }
    finally { bounded.clear(); }
  }, [apiBase]);

  const loadV2 = useCallback(async () => {
    // Never let a toggle in flight be clobbered by the poll (same single-flight rule as models).
    if (v2BusyRef.current) return;
    const bounded = createBoundedFetch(15_000);
    try {
      const r = await fetch(`${apiBase}/api/v2`, { signal: bounded.signal });
      if (!(r.headers.get("content-type") ?? "").includes("application/json")) { setV2(null); return; }
      const data = await readJsonIfOk<V2Status>(r);
      if (!data || typeof data.enabled !== "boolean") { setV2(null); return; }
      setV2({
        enabled: data.enabled,
        agentsMaxThreadsConflict: data.agentsMaxThreadsConflict === true,
        maxConcurrentThreadsPerSession: typeof data.maxConcurrentThreadsPerSession === "number" ? data.maxConcurrentThreadsPerSession : null,
        multiAgentMode: data.multiAgentMode === "v1" || data.multiAgentMode === "v2" ? data.multiAgentMode : "default",
        keepNativeChatGptOnV1: data.keepNativeChatGptOnV1 === true,
      });
    } catch {
      setV2(null); // old server / network: hide the section instead of guessing
    } finally {
      bounded.clear();
      setV2Loading(false);
    }
  }, [apiBase]);

  const fetchCatalog = useCallback(async (signal: AbortSignal): Promise<CachedModelsPage> => {
    const [modelsRes, capsRes, providersRes, selectionData] = await Promise.all([
      // Every request carries the resource signal, so leaving the catalog tab cancels
      // the work rather than only discarding its result.
      fetch(`${apiBase}/api/models`, { signal }),
      fetch(`${apiBase}/api/provider-context-caps`, { signal }),
      fetch(`${apiBase}/api/providers`, { signal }),
      fetchSelectedModels(apiBase, fetch, signal),
    ]);
    const [data, capsData, providerData] = await Promise.all([
      readJsonOrThrow<ModelRow[]>(modelsRes),
      readJsonOrThrow<ProviderContextCapsResponse>(capsRes),
      readJsonOrThrow<ConfiguredProviderSummary[]>(providersRes),
    ]);
    if (data === undefined || capsData === undefined || providerData === undefined) {
      throw new Error("models payload missing");
    }
    if (signal.aborted) throw new Error("models request aborted");
    const nextDisabled = collectDisabledNamespaced(data);
    const value = typeof capsData.value === "number" && Number.isFinite(capsData.value) && capsData.value > 0
      ? capsData.value
      : (typeof capsData.cap === "number" && Number.isFinite(capsData.cap) && capsData.cap > 0 ? capsData.cap : undefined);
    const nextCapValue = value !== undefined ? value : 350_000;
    const next = {
      models: data,
      providers: providerData,
      selectedModels: selectionData,
      disabled: [...nextDisabled],
      contextCaps: capsData.caps ?? {},
      contextCapValues: capsData.values ?? capsData.caps ?? {},
      contextCapValue: nextCapValue,
    } satisfies CachedModelsPage;
    writeSessionListCache(cacheKey, next);
    return next;
  }, [apiBase, cacheKey]);

  const applyCatalog = useCallback((next: CachedModelsPage) => {
    const nextGroups = buildProviderModelGroups(next.models, next.providers);
    setSelectedProvider(prev => (
      prev !== null && !nextGroups.some(group => group.provider === prev)
        ? null
        : prev
    ));
    setModels(next.models);
    setProviders(next.providers);
    setDisabled(new Set(next.disabled));
    setSelectedModels(next.selectedModels);
    setContextCapValue(next.contextCapValue);
    setContextCaps(next.contextCaps);
    setContextCapValues(next.contextCapValues ?? next.contextCaps);
  }, []);

  const catalogResource = useDataSurface<CachedModelsPage>(
    cacheKey,
    [apiBase],
    async (signal) => {
      const next = await fetchCatalog(signal);
      // A manual mutation refresh may have invalidated this request while its JSON was decoding.
      // Do not let the aborted catalog repaint controls after the newer result is applied.
      if (signal.aborted) throw new Error("models request aborted");
      applyCatalog(next);
      return next;
    },
    // Gated on the catalog tab: a 10-second poll that keeps running while the user
    // reads Combos or Routing is exactly the hidden work this workspace avoids.
    // Live model discovery is slow; the catalog gets a raised deadline so a slow
    // response is never misread as a hung one.
    { isEmpty: () => false, pollMs: 10_000, initialData: cached ?? undefined, enabled: catalogActive, deadlineMs: 60_000 },
  );
  const catalogState = catalogResource.state;

  const load = useCallback(async (force = false, signal?: AbortSignal): Promise<boolean> => {
    if (loadPendingRef.current && !force) return false;
    loadPendingRef.current = true;
    const generation = ++loadGenerationRef.current;
    try {
      const next = await fetchCatalog(signal ?? new AbortController().signal);
      if (!shouldApplyLoadGeneration(generation, loadGenerationRef.current)) return false;
      applyCatalog(next);
      // Follow-up mutation refreshes retain their existing awaitable contract while publishing
      // the result through the same shared store used by the initial catalog subscription.
      setClientResourceData(cacheKey, next);
      pickerResource.refresh();
      return true;
    } catch {
      return false;
    } finally {
      if (shouldApplyLoadGeneration(generation, loadGenerationRef.current)) {
        loadPendingRef.current = false;
      }
    }
  }, [applyCatalog, cacheKey, fetchCatalog, pickerResource.refresh]);

  const finishDisplayNameEdit = useCallback(() => {
    const trigger = displayNameTriggerRef.current;
    setDisplayNameModel(null);
    setDisplayNameRequestError(null);
    setDisplayNameRecovery(null);
    setDisplayNameCurrentPending(false);
    window.setTimeout(() => {
      if (trigger?.isConnected) trigger.focus();
    }, 0);
  }, []);

  const closeDisplayNameEdit = useCallback(() => {
    if (!displayNameSavingRef.current) finishDisplayNameEdit();
  }, [finishDisplayNameEdit]);

  // undefined retries only the read after a confirmed write or an unknown outcome.
  const saveDisplayName = useCallback(async (displayName: string | null | undefined) => {
    const model = displayNameModel;
    if (!model || displayNameSavingRef.current) return;
    const bounded = createBoundedFetch(60_000);
    displayNameRequestRef.current = bounded;
    displayNameSavingRef.current = true;
    setDisplayNameSaving(true);
    setDisplayNameRequestError(null);
    // A failed convergence retry cannot invalidate an earlier persistence receipt
    // for the same value. Editing the draft clears recovery and starts a new intent.
    let confirmed = displayNameRecovery?.confirmed === true
      && (displayName === undefined || displayName === displayNameRecovery.value);
    let receivedReceipt = displayName === undefined;
    let refreshOnly = displayName === undefined;
    try {
      if (displayName !== undefined) {
        const response = await fetch(
          `${apiBase}/api/providers/${encodeURIComponent(model.provider)}/model-display-names`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ modelId: model.id, displayName }),
            signal: bounded.signal,
          },
        );
        // The route can persist the value and return 503 when catalog convergence fails.
        // Keep that receipt instead of throwing away saved:true with the error body.
        type DisplayNameReceipt = {
          saved?: boolean;
          error?: string;
          displayName?: string;
          displayNameOverride?: string | null;
          displayNameSource?: ModelRow["displayNameSource"];
        };
        const result: DisplayNameReceipt | undefined = response.ok
          ? await readJsonOrThrow<DisplayNameReceipt>(response, t("models.displayNameSaveFailed"))
          : await response.json();
        bounded.signal.throwIfAborted();
        if (!result || typeof result !== "object" || Array.isArray(result)
          || (!response.ok && result.saved !== true && typeof result.error !== "string")) {
          throw new Error(t("models.displayNameSaveFailed"));
        }
        receivedReceipt = true;
        const receiptConfirmed = response.ok || result.saved === true;
        confirmed = confirmed || receiptConfirmed;
        if (receiptConfirmed) {
          const override = result.displayNameOverride === null ? undefined
            : result.displayNameOverride ?? displayName ?? undefined;
          const fields: Pick<ModelRow, "displayName" | "displayNameOverride" | "displayNameSource"> = {
            displayName: result.displayName ?? override,
            displayNameOverride: override,
            displayNameSource: result.displayNameSource ?? (override ? "operator" : undefined),
          };
          setModels(current => current.map(row => row.namespaced === model.namespaced ? { ...row, ...fields } : row));
          setDisplayNameModel({ ...model, ...fields });
          // A saved:true reset receipt omits the provider's effective fallback label.
          setDisplayNameCurrentPending(fields.displayName === undefined);
        }
        if (!response.ok) {
          throw new Error(result.error || t("models.displayNameSaveFailed"));
        }
        refreshOnly = true;
      }
      if (!await load(true, bounded.signal)) throw new Error(t("models.loadFail"));
      bounded.signal.throwIfAborted();
      publishFeedback(true, confirmed
        ? t(displayName === null || (displayName === undefined && displayNameRecovery?.value === null)
          ? "models.displayNameResetDone" : "models.displayNameSaved")
        : t("models.displayNameReloaded"));
      finishDisplayNameEdit();
    } catch (error) {
      if (displayNameRequestRef.current !== bounded) return;
      // A dropped connection or unreadable body can hide a committed write just
      // like a timeout. Reconcile by reading; never replay an unchanged old draft.
      const unknownOutcome = !receivedReceipt || bounded.signal.aborted;
      if (unknownOutcome && !confirmed) setDisplayNameCurrentPending(true);
      setDisplayNameRecovery(confirmed || unknownOutcome || refreshOnly
        ? { value: refreshOnly || unknownOutcome ? undefined : displayName, confirmed }
        : null);
      setDisplayNameRequestError(confirmed
        ? t("models.displayNameSavedRefreshFailed")
        : unknownOutcome || refreshOnly
          ? t("models.displayNameOutcomeUnknown")
          : error instanceof Error && error.message
            ? error.message
            : t("models.displayNameSaveFailed"));
    } finally {
      bounded.clear();
      if (displayNameRequestRef.current === bounded) {
        displayNameRequestRef.current = null;
        displayNameSavingRef.current = false;
        setDisplayNameSaving(false);
      }
    }
  }, [apiBase, displayNameModel, displayNameRecovery, finishDisplayNameEdit, load, publishFeedback, t]);

  // Shadow/v2 controls must not wait on the models catalog (live discovery can be slow).
  useEffect(() => {
    // Both belong to the catalog tab; a hidden panel polling /api/v2 every ten seconds
    // is the same leak as the catalog poll above.
    if (!catalogActive) return;
    const timeout = window.setTimeout(() => {
      void loadShadowCall();
      void loadV2();
      // Preset previews belong to the same tab. Loaded once rather than polled: the rules are
      // shipped code and the catalog poll above already refreshes the rows they describe.
      void loadPresets();
      void loadModelDiscovery();
    }, 0);
    // Hidden tab: no timer, no /api/v2 traffic; the make-up tick refreshes on return.
    const stop = startVisibilityPoll(() => {
      if (!v2BusyRef.current) void loadV2();
    }, 10_000);
    return () => {
      window.clearTimeout(timeout);
      stop();
    };
    // oxlint-disable-next-line react/react-compiler -- existing exhaustive-deps exception is intentional
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadPresets is a plain async loader
    // like the rest of this file's; a useCallback wrapper trips PreserveManualMemo, and the
    // effect only ever needs the current closure. Verified 2026-08-27: converting both loaders
    // to useCallback and completing the dep array turns ONE warning into five react-compiler
    // errors - two PreserveManualMemo, two Immutability (they are declared ~430 lines below this
    // effect), and one EffectSetState - so the note above still holds against oxlint 1.78.
    // Both gates suppress this one rule for this one file by config rather than by comment:
    // gui/.oxlintrc.json (override) and gui/doctor.config.json (ignore.overrides). An in-file
    // react-doctor-disable comment was tried and removed - it changed nothing, and
    // react/react-compiler penalises a component for carrying suppressions at all.
  }, [catalogActive, loadShadowCall, loadV2]);

  const groups = useMemo(
    () => buildProviderModelGroups(models, providers),
    [models, providers],
  );

  /*
   * The catalog count is only honest once a seed or a real response has landed. With
   * the catalog gated, a cold load straight to `#models/combos` never fetches it, and
   * rendering "0/0" would present unknown as fact.
   */
  const catalogCountReady = models.length > 0 || catalogState.data !== undefined;

  const openContextSettings = (group: ProviderModelGroup<ModelRow>) => {
    const modelIds = [...new Set([
      ...group.rows.map(model => model.id),
      ...group.configuredModels,
      // A model that vanished from live discovery can still hold an override. Without this it
      // would sit in the drafts map, invisible in the picker, with no way to inspect or clear it.
      ...Object.keys(group.modelContextWindows ?? {}),
    ])].sort();
    const modelId = modelIds[0] ?? "";
    setContextModalProvider(group.provider);
    setContextModalModels(modelIds);
    setContextModelId(modelId);
    const defaultDraft = group.contextWindow ? String(group.contextWindow) : "";
    const modelDrafts = Object.fromEntries(
      Object.entries(group.modelContextWindows ?? {})
        .map(([model, window]) => [model, String(window)]),
    );
    setContextDefaultDraft(defaultDraft);
    setContextModelDrafts(modelDrafts);
    // Canonical numbers, not the raw strings. "64,000" and "64_000" and "64000" are the same
    // value, and comparing text would treat a reformat as an edit — then Apply would send a
    // stale number over whatever changed while the modal was open.
    setContextSnapshot({
      contextWindow: group.contextWindow ?? null,
      modelContextWindows: Object.fromEntries(
        Object.entries(group.modelContextWindows ?? {}).map(([model, window]) => [model, window]),
      ),
    });
    setContextTouchedModels(new Set());
    setContextDefaultTouched(false);
    setContextError("");
  };

  const selectContextModel = (modelId: string) => {
    setContextModelId(modelId);
  };

  const saveContextSettings = async () => {
    if (!contextModalProvider) return;
    const providerWindow = parseContextWindowDraft(contextDefaultDraft);
    const group = groups.find(candidate => candidate.provider === contextModalProvider);
    if (!group) {
      setContextError(t("models.contextSaveFailed"));
      return;
    }

    // A field is sent only when the user touched it AND its value actually differs from what
    // the modal opened with. Both halves matter, and each one alone is wrong.
    //
    // Sending only the selected model — what this did before — silently dropped any model
    // edited before switching the picker. No error, no warning, the value just did not save.
    //
    // Sending everything that differs from the LIVE state is wrong the other way: the 10s poll
    // can refresh a field mid-modal, and a stale draft would then look dirty and revert a
    // change the user never made. Comparing against the opening snapshot instead means a value
    // typed and then restored sends nothing at all.
    // Only validate the default when the user touched it. A malformed value inherited from a
    // hand-edited config would otherwise block a save that never intended to touch it.
    if (contextDefaultTouched && providerWindow === undefined) {
      setContextError(t("models.contextInvalid"));
      return;
    }
    const modelWindows: Record<string, number | null> = {};
    for (const modelId of contextTouchedModels) {
      const draft = contextModelDrafts[modelId] ?? "";
      const parsed = parseContextWindowDraft(draft);
      if (parsed === undefined) {
        setContextError(t("models.contextInvalid"));
        return;
      }
      // Compare VALUES, not text. Retyping 64000 as "64,000" is not a change.
      if (parsed === (contextSnapshot.modelContextWindows[modelId] ?? null)) continue;
      modelWindows[modelId] = parsed;
    }
    const defaultChanged = contextDefaultTouched
      && providerWindow !== contextSnapshot.contextWindow;

    // Nothing survived the comparison: every edit was reverted before Apply. Writing an
    // unchanged payload would still stamp over concurrent edits.
    if (!defaultChanged && Object.keys(modelWindows).length === 0) {
      setContextModalProvider(null);
      // Not "updated" — nothing was. Saying otherwise would be a small lie the user could
      // act on, e.g. believing a value they typed and reverted had been written.
      publishFeedback(true, t("models.contextUnchanged"));
      return;
    }

    setContextSaving(true);
    setContextError("");
    try {
      const body: Record<string, unknown> = {};
      if (defaultChanged) body.contextWindow = providerWindow;
      if (Object.keys(modelWindows).length > 0) body.modelContextWindows = modelWindows;
      const response = await fetch(
        `${apiBase}/api/providers?name=${encodeURIComponent(contextModalProvider)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      await readJsonOrThrow(response, t("models.contextSaveFailed"));
    } catch (error) {
      setContextError(error instanceof Error ? error.message : t("models.contextSaveFailed"));
      return;
    } finally {
      setContextSaving(false);
    }

    // Past the write boundary: the values ARE saved. A refresh that fails afterwards is a
    // display problem, and reporting it through `contextError` would set an error on a modal
    // that is already closed — invisible to the user, and it contradicts the success they just
    // saw. Let the ordinary load error surface handle it.
    setContextModalProvider(null);
    publishFeedback(true, t("models.contextSaved"));
    await load(true);
  };

  // One-shot default collapse. It stays an effect on `groups` so CACHED groups collapse
  // immediately on first paint, even when revalidation is slow or fails; moving it into
  // the load() success path would render cached providers expanded and leave them
  // expanded whenever the refresh errors.
  useEffect(() => {
    if (!needsDefaultCollapseRef.current) return;
    if (groups.length === 0) return;
    needsDefaultCollapseRef.current = false;
    const all = new Set(groups.map(group => group.provider));
    // eslint-disable-next-line react-hooks/set-state-in-effect, react/react-compiler
    setCollapsed(all);
    writeCollapsedProviders(all);
  }, [groups]);

  const effectiveVisibleCount = useMemo(() => {
    if (!selectedModels) return 0;
    return models.filter(model => modelVisible(
      selectedModels,
      model.provider,
      model.id,
      model.native === true,
      disabled.has(model.namespaced),
    )).length;
  }, [disabled, models, selectedModels]);

  /*
   * Quiet per-tab counts. A count is omitted, never zeroed, while it is unknown: the
   * panels report theirs up once mounted, and a tab that has never been opened has
   * nothing truthful to say.
   */
  const tabMeta = useMemo(() => ({
    catalog: catalogCountReady
      ? t("models.active", { active: effectiveVisibleCount, total: models.length })
      : undefined,
    combos: comboCount === null ? undefined : String(comboCount),
    routing: routingCount === null ? undefined : String(routingCount),
    compatibility: compatibilityCount === null ? undefined : String(compatibilityCount),
  }), [catalogCountReady, comboCount, compatibilityCount, effectiveVisibleCount, models.length, routingCount, t]);

  const applyVisibility = async (
    scope: ModelVisibilityScope,
    provider: string,
    targets: ModelVisibilityTarget[],
    enabled: boolean,
  ) => {
    if (catalogMutationRef.current) return;
    catalogMutationRef.current = true;
    ++loadGenerationRef.current;
    setBusy(true);
    busyRef.current = true;
    setStatus("");
    let errorKey: "models.saveFailed" | "models.networkError" | null = null;
    try {
      const response = await putModelVisibility(apiBase, scope, provider, targets, enabled);
      if (!response.ok) errorKey = "models.saveFailed";
      else {
        const failures = clientCatalogRefreshFailures(await response.json());
        if (failures !== undefined) setIntegrationFailures(failures);
      }
    } catch {
      errorKey = "models.networkError";
    } finally {
      const refreshed = await load(true);
      if (errorKey) {
        setOk(false);
        setStatus(t(errorKey));
      } else if (refreshed) {
        setOk(true);
        setStatus(t("models.applied"));
      }
      setBusy(false);
      busyRef.current = false;
      catalogMutationRef.current = false;
    }
  };

  const toggleProviderCap = async (provider: string) => {
    setBusy(true);
    busyRef.current = true;
    setStatus("");
    // Send the desired next state, not the current one: clicking the switch turns a
    // currently-unset cap on (enabled: true) and a currently-set cap off (enabled: false).
    const enabled = contextCaps[provider] === undefined;
    try {
      const r = await fetch(`${apiBase}/api/provider-context-caps`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, enabled }),
      });
      try {
        const data = await readJsonOrThrow<ProviderContextCapsResponse>(r, t("models.capSaveFailed"));
        setContextCaps(data?.caps ?? {});
        setContextCapValues(data?.values ?? data?.caps ?? {});
        setOk(true);
        setStatus(t("models.capApplied"));
        await load(true);
      } catch (e) {
        setOk(false);
        setStatus(e instanceof Error ? e.message : t("models.capSaveFailed"));
      }
    } catch {
      setOk(false); setStatus(t("models.networkError"));
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  };
  const toggleCollapse = (p: string) => {
    setCollapsed(prev => {
      const n = new Set(prev);
      if (n.has(p)) n.delete(p); else n.add(p);
      writeCollapsedProviders(n);
      return n;
    });
  };
  const setAllCollapsed = (collapse: boolean) => {
    setCollapsed(() => {
      const n = collapse ? new Set(groups.map(group => group.provider)) : new Set<string>();
      writeCollapsedProviders(n);
      return n;
    });
  };

  const putCap = async (body: Record<string, unknown>) => {
    setBusy(true);
    busyRef.current = true;
    setStatus("");
    try {
      const r = await fetch(`${apiBase}/api/provider-context-caps`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      try {
        const data = await readJsonOrThrow<ProviderContextCapsResponse>(r, t("models.capSaveFailed"));
        if (typeof data?.value === "number" && Number.isFinite(data.value) && data.value > 0) setContextCapValue(data.value);
        setContextCaps(data?.caps ?? {});
