/*
 * Surge Airport Traffic Panel
 *
 * =========================================================
 * 使用方式
 * =========================================================
 *
 * [Proxy Group]
 * xxx = select, policy-path=https://example.com/sub/xxx
 * yyy = select, policy-path=https://example.com/sub/yyy
 *
 * [Panel]
 * xxx = script-name=机场流量, update-interval=1
 * yyy = script-name=机场流量, update-interval=1
 *
 * [Script]
 * 机场流量 = type=generic, script-path=https://raw.githubusercontent.com/xxx/airport-traffic.js, timeout=15, script-update-interval=43200
 *
 *
 * 要求：
 *   Panel 名称必须与对应的 [Proxy Group] 名称完全一致。
 *
 *
 * 工作流程：
 *
 *   $input.panelName
 *          ↓
 *   读取当前 Surge Profile（sensitive=1）
 *          ↓
 *   找到同名 [Proxy Group]
 *          ↓
 *   提取 policy-path
 *          ↓
 *   请求机场订阅
 *          ↓
 *   读取 Subscription-Userinfo
 *          ↓
 *   生成 Panel
 *
 *
 * 标题优先级：
 *
 *   1. Profile-Title
 *   2. Content-Disposition filename*
 *   3. Content-Disposition filename
 *   4. $input.panelName
 *
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

const USER_AGENTS = [
  "Quantumult X",
  "Surge"
];

const HTTP_TIMEOUT = 6;

const DEFAULT_TITLE = "订阅信息";


/* =========================================================
 * Main
 * ========================================================= */

(async function () {

  let panelName = DEFAULT_TITLE;

  try {

    /*
     * 1. 获取 Panel 名称
     */

    panelName = getPanelName();

    if (!panelName) {
      throw new Error(
        "该脚本必须由 Surge Panel 调用"
      );
    }


    /*
     * 2. 获取当前完整 Profile
     *
     * 必须使用 sensitive=1。
     *
     * sensitive=0 会使 policy-path
     * 等敏感内容可能变成：
     *
     * https://masked/
     */

    const profile =
      await getCurrentProfile();


    /*
     * 3. 从同名 Proxy Group 获取 policy-path
     */

    const subscriptionURL =
      findPolicyPath(
        profile,
        panelName
      );


    if (!subscriptionURL) {
      throw new Error(
        "未找到同名 Proxy Group 的 policy-path"
      );
    }


    if (
      !/^https?:\/\//i.test(
        subscriptionURL
      )
    ) {
      throw new Error(
        "policy-path 不是有效的 HTTP(S) 地址"
      );
    }


    /*
     * 额外防御：
     * 不应该再出现 masked，
     * 若出现则直接报错，不发起错误请求。
     */

    if (
      isMaskedURL(
        subscriptionURL
      )
    ) {
      throw new Error(
        "Surge 返回的 policy-path 仍处于脱敏状态"
      );
    }


    /*
     * 4. 请求订阅
     */

    const subscription =
      await fetchSubscription(
        subscriptionURL
      );


    const response =
      subscription.response;

    const userInfoHeader =
      subscription.userInfo;


    /*
     * 5. 自动识别机场名称
     */

    const airportName =
      getAirportName(
        response.headers
      ) ||
      panelName;


    /*
     * 6. 解析 Subscription-Userinfo
     */

    const info =
      parseUserInfo(
        userInfoHeader
      );


    validateTrafficInfo(
      info
    );


    /*
     * 7. 构建 Panel 内容
     */

    const content =
      buildPanelContent(
        info
      );


    /*
     * 8. 输出
     */

    $done({
      title: airportName,
      content: content
    });


  } catch (error) {

    const message =
      error &&
      error.message
        ? error.message
        : String(error);


    /*
     * 不输出：
     *
     * - Profile
     * - policy-path
     * - 订阅 Token
     *
     * 避免敏感信息进入日志。
     */

    console.log(
      "[airport-traffic] " +
      message
    );


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

  if (
    typeof $input === "undefined" ||
    !$input ||
    !$input.panelName
  ) {
    return null;
  }


  const name =
    String(
      $input.panelName
    ).trim();


  return name || null;
}


/* =========================================================
 * Surge HTTP API
 * ========================================================= */

function callHTTPAPI(
  method,
  path,
  body
) {

  return new Promise(
    function (resolve) {

      $httpAPI(
        method,
        path,
        body || {},
        function (result) {
          resolve(result);
        }
      );

    }
  );
}


/*
 * 获取当前完整 Profile。
 *
 * 使用 sensitive=1，
 * 避免 policy-path 被替换成 https://masked/
 */

async function getCurrentProfile() {

  const result =
    await callHTTPAPI(
      "GET",
      "/v1/profiles/current",
      {
        sensitive: 1
      }
    );


  if (!result) {
    throw new Error(
      "无法读取当前 Surge Profile"
    );
  }


  /*
   * 当前 Surge 通常返回：
   *
   * {
   *   profile: "..."
   * }
   *
   * 同时兼容可能存在的其他字段名称。
   */

  const profile =
    typeof result.profile === "string"
      ? result.profile

      : typeof result.originalProfile === "string"
        ? result.originalProfile

        : typeof result.content === "string"
          ? result.content

          : null;


  if (!profile) {
    throw new Error(
      "Surge HTTP API 未返回 Profile 内容"
    );
  }


  return profile;
}


/* =========================================================
 * Proxy Group / policy-path
 * ========================================================= */

function findPolicyPath(
  profile,
  targetGroupName
) {

  /*
   * 移除 UTF-8 BOM
   */

  const text =
    String(profile).replace(
      /^\uFEFF/,
      ""
    );


  const lines =
    text.split(
      /\r?\n/
    );


  let inProxyGroupSection =
    false;


  for (
    let i = 0;
    i < lines.length;
    i++
  ) {

    const rawLine =
      lines[i];

    const line =
      rawLine.trim();


    if (!line) {
      continue;
    }


    /*
     * Section
     */

    const sectionMatch =
      line.match(
        /^\[\s*([^\]]+?)\s*\]$/
      );


    if (sectionMatch) {

      inProxyGroupSection =
        sectionMatch[1]
          .trim()
          .toLowerCase() ===
        "proxy group";

      continue;
    }


    if (!inProxyGroupSection) {
      continue;
    }


    /*
     * 注释
     */

    if (
      line.startsWith("#") ||
      line.startsWith(";") ||
      line.startsWith("//")
    ) {
      continue;
    }


    /*
     * GroupName = ...
     */

    const equalIndex =
      rawLine.indexOf("=");


    if (equalIndex < 0) {
      continue;
    }


    const groupName =
      rawLine
        .slice(
          0,
          equalIndex
        )
        .trim();


    if (
      groupName !==
      targetGroupName
    ) {
      continue;
    }


    const definition =
      rawLine.slice(
        equalIndex + 1
      );


    return extractPolicyPath(
      definition
    );
  }


  return null;
}


/*
 * 支持：
 *
 * policy-path=https://example.com/sub
 *
 * policy-path="https://example.com/sub"
 *
 * policy-path='https://example.com/sub'
 *
 * 也支持后面继续存在：
 *
 * , update-interval=3600
 * , policy-regex-filter=...
 */

function extractPolicyPath(
  definition
) {

  const match =
    String(definition).match(

      /(?:^|,)\s*policy-path\s*=\s*(?:"([^"]*)"|'([^']*)'|(.+?))(?=\s*,\s*[A-Za-z][A-Za-z0-9_-]*\s*=|\s*$)/i

    );


  if (!match) {
    return null;
  }


  const value =
    (
      match[1] ||
      match[2] ||
      match[3] ||
      ""
    ).trim();


  return value || null;
}


function isMaskedURL(
  url
) {

  const text =
    String(url).toLowerCase();


  return (
    text === "https://masked/" ||
    text === "http://masked/" ||
    text.indexOf("<masked>") !== -1 ||
    text.indexOf("<redacted>") !== -1 ||
    /\*{3,}/.test(text)
  );
}


/* =========================================================
 * HTTP Client
 * ========================================================= */

function httpGet(
  options
) {

  return new Promise(
    function (
      resolve,
      reject
    ) {

      $httpClient.get(
        options,

        function (
          error,
          response,
          data
        ) {

          if (error) {

            reject(
              new Error(
                String(error)
              )
            );

            return;
          }


          if (!response) {

            reject(
              new Error(
                "未收到服务器响应"
              )
            );

            return;
          }


          resolve({
            response: response,
            data: data
          });
        }
      );

    }
  );
}


/* =========================================================
 * 订阅请求
 * ========================================================= */

/*
 * 部分机场会根据 User-Agent
 * 决定订阅格式或是否返回 Subscription-Userinfo。
 *
 * 当前顺序：
 *
 * 1. Quantumult X
 * 2. Surge
 *
 * 一旦获取到 Subscription-Userinfo，
 * 就立即停止，不会继续发第二次请求。
 */

async function fetchSubscription(
  url
) {

  let lastError =
    null;

  let receivedValidHTTPResponse =
    false;


  for (
    let i = 0;
    i < USER_AGENTS.length;
    i++
  ) {

    const userAgent =
      USER_AGENTS[i];


    try {

      const result =
        await httpGet({

          url: url,

          headers: {
            "User-Agent": userAgent,
            "Accept": "*/*"
          },

          timeout:
            HTTP_TIMEOUT

        });


      const response =
        result.response;


      const status =
        Number(
          response.status || 0
        );


      /*
       * $httpClient 默认自动跟随重定向。
       * 正常情况下最终应为 2xx。
       */

      if (
        status < 200 ||
        status >= 400
      ) {

        lastError =
          new Error(
            "订阅服务器返回 HTTP " +
            status
          );

        continue;
      }


      receivedValidHTTPResponse =
        true;


      const userInfo =
        getHeader(
          response.headers,
          "subscription-userinfo"
        );


      if (userInfo) {

        return {
          response: response,
          userInfo: userInfo
        };

      }


    } catch (error) {

      lastError =
        error;

    }
  }


  /*
   * 至少成功收到过 HTTP 响应，
   * 但所有 UA 都没有 userinfo。
   */

  if (receivedValidHTTPResponse) {

    throw new Error(
      "订阅响应中没有 Subscription-Userinfo"
    );

  }


  /*
   * 所有请求均失败。
   */

  throw new Error(

    "订阅请求失败" +

    (
      lastError &&
      lastError.message
        ? "：" +
          lastError.message
        : ""
    )

  );
}


/* =========================================================
 * Headers
 * ========================================================= */

function getHeader(
  headers,
  targetName
) {

  if (!headers) {
    return null;
  }


  const target =
    String(
      targetName
    ).toLowerCase();


  /*
   * 兼容 full-header-mode
   * 数组形式：
   *
   * [
   *   { field: "...", value: "..." }
   * ]
   */

  if (
    Array.isArray(
      headers
    )
  ) {

    for (
      let i = 0;
      i < headers.length;
      i++
    ) {

      const item =
        headers[i];


      if (
        item &&
        item.field &&
        String(
          item.field
        ).toLowerCase() ===
        target
      ) {

        return String(
          item.value || ""
        );
      }
    }


    return null;
  }


  /*
   * 默认 Object 形式
   */

  for (
    const key in headers
  ) {

    if (
      String(key)
        .toLowerCase() ===
      target
    ) {

      const value =
        headers[key];


      if (
        Array.isArray(
          value
        )
      ) {

        return value.length
          ? String(value[0])
          : null;
      }


      if (
        value === undefined ||
        value === null
      ) {
        return null;
      }


      return String(value);
    }
  }


  return null;
}


/* =========================================================
 * 自动识别机场名称
 * ========================================================= */

function getAirportName(
  headers
) {

  /*
   * 1. Profile-Title
   */

  const profileTitle =
    getHeader(
      headers,
      "profile-title"
    );


  if (profileTitle) {

    const title =
      decodeProfileTitle(
        profileTitle
      );


    if (title) {
      return title;
    }
  }


  /*
   * 2/3. Content-Disposition
   */

  const contentDisposition =
    getHeader(
      headers,
      "content-disposition"
    );


  if (contentDisposition) {

    const filename =
      getContentDispositionFilename(
        contentDisposition
      );


    if (filename) {

      return cleanFilename(
        filename
      );
    }
  }


  return null;
}


/*
 * Profile-Title 常见形式：
 *
 * Profile-Title: Lumina
 *
 * Profile-Title: base64:THVtaW5h
 *
 * 也兼容 URL encoded 文本。
 */

function decodeProfileTitle(
  value
) {

  let text =
    String(value)
      .trim()
      .replace(
        /^["']|["']$/g,
        ""
      );


  if (!text) {
    return null;
  }


  /*
   * Base64
   */

  if (
    /^base64:/i.test(
      text
    )
  ) {

    const base64 =
      text
        .replace(
          /^base64:/i,
          ""
        )
        .trim();


    try {

      return cleanTitle(
        decodeBase64UTF8(
          base64
        )
      );

    } catch (error) {

      return null;

    }
  }


  /*
   * URL encoding
   */

  if (
    text.indexOf("%") !== -1
  ) {

    try {

      text =
        decodeURIComponent(
          text
        );

    } catch (error) {
      // 保留原值
    }
  }


  return cleanTitle(
    text
  );
}


/* =========================================================
 * Content-Disposition
 * ========================================================= */

function getContentDispositionFilename(
  value
) {

  const text =
    String(value || "");


  /*
   * 优先 filename*
   *
   * filename*=UTF-8''Lumina
   */

  const extended =
    text.match(

      /filename\*\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;]+))/i

    );


  if (extended) {

    let filename =
      (
        extended[1] ||
        extended[2] ||
        extended[3] ||
        ""
      ).trim();


    /*
     * RFC 5987:
     *
     * UTF-8''filename
     */

    const encoded =
      filename.match(

        /^[^']*'[^']*'(.*)$/

      );


    if (encoded) {
      filename =
        encoded[1];
    }


    try {

      filename =
        decodeURIComponent(
          filename
        );

    } catch (error) {
      // 保留原值
    }


    if (filename) {
      return filename;
    }
  }


  /*
   * 普通 filename=
   */

  const normal =
    text.match(

      /filename\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;]+))/i

    );


  if (!normal) {
    return null;
  }


  let filename =
    (
      normal[1] ||
      normal[2] ||
      normal[3] ||
      ""
    ).trim();


  if (
    filename.indexOf("%") !== -1
  ) {

    try {

      filename =
        decodeURIComponent(
          filename
        );

    } catch (error) {
      // 保留原值
    }
  }


  return filename || null;
}


function cleanFilename(
  value
) {

  const text =
    String(
      value || ""
    )
      .trim()
      .replace(

        /\.(yaml|yml|txt|conf|json)$/i,

        ""

      );


  return cleanTitle(
    text
  );
}


function cleanTitle(
  value
) {

  const text =
    String(
      value || ""
    )
      .replace(
        /[\r\n\t]+/g,
        " "
      )
      .trim();


  return text || null;
}


/* =========================================================
 * Subscription-Userinfo
 * ========================================================= */

function parseUserInfo(
  header
) {

  const result =
    {};


  const items =
    String(header)
      .split(";");


  for (
    let i = 0;
    i < items.length;
    i++
  ) {

    const item =
      items[i].trim();


    if (!item) {
      continue;
    }


    const equalIndex =
      item.indexOf("=");


    if (equalIndex < 0) {
      continue;
    }


    /*
     * reset-day
     * ↓
     * reset_day
     */

    const key =
      item
        .slice(
          0,
          equalIndex
        )
        .trim()
        .toLowerCase()
        .replace(
          /-/g,
          "_"
        );


    const value =
      Number(

        item
          .slice(
            equalIndex + 1
          )
          .trim()

      );


    if (
      key &&
      Number.isFinite(value)
    ) {

      result[key] =
        value;
    }
  }


  return result;
}


function validateTrafficInfo(
  info
) {

  const required =
    [
      "upload",
      "download",
      "total"
    ];


  for (
    let i = 0;
    i < required.length;
    i++
  ) {

    const key =
      required[i];


    if (
      !Number.isFinite(
        info[key]
      ) ||
      info[key] < 0
    ) {

      throw new Error(
        "Subscription-Userinfo 缺少或无法解析 " +
        key
      );
    }
  }
}


/* =========================================================
 * Panel 内容
 * ========================================================= */

function buildPanelContent(
  info
) {

  const used =
    info.upload +
    info.download;


  const total =
    info.total;


  const remaining =
    Math.max(
      total - used,
      0
    );


  let remainingText;
  let usedText;
  let totalText;

  let usedPercentText =
    null;

  let remainingPercentText =
    null;


  /*
   * total > 0：
   * 普通流量套餐
   */

  if (total > 0) {

    remainingText =
      formatBytes(
        remaining
      );


    usedText =
      formatBytes(
        used
      );


    totalText =
      formatBytes(
        total
      );


    const usedPercent =
      clamp(
        used / total * 100,
        0,
        100
      );


    const remainingPercent =
      100 -
      usedPercent;


    usedPercentText =
      usedPercent.toFixed(1) +
      "%";


    remainingPercentText =
      remainingPercent.toFixed(1) +
      "%";

  } else {

    /*
     * total=0：
     * 常见实现中通常代表不限量。
     */

    remainingText =
      "不限量";


    usedText =
      formatBytes(
        used
      );


    totalText =
      "不限量";
  }


  /*
   * 到期时间
   */

  const expireDate =
    (
      Number.isFinite(
        info.expire
      ) &&
      info.expire > 0
    )
      ? parseTimestamp(
          info.expire
        )
      : null;


  const expireText =
    expireDate
      ? formatDate(
          expireDate
        )
      : "长期有效";


  /*
   * 重置日
   *
   * 优先读取非标准扩展字段：
   *
   * reset_day=
   * reset-day=
   *
   * parseUserInfo 已将 "-" 转为 "_"。
   *
   * 若机场没有提供，
   * fallback 为到期日期的“日”。
   */

  let resetDay =
    null;


  if (
    isValidResetDay(
      info.reset_day
    )
  ) {

    resetDay =
      info.reset_day;

  } else if (
    isValidResetDay(
      info.resetday
    )
  ) {

    resetDay =
      info.resetday;

  } else if (
    expireDate
  ) {

    resetDay =
      expireDate.getDate();

  }


  const resetText =
    resetDay
      ? "剩余 " +
        getDaysUntilReset(
          resetDay
        ) +
        " 天"

      : "--";


  /*
   * 最终布局
   */

  let content =

    "剩余：" +
    remainingText;


  if (
    remainingPercentText
  ) {

    content +=
      "（" +
      remainingPercentText +
      "）";
  }


  content +=

    "\n已用：" +
    usedText;


  if (
    usedPercentText
  ) {

    content +=
      "（" +
      usedPercentText +
      "）";
  }


  content +=

    "\n总量：" +
    totalText +

    "\n重置：" +
    resetText +

    "\n到期：" +
    expireText;


  return content;
}


/* =========================================================
 * 流量格式
 * ========================================================= */

function formatBytes(
  bytes
) {

  if (
    !Number.isFinite(bytes) ||
    bytes < 0
  ) {
    return "--";
  }


  if (bytes === 0) {
    return "0 B";
  }


  const units =
    [
      "B",
      "KB",
      "MB",
      "GB",
      "TB",
      "PB"
    ];


  const index =
    Math.min(

      Math.floor(

        Math.log(bytes) /
        Math.log(1024)

      ),

      units.length - 1

    );


  const value =
    bytes /
    Math.pow(
      1024,
      index
    );


  return (
    value.toFixed(2) +
    " " +
    units[index]
  );
}


/* =========================================================
 * 到期时间
 * ========================================================= */

function parseTimestamp(
  value
) {

  let timestamp =
    Number(value);


  if (
    !Number.isFinite(
      timestamp
    ) ||
    timestamp <= 0
  ) {
    return null;
  }


  /*
   * Unix 秒 / 毫秒兼容
   */

  if (
    timestamp >
    1000000000000
  ) {

    timestamp =
      Math.floor(
        timestamp / 1000
      );
  }


  const date =
    new Date(
      timestamp * 1000
    );


  return Number.isNaN(
    date.getTime()
  )
    ? null
    : date;
}


function formatDate(
  date
) {

  return (
    date.getFullYear() +
    "-" +
    pad2(
      date.getMonth() + 1
    ) +
    "-" +
    pad2(
      date.getDate()
    )
  );
}


/* =========================================================
 * 重置日
 * ========================================================= */

function isValidResetDay(
  value
) {

  return (
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 31
  );
}


/*
 * 计算距离下一次重置还有多少“日历天”。
 *
 * 若今天正好是重置日，
 * 则认为本月重置已经发生，
 * 计算下个月重置日。
 */

function getDaysUntilReset(
  resetDay
) {

  const now =
    new Date();


  const todayYear =
    now.getFullYear();

  const todayMonth =
    now.getMonth();

  const todayDay =
    now.getDate();


  let targetYear =
    todayYear;

  let targetMonth =
    todayMonth;


  let targetDay =
    normalizeDay(
      targetYear,
      targetMonth,
      resetDay
    );


  /*
   * 本月重置日已经到达或过去
   */

  if (
    todayDay >=
    targetDay
  ) {

    targetMonth++;


    if (
      targetMonth > 11
    ) {

      targetMonth =
        0;

      targetYear++;

    }


    targetDay =
      normalizeDay(
        targetYear,
        targetMonth,
        resetDay
      );
  }


  /*
   * 用 UTC 仅计算日历天差，
   * 避免 DST 导致 23/25 小时一天的问题。
   */

  const todayUTC =
    Date.UTC(
      todayYear,
      todayMonth,
      todayDay
    );


  const targetUTC =
    Date.UTC(
      targetYear,
      targetMonth,
      targetDay
    );


  return Math.round(
    (
      targetUTC -
      todayUTC
    ) /
    86400000
  );
}


function normalizeDay(
  year,
  month,
  desiredDay
) {

  const daysInMonth =
    new Date(
      year,
      month + 1,
      0
    ).getDate();


  return Math.min(
    desiredDay,
    daysInMonth
  );
}


/* =========================================================
 * Base64 UTF-8
 * ========================================================= */

/*
 * 不依赖浏览器 atob / TextDecoder，
 * 因此 JSC / WebView 均可使用。
 */

function decodeBase64UTF8(
  input
) {

  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ" +
    "abcdefghijklmnopqrstuvwxyz" +
    "0123456789+/";


  let source =
    String(input)
      .replace(
        /\s+/g,
        ""
      )
      .replace(
        /-/g,
        "+"
      )
      .replace(
        /_/g,
        "/"
      );


  while (
    source.length % 4
  ) {
    source += "=";
  }


  const bytes =
    [];


  for (
    let i = 0;
    i < source.length;
    i += 4
  ) {

    const a =
      alphabet.indexOf(
        source[i]
      );


    const b =
      alphabet.indexOf(
        source[i + 1]
      );


    const c =
      source[i + 2] === "="
        ? 0
        : alphabet.indexOf(
            source[i + 2]
          );


    const d =
      source[i + 3] === "="
        ? 0
        : alphabet.indexOf(
            source[i + 3]
          );


    if (
      a < 0 ||
      b < 0 ||
      c < 0 ||
      d < 0
    ) {

      throw new Error(
        "无效的 Base64"
      );
    }


    const value =
      (a << 18) |
      (b << 12) |
      (c << 6) |
      d;


    bytes.push(
      (value >> 16) &
      0xff
    );


    if (
      source[i + 2] !== "="
    ) {

      bytes.push(
        (value >> 8) &
        0xff
      );
    }


    if (
      source[i + 3] !== "="
    ) {

      bytes.push(
        value &
        0xff
      );
    }
  }


  /*
   * UTF-8 → JS String
   */

  let encoded =
    "";


  for (
    let i = 0;
    i < bytes.length;
    i++
  ) {

    encoded +=
      "%" +
      bytes[i]
        .toString(16)
        .padStart(
          2,
          "0"
        );
  }


  try {

    return decodeURIComponent(
      encoded
    );

  } catch (error) {

    /*
     * 非 UTF-8 时 fallback
     */

    let fallback =
      "";


    for (
      let i = 0;
      i < bytes.length;
      i++
    ) {

      fallback +=
        String.fromCharCode(
          bytes[i]
        );
    }


    return fallback;
  }
}


/* =========================================================
 * Utils
 * ========================================================= */

function clamp(
  value,
  min,
  max
) {

  return Math.min(
    Math.max(
      value,
      min
    ),
    max
  );
}


function pad2(
  value
) {

  return String(value)
    .padStart(
      2,
      "0"
    );
}
