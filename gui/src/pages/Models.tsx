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
  const [priceModel, setPriceModel] = us