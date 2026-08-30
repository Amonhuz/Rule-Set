/*
 * Surge Airport Traffic Panel
 *
 * 使用方式：
 *   Panel 名称必须与对应 [Proxy Group] 名称完全一致。
 *
 * 工作流程：
 *   $input.panelName
 *          ↓
 *   当前 Surge Profile
 *          ↓
 *   同名 [Proxy Group]
 *          ↓
 *   policy-path
 *          ↓
 *   请求机场订阅
 *          ↓
 *   Subscription-Userinfo
 *
 * 标题优先级：
 *   1. Profile-Title
 *   2. Content-Disposition filename* / filename
 *   3. $input.panelName
 */

const UA_LIST = [
  "Quantumult X",
  "Surge"
];

const HTTP_TIMEOUT = 6;

let panelName = "订阅信息";


(async () => {
  try {

    /*
     * =================================================
     * 1. 获取当前 Panel 名称
     * =================================================
     */

    panelName = getPanelName();

    if (!panelName) {
      throw new Error(
        "该脚本必须由 Surge Panel 调用"
      );
    }


    /*
     * =================================================
     * 2. 读取当前 Profile
     * =================================================
     *
     * 优先 sensitive=0。
     *
     * 通常 policy-path 不会被隐藏。
     * 如果被遮罩，再读取 sensitive=1。
     */

    let profile =
      await getProfile(false);

    let subURL =
      findPolicyPath(
        profile,
        panelName
      );


    if (
      subURL &&
      /\*{3,}|<masked>|<redacted>/i.test(
        subURL
      )
    ) {
      profile =
        await getProfile(true);

      subURL =
        findPolicyPath(
          profile,
          panelName
        );
    }


    if (!subURL) {
      throw new Error(
        "未找到同名 [Proxy Group] 或 policy-path：" +
        panelName
      );
    }


    if (
      !/^https?:\/\//i.test(
        subURL
      )
    ) {
      throw new Error(
        "policy-path 不是 HTTP(S) 订阅地址"
      );
    }


    /*
     * =================================================
     * 3. 请求订阅
     * =================================================
     */

    const {
      response,
      userInfo
    } =
      await fetchSubscription(
        subURL
      );


    const headers =
      response.headers || {};


    /*
     * =================================================
     * 4. 自动识别机场名称
     * =================================================
     */

    const title =
      getAirportName(
        headers
      ) ||
      panelName;


    /*
     * =================================================
     * 5. 解析 Subscription-Userinfo
     * =================================================
     */

    const info =
      parseUserInfo(
        userInfo
      );


    for (
      const key of [
        "upload",
        "download",
        "total"
      ]
    ) {
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


    /*
     * =================================================
     * 6. 流量计算
     * =================================================
     */

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

    let usedText =
      formatBytes(
        used
      );

    let totalText;

    let usedPct =
      "--";

    let remainPct =
      "--";


    if (
      total > 0
    ) {

      remainingText =
        formatBytes(
          remaining
        );

      totalText =
        formatBytes(
          total
        );


      const percent =
        clamp(
          used /
          total *
          100,
          0,
          100
        );


      usedPct =
        percent.toFixed(1) +
        "%";

      remainPct =
        (
          100 -
          percent
        ).toFixed(1) +
        "%";

    } else {

      /*
       * 常见机场中 total=0
       * 通常表示不限量。
       */

      remainingText =
        "不限量";

      totalText =
        "不限量";
    }


    /*
     * =================================================
     * 7. 到期时间
     * =================================================
     */

    const expireDate =
      info.expire > 0
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
     * =================================================
     * 8. 流量重置日
     * =================================================
     *
     * 如果 Subscription-Userinfo
     * 非标准扩展中包含：
     *
     * reset_day=
     * reset-day=
     *
     * 则优先使用。
     *
     * 否则 fallback：
     * 使用到期日期中的“日”作为每月重置日。
     */

    const resetDay =
      validResetDay(
        info.reset_day
      )
        ? info.reset_day
        : expireDate
          ? expireDate.getDate()
          : null;


    const resetText =
      resetDay
        ? formatReset(
            resetDay
          )
        : "--";


    /*
     * =================================================
     * 9. 输出 Panel
     * =================================================
     */

    $done({

      title: title,

      content:

        "剩余：" +
        remainingText +
        (
          total > 0
            ? "（" +
              remainPct +
              "）"
            : ""
        ) +

        "\n已用：" +
        usedText +
        (
          total > 0
            ? "（" +
              usedPct +
              "）"
            : ""
        ) +

        "\n总量：" +
        totalText +

        "\n重置：" +
        resetText +

        "\n到期：" +
        expireText

    });


  } catch (e) {

    const message =
      e &&
      e.message
        ? e.message
        : String(e);


    /*
     * 不记录 Profile
     * 不记录订阅 URL
     * 避免订阅凭据进入日志。
     */

    console.log(
      "[airport-traffic] " +
      message
    );


    $done({

      title:
        panelName,

      content:
        message,

      style:
        "error"

    });
  }

})();


/*
 * =====================================================
 * Panel
 * =====================================================
 */

function getPanelName() {

  if (
    typeof $input ===
      "undefined" ||
    !$input ||
    !$input.panelName
  ) {
    return null;
  }


  return String(
    $input.panelName
  ).trim();
}


/*
 * =====================================================
 * Surge HTTP API
 * =====================================================
 */

function httpAPI(
  method,
  path,
  body = {}
) {

  return new Promise(
    resolve => {

      $httpAPI(
        method,
        path,
        body,
        resolve
      );

    }
  );
}


async function getProfile(
  sensitive
) {

  const result =
    await httpAPI(

      "GET",

      "/v1/profiles/current",

      {
        sensitive:
          sensitive
            ? 1
            : 0
      }

    );


  if (
    !result ||
    typeof result.profile !==
      "string"
  ) {

    throw new Error(
      "无法通过 Surge HTTP API 读取当前 Profile"
    );
  }


  return result.profile;
}


/*
 * =====================================================
 * 查找同名 Proxy Group 的 policy-path
 * =====================================================
 */

function findPolicyPath(
  profile,
  groupName
) {

  const lines =
    String(profile)
      .replace(
        /^\uFEFF/,
        ""
      )
      .split(
        /\r?\n/
      );


  let inSection =
    false;


  for (
    const raw of lines
  ) {

    const line =
      raw.trim();


    /*
     * Section
     */

    const section =
      line.match(
        /^\[([^\]]+)\]$/
      );


    if (section) {

      inSection =
        section[1]
          .trim()
          .toLowerCase() ===
        "proxy group";

      continue;
    }


    if (
      !inSection ||
      !line
    ) {
      continue;
    }


    /*
     * 跳过注释
     */

    if (
      /^(#|;|\/\/)/.test(
        line
      )
    ) {
      continue;
    }


    /*
     * 找策略组名称
     */

    const eq =
      raw.indexOf(
        "="
      );


    if (
      eq < 0
    ) {
      continue;
    }


    const name =
      raw
        .slice(
          0,
          eq
        )
        .trim();


    if (
      name !==
      groupName
    ) {
      continue;
    }


    /*
     * 查找 policy-path
     *
     * 同时支持：
     *
     * policy-path=https://...
     *
     * policy-path="https://..."
     *
     * policy-path='https://...'
     */

    const rhs =
      raw.slice(
        eq + 1
      );


    const match =
      rhs.match(

        /(?:^|,)\s*policy-path\s*=\s*(?:"([^"]+)"|'([^']+)'|([^,\s]+))/i

      );


    if (
      !match
    ) {
      return null;
    }


    return (
      match[1] ||
      match[2] ||
      match[3] ||
      ""
    ).trim();
  }


  return null;
}


/*
 * =====================================================
 * HTTP
 * =====================================================
 */

function httpGet(
  options
) {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      $httpClient.get(

        options,

        (
          error,
          response
        ) => {

          if (error) {

            reject(
              new Error(
                String(
                  error
                )
              )
            );

            return;
          }


          if (
            !response
          ) {

            reject(
              new Error(
                "未收到订阅服务器响应"
              )
            );

            return;
          }


          resolve(
            response
          );

        }

      );

    }
  );
}


/*
 * =====================================================
 * 请求订阅
 * =====================================================
 *
 * 某些机场会根据 UA
 * 决定是否返回 Subscription-Userinfo。
 *
 * 优先：
 * Quantumult X
 *
 * fallback：
 * Surge
 */

async function fetchSubscription(
  url
) {

  let lastResponse =
    null;

  let lastError =
    null;


  for (
    const ua of
    UA_LIST
  ) {

    try {

      const response =
        await httpGet({

          url: url,

          headers: {

            "User-Agent":
              ua,

            "Accept":
              "*/*"

          },

          timeout:
            HTTP_TIMEOUT

        });


      lastResponse =
        response;


      const status =
        Number(
          response.status ||
          0
        );


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


      const userInfo =
        getHeader(

          response.headers,

          "subscription-userinfo"

        );


      if (
        userInfo
      ) {

        return {

          response:
            response,

          userInfo:
            userInfo

        };
      }


    } catch (e) {

      lastError =
        e;

    }
  }


  if (
    lastResponse
  ) {

    throw new Error(
      "订阅响应中没有 Subscription-Userinfo"
    );

  }


  throw new Error(

    "订阅请求失败" +

    (
      lastError
        ? "：" +
          lastError.message
        : ""
    )

  );
}


/*
 * =====================================================
 * Header
 * =====================================================
 */

function getHeader(
  headers,
  name
) {

  if (
    !headers
  ) {
    return null;
  }


  const target =
    name.toLowerCase();


  for (
    const key in headers
  ) {

    if (
      key.toLowerCase() ===
      target
    ) {

      const value =
        headers[key];


      if (
        Array.isArray(
          value
        )
      ) {

        return String(
          value[0] ||
          ""
        );
      }


      return String(
        value ||
        ""
      );
    }
  }


  return null;
}


/*
 * =====================================================
 * 机场名称
 * =====================================================
 */

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


  if (
    profileTitle
  ) {

    const title =
      decodeProfileTitle(
        profileTitle
      );


    if (
      title
    ) {
      return title;
    }
  }


  /*
   * 2. Content-Disposition
   */

  const cd =
    getHeader(

      headers,

      "content-disposition"

    );


  if (
    !cd
  ) {
    return null;
  }


  /*
   * filename*=UTF-8''...
   */

  const extended =
    cd.match(

      /filename\*\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;]+))/i

    );


  if (
    extended
  ) {

    let name =
      (
        extended[1] ||
        extended[2] ||
        extended[3] ||
        ""
      ).trim();


    const rfc5987 =
      name.match(

        /^[^']*'[^']*'(.*)$/

      );


    if (
      rfc5987
    ) {
      name =
        rfc5987[1];
    }


    try {

      name =
        decodeURIComponent(
          name
        );

    } catch (_) {}


    return cleanFilename(
      name
    );
  }


  /*
   * filename=
   */

  const normal =
    cd.match(

      /filename\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;]+))/i

    );


  if (
    normal
  ) {

    return cleanFilename(

      normal[1] ||
      normal[2] ||
      normal[3]

    );
  }


  return null;
}


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


  /*
   * base64:
   */

  if (
    /^base64:/i.test(
      text
    )
  ) {

    try {

      return cleanTitle(

        base64Utf8(

          text
            .replace(
              /^base64:/i,
              ""
            )
            .trim()

        )

      );

    } catch (_) {

      return null;
    }
  }


  /*
   * URL encoded
   */

  try {

    if (
      text.includes(
        "%"
      )
    ) {

      text =
        decodeURIComponent(
          text
        );
    }

  } catch (_) {}


  return cleanTitle(
    text
  );
}


function cleanFilename(
  value
) {

  let text =
    String(
      value ||
      ""
    ).trim();


  try {

    if (
      text.includes(
        "%"
      )
    ) {

      text =
        decodeURIComponent(
          text
        );
    }

  } catch (_) {}


  return cleanTitle(

    text.replace(

      /\.(yaml|yml|txt|conf|json)$/i,

      ""

    )

  );
}


function cleanTitle(
  value
) {

  const text =
    String(
      value ||
      ""
    )
      .replace(
        /[\r\n\t]+/g,
        " "
      )
      .trim();


  return (
    text ||
    null
  );
}


/*
 * =====================================================
 * Subscription-Userinfo
 * =====================================================
 */

function parseUserInfo(
  value
) {

  const result =
    {};


  for (
    const item of
    String(value)
      .split(";")
  ) {

    const eq =
      item.indexOf(
        "="
      );


    if (
      eq < 0
    ) {
      continue;
    }


    /*
     * reset-day
     * 自动归一化为
     * reset_day
     */

    const key =
      item
        .slice(
          0,
          eq
        )
        .trim()
        .toLowerCase()
        .replace(
          /-/g,
          "_"
        );


    const number =
      Number(

        item
          .slice(
            eq + 1
          )
          .trim()

      );


    if (
      key &&
      Number.isFinite(
        number
      )
    ) {

      result[key] =
        number;
    }
  }


  return result;
}


/*
 * =====================================================
 * 流量格式
 * =====================================================
 */

function formatBytes(
  bytes
) {

  if (
    !Number.isFinite(
      bytes
    ) ||
    bytes < 0
  ) {

    return "--";
  }


  if (
    bytes === 0
  ) {

    return "0 B";
  }


  const units = [

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

        Math.log(
          bytes
        ) /

        Math.log(
          1024
        )

      ),

      units.length -
      1

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


/*
 * =====================================================
 * 到期时间
 * =====================================================
 */

function parseTimestamp(
  value
) {

  let timestamp =
    Number(
      value
    );


  if (
    !Number.isFinite(
      timestamp
    ) ||
    timestamp <= 0
  ) {

    return null;
  }


  /*
   * 通常是 Unix 秒。
   * 同时兼容毫秒时间戳。
   */

  if (
    timestamp >
    1000000000000
  ) {

    timestamp =
      Math.floor(
        timestamp /
        1000
      );
  }


  const date =
    new Date(
      timestamp *
      1000
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
      date.getMonth() +
      1
    ) +

    "-" +

    pad2(
      date.getDate()
    )

  );
}


/*
 * =====================================================
 * 重置日
 * =====================================================
 */

function validResetDay(
  day
) {

  return (

    Number.isInteger(
      day
    ) &&

    day >= 1 &&

    day <= 31

  );
}


function formatReset(
  resetDay
) {

  const now =
    new Date();


  const today =
    new Date(

      now.getFullYear(),

      now.getMonth(),

      now.getDate()

    );


  let year =
    today.getFullYear();

  let month =
    today.getMonth();


  let target =
    resetDate(

      year,

      month,

      resetDay

    );


  /*
   * 如果今天就是重置日，
   * 认为本次重置已经发生，
   * 计算下一次重置。
   */

  if (
    target <=
    today
  ) {

    month +=
      1;


    if (
      month > 11
    ) {

      month =
        0;

      year +=
        1;
    }


    target =
      resetDate(

        year,

        month,

        resetDay

      );
  }


  const days =
    Math.max(

      0,

      Math.ceil(

        (
          target -
          today
        ) /

        86400000

      )

    );


  return (
    "剩余 " +
    days +
    " 天"
  );
}


function resetDate(
  year,
  month,
  day
) {

  const maxDay =
    new Date(

      year,

      month + 1,

      0

    ).getDate();


  return new Date(

    year,

    month,

    Math.min(
      day,
      maxDay
    )

  );
}


/*
 * =====================================================
 * Base64 UTF-8
 * =====================================================
 *
 * 不依赖 engine=webview。
 */

function base64Utf8(
  input
) {

  const chars =

    "ABCDEFGHIJKLMNOPQRSTUVWXYZ" +
    "abcdefghijklmnopqrstuvwxyz" +
    "0123456789+/";


  let source =
    String(input)

      .replace(
        /\s/g,
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
    source.length %
    4
  ) {

    source +=
      "=";
  }


  const bytes =
    [];


  for (
    let i = 0;
    i < source.length;
    i += 4
  ) {

    const a =
      chars.indexOf(
        source[i]
      );

    const b =
      chars.indexOf(
        source[i + 1]
      );

    const c =
      source[i + 2] ===
      "="
        ? 0
        : chars.indexOf(
            source[i + 2]
          );

    const d =
      source[i + 3] ===
      "="
        ? 0
        : chars.indexOf(
            source[i + 3]
          );


    if (
      a < 0 ||
      b < 0 ||
      c < 0 ||
      d < 0
    ) {

      throw new Error(
        "Invalid Base64"
      );
    }


    const value =

      (
        a << 18
      ) |

      (
        b << 12
      ) |

      (
        c << 6
      ) |

      d;


    bytes.push(

      (
        value >>
        16
      ) &
      255

    );


    if (
      source[i + 2] !==
      "="
    ) {

      bytes.push(

        (
          value >>
          8
        ) &
        255

      );
    }


    if (
      source[i + 3] !==
      "="
    ) {

      bytes.push(

        value &
        255

      );
    }
  }


  let encoded =
    "";


  for (
    const byte of bytes
  ) {

    encoded +=

      "%" +

      byte
        .toString(16)
        .padStart(
          2,
          "0"
        );
  }


  return decodeURIComponent(
    encoded
  );
}


/*
 * =====================================================
 * Utils
 * =====================================================
 */

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

  return String(
    value
  ).padStart(
    2,
    "0"
  );
}
