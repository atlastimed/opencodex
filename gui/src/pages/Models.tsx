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
