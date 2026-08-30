/*
 * Surge Airport Traffic Panel
 *
 * 使用要求：
 *   [Panel] 名称必须与对应 [Proxy Group] 名称完全一致。
 *
 * 工作流程：
 *   $input.panelName
 *      → 当前 Surge Profile（sensitive=1）
 *      → 同名 [Proxy Group]
 *      → policy-path
 *      → 请求机场订阅
 *      → Subscription-Userinfo
 *      → 输出 Panel
 *
 * 标题优先级：
 *   1. Profile-Title
 *   2. Content-Disposition filename*
 *   3. Content-Disposition filename
 *   4. $input.panelName
 *
 * Panel 示例：
 *
 *   Lumina
 *
 *   剩余：326.47 GB（65.3%）
 *   已用：173.53 GB（34.7%）
 *   总量：500.00 GB
 *   重置：剩余 12 天
 *   到期：2026-12-31
 */


/* =========================================================
 * 配置
 * ========================================================= */

const USER_AGENTS = ["Quantumult X", "Surge"];
const HTTP_TIMEOUT = 6;
const DEFAULT_TITLE = "订阅信息";


/* =========================================================
 * Main
 * ========================================================= */

(async () => {
  let panelName = DEFAULT_TITLE;

  try {
    // 1. 获取当前 Panel 名称
    panelName = getPanelName();
    if (!panelName) throw new Error("该脚本必须由 Surge Panel 调用");

    // 2. 读取完整 Profile。
    // sensitive=0 会使 policy-path 可能变成 https://masked/
    const profile = await getCurrentProfile();

    // 3. 找到同名 Proxy Group 的 policy-path
    const subscriptionURL = findPolicyPath(profile, panelName);

    if (!subscriptionURL) {
      throw new Error("未找到同名 Proxy Group 的 policy-path");
    }

    if (!/^https?:\/\//i.test(subscriptionURL)) {
      throw new Error("policy-path 不是有效的 HTTP(S) 地址");
    }

    // 即使 Surge 行为改变，也绝不向脱敏地址发请求
    if (isMaskedURL(subscriptionURL)) {
      throw new Error("Surge 返回的 policy-path 仍处于脱敏状态");
    }

    // 4. 请求订阅并获取 Subscription-Userinfo
    const { response, userInfo } = await fetchSubscription(subscriptionURL);

    // 5. 自动识别机场名称
    const airportName = getAirportName(response.headers) || panelName;

    // 6. 解析并验证流量信息
    const info = parseUserInfo(userInfo);
    validateTrafficInfo(info);

    // 7. 输出 Panel
    $done({
      title: airportName,
      content: buildPanelContent(info)
    });

  } catch (error) {
    const message = error?.message || String(error);

    // 不记录 Profile / policy-path / Token 等敏感信息
    console.log("[airport-traffic] " + message);

    $done({
      title: panelName,
      content: message,
      style: "error"
    });
  }
})();


/* =========================================================
 * Panel
 * ========================================================= */

function getPanelName() {
  if (typeof $input === "undefined" || !$input?.panelName) return null;
  return String($input.panelName).trim() || null;
}


/* =========================================================
 * Surge HTTP API
 * ========================================================= */

function callHTTPAPI(method, path, body = {}) {
  return new Promise(resolve => {
    $httpAPI(method, path, body, resolve);
  });
}

/*
 * 必须使用 sensitive=1：
 * sensitive=0 可能把 policy-path 替换为 https://masked/
 */
async function getCurrentProfile() {
  const result = await callHTTPAPI(
    "GET",
    "/v1/profiles/current",
    { sensitive: 1 }
  );

  if (!result) throw new Error("无法读取当前 Surge Profile");

  // 兼容可能存在的不同返回字段
  const profile =
    typeof result.profile === "string" ? result.profile :
    typeof result.originalProfile === "string" ? result.originalProfile :
    typeof result.content === "string" ? result.content :
    null;

  if (!profile) throw new Error("Surge HTTP API 未返回 Profile 内容");

  return profile;
}


/* =========================================================
 * Proxy Group / policy-path
 * ========================================================= */

function findPolicyPath(profile, targetGroupName) {
  const lines = String(profile)
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/);

  let inProxyGroupSection = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Section
    const section = line.match(/^\[\s*([^\]]+?)\s*\]$/);

    if (section) {
      inProxyGroupSection =
        section[1].trim().toLowerCase() === "proxy group";
      continue;
    }

    if (!inProxyGroupSection) continue;

    // 注释
    if (
      line.startsWith("#") ||
      line.startsWith(";") ||
      line.startsWith("//")
    ) {
      continue;
    }

    const equalIndex = rawLine.indexOf("=");
    if (equalIndex < 0) continue;

    const groupName = rawLine.slice(0, equalIndex).trim();
    if (groupName !== targetGroupName) continue;

    return extractPolicyPath(rawLine.slice(equalIndex + 1));
  }

  return null;
}

/*
 * 支持：
 *   policy-path=https://example.com/sub
 *   policy-path="https://example.com/sub"
 *   policy-path='https://example.com/sub'
 *
 * 后面也可以继续存在：
 *   , update-interval=3600
 *   , policy-regex-filter=...
 */
function extractPolicyPath(definition) {
  const match = String(definition).match(
    /(?:^|,)\s*policy-path\s*=\s*(?:"([^"]*)"|'([^']*)'|(.+?))(?=\s*,\s*[A-Za-z][A-Za-z0-9_-]*\s*=|\s*$)/i
  );

  if (!match) return null;

  return (match[1] || match[2] || match[3] || "").trim() || null;
}

function isMaskedURL(url) {
  const text = String(url).toLowerCase();

  return (
    text === "https://masked/" ||
    text === "http://masked/" ||
    text.includes("<masked>") ||
    text.includes("<redacted>") ||
    /\*{3,}/.test(text)
  );
}


/* =========================================================
 * HTTP Client
 * ========================================================= */

function httpGet(options) {
  return new Promise((resolve, reject) => {
    $httpClient.get(options, (error, response) => {
      if (error) {
        reject(new Error(String(error)));
        return;
      }

      if (!response) {
        reject(new Error("未收到服务器响应"));
        return;
      }

      resolve(response);
    });
  });
}


/* =========================================================
 * 请求订阅
 * ========================================================= */

/*
 * 部分机场根据 User-Agent 决定订阅格式
 * 或是否返回 Subscription-Userinfo。
 *
 * 顺序：
 *   1. Quantumult X
 *   2. Surge
 *
 * 获取到 Subscription-Userinfo 后立即停止。
 */
async function fetchSubscription(url) {
  let lastError = null;
  let receivedValidHTTPResponse = false;

  for (const userAgent of USER_AGENTS) {
    try {
      const response = await httpGet({
        url,
        headers: {
          "User-Agent": userAgent,
          "Accept": "*/*"
        },
        timeout: HTTP_TIMEOUT
      });

      const status = Number(response.status || 0);

      if (status < 200 || status >= 400) {
        lastError = new Error("订阅服务器返回 HTTP " + status);
        continue;
      }

      receivedValidHTTPResponse = true;

      const userInfo = getHeader(
        response.headers,
        "subscription-userinfo"
      );

      if (userInfo) {
        return { response, userInfo };
      }

    } catch (error) {
      lastError = error;
    }
  }

  // 成功收到 HTTP 响应，但没有流量信息头
  if (receivedValidHTTPResponse) {
    throw new Error("订阅响应中没有 Subscription-Userinfo");
  }

  throw new Error(
    "订阅请求失败" +
    (lastError?.message ? "：" + lastError.message : "")
  );
}


/* =========================================================
 * Headers
 * ========================================================= */

function getHeader(headers, targetName) {
  if (!headers) return null;

  const target = String(targetName).toLowerCase();

  /*
   * 兼容 full-header-mode 数组形式：
   * [{ field: "...", value: "..." }]
   */
  if (Array.isArray(headers)) {
    const item = headers.find(
      h => h?.field && String(h.field).toLowerCase() === target
    );

    return item ? String(item.value || "") : null;
  }

  // 默认 Object 形式
  for (const key in headers) {
    if (String(key).toLowerCase() !== target) continue;

    const value = headers[key];

    if (Array.isArray(value)) {
      return value.length ? String(value[0]) : null;
    }

    return value == null ? null : String(value);
  }

  return null;
}


/* =========================================================
 * 自动识别机场名称
 * ========================================================= */

function getAirportName(headers) {
  // 1. Profile-Title
  const profileTitle = getHeader(headers, "profile-title");

  if (profileTitle) {
    const title = decodeProfileTitle(profileTitle);
    if (title) return title;
  }

  // 2 / 3. Content-Disposition
  const contentDisposition = getHeader(headers, "content-disposition");

  if (contentDisposition) {
    const filename =
      getContentDispositionFilename(contentDisposition);

    if (filename) return cleanFilename(filename);
  }

  return null;
}

/*
 * Profile-Title 常见形式：
 *
 *   Profile-Title: Lumina
 *   Profile-Title: base64:THVtaW5h
 *
 * 同时兼容 URL encoded 文本。
 */
function decodeProfileTitle(value) {
  let text = String(value)
    .trim()
    .replace(/^["']|["']$/g, "");

  if (!text) return null;

  // Base64
  if (/^base64:/i.test(text)) {
    try {
      return cleanTitle(
        decodeBase64UTF8(
          text.replace(/^base64:/i, "").trim()
        )
      );
    } catch {
      return null;
    }
  }

  // URL encoding
  if (text.includes("%")) {
    try {
      text = decodeURIComponent(text);
    } catch {}
  }

  return cleanTitle(text);
}


/* =========================================================
 * Content-Disposition
 * ========================================================= */

function getContentDispositionFilename(value) {
  const text = String(value || "");

  /*
   * 优先 filename*
   * 例如：
   * filename*=UTF-8''Lumina
   */
  const extended = text.match(
    /filename\*\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;]+))/i
  );

  if (extended) {
    let filename =
      (extended[1] || extended[2] || extended[3] || "").trim();

    // RFC 5987：UTF-8''filename
    const encoded = filename.match(/^[^']*'[^']*'(.*)$/);
    if (encoded) filename = encoded[1];

    try {
      filename = decodeURIComponent(filename);
    } catch {}

    if (filename) return filename;
  }

  // 普通 filename=
  const normal = text.match(
    /filename\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;]+))/i
  );

  if (!normal) return null;

  let filename =
    (normal[1] || normal[2] || normal[3] || "").trim();

  if (filename.includes("%")) {
    try {
      filename = decodeURIComponent(filename);
    } catch {}
  }

  return filename || null;
}

function cleanFilename(value) {
  return cleanTitle(
    String(value || "")
      .trim()
      .replace(/\.(yaml|yml|txt|conf|json)$/i, "")
  );
}

function cleanTitle(value) {
  return (
    String(value || "")
      .replace(/[\r\n\t]+/g, " ")
      .trim() ||
    null
  );
}


/* =========================================================
 * Subscription-Userinfo
 * ========================================================= */

function parseUserInfo(header) {
  const result = {};

  for (const item of String(header).split(";")) {
    const equalIndex = item.indexOf("=");
    if (equalIndex < 0) continue;

    // reset-day → reset_day
    const key = item
      .slice(0, equalIndex)
      .trim()
      .toLowerCase()
      .replace(/-/g, "_");

    const value = Number(
      item.slice(equalIndex + 1).trim()
    );

    if (key && Number.isFinite(value)) {
      result[key] = value;
    }
  }

  return result;
}

function validateTrafficInfo(info) {
  for (const key of ["upload", "download", "total"]) {
    if (!Number.isFinite(info[key]) || info[key] < 0) {
      throw new Error(
        "Subscription-Userinfo 缺少或无法解析 " + key
      );
    }
  }
}


/* =========================================================
 * Panel 内容
 * ========================================================= */

function buildPanelContent(info) {
  const used = info.upload + info.download;
  const total = info.total;
  const remaining = Math.max(total - used, 0);

  let remainingText;
  let usedText = formatBytes(used);
  let totalText;
  let usedPercentText = null;
  let remainingPercentText = null;

  /*
   * total > 0：普通流量套餐
   * total = 0：常见实现中通常代表不限量
   */
  if (total > 0) {
    remainingText = formatBytes(remaining);
    totalText = formatBytes(total);

    const usedPercent = clamp((used / total) * 100, 0, 100);

    usedPercentText = usedPercent.toFixed(1) + "%";
    remainingPercentText = (100 - usedPercent).toFixed(1) + "%";

  } else {
    remainingText = "不限量";
    totalText = "不限量";
  }

  // 到期时间
  const expireDate =
    Number.isFinite(info.expire) && info.expire > 0
      ? parseTimestamp(info.expire)
      : null;

  const expireText =
    expireDate
      ? formatDate(expireDate)
      : "长期有效";

  /*
   * 重置日优先级：
   *   1. reset_day / reset-day
   *   2. resetday
   *   3. 到期日期中的“日”
   */
  let resetDay = null;

  if (isValidResetDay(info.reset_day)) {
    resetDay = info.reset_day;
  } else if (isValidResetDay(info.resetday)) {
    resetDay = info.resetday;
  } else if (expireDate) {
    resetDay = expireDate.getDate();
  }

  const resetText =
    resetDay
      ? "剩余 " + getDaysUntilReset(resetDay) + " 天"
      : "--";

  // 保持当前显示方式不变
  let content = "剩余：" + remainingText;

  if (remainingPercentText) {
    content += "（" + remainingPercentText + "）";
  }

  content += "\n已用：" + usedText;

  if (usedPercentText) {
    content += "（" + usedPercentText + "）";
  }

  content +=
    "\n总量：" + totalText +
    "\n重置：" + resetText +
    "\n到期：" + expireText;

  return content;
}


/* =========================================================
 * 流量格式
 * ========================================================= */

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "--";
  if (bytes === 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB", "PB"];

  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );

  const value = bytes / Math.pow(1024, index);

  return value.toFixed(2) + " " + units[index];
}


/* =========================================================
 * 到期时间
 * ========================================================= */

function parseTimestamp(value) {
  let timestamp = Number(value);

  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return null;
  }

  // Unix 秒 / 毫秒兼容
  if (timestamp > 1000000000000) {
    timestamp = Math.floor(timestamp / 1000);
  }

  const date = new Date(timestamp * 1000);

  return Number.isNaN(date.getTime())
    ? null
    : date;
}

function formatDate(date) {
  return (
    date.getFullYear() +
    "-" +
    pad2(date.getMonth() + 1) +
    "-" +
    pad2(date.getDate())
  );
}


/* =========================================================
 * 重置日
 * ========================================================= */

function isValidResetDay(value) {
  return (
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 31
  );
}

/*
 * 计算距离下一次重置还有多少日历天。
 *
 * 如果今天正好是重置日，
 * 认为本月重置已经发生，计算下一次。
 */
function getDaysUntilReset(resetDay) {
  const now = new Date();

  const todayYear = now.getFullYear();
  const todayMonth = now.getMonth();
  const todayDay = now.getDate();

  let targetYear = todayYear;
  let targetMonth = todayMonth;
  let targetDay = normalizeDay(
    targetYear,
    targetMonth,
    resetDay
  );

  if (todayDay >= targetDay) {
    targetMonth++;

    if (targetMonth > 11) {
      targetMonth = 0;
      targetYear++;
    }

    targetDay = normalizeDay(
      targetYear,
      targetMonth,
      resetDay
    );
  }

  /*
   * 使用 UTC 计算纯日历天差，
   * 避免 DST 导致一天为 23 / 25 小时。
   */
  const todayUTC = Date.UTC(
    todayYear,
    todayMonth,
    todayDay
  );

  const targetUTC = Date.UTC(
    targetYear,
    targetMonth,
    targetDay
  );

  return Math.round(
    (targetUTC - todayUTC) / 86400000
  );
}

function normalizeDay(year, month, desiredDay) {
  const daysInMonth =
    new Date(year, month + 1, 0).getDate();

  return Math.min(
    desiredDay,
    daysInMonth
  );
}


/* =========================================================
 * Base64 UTF-8
 * ========================================================= */

/*
 * 不依赖 atob / TextDecoder，
 * 因此 Surge JSC / WebView 均可使用。
 */
function decodeBase64UTF8(input) {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  let source = String(input)
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  while (source.length % 4) source += "=";

  const bytes = [];

  for (let i = 0; i < source.length; i += 4) {
    const a = alphabet.indexOf(source[i]);
    const b = alphabet.indexOf(source[i + 1]);

    const c =
      source[i + 2] === "="
        ? 0
        : alphabet.indexOf(source[i + 2]);

    const d =
      source[i + 3] === "="
        ? 0
        : alphabet.indexOf(source[i + 3]);

    if (a < 0 || b < 0 || c < 0 || d < 0) {
      throw new Error("无效的 Base64");
    }

    const value =
      (a << 18) |
      (b << 12) |
      (c << 6) |
      d;

    bytes.push((value >> 16) & 0xff);

    if (source[i + 2] !== "=") {
      bytes.push((value >> 8) & 0xff);
    }

    if (source[i + 3] !== "=") {
      bytes.push(value & 0xff);
    }
  }

  let encoded = "";

  for (const byte of bytes) {
    encoded += "%" + byte.toString(16).padStart(2, "0");
  }

  try {
    return decodeURIComponent(encoded);

  } catch {
    // 非 UTF-8 时 fallback
    return bytes
      .map(byte => String.fromCharCode(byte))
      .join("");
  }
}


/* =========================================================
 * Utils
 * ========================================================= */

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function pad2(value) {
  return String(value).padStart(2, "0");
}
