/*
 * Surge Subscription Info Panel
 *
 * 订阅地址：来自 $argument
 *
 * 机场名称识别优先级：
 *   1. Profile-Title
 *   2. Content-Disposition filename* / filename
 *   3. $input.panelName
 *
 * Panel:
 *   机场名称
 *
 *   剩余：326.47 GB（65.3%）
 *   已用：173.53 GB（34.7%）
 *   总量：500.00 GB
 *   重置：剩余 12 天
 *   到期：2026-12-31
 */

const fallbackName =
  typeof $input !== "undefined" &&
  $input.panelName
    ? $input.panelName
    : "订阅信息";

const subscriptionURL =
  typeof $argument !== "undefined"
    ? $argument.trim()
    : "";

if (!subscriptionURL) {
  finishError(
    fallbackName,
    "未配置订阅地址"
  );
} else {
  fetchSubscriptionInfo(
    subscriptionURL
  );
}


function fetchSubscriptionInfo(url) {
  const request = {
    url: url,
    headers: {
      "User-Agent": "Surge"
    }
  };

  $httpClient.get(
    request,
    function (
      error,
      response,
      data
    ) {
      if (error) {
        finishError(
          fallbackName,
          "订阅请求失败\n" + error
        );
        return;
      }

      if (!response) {
        finishError(
          fallbackName,
          "未收到订阅服务器响应"
        );
        return;
      }

      const status =
        Number(response.status || 0);

      if (
        status < 200 ||
        status >= 400
      ) {
        finishError(
          fallbackName,
          "订阅服务器返回 HTTP " +
            status
        );
        return;
      }

      const headers =
        response.headers || {};

      /*
       * 自动识别机场名称
       */
      const airportName =
        getAirportName(
          headers,
          fallbackName
        );

      /*
       * Subscription-Userinfo
       */
      const userInfo =
        getHeader(
          headers,
          "subscription-userinfo"
        );

      if (!userInfo) {
        finishError(
          airportName,
          "订阅响应中没有 Subscription-Userinfo"
        );
        return;
      }

      const info =
        parseUserInfo(userInfo);

      if (
        info.upload === undefined ||
        info.download === undefined ||
        info.total === undefined
      ) {
        finishError(
          airportName,
          "无法解析订阅流量信息"
        );
        return;
      }

      /*
       * 流量计算
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
      let usedText;
      let totalText;

      let usedPercentText = "--";
      let remainingPercentText =
        "--";

      if (total === 0) {
        remainingText =
          "不限量";

        totalText =
          "不限量";

        usedText =
          formatBytes(used);
      } else {
        remainingText =
          formatBytes(remaining);

        usedText =
          formatBytes(used);

        totalText =
          formatBytes(total);

        const usedPercent =
          Math.min(
            Math.max(
              used /
                total *
                100,
              0
            ),
            100
          );

        const remainingPercent =
          Math.max(
            100 -
              usedPercent,
            0
          );

        usedPercentText =
          usedPercent.toFixed(1) +
          "%";

        remainingPercentText =
          remainingPercent.toFixed(
            1
          ) + "%";
      }

      /*
       * 到期时间 / 重置时间
       */
      let expireText =
        "长期有效";

      let resetText =
        "--";

      if (
        info.expire !== undefined &&
        info.expire > 0
      ) {
        const expireDate =
          parseTimestamp(
            info.expire
          );

        if (expireDate) {
          expireText =
            formatDate(
              expireDate
            );

          /*
           * Subscription-Userinfo
           * 通常没有 reset_day。
           *
           * fallback：
           * 使用到期日期的“日”
           * 作为每月重置日。
           */
          const resetDay =
            expireDate.getDate();

          const daysLeft =
            getResetDaysLeft(
              resetDay
            );

          resetText =
            "剩余 " +
            daysLeft +
            " 天";
        }
      }

      /*
       * 输出 Panel
       */
      $done({
        title: airportName,

        content:
          "剩余：" +
          remainingText +
          (
            total > 0
              ? "（" +
                remainingPercentText +
                "）"
              : ""
          ) +

          "\n已用：" +
          usedText +
          (
            total > 0
              ? "（" +
                usedPercentText +
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
    }
  );
}


/*
 * =====================================================
 * 机场名称
 * =====================================================
 */

function getAirportName(
  headers,
  fallback
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
    const decoded =
      decodeProfileTitle(
        profileTitle
      );

    if (decoded) {
      return decoded;
    }
  }

  /*
   * 2. Content-Disposition
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
      return cleanupFilename(
        filename
      );
    }
  }

  /*
   * 3. Panel 名称
   */
  return fallback;
}


/*
 * Profile-Title 常见格式：
 *
 * Profile-Title: ABC机场
 *
 * 或：
 *
 * Profile-Title:
 * base64:QUJD5py65Zy6
 */
function decodeProfileTitle(
  value
) {
  if (!value) {
    return null;
  }

  let text =
    String(value).trim();

  if (!text) {
    return null;
  }

  /*
   * base64:
   */
  if (
    /^base64:/i.test(text)
  ) {
    const encoded =
      text.replace(
        /^base64:/i,
        ""
      ).trim();

    try {
      const decoded =
        base64ToUtf8(
          encoded
        );

      if (decoded) {
        return decoded.trim();
      }
    } catch (e) {
      return null;
    }
  }

  /*
   * 某些服务器可能返回
   * URL encoded 标题
   */
  if (
    text.indexOf("%") !== -1
  ) {
    try {
      text =
        decodeURIComponent(
          text
        );
    } catch (e) {
      // 保留原始内容
    }
  }

  /*
   * 去掉包裹引号
   */
  text =
    text.replace(
      /^["']|["']$/g,
      ""
    );

  return (
    text.trim() ||
    null
  );
}


/*
 * =====================================================
 * Content-Disposition
 * =====================================================
 */

function getContentDispositionFilename(
  value
) {
  if (!value) {
    return null;
  }

  const text =
    String(value);

  /*
   * 优先 filename*
   *
   * 例如：
   * filename*=UTF-8''ABC%E6%9C%BA%E5%9C%BA
   */
  const extendedMatch =
    text.match(
      /filename\*\s*=\s*([^;]+)/i
    );

  if (extendedMatch) {
    let filename =
      extendedMatch[1]
        .trim()
        .replace(
          /^["']|["']$/g,
          ""
        );

    /*
     * RFC 5987:
     *
     * UTF-8''xxx
     */
    const charsetMatch =
      filename.match(
        /^[^']*'[^']*'(.*)$/
      );

    if (charsetMatch) {
      filename =
        charsetMatch[1];
    }

    try {
      filename =
        decodeURIComponent(
          filename
        );
    } catch (e) {
      // 保留原字符串
    }

    if (filename) {
      return filename;
    }
  }

  /*
   * 普通 filename=
   */
  const filenameMatch =
    text.match(
      /filename\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;]*))/i
    );

  if (
    filenameMatch
  ) {
    let filename =
      filenameMatch[1] ||
      filenameMatch[2] ||
      filenameMatch[3];

    if (filename) {
      filename =
        filename.trim();

      try {
        if (
          filename.indexOf(
            "%"
          ) !== -1
        ) {
          filename =
            decodeURIComponent(
              filename
            );
        }
      } catch (e) {
        // 保留原字符串
      }

      return filename;
    }
  }

  return null;
}


/*
 * Content-Disposition 有时返回：
 *
 * filename="ABC机场.yaml"
 *
 * 作为 Panel 标题时，
 * 去掉常见订阅文件扩展名。
 */
function cleanupFilename(
  filename
) {
  if (!filename) {
    return null;
  }

  let name =
    String(filename).trim();

  name =
    name.replace(
      /\.(yaml|yml|txt|conf|json)$/i,
      ""
    );

  return (
    name.trim() ||
    null
  );
}


/*
 * =====================================================
 * HTTP Headers
 * =====================================================
 */

function getHeader(
  headers,
  targetName
) {
  if (!headers) {
    return null;
  }

  const target =
    targetName.toLowerCase();

  for (
    const key in headers
  ) {
    if (
      key.toLowerCase() ===
      target
    ) {
      return String(
        headers[key]
      );
    }
  }

  return null;
}


/*
 * =====================================================
 * Subscription-Userinfo
 * =====================================================
 */

function parseUserInfo(
  value
) {
  const result = {};

  String(value)
    .split(";")
    .forEach(
      function (item) {
        const parts =
          item
            .trim()
            .split("=");

        if (
          parts.length < 2
        ) {
          return;
        }

        const key =
          parts[0]
            .trim()
            .
