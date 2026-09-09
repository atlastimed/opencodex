import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { I18nContext, interpolate, LOCALES } from "../src/i18n/shared";
import { DICTS, type Locale, type TKey } from "../src/i18n/shared";
import { LanguageProvider } from "../src/i18n/provider";
import Models from "../src/pages/Models";
import { EmptyProviderHint } from "../src/pages/models-provider-hints";
import { discoveryFailureLabel } from "../src/pages/models-shared";
import type { ProviderDiscoverySummary } from "../src/models-groups";
import { en } from "../src/i18n/en";

/**
 * Models-page discovery-failure guidance (#4075).
 *
 * Imports only modules that exist on the recorded baseline (`EmptyProviderHint`,
 * `Models`) so the same file can run against an isolated unpatched copy. A
 * missing `DiscoveryFailedHint` export is not required for these assertions.
 */

const originalFetch = globalThis.fetch;
let previousLanguage: unknown;

const HTTP_FAILURE: Extract<ProviderDiscoverySummary, { status: "failed" }> = {
  status: "failed",
  reason: "http",
  httpStatus: 401,
};

const PROVIDER = "google-custom";
const CUSTOM_ID = "gemini-3.8-flash";

type CatalogRow = {
  provider: string;
  id: string;
  namespaced: string;
  disabled: boolean;
  custom?: boolean;
};

type Fixture = {
  liveModels: boolean;
  discovery?: ProviderDiscoverySummary;
  rows: CatalogRow[];
  selected: string[];
  holdModels?: boolean;
};

type WriteCall = { method: string; url: string; body: string };

const domGlobals = [
  "document",
  "window",
  "localStorage",
  "sessionStorage",
  "IS_REACT_ACT_ENVIRONMENT",
  "setInterval",
  "clearInterval",
] as const;

function catalogT(locale: Locale) {
  return (key: TKey, vars?: Record<string, string | number>) =>
    interpolate(DICTS[locale][key] ?? en[key] ?? key, vars);
}

function guidanceText(locale: Locale = "en"): string {
  return catalogT(locale)("models.discoveryFailedGuidance", {
    setting: catalogT(locale)("pws.liveModels"),
  });
}

function reasonText(
  discovery: Extract<ProviderDiscoverySummary, { status: "failed" }>,
  locale: Locale = "en",
): string {
  return discoveryFailureLabel(catalogT(locale), discovery);
}

function renderEmptyHint(
  liveModels: boolean,
  discovery?: ProviderDiscoverySummary,
  locale: Locale = "en",
): string {
  const t = catalogT(locale);
  return renderToStaticMarkup(
    <I18nContext.Provider value={{ locale, setLocale: () => {}, t }}>
      <EmptyProviderHint liveModels={liveModels} discovery={discovery} />
    </I18nContext.Provider>,
  );
}

function countVisible(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

function settingsButtons(container: Element, locale: Locale = "en"): HTMLButtonElement[] {
  const label = catalogT(locale)("models.openProviderSettings");
  return [...container.querySelectorAll<HTMLButtonElement>("button.link-btn")]
    .filter(button => button.textContent === label);
}

function bodyStatusHints(container: Element): Element[] {
  return [...container.querySelectorAll(".models-provider-body [role='status']")];
}

beforeEach(() => {
  clearClientResourceStoresForTests();
  previousLanguage = (globalThis.navigator as { language?: unknown } | undefined)?.language;
  Object.defineProperty(globalThis.navigator, "language", {
    configurable: true,
    value: "en-US",
  });
});

afterEach(() => {
  clearClientResourceStoresForTests();
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis.navigator, "language", {
    configurable: true,
    value: previousLanguage,
  });
});

async function withModelsPage<T>(
  fixture: Fixture,
  run: (ctx: {
    container: HTMLElement;
    testWindow: Window;
    writes: WriteCall[];
    poll: () => void;
    fixture: Fixture;
  }) => Promise<T>,
  options: { locale?: Locale; cache?: boolean } = {},
): Promise<T> {
  const locale = options.locale ?? "en";
  const previousDescriptors = Object.fromEntries(
    domGlobals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as Record<(typeof domGlobals)[number], PropertyDescriptor | undefined>;
  const testWindow = new Window({ url: "http://localhost/#models" });
  const container = testWindow.document.createElement("div");
  testWindow.document.body.append(container);
  let root: Root | undefined;
  const polls: Array<() => void> = [];
  const recordPoll = (handler: () => void) => {
    polls.push(handler);
    return polls.length;
  };
  const poll = () => { for (const handler of polls) handler(); };
  Object.defineProperty(testWindow, "setInterval", {
    configurable: true,
    value: recordPoll,
  });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
    setInterval: { configurable: true, value: recordPoll },
    clearInterval: { configurable: true, value: () => {} },
  });
  testWindow.localStorage.setItem("ocx-models-collapsed:v2", JSON.stringify([]));
  testWindow.localStorage.setItem("ocx-lang", locale);
  const writes: WriteCall[] = [];
  let releaseModels: ((response: Response) => void) | undefined;
  const heldModels = fixture.holdModels
    ? new Promise<Response>(resolve => { releaseModels = resolve; })
    : null;

  const rowsJson = () => fixture.rows;
  if (options.cache !== false && !fixture.holdModels) {
    testWindow.sessionStorage.setItem("ocx.models.catalog.v1:http://localhost", JSON.stringify({
      models: rowsJson(),
      providers: [{
        name: PROVIDER,
        liveModels: fixture.liveModels,
        models: fixture.rows.map(row => row.id),
        ...(fixture.discovery ? { discovery: fixture.discovery } : {}),
      }],
      selectedModels: { [PROVIDER]: fixture.selected },
      disabled: fixture.rows.filter(row => row.disabled).map(row => row.namespaced),
      contextCaps: {},
      contextCapValue: 350_000,
    }));
  }

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") {
      writes.push({ method, url, body: String(init?.body ?? "") });
    }
    if (url.endsWith("/api/models")) {
      if (heldModels) return heldModels;
      return Response.json(rowsJson());
    }
    if (url.endsWith("/api/providers")) {
      return Response.json([{
        name: PROVIDER,
        liveModels: fixture.liveModels,
        models: fixture.rows.map(row => row.id),
        ...(fixture.discovery ? { discovery: fixture.discovery } : {}),
      }]);
    }
    if (url.endsWith("/api/selected-models")) {
      return Response.json({
        selected: { [PROVIDER]: fixture.selected },
        available: { [PROVIDER]: fixture.rows.map(row => row.id) },
      });
    }
    if (url.endsWith("/api/provider-context-caps")) return Response.json({ caps: {} });
    if (url.endsWith("/api/aliases")) {
      return Response.json({ providers: {}, models: {}, defaults: { global: false, providers: {} } });
    }
    if (url.endsWith("/api/subagent-models")) {
      return Response.json({ pickerOrder: [], pickerOrderMode: null, pickerAvailable: [] });
    }
    if (url.endsWith("/api/shadow-call-settings")) {
      return Response.json({ enabled: false, model: "" });
    }
    if (url.endsWith("/api/v2")) return new Response("not-json", { status: 404 });
    if (url.endsWith("/api/model-presets")) return Response.json({ providers: {} });
    if (url.endsWith("/api/model-discovery")) {
      if (method === "PUT") return Response.json({ ok: true });
      return Response.json({
        policy: "on",
        providers: { [PROVIDER]: "off" },
        recentArrivals: {},
      });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  try {
    const { createRoot } = await import("react-dom/client");
    await act(async () => {
      root = createRoot(container);
      root.render(
        <LanguageProvider>
          <Models apiBase="http://localhost" />
        </LanguageProvider>,
      );
    });
    await act(async () => {
      await new Promise(resolve => testWindow.setTimeout(resolve, 0));
      await Promise.resolve();
    });
    if (releaseModels && !fixture.holdModels) {
      await act(async () => {
        releaseModels!(Response.json(rowsJson()));
        await new Promise(resolve => testWindow.setTimeout(resolve, 0));
      });
    }
    return await run({ container, testWindow, writes, poll, fixture });
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    testWindow.close();
    for (const key of domGlobals) {
      const descriptor = previousDescriptors[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

function customFixture(overrides: Partial<Fixture> = {}): Fixture {
  return {
    liveModels: true,
    discovery: HTTP_FAILURE,
    rows: [{
      provider: PROVIDER,
      id: CUSTOM_ID,
      namespaced: `${PROVIDER}/${CUSTOM_ID}`,
      disabled: false,
      custom: true,
    }],
    selected: [CUSTOM_ID],
    ...overrides,
  };
}

test("failed discovery with custom models shows visible guidance and a settings action", async () => {
  await withModelsPage(customFixture(), async ({ container, testWindow, writes }) => {
    expect(container.querySelector(".badge.badge-amber")?.textContent).toContain(en["models.discoveryFailedBadge"]);
    expect(container.textContent).toContain(reasonText(HTTP_FAILURE));
    expect(container.textContent).toContain(guidanceText());
    expect(container.textContent).toContain(en["pws.liveModels"]);
    expect(container.textContent).toContain(`${PROVIDER}/${CUSTOM_ID}`);
    expect(container.textContent).toContain(en["models.customBadge"]);

    const toggle = container.querySelector<HTMLButtonElement>(`button[aria-label="${PROVIDER}/${CUSTOM_ID}"]`);
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute("aria-pressed")).toBe("true");
    expect(toggle!.disabled).toBe(false);

    const body = container.querySelector(".models-provider-body")!;
    expect(body.textContent).toContain(en["models.newPolicyProvider"]);
    const policy = [...body.querySelectorAll(".models-provider-hint")]
      .find(node => node.textContent?.includes(en["models.newPolicyProvider"]));
    const hint = bodyStatusHints(container)[0] as HTMLElement | undefined;
    expect(hint).toBeDefined();
    expect(policy).toBeDefined();
    expect(
      policy!.compareDocumentPosition(hint!) & testWindow.Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const buttons = settingsButtons(container);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.getAttribute("type")).toBe("button");
    expect(buttons[0]!.textContent).toBe(en["models.openProviderSettings"]);
    expect(bodyStatusHints(container)).toHaveLength(1);
    expect(countVisible(container.textContent ?? "", guidanceText())).toBe(1);

    const writesBefore = writes.length;
    buttons[0]!.focus();
    expect(testWindow.document.activeElement).toBe(buttons[0]);
    await act(async () => {
      buttons[0]!.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      buttons[0]!.click();
    });
    expect(testWindow.location.hash.replace(/^#/, "")).toBe("providers");
    expect(writes.slice(writesBefore)).toEqual([]);
    expect(writes.every(call => !call.body.includes("liveModels"))).toBe(true);
  });
});

test("failed empty provider shows one useful hint and does not duplicate it", async () => {
  await withModelsPage(customFixture({
    rows: [],
    selected: [],
  }), async ({ container }) => {
    expect(container.textContent).toContain(reasonText(HTTP_FAILURE));
    expect(container.textContent).toContain(guidanceText());
    expect(container.textContent).not.toContain(en["models.emptyDiscovery"]);
    expect(settingsButtons(container)).toHaveLength(1);
    expect(bodyStatusHints(container)).toHaveLength(1);
    expect(countVisible(container.textContent ?? "", reasonText(HTTP_FAILURE))).toBe(1);
    expect(countVisible(container.textContent ?? "", guidanceText())).toBe(1);
    expect(countVisible(container.textContent ?? "", en["models.openProviderSettings"])).toBe(1);
  });
});

test("successful discovery does not show failure guidance", async () => {
  await withModelsPage(customFixture({
    discovery: { status: "ok" },
    rows: [],
    selected: [],
  }), async ({ container }) => {
    expect(container.textContent).toContain(en["models.emptyDiscovery"]);
    expect(container.textContent).not.toContain(en["models.discoveryFailedBadge"]);
    expect(container.textContent).not.toContain(guidanceText());
    expect(container.textContent).not.toContain(reasonText(HTTP_FAILURE));
    expect(settingsButtons(container)).toHaveLength(1);
  });
});

test("discovery disabled with stale failure metadata does not warn", async () => {
  await withModelsPage(customFixture({
    liveModels: false,
    discovery: HTTP_FAILURE,
  }), async ({ container }) => {
    expect(container.textContent).toContain(`${PROVIDER}/${CUSTOM_ID}`);
    expect(container.querySelector(".badge.badge-amber")).toBeNull();
    expect(container.textContent).not.toContain(guidanceText());
    expect(container.textContent).not.toContain(reasonText(HTTP_FAILURE));
    expect(settingsButtons(container)).toHaveLength(0);
  });
});

test("loading catalog does not invent a discovery failure", async () => {
  await withModelsPage(customFixture({
    holdModels: true,
    rows: [],
    selected: [],
  }), async ({ container }) => {
    expect(container.textContent).toContain(en["models.loading"]);
    expect(container.textContent).not.toContain(guidanceText());
    expect(container.textContent).not.toContain(en["models.discoveryFailedBadge"]);
    expect(settingsButtons(container)).toHaveLength(0);
  }, { cache: false });
});

test("missing discovery metadata does not invent a failure", async () => {
  const { discovery: _ignored, ...rest } = customFixture();
  await withModelsPage({ ...rest, discovery: undefined }, async ({ container }) => {
    expect(container.textContent).toContain(`${PROVIDER}/${CUSTOM_ID}`);
    expect(container.querySelector(".badge.badge-amber")).toBeNull();
    expect(container.textContent).not.toContain(guidanceText());
    expect(settingsButtons(container)).toHaveLength(0);
  });
});

test("guidance updates when discovery recovers after a poll", async () => {
  const fixture = customFixture();
  await withModelsPage(fixture, async ({ container, poll }) => {
    expect(container.textContent).toContain(guidanceText());
    fixture.discovery = { status: "ok" };
    await act(async () => {
      poll();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(container.textContent).not.toContain(guidanceText());
    expect(container.textContent).not.toContain(en["models.discoveryFailedBadge"]);
    expect(container.textContent).toContain(`${PROVIDER}/${CUSTOM_ID}`);
    expect(settingsButtons(container)).toHaveLength(0);
  });
});

test("EmptyProviderHint failure copy is visible and locale-complete", () => {
  for (const { code } of LOCALES) {
    const html = renderEmptyHint(true, HTTP_FAILURE, code);
    expect(html).toContain('role="status"');
    expect(html).toContain('class="link-btn"');
    expect(html).toContain(reasonText(HTTP_FAILURE, code));
    expect(html).toContain(guidanceText(code));
    expect(html).toContain(catalogT(code)("models.openProviderSettings"));
    expect(html).toContain(catalogT(code)("pws.liveModels"));
    expect(countVisible(html, catalogT(code)("models.openProviderSettings"))).toBe(1);
  }
});

test("EmptyProviderHint keeps non-failed empty copy unchanged", () => {
  const live = renderEmptyHint(true, { status: "ok" });
  expect(live).toContain(en["models.emptyDiscovery"]);
  expect(live).not.toContain(guidanceText());
  expect(live).toContain(en["models.openProviderSettings"]);

  const disabled = renderEmptyHint(false);
  expect(disabled).toContain(en["models.emptyDiscoveryDisabled"]);
  expect(disabled).not.toContain(guidanceText());
  expect(disabled).not.toContain(en["models.discoveryFailedBadge"]);
});

test("Chinese Models page uses the zh catalog for failure guidance", async () => {
  await withModelsPage(customFixture(), async ({ container }) => {
    expect(container.textContent).toContain(guidanceText("zh"));
    expect(container.textContent).toContain(catalogT("zh")("models.openProviderSettings"));
    expect(container.textContent).toContain(catalogT("zh")("models.discoveryFailedBadge"));
    expect(container.textContent).toContain(reasonText(HTTP_FAILURE, "zh"));
    expect(settingsButtons(container, "zh")).toHaveLength(1);
  }, { locale: "zh" });
});
