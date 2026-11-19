const MEASUREMENT_ID = "G-XK9F132CT4";
const CONSENT_KEY = "winter-road-navi-analytics-v1";
const PAGE_URL = "https://bousai-wx-lab.github.io/winter-road-navi/";
const PAGE_TITLE = "冬道そなえナビ | Bousai Wx Lab";
const COOKIE_PREFIX = "wrn";
const COOKIE_PATH = "/winter-road-navi/";
const panel = document.getElementById("analyticsConsentPanel");
const settings = document.getElementById("analyticsSettingsButton");
const accept = document.getElementById("analyticsAcceptButton");
const decline = document.getElementById("analyticsDeclineButton");
let loaded = false;
let restoreFocus = false;
let choice = null;

try {
  choice = window.localStorage.getItem(CONSENT_KEY);
} catch {
  // Without storage, a fresh page requires a fresh choice.
}

function gtag() {
  window.dataLayer.push(arguments);
}

function loadTag() {
  if (loaded || window.location.origin + window.location.pathname !== PAGE_URL) return;
  loaded = true;
  window[`ga-disable-${MEASUREMENT_ID}`] = false;
  window.dataLayer = window.dataLayer || [];
  gtag("consent", "default", {
    analytics_storage: "granted",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  });
  const page = { page_location: PAGE_URL, page_title: PAGE_TITLE, page_referrer: "" };
  gtag("set", page);
  gtag("js", new Date());
  gtag("config", MEASUREMENT_ID, {
    ...page,
    send_page_view: false,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    cookie_prefix: COOKIE_PREFIX,
    cookie_path: COOKIE_PATH,
    cookie_domain: "bousai-wx-lab.github.io",
    cookie_expires: 60 * 24 * 60 * 60,
    cookie_update: false,
    cookie_flags: "SameSite=Lax;Secure",
  });
  gtag("event", "page_view", { ...page, send_to: MEASUREMENT_ID });
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
  script.referrerPolicy = "no-referrer";
  script.dataset.analyticsLoader = "true";
  document.head.append(script);
}

function stopTag() {
  window[`ga-disable-${MEASUREMENT_ID}`] = true;
  document.querySelector("script[data-analytics-loader]")?.remove();
  if (!loaded) return;
  // Remove only this tool's cookies; other Bousai tools keep their settings.
  for (const name of [`${COOKIE_PREFIX}_ga`, `${COOKIE_PREFIX}_ga_${MEASUREMENT_ID.slice(2)}`]) {
    document.cookie = `${name}=; Max-Age=0; Path=${COOKIE_PATH}; SameSite=Lax; Secure`;
    document.cookie = `${name}=; Max-Age=0; Path=${COOKIE_PATH}; Domain=bousai-wx-lab.github.io; SameSite=Lax; Secure`;
  }
  // A reload also removes Google's listeners. Do not send a cookieless denial ping.
  window.location.reload();
}

function showPanel() {
  panel.hidden = false;
  decline.focus({ preventScroll: true });
}

function hidePanel() {
  panel.hidden = true;
  if (restoreFocus) settings.focus({ preventScroll: true });
  restoreFocus = false;
}

function choose(value) {
  choice = value;
  try {
    window.localStorage.setItem(CONSENT_KEY, value);
  } catch {
    // The choice still applies until the next page load.
  }
  hidePanel();
  if (value === "granted") loadTag();
  else stopTag();
}

accept.addEventListener("click", () => choose("granted"));
decline.addEventListener("click", () => choose("denied"));
settings.addEventListener("click", () => {
  restoreFocus = true;
  showPanel();
});
panel.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && (choice === "granted" || choice === "denied")) hidePanel();
});
window.addEventListener("storage", (event) => {
  if (event.key !== CONSENT_KEY && event.key !== null) return;
  choice = event.key === CONSENT_KEY ? event.newValue : null;
  if (choice === "granted") {
    hidePanel();
    loadTag();
  } else {
    stopTag();
    if (choice === "denied") hidePanel();
    else showPanel();
  }
});

window[`ga-disable-${MEASUREMENT_ID}`] = choice !== "granted";
if (choice === "granted") loadTag();
else if (choice !== "denied") showPanel();
