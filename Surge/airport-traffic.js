/*
 * Surge Subscription Info Panel
 *
 * 机场名称：来自 $input.panelName
 * 订阅地址：来自 $argument
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

const airportName =
  typeof $input !== "undefined" && $input.panelName
    ? $input.panelName
    : "订阅信息";

const subscriptionURL =
  typeof $argument !== "undefined"
    ? $argument.trim()
    : "";

if (!subscriptionURL) {
  finishError("未配置订阅地址");
} else {
  fetchSubscriptionInfo(subscriptionURL);
}


function fetchSubscriptionInfo(url) {
  const request = {
    url: url,
    headers: {
      "User-Agent": "Quantumult X"
    }
  };

  $httpClient.get(request, function (error, response, data) {
    if (error) {
      finishError("订阅请求失败\n" + error);
      return;
    }

    if (!response) {
      finishError("未收到订阅服务器响应");
      return;
    }

    const status = Number(response.status || 0);

    if (status < 200 || status >= 400) {
      finishError("订阅服务器返回 HTTP " + status);
      return;
    }

    const userInfo = getHeader(
      response.headers,
      "subscription-userinfo"
    );

    if (!userInfo) {
      finishError("订阅响应中没有 Subscription-Userinfo");
      return;
    }

    const info = parseUserInfo(userInfo);

    if (
      info.upload === undefined ||
      info.download === undefined ||
      info.total === undefined
    ) {
      finishError("无法解析订阅流量信息");
      return;
    }

    const used = info.upload + info.download;
    const total = info.total;
    const remaining = Math.max(total - used, 0);

    let remainingText;
    let totalText;
    let usedText;
    let usedPercentText = "--";
    let remainingPercentText = "--";

    if (total === 0) {
      remainingText = "不限量";
      totalText = "不限量";
      usedText = formatBytes(used);
    } else {
      remainingText = formatBytes(remaining);
      totalText = formatBytes(total);
      usedText = formatBytes(used);

      const usedPercent = Math.min(
        Math.max((used / total) * 100, 0),
        100
      );

      const remainingPercent = Math.max(
        100 - usedPercent,
        0
      );

      usedPercentText = usedPercent.toFixed(1) + "%";
      remainingPercentText =
        remainingPercent.toFixed(1) + "%";
    }

    let expireText = "长期有效";
    let resetText = "--";

    if (
      info.expire !== undefined &&
      info.expire > 0
    ) {
      const expireDate =
        parseTimestamp(info.expire);

      if (expireDate) {
        expireText = formatDate(expireDate);

        /*
         * Subscription-Userinfo 通常没有独立的
         * reset_day 字段。
         *
         * 当前逻辑：
         * 以到期日期中的“日”作为每月重置日。
         *
         * 例如：
         * 到期：2027-06-18
         * 则认为每月 18 日重置。
         */
        const resetDay =
          expireDate.getDate();

        const daysLeft =
          getResetDaysLeft(resetDay);

        resetText =
          "剩余 " + daysLeft + " 天";
      }
    }

    $done({
      title: airportName,
      content:
        "剩余：" +
        remainingText +
        (
          total > 0
            ? "（" + remainingPercentText + "）"
            : ""
        ) +
        "\n已用：" +
        usedText +
        (
          total > 0
            ? "（" + usedPercentText + "）"
            : ""
        ) +
        "\n总量：" +
        totalText +
        "\n重置：" +
        resetText +
        "\n到期：" +
        expireText
    });
  });
}


function getHeader(headers, targetName) {
  if (!headers) {
    return null;
  }

  const target =
    targetName.toLowerCase();

  for (const key in headers) {
    if (
      key.toLowerCase() === target
    ) {
      return String(headers[key]);
    }
  }

  return null;
}


function parseUserInfo(value) {
  const result = {};

  value
    .split(";")
    .forEach(function (item) {
      const parts =
        item.trim().split("=");

      if (parts.length < 2) {
        return;
      }

      const key =
        parts[0]
          .trim()
          .toLowerCase();

      const number =
        Number(
          parts
            .slice(1)
            .join("=")
            .trim()
        );

      if (!Number.isNaN(number)) {
        result[key] = number;
      }
    });

  return result;
}


function formatBytes(bytes) {
  if (
    !Number.isFinite(bytes) ||
    bytes < 0
  ) {
    return "--";
  }

  const units = [
    "B",
    "KB",
    "MB",
    "GB",
    "TB",
    "PB"
  ];

  if (bytes === 0) {
    return "0 B";
  }

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
    Math.pow(1024, index);

  return (
    value.toFixed(2) +
    " " +
    units[index]
  );
}


function parseTimestamp(timestamp) {
  let value =
    Number(timestamp);

  if (
    !Number.isFinite(value) ||
    value <= 0
  ) {
    return null;
  }

  /*
   * 正常情况下 expire 是 Unix 秒。
   * 同时兼容毫秒时间戳。
   */
  if (value > 1000000000000) {
    value =
      Math.floor(value / 1000);
  }

  const date =
    new Date(value * 1000);

  if (
    Number.isNaN(date.getTime())
  ) {
    return null;
  }

  return date;
}


function formatDate(date) {
  const year =
    date.getFullYear();

  const month =
    pad(date.getMonth() + 1);

  const day =
    pad(date.getDate());

  return (
    year +
    "-" +
    month +
    "-" +
    day
  );
}


function getResetDaysLeft(resetDay) {
  const now =
    new Date();

  const year =
    now.getFullYear();

  const month =
    now.getMonth();

  const today =
    now.getDate();

  let target;

  if (today < resetDay) {
    /*
     * 本月尚未到重置日
     */
    const daysInMonth =
      new Date(
        year,
        month + 1,
        0
      ).getDate();

    target =
      new Date(
        year,
        month,
        Math.min(
          resetDay,
          daysInMonth
        )
      );
  } else {
    /*
     * 本月重置日已过，
     * 计算下个月重置日。
     */
    const nextMonthDays =
      new Date(
        year,
        month + 2,
        0
      ).getDate();

    target =
      new Date(
        year,
        month + 1,
        Math.min(
          resetDay,
          nextMonthDays
        )
      );
  }

  const todayStart =
    new Date(
      year,
      month,
      today
    );

  return Math.ceil(
    (
      target -
      todayStart
    ) /
    86400000
  );
}


function pad(value) {
  return String(value)
    .padStart(2, "0");
}


function finishError(message) {
  $done({
    title: airportName,
    content: message,
    style: "error"
  });
}
