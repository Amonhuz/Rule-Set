/*
 * Surge Subscription Info Panel
 *
 * 机场名称：来自 $input.panelName
 * 订阅地址：来自 $argument
 *
 * GitHub JS 中无需填写任何机场相关信息。
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
      "User-Agent": "Surge"
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

    let remainingText;

    if (info.total === 0) {
      remainingText = "不限量";
    } else {
      const remaining = Math.max(info.total - used, 0);
      remainingText = formatBytes(remaining);
    }

    let expireText = "未提供";

    if (info.expire !== undefined && info.expire > 0) {
      expireText = formatExpireTime(info.expire);
    }

    $done({
      title: airportName,
      content:
        "剩余流量：" + remainingText +
        "\n到期时间：" + expireText,
      style: "info"
    });
  });
}


function getHeader(headers, targetName) {
  if (!headers) return null;

  const target = targetName.toLowerCase();

  for (const key in headers) {
    if (key.toLowerCase() === target) {
      return String(headers[key]);
    }
  }

  return null;
}


function parseUserInfo(value) {
  const result = {};

  value.split(";").forEach(function (item) {
    const parts = item.trim().split("=");

    if (parts.length < 2) return;

    const key = parts[0].trim().toLowerCase();
    const number = Number(parts.slice(1).join("=").trim());

    if (!Number.isNaN(number)) {
      result[key] = number;
    }
  });

  return result;
}


function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "未知";
  }

  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  const TB = GB * 1024;

  if (bytes >= TB) {
    return (bytes / TB).toFixed(2) + " TB";
  }

  if (bytes >= GB) {
    return (bytes / GB).toFixed(2) + " GB";
  }

  if (bytes >= MB) {
    return (bytes / MB).toFixed(2) + " MB";
  }

  if (bytes >= KB) {
    return (bytes / KB).toFixed(2) + " KB";
  }

  return bytes.toFixed(0) + " B";
}


function formatExpireTime(timestamp) {
  // Subscription-Userinfo 的 expire 通常为 Unix 秒。
  // 同时兼容误传毫秒时间戳的情况。
  if (timestamp > 1000000000000) {
    timestamp = Math.floor(timestamp / 1000);
  }

  const date = new Date(timestamp * 1000);

  if (Number.isNaN(date.getTime())) {
    return "未知";
  }

  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hour = pad(date.getHours());
  const minute = pad(date.getMinutes());

  return (
    year +
    "-" +
    month +
    "-" +
    day +
    " " +
    hour +
    ":" +
    minute
  );
}


function pad(value) {
  return String(value).padStart(2, "0");
}


function finishError(message) {
  $done({
    title: airportName,
    content: message,
    style: "error"
  });
}
